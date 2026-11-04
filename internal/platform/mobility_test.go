package platform

import (
	"errors"
	"testing"
	"time"
)

func awa(p *Platform) Principal { return travelerByPhone(p, DemoAwa.Phone) }

func TestJourneyHomeToWork(t *testing.T) {
	p, clk := setup(t)
	tr := p.travelers[awa(p).TravelerID]
	js, err := p.PlanJourneys(JourneyQuery{From: *tr.Home, To: *tr.Work, At: clk.Now()})
	if err != nil || len(js) == 0 {
		t.Fatalf("aucun trajet : %v", err)
	}
	j := js[0]
	if j.Legs[0].Kind != "walk" || j.Legs[len(j.Legs)-1].Kind != "walk" {
		t.Fatalf("un trajet porte-à-porte commence et finit à pied : %+v", j.Legs)
	}
	rides := 0
	for _, l := range j.Legs {
		if l.Kind == "ride" {
			rides++
			if l.Depart.Before(clk.Now()) || !l.Arrive.After(l.Depart) {
				t.Fatalf("horaires incohérents : %+v", l)
			}
		}
	}
	if rides == 0 || !j.Arrive.After(j.Depart) {
		t.Fatalf("trajet sans véhicule : %+v", j)
	}
}

func TestJourneyWithTransferAndArriveBy(t *testing.T) {
	p, clk := setup(t)
	from := Place{Name: "Yopougon Selmer", Lat: 5.3497, Lon: -4.0812}
	to := Place{Name: "Abobo Gare", Lat: 5.4300, Lon: -4.0170}
	js, err := p.PlanJourneys(JourneyQuery{From: from, To: to, At: clk.Now()})
	if err != nil || len(js) == 0 || js[0].Transfers != 1 {
		t.Fatalf("correspondance M2 → G7 attendue : %+v %v", js, err)
	}
	// Arriver avant 08:30 demain.
	tomorrow := clk.Now().Add(24 * time.Hour)
	deadline := time.Date(tomorrow.Year(), tomorrow.Month(), tomorrow.Day(), 8, 30, 0, 0, abidjan)
	js, _ = p.PlanJourneys(JourneyQuery{From: from, To: to, At: deadline, ArriveBy: true})
	if len(js) == 0 {
		t.Fatal("aucun trajet en « arriver avant »")
	}
	for _, j := range js {
		if j.Arrive.After(deadline) {
			t.Fatalf("arrivée %s après l'heure demandée %s", j.Arrive, deadline)
		}
	}
	if _, err := p.PlanJourneys(JourneyQuery{From: Place{Lat: 48.8, Lon: 2.3}, To: to}); !errors.Is(err, ErrInvalid) {
		t.Fatal("un lieu hors d'Abidjan doit être refusé")
	}
}

func TestNextPassageRespectsServiceHours(t *testing.T) {
	p, _ := setup(t)
	l := p.lines["ln_m2"]
	late := time.Date(2026, 11, 3, 23, 30, 0, 0, abidjan)
	next, ok := l.NextPassage(0, 1, late)
	if !ok || next.Day() != 4 || next.Hour() != 5 || next.Minute() != 0 {
		t.Fatalf("après le dernier départ, le prochain est 05:00 le lendemain : %s", next)
	}
}

func TestPhonePaymentToken(t *testing.T) {
	p, clk := setup(t)
	tok, _, err := p.PayToken(awa(p))
	if err != nil {
		t.Fatal(err)
	}
	dev := device(p, "dev_201") // navette : payée au porte-monnaie
	v, _ := p.Validate(dev, TapRequest{TapID: "q1", PayToken: tok})
	if v.Status != ValAccepted || v.Channel != "phone" || v.CardUID != DemoAwa.CardUID {
		t.Fatalf("paiement par téléphone : %+v", v)
	}
	if v2, _ := p.Validate(device(p, "dev_202"), TapRequest{TapID: "q2", PayToken: tok}); v2.Reason != "replay" {
		t.Fatalf("un QR ne sert qu'une fois : %+v", v2)
	}
	tok2, _, _ := p.PayToken(awa(p))
	clk.Add(2 * time.Minute)
	if v3, _ := p.Validate(dev, TapRequest{TapID: "q3", PayToken: tok2}); v3.Reason != "token_expired" {
		t.Fatalf("QR expiré accepté : %+v", v3)
	}
	if v4, _ := p.Validate(dev, TapRequest{TapID: "q4", PayToken: tok2[:len(tok2)-2] + "00"}); v4.Reason != "bad_token" {
		t.Fatalf("QR falsifié accepté : %+v", v4)
	}
	assertBalanced(t, p)
}

func TestMeteredTaxi(t *testing.T) {
	p, _ := setup(t)
	taxi := device(p, "dev_601")
	if _, err := p.Validate(taxi, TapRequest{TapID: "t0", CardUID: DemoAwa.CardUID}); !errors.Is(err, ErrInvalid) {
		t.Fatal("un taxi compteur exige le montant de la course")
	}
	bal := awaBalance(p)
	ch, _, _ := p.IssueChallenge(taxi)
	proof, _ := p.SimulateCard(DemoAwa.CardUID, ch)
	v, _ := p.Validate(taxi, TapRequest{TapID: "t1", CardUID: DemoAwa.CardUID, Challenge: ch, Proof: proof, Amount: 1200})
	if v.Status != ValAccepted || v.Source != "wallet" || v.Debited != 1200 || awaBalance(p) != bal-1200 {
		t.Fatalf("course au compteur : %+v", v)
	}
	assertBalanced(t, p)
}

func TestDriverShift(t *testing.T) {
	p, _ := setup(t)
	if _, _, err := p.DriverLogin("01 01 01 01 01", "0000", "veh_101"); !errors.Is(err, ErrUnauthorized) {
		t.Fatal("mauvais PIN accepté")
	}
	if _, _, err := p.DriverLogin("01 01 01 01 01", DemoDriverPIN, "veh_201"); !errors.Is(err, ErrForbidden) {
		t.Fatal("un chauffeur ne prend pas le véhicule d'une autre compagnie")
	}
	tok, pr, err := p.DriverLogin("01 01 01 01 01", DemoDriverPIN, "veh_101")
	if err != nil {
		t.Fatal(err)
	}
	v := tap(t, p, pr, DemoAwa.CardUID, "s1")
	if v.DriverID != "drv_kone" {
		t.Fatalf("la montée doit être rattachée au chauffeur : %+v", v)
	}
	sv, _ := p.ShiftSummary(pr)
	if sv.Passengers != 1 || sv.Revenue != v.Debited || sv.Fare != 300 {
		t.Fatalf("bilan du service : %+v", sv)
	}
	if _, err := p.EndShift(pr, tok); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Authenticate(tok); err == nil {
		t.Fatal("la session doit se fermer en fin de service")
	}
}

func TestBudget(t *testing.T) {
	p, _ := setup(t)
	b, err := p.Budget(awa(p))
	if err != nil {
		t.Fatal(err)
	}
	if b.Budget != 15000 || b.LastMonth == 0 || len(b.Daily) != 30 || len(b.Advice) == 0 {
		t.Fatalf("budget d'Awa : %+v", b)
	}
	var sum int64
	for _, m := range b.ByMode {
		sum += m.Amount
	}
	if sum != b.Spent {
		t.Fatalf("répartition par mode (%d) ≠ total (%d)", sum, b.Spent)
	}
	if err := p.SetBudget(awa(p), -1); !errors.Is(err, ErrInvalid) {
		t.Fatal("budget négatif accepté")
	}
}

func TestFleetManagement(t *testing.T) {
	p, _ := setup(t)
	_, lagune, _ := p.StaffLogin("fleet@lagune.demo", DemoStaffPassword)
	_, admin, _ := p.StaffLogin("admin@metala.demo", DemoStaffPassword)
	v, err := p.AddVehicle(lagune, NewVehicle{Plate: "4521 LG 01", LineID: "ln_m2", ReservableSeats: 4})
	if err != nil || v.OperatorID != "op_lagune" || v.DeviceID == "" {
		t.Fatalf("ajout de véhicule : %+v %v", v, err)
	}
	if _, err := p.AddVehicle(lagune, NewVehicle{Plate: "4522 LG 01", LineID: "ln_n1"}); !errors.Is(err, ErrInvalid) {
		t.Fatal("une compagnie ne peut pas affecter un véhicule à la ligne d'une autre")
	}
	if _, err := p.AddVehicle(lagune, NewVehicle{OperatorID: "op_ebene", Plate: "4523 LG 01", LineID: "ln_n1"}); !errors.Is(err, ErrForbidden) {
		t.Fatal("isolation des opérateurs non respectée")
	}
	if _, err := p.AddDriver(lagune, NewDriver{Name: "Awa Test", Phone: "0102030405", PIN: "4321"}); err != nil {
		t.Fatal(err)
	}
	if _, err := p.AddOperator(lagune, NewOperator{Name: "X", Kind: OpTaxi}); !errors.Is(err, ErrForbidden) {
		t.Fatal("seul le super administrateur inscrit des opérateurs")
	}
	o, err := p.AddOperator(admin, NewOperator{Name: "Taxis Bleus (test)", Kind: OpTaxi, AdminEmail: "admin@taxisbleus.ci", Password: "motdepasse"})
	if err != nil {
		t.Fatal(err)
	}
	_, pr, err := p.StaffLogin("admin@taxisbleus.ci", "motdepasse")
	if err != nil || pr.OperatorID != o.ID || pr.Role != RoleOperatorAdmin {
		t.Fatalf("compte administrateur de la nouvelle compagnie : %+v %v", pr, err)
	}
	if _, err := p.AddVehicle(pr, NewVehicle{Plate: "1111 TB 01", Mode: ModeTaxi}); err != nil {
		t.Fatalf("taxi sans ligne : %v", err)
	}
}

func TestJourneysAreNotDominated(t *testing.T) {
	p, clk := setup(t)
	tr := p.travelers[awa(p).TravelerID]
	for _, q := range []JourneyQuery{
		{From: *tr.Home, To: Place{Lat: 5.4262, Lon: -4.0188}, At: clk.Now()},
		{From: *tr.Home, To: *tr.Work, At: clk.Now().Add(25 * time.Hour), ArriveBy: true},
	} {
		js, _ := p.PlanJourneys(q)
		for i, a := range js {
			for k, b := range js {
				if i != k && !b.Depart.Before(a.Depart) && !b.Arrive.After(a.Arrive) && b.WalkMinutes <= a.WalkMinutes && b.Transfers <= a.Transfers {
					t.Fatalf("trajet %d dominé par %d : %s→%s vs %s→%s", i, k, a.Depart, a.Arrive, b.Depart, b.Arrive)
				}
			}
		}
	}
}
