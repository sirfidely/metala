package platform

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

// Les identifiants T-xxx renvoient aux tests de réception du cahier des
// charges MVP Metala v1.0 (§18), repris en Annexe D de la proposition.

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time      { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *fakeClock) Add(d time.Duration) { c.mu.Lock(); c.t = c.t.Add(d); c.mu.Unlock() }

func setup(t *testing.T) (*Platform, *fakeClock) {
	t.Helper()
	clk := &fakeClock{t: time.Date(2026, 11, 3, 7, 0, 0, 0, time.UTC)}
	p := New(DefaultConfig())
	p.now = clk.Now
	if err := p.Seed(); err != nil {
		t.Fatal(err)
	}
	p.now = clk.Now
	return p, clk
}

func device(p *Platform, id string) Principal {
	d := p.devices[id]
	return Principal{Role: RoleDevice, DeviceID: d.ID, OperatorID: d.OperatorID}
}

func travelerByPhone(p *Platform, phone string) Principal {
	return Principal{Role: RoleTraveler, TravelerID: p.travelerByPhone[phone]}
}

func tap(t *testing.T, p *Platform, dev Principal, uid, tapID string) *Validation {
	t.Helper()
	ch, _, err := p.IssueChallenge(dev)
	if err != nil {
		t.Fatal(err)
	}
	proof, _ := p.SimulateCard(uid, ch)
	v, err := p.Validate(dev, TapRequest{TapID: tapID, CardUID: uid, Challenge: ch, Proof: proof})
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func assertBalanced(t *testing.T, p *Platform) {
	t.Helper()
	p.mu.Lock()
	r := p.reconcileLocked("")
	p.mu.Unlock()
	if !r.Balanced {
		t.Fatalf("rapprochement en écart : %v (%+v)", r.Discrepancies, r)
	}
}

func TestSeedScenarioAwa(t *testing.T) {
	p, _ := setup(t)
	v := tap(t, p, device(p, "dev_101"), DemoAwa.CardUID, "t1")
	if v.Status != ValAccepted || v.Message != "Validé — 18 trajets restants" {
		t.Fatalf("attendu « Validé — 18 trajets restants », obtenu %q (%s)", v.Message, v.Status)
	}
	assertBalanced(t, p)
}

// T-004 : un même tap rejoué (retry réseau) ne débite qu'une fois.
func TestT004_TapRetryIsIdempotent(t *testing.T) {
	p, _ := setup(t)
	dev := device(p, "dev_101")
	ch, _, _ := p.IssueChallenge(dev)
	proof, _ := p.SimulateCard(DemoAwa.CardUID, ch)
	req := TapRequest{TapID: "same-tap", CardUID: DemoAwa.CardUID, Challenge: ch, Proof: proof}
	a, _ := p.Validate(dev, req)
	b, _ := p.Validate(dev, req)
	if a.ID != b.ID || *a.TripsRemaining != *b.TripsRemaining {
		t.Fatalf("le rejeu doit renvoyer la même validation")
	}
	if n := countUsage(p); n != 2 { // 1 trajet au seed + 1 ici
		t.Fatalf("écritures de consommation = %d, attendu 2", n)
	}
	assertBalanced(t, p)
}

// T-005 : l'UID seul (carte clonée sans clé) est refusé ; une preuve
// fausse aussi ; un challenge ne peut pas être rejoué.
func TestT005_UIDOnlyAndReplayRejected(t *testing.T) {
	p, _ := setup(t)
	dev := device(p, "dev_101")
	v, _ := p.Validate(dev, TapRequest{TapID: "a", CardUID: DemoAwa.CardUID})
	if v.Status != ValRejected || v.Reason != "uid_only" {
		t.Fatalf("UID seul : %+v", v)
	}
	ch, _, _ := p.IssueChallenge(dev)
	v, _ = p.Validate(dev, TapRequest{TapID: "b", CardUID: DemoAwa.CardUID, Challenge: ch, Proof: "00ff"})
	if v.Reason != "bad_proof" {
		t.Fatalf("preuve fausse : %+v", v)
	}
	ch2, _, _ := p.IssueChallenge(dev)
	proof, _ := p.SimulateCard(DemoAwa.CardUID, ch2)
	if v, _ = p.Validate(dev, TapRequest{TapID: "c", CardUID: DemoAwa.CardUID, Challenge: ch2, Proof: proof}); v.Status != ValAccepted {
		t.Fatalf("tap légitime refusé : %+v", v)
	}
	v, _ = p.Validate(dev, TapRequest{TapID: "d", CardUID: DemoAwa.CardUID, Challenge: ch2, Proof: proof})
	if v.Reason != "replay" {
		t.Fatalf("rejeu du challenge : %+v", v)
	}
	// Challenge émis pour un autre terminal.
	ch3, _, _ := p.IssueChallenge(device(p, "dev_102"))
	proof3, _ := p.SimulateCard(DemoAwa.CardUID, ch3)
	if v, _ = p.Validate(dev, TapRequest{TapID: "e", CardUID: DemoAwa.CardUID, Challenge: ch3, Proof: proof3}); v.Reason != "bad_challenge" {
		t.Fatalf("challenge d'un autre terminal : %+v", v)
	}
}

// T-008 : deux présentations rapprochées dans le même véhicule = un seul débit.
func TestT008_PassbackNoDoubleDebit(t *testing.T) {
	p, clk := setup(t)
	dev := device(p, "dev_101")
	a := tap(t, p, dev, DemoAwa.CardUID, "x1")
	clk.Add(10 * time.Second)
	b := tap(t, p, dev, DemoAwa.CardUID, "x2")
	if a.Status != ValAccepted || b.Status != ValAlready || b.Debited != 0 {
		t.Fatalf("passback : a=%s b=%s debit=%d", a.Status, b.Status, b.Debited)
	}
	clk.Add(2 * time.Minute)
	if c := tap(t, p, dev, DemoAwa.CardUID, "x3"); c.Status != ValAccepted || *c.TripsRemaining != 17 {
		t.Fatalf("après la fenêtre, nouveau trajet attendu : %+v", c)
	}
	assertBalanced(t, p)
}

// T-009 : un webhook PSP doublé n'émet qu'un seul titre ; signature exigée.
func TestT009_DuplicateWebhookOneTitle(t *testing.T) {
	p, _ := setup(t)
	yao := travelerByPhone(p, DemoYao.Phone)
	pay, _ := p.CreatePurchase(yao, "prd_lag_c10")
	if _, err := p.SimulatePSP(pay.ID, "succeeded", true); err != nil {
		t.Fatal(err)
	}
	me, _ := p.Me(yao)
	if len(me.Titles) != 1 {
		t.Fatalf("titres émis = %d, attendu 1", len(me.Titles))
	}
	body, _ := json.Marshal(PSPEvent{EventID: "evt_forged", PSPRef: pay.PSPRef, Status: "succeeded", Amount: pay.Amount})
	if _, err := p.HandlePSPWebhook(body, "bad-signature"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("signature invalide acceptée : %v", err)
	}
	assertBalanced(t, p)
}

func TestWebhookAmountMismatchRejected(t *testing.T) {
	p, _ := setup(t)
	yao := travelerByPhone(p, DemoYao.Phone)
	pay, _ := p.CreatePurchase(yao, "prd_lag_c10")
	body, _ := json.Marshal(PSPEvent{EventID: "evt_1", PSPRef: pay.PSPRef, Status: "succeeded", Amount: 1})
	if _, err := p.HandlePSPWebhook(body, SignWebhook(p.cfg.PSPWebhookSecret, body)); !errors.Is(err, ErrConflict) {
		t.Fatalf("montant incohérent accepté : %v", err)
	}
	if me, _ := p.Me(yao); len(me.Titles) != 0 {
		t.Fatal("aucun titre ne doit être émis")
	}
	assertBalanced(t, p)
}

// T-011 : la dernière place ne peut être réservée qu'une fois.
func TestT011_LastSeatOnlyOnce(t *testing.T) {
	p, _ := setup(t)
	var dep string
	for _, d := range p.Departures("ln_m2") {
		if d.ReservableSeats == 1 {
			dep = d.ID
		}
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	ok := 0
	for i := 0; i < 20; i++ {
		phone := fmt.Sprintf("+225015%07d", i)
		_, code, err := p.RequestOTP(phone)
		if err != nil {
			t.Fatal(err)
		}
		_, tr, _ := p.VerifyOTP(phone, code, "")
		wg.Add(1)
		go func(pr Principal) {
			defer wg.Done()
			if _, err := p.Reserve(pr, dep); err == nil {
				mu.Lock()
				ok++
				mu.Unlock()
			}
		}(Principal{Role: RoleTraveler, TravelerID: tr.ID})
	}
	wg.Wait()
	if ok != 1 {
		t.Fatalf("réservations réussies = %d, attendu 1", ok)
	}
}

// T-013 : un GPS de plus de 120 s est « inconnu » et ne produit aucun ETA.
func TestT013_StaleGPSUnknown(t *testing.T) {
	p, clk := setup(t)
	if err := p.IngestSimulated("veh_101", TelemetryInput{Lat: 5.3400, Lon: -4.0660, Direction: 1}); err != nil {
		t.Fatal(err)
	}
	check := func(want Freshness) {
		t.Helper()
		for _, s := range p.Snapshot("op_lagune") {
			if s.VehicleID == "veh_101" && s.Freshness != want {
				t.Fatalf("fraîcheur = %s, attendu %s", s.Freshness, want)
			}
		}
	}
	check(FreshnessFresh)
	if a, _ := p.Arrivals("st_plateau_cite"); len(a) != 1 {
		t.Fatalf("ETA attendu pour un GPS frais, obtenu %d", len(a))
	}
	clk.Add(45 * time.Second)
	check(FreshnessDelayed)
	if a, _ := p.Arrivals("st_plateau_cite"); len(a) != 1 || !a[0].Degraded {
		t.Fatalf("ETA dégradé attendu : %+v", a)
	}
	clk.Add(90 * time.Second)
	check(FreshnessUnknown)
	if a, _ := p.Arrivals("st_plateau_cite"); len(a) != 0 {
		t.Fatalf("aucun ETA ne doit être produit d'un GPS inconnu : %+v", a)
	}
}

// T-014 : isolation stricte entre opérateurs.
func TestT014_OperatorIsolation(t *testing.T) {
	p, _ := setup(t)
	_, lagune, _ := p.StaffLogin("fleet@lagune.demo", DemoStaffPassword)
	if _, err := p.FleetVehicles(lagune, "op_ebene"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("accès inter-opérateurs non bloqué : %v", err)
	}
	if _, err := p.Reconcile(lagune, "op_ebene"); !errors.Is(err, ErrForbidden) {
		t.Fatal("rapprochement d'un autre opérateur accessible")
	}
	vs, _ := p.FleetVehicles(lagune, "")
	for _, v := range vs {
		if v.OperatorID != "op_lagune" {
			t.Fatalf("véhicule d'un autre opérateur visible : %s", v.VehicleID)
		}
	}
	vals, _ := p.FleetValidations(lagune, "", 100)
	for _, v := range vals {
		if v.OperatorID != "op_lagune" || v.TravelerID != "" {
			t.Fatalf("validation non isolée ou non minimisée : %+v", v)
		}
	}
	if err := p.FreezeDevice(lagune, "dev_201", true); !errors.Is(err, ErrForbidden) {
		t.Fatal("un opérateur ne doit pas geler le terminal d'un autre")
	}
	// Un titre Lagune n'ouvre pas les bus Ébène.
	// (le porte-monnaie, lui, est valable sur tous les réseaux)
	if v := tap(t, p, device(p, "dev_201"), DemoAwa.CardUID, "iso"); v.Source == "title" {
		t.Fatalf("titre Lagune accepté chez Ébène : %+v", v)
	}
	// Un voyageur ou un terminal n'accède pas à Fleet.
	if _, err := p.Dashboard(device(p, "dev_101"), ""); !errors.Is(err, ErrForbidden) {
		t.Fatal("terminal autorisé sur Fleet")
	}
}

// T-015 : un forfait expiré est rejeté.
func TestT015_ExpiredMonthlyRejected(t *testing.T) {
	p, clk := setup(t)
	if v := tap(t, p, device(p, "dev_201"), DemoKoffi.CardUID, "k1"); v.Status != ValAccepted {
		t.Fatalf("forfait valide refusé : %+v", v)
	}
	clk.Add(31 * 24 * time.Hour)
	v := tap(t, p, device(p, "dev_202"), DemoKoffi.CardUID, "k2")
	if v.Status != ValRejected || v.Reason != "title_expired" {
		t.Fatalf("forfait expiré accepté : %+v", v)
	}
}

func TestRevokedCardAndFrozenDevice(t *testing.T) {
	p, _ := setup(t)
	_, admin, _ := p.StaffLogin("admin@metala.demo", DemoStaffPassword)
	if err := p.RevokeCard(admin, DemoAwa.CardUID); err != nil {
		t.Fatal(err)
	}
	if v := tap(t, p, device(p, "dev_101"), DemoAwa.CardUID, "r1"); v.Reason != "card_revoked" {
		t.Fatalf("carte révoquée acceptée : %+v", v)
	}
	_, lagune, _ := p.StaffLogin("fleet@lagune.demo", DemoStaffPassword)
	if err := p.FreezeDevice(lagune, "dev_101", true); err != nil {
		t.Fatal(err)
	}
	tok, _, _ := p.DeviceLogin("dev_102", p.devices["dev_102"].token)
	if _, err := p.Authenticate(tok); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Validate(device(p, "dev_101"), TapRequest{TapID: "z"}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("terminal gelé non bloqué : %v", err)
	}
}

// T-018 : le grand livre égale les rapports après un trafic soutenu.
func TestT018_LedgerMatchesReports(t *testing.T) {
	p, clk := setup(t)
	yao := travelerByPhone(p, DemoYao.Phone)
	for _, prod := range []string{"prd_lag_single", "prd_lag_c10", "prd_lag_month"} {
		pay, _ := p.CreatePurchase(yao, prod)
		if _, err := p.SimulatePSP(pay.ID, "succeeded", true); err != nil {
			t.Fatal(err)
		}
	}
	pend, _ := p.CreatePurchase(yao, "prd_ebe_c10") // jamais confirmé
	_ = pend
	failed, _ := p.CreatePurchase(yao, "prd_ebe_c10")
	_, _ = p.SimulatePSP(failed.ID, "failed", false)
	for i := 0; i < 25; i++ {
		clk.Add(2 * time.Minute)
		tap(t, p, device(p, "dev_101"), DemoAwa.CardUID, "a"+string(rune('a'+i)))
		tap(t, p, device(p, "dev_103"), DemoYao.CardUID, "y"+string(rune('a'+i)))
		tap(t, p, device(p, "dev_201"), DemoKoffi.CardUID, "k"+string(rune('a'+i)))
	}
	assertBalanced(t, p)
	_, lagune, _ := p.StaffLogin("fleet@lagune.demo", DemoStaffPassword)
	r, _ := p.Reconcile(lagune, "")
	if !r.Balanced || r.LedgerSalesTotal != r.OperatorRevenue+r.MetalaCommission+r.LiabilityBalance+r.WalletLedger {
		t.Fatalf("rapprochement Lagune : %+v", r)
	}
}

func TestOTPFlow(t *testing.T) {
	p, _ := setup(t)
	phone, code, err := p.RequestOTP("07 07 12 34 56")
	if err != nil || phone != "+2250707123456" {
		t.Fatalf("normalisation : %s %v", phone, err)
	}
	if _, _, err := p.VerifyOTP(phone, "000000x", ""); err == nil {
		t.Fatal("mauvais code accepté")
	}
	tok, tr, err := p.VerifyOTP(phone, code, "Test")
	if err != nil {
		t.Fatal(err)
	}
	pr, err := p.Authenticate(tok)
	if err != nil || pr.TravelerID != tr.ID {
		t.Fatal("session invalide")
	}
	if me, _ := p.Me(pr); len(me.Cards) != 1 {
		t.Fatal("un Metala Pass doit être émis au premier login")
	}
	if _, _, err := p.RequestOTP("12345"); !errors.Is(err, ErrInvalid) {
		t.Fatal("numéro invalide accepté")
	}
}

func countUsage(p *Platform) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	n := 0
	for _, e := range p.ledger {
		if e.Kind == "usage" {
			n++
		}
	}
	return n
}

func TestResetRestoresDemo(t *testing.T) {
	p, _ := setup(t)
	tap(t, p, device(p, "dev_101"), DemoAwa.CardUID, "before")
	tok, _, _ := p.StaffLogin("fleet@lagune.demo", DemoStaffPassword)
	e := p.Epoch()
	if err := p.Reset(); err != nil {
		t.Fatal(err)
	}
	if p.Epoch() != e+1 {
		t.Fatal("epoch non incrémenté")
	}
	if _, err := p.Authenticate(tok); err == nil {
		t.Fatal("les sessions doivent être invalidées")
	}
	if v := tap(t, p, device(p, "dev_101"), DemoAwa.CardUID, "after"); v.Message != "Validé — 18 trajets restants" {
		t.Fatalf("après réinitialisation : %q", v.Message)
	}
	assertBalanced(t, p)
}

// Porte-monnaie : paiement en ligne quand aucun titre ne couvre le trajet.
func TestWalletOnlinePayment(t *testing.T) {
	p, _ := setup(t)
	yao := travelerByPhone(p, DemoYao.Phone)
	if v := tap(t, p, device(p, "dev_101"), DemoYao.CardUID, "w0"); v.Reason != "no_title" {
		t.Fatalf("sans titre ni solde : %+v", v)
	}
	pay, _ := p.CreatePurchase(yao, "prd_wallet_1000")
	if _, err := p.SimulatePSP(pay.ID, "succeeded", true); err != nil {
		t.Fatal(err)
	}
	v := tap(t, p, device(p, "dev_101"), DemoYao.CardUID, "w1")
	if v.Status != ValAccepted || v.Source != "wallet" || v.Debited != 300 || *v.WalletBalance != 700 {
		t.Fatalf("paiement porte-monnaie : %+v", v)
	}
	assertBalanced(t, p)
	// Plafond
	big, _ := p.CreatePurchase(yao, "prd_wallet_5000")
	for i := 0; i < 3; i++ {
		b2, _ := p.CreatePurchase(yao, "prd_wallet_5000")
		_, _ = p.SimulatePSP(b2.ID, "succeeded", false)
	}
	_ = big
	if _, err := p.CreatePurchase(yao, "prd_wallet_5000"); !errors.Is(err, ErrConflict) {
		t.Fatalf("plafond non appliqué : %v", err)
	}
}

// Hors ligne : la puce est débitée sans serveur, puis la remontée est
// vérifiée, idempotente et comptabilisée.
func TestOfflineWalletDebitAndSync(t *testing.T) {
	p, _ := setup(t)
	dev := device(p, "dev_103")
	tx, err := p.OfflineTap("dev_103", DemoAwa.CardUID)
	if err != nil || tx.Balance != 1700 {
		t.Fatalf("débit hors ligne : %+v %v", tx, err)
	}
	// Avant synchronisation, le rapprochement reste juste grâce au journal en attente.
	assertBalanced(t, p)
	p.mu.Lock()
	r := p.reconcileLocked("")
	p.mu.Unlock()
	if r.OfflinePendingCount != 1 || r.OfflinePending != 300 {
		t.Fatalf("en attente : %+v", r)
	}
	forged := *tx
	forged.Amount = 1
	res, _ := p.OfflineSync(dev, []OfflineTx{forged})
	if res.Rejected != 1 || res.Synced != 0 {
		t.Fatalf("transaction falsifiée acceptée : %+v", res)
	}
	res, _ = p.OfflineSync(dev, []OfflineTx{*tx, *tx})
	if res.Synced != 1 || res.Duplicates != 1 {
		t.Fatalf("synchronisation : %+v", res)
	}
	res, _ = p.OfflineSync(dev, []OfflineTx{*tx})
	if res.Duplicates != 1 || res.Synced != 0 {
		t.Fatalf("re-synchronisation : %+v", res)
	}
	assertBalanced(t, p)
	// Impossible de dépenser plus que le solde prépayé.
	for i := 0; i < 5; i++ {
		_, _ = p.OfflineTap("dev_103", DemoAwa.CardUID)
	}
	if _, err := p.OfflineTap("dev_103", DemoAwa.CardUID); !errors.Is(err, ErrConflict) {
		t.Fatalf("solde négatif autorisé : %v", err)
	}
	// La liste noire est fournie aux valideurs pour décider hors ligne.
	_, admin, _ := p.StaffLogin("admin@metala.demo", DemoStaffPassword)
	_ = p.RevokeCard(admin, DemoKoffi.CardUID)
	cfg, _ := p.ScanConfig(dev)
	if cfg.Fare != 300 || len(cfg.Blacklist) != 1 || cfg.Blacklist[0] != DemoKoffi.CardUID {
		t.Fatalf("configuration hors ligne : %+v", cfg)
	}
}
