package platform

import (
	"sort"
	"time"
)

// LineStats agrège la fréquentation d'une ligne.
type LineStats struct {
	LineID      string `json:"line_id"`
	LineCode    string `json:"line_code"`
	Validations int    `json:"validations"`
	Rejections  int    `json:"rejections"`
}

// Dashboard est la vue de pilotage Metala Fleet.
type Dashboard struct {
	OperatorID       string      `json:"operator_id"`
	VehiclesTotal    int         `json:"vehicles_total"`
	VehiclesFresh    int         `json:"vehicles_fresh"`
	VehiclesDelayed  int         `json:"vehicles_delayed"`
	VehiclesUnknown  int         `json:"vehicles_unknown"`
	ValidationsToday int         `json:"validations_today"`
	RejectionsToday  int         `json:"rejections_today"`
	SalesToday       int64       `json:"sales_today"`      // FCFA encaissés
	RevenueToday     int64       `json:"revenue_today"`    // recette transporteur reconnue
	CommissionToday  int64       `json:"commission_today"` // part Metala
	ReservationsOpen int         `json:"reservations_open"`
	Lines            []LineStats `json:"lines"`
}

func startOfDay(t time.Time) time.Time {
	y, m, d := t.Date()
	return time.Date(y, m, d, 0, 0, 0, 0, t.Location())
}

func (p *Platform) Dashboard(pr Principal, requested string) (*Dashboard, error) {
	op, err := resolveOperatorScope(pr, requested)
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	in := func(id string) bool { return op == "" || id == op }
	day := startOfDay(p.now())
	db := &Dashboard{OperatorID: op, Lines: []LineStats{}}
	for _, v := range p.vehicles {
		if !in(v.OperatorID) {
			continue
		}
		db.VehiclesTotal++
		switch fr, _ := p.freshnessLocked(p.telemetry[v.ID]); fr {
		case FreshnessFresh:
			db.VehiclesFresh++
		case FreshnessDelayed:
			db.VehiclesDelayed++
		default:
			db.VehiclesUnknown++
		}
	}
	lines := map[string]*LineStats{}
	for _, l := range p.lines {
		if in(l.OperatorID) {
			lines[l.ID] = &LineStats{LineID: l.ID, LineCode: l.Code}
		}
	}
	for _, v := range p.validations {
		if !in(v.OperatorID) || v.At.Before(day) {
			continue
		}
		ls := lines[v.LineID]
		switch v.Status {
		case ValAccepted:
			db.ValidationsToday++
			if ls != nil {
				ls.Validations++
			}
		case ValRejected:
			db.RejectionsToday++
			if ls != nil {
				ls.Rejections++
			}
		}
	}
	for _, e := range p.ledger {
		if !in(e.OperatorID) || e.At.Before(day) {
			continue
		}
		for _, l := range e.Lines {
			switch l.Account {
			case AccPSPClearing:
				db.SalesToday += l.Debit
			case AccOperatorRevenue:
				db.RevenueToday += l.Credit
			case AccMetalaCommission:
				db.CommissionToday += l.Credit
			}
		}
	}
	for _, r := range p.reservations {
		if in(r.OperatorID) && r.Status == "confirmed" {
			db.ReservationsOpen++
		}
	}
	for _, ls := range lines {
		db.Lines = append(db.Lines, *ls)
	}
	sort.Slice(db.Lines, func(i, j int) bool { return db.Lines[i].LineCode < db.Lines[j].LineCode })
	return db, nil
}

// FleetVehicles renvoie flotte + terminaux de l'opérateur.
type FleetVehicle struct {
	VehicleState
	DeviceID string `json:"device_id"`
}

func (p *Platform) FleetVehicles(pr Principal, requested string) ([]FleetVehicle, error) {
	op, err := resolveOperatorScope(pr, requested)
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	out := []FleetVehicle{}
	for _, v := range p.vehicles {
		if op != "" && v.OperatorID != op {
			continue
		}
		fv := FleetVehicle{VehicleState: p.stateLocked(v)}
		for _, d := range p.devices {
			if d.VehicleID == v.ID {
				fv.DeviceID = d.ID
			}
		}
		out = append(out, fv)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].VehicleID < out[j].VehicleID })
	return out, nil
}

func (p *Platform) FleetValidations(pr Principal, requested string, limit int) ([]Validation, error) {
	op, err := resolveOperatorScope(pr, requested)
	if err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	out := []Validation{}
	for i := len(p.validations) - 1; i >= 0 && len(out) < limit; i-- {
		v := p.validations[i]
		if op == "" || v.OperatorID == op {
			cp := *v
			cp.TravelerID = "" // minimisation : l'opérateur ne voit pas l'identité voyageur
			out = append(out, cp)
		}
	}
	return out, nil
}

// Reconciliation rapproche rapport PSP, titres, validations et grand livre.
type Reconciliation struct {
	OperatorID string `json:"operator_id"`
	// Côté PSP
	PSPSucceededCount int   `json:"psp_succeeded_count"`
	PSPSucceededTotal int64 `json:"psp_succeeded_total"`
	// Côté grand livre
	LedgerSalesCount int   `json:"ledger_sales_count"`
	LedgerSalesTotal int64 `json:"ledger_sales_total"`
	TitlesIssued     int   `json:"titles_issued"`
	// Consommation
	DebitingValidations int   `json:"debiting_validations"`
	LedgerUsageCount    int   `json:"ledger_usage_count"`
	LedgerUsageTotal    int64 `json:"ledger_usage_total"`
	// Soldes
	LiabilityBalance     int64 `json:"liability_balance"`      // grand livre
	TitlesValueRemaining int64 `json:"titles_value_remaining"` // registre des titres
	OperatorRevenue      int64 `json:"operator_revenue"`
	MetalaCommission     int64 `json:"metala_commission"`
	// Porte-monnaie (vue globale uniquement pour les soldes des cartes)
	WalletLoads         int   `json:"wallet_loads"`
	WalletLedger        int64 `json:"wallet_ledger"`         // solde net du compte porte-monnaie (périmètre)
	WalletCards         int64 `json:"wallet_cards"`          // somme des soldes des puces
	OfflinePending      int64 `json:"offline_pending"`       // débits hors ligne non remontés
	OfflinePendingCount int   `json:"offline_pending_count"` // nombre de ces débits
	OfflineSynced       int   `json:"offline_synced"`
	// Écarts (doivent être nuls)
	Discrepancies []string `json:"discrepancies"`
	Balanced      bool     `json:"balanced"`
}

func (p *Platform) Reconcile(pr Principal, requested string) (*Reconciliation, error) {
	op, err := resolveOperatorScope(pr, requested)
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.reconcileLocked(op), nil
}

func (p *Platform) reconcileLocked(op string) *Reconciliation {
	in := func(id string) bool { return op == "" || id == op }
	r := &Reconciliation{OperatorID: op, Discrepancies: []string{}}
	for _, pay := range p.payments {
		if in(pay.OperatorID) && pay.Status == PaymentSucceeded {
			r.PSPSucceededCount++
			r.PSPSucceededTotal += pay.Amount
			if prod := p.products[pay.ProductID]; prod != nil && prod.Kind == ProductWallet {
				r.WalletLoads++
			}
		}
	}
	for _, t := range p.titles {
		if in(t.OperatorID) {
			r.TitlesIssued++
			r.TitlesValueRemaining += t.ValueRemaining
		}
	}
	for _, v := range p.validations {
		if in(v.OperatorID) && v.Status == ValAccepted && v.Debited > 0 {
			r.DebitingValidations++
			if v.Offline {
				r.OfflineSynced++
			}
		}
	}
	for _, c := range p.cards {
		r.WalletCards += c.Balance
		for _, a := range c.pendingOffline {
			r.OfflinePending += a
			r.OfflinePendingCount++
		}
	}
	for _, e := range p.ledger {
		if !in(e.OperatorID) {
			continue
		}
		switch e.Kind {
		case "sale", "wallet_load":
			r.LedgerSalesCount++
		case "usage":
			r.LedgerUsageCount++
		}
		for _, l := range e.Lines {
			switch l.Account {
			case AccPSPClearing:
				r.LedgerSalesTotal += l.Debit - l.Credit
			case AccTitleLiability:
				r.LiabilityBalance += l.Credit - l.Debit
				if e.Kind == "usage" {
					r.LedgerUsageTotal += l.Debit
				}
			case AccWalletLiability:
				r.WalletLedger += l.Credit - l.Debit
				if e.Kind == "usage" {
					r.LedgerUsageTotal += l.Debit
				}
			case AccOperatorRevenue:
				r.OperatorRevenue += l.Credit - l.Debit
			case AccMetalaCommission:
				r.MetalaCommission += l.Credit - l.Debit
			}
		}
	}
	if r.PSPSucceededCount != r.LedgerSalesCount || r.PSPSucceededTotal != r.LedgerSalesTotal {
		r.Discrepancies = append(r.Discrepancies, "ventes PSP ≠ ventes au grand livre")
	}
	if r.PSPSucceededCount != r.TitlesIssued+r.WalletLoads {
		r.Discrepancies = append(r.Discrepancies, "paiements réussis ≠ titres émis + recharges")
	}
	if r.DebitingValidations != r.LedgerUsageCount {
		r.Discrepancies = append(r.Discrepancies, "validations débitrices ≠ écritures de consommation")
	}
	if r.LiabilityBalance != r.TitlesValueRemaining {
		r.Discrepancies = append(r.Discrepancies, "solde des titres au grand livre ≠ registre des titres")
	}
	if op == "" && r.WalletLedger != r.WalletCards+r.OfflinePending {
		r.Discrepancies = append(r.Discrepancies, "porte-monnaie au grand livre ≠ soldes des cartes + débits hors ligne en attente")
	}
	if r.LedgerSalesTotal != r.LiabilityBalance+r.WalletLedger+r.OperatorRevenue+r.MetalaCommission {
		r.Discrepancies = append(r.Discrepancies, "grand livre déséquilibré")
	}
	r.Balanced = len(r.Discrepancies) == 0
	return r
}

// DevInventory expose terminaux et cartes au simulateur (mode dev).
type DevDevice struct {
	Device
	Secret   string `json:"secret"`
	LineCode string `json:"line_code"`
	Plate    string `json:"plate"`
	Mode     Mode   `json:"mode"`
}

type DevCard struct {
	Card
	Holder string `json:"holder"`
	Phone  string `json:"phone"`
}

func (p *Platform) DevInventory() ([]DevDevice, []DevCard) {
	p.mu.Lock()
	defer p.mu.Unlock()
	devs := []DevDevice{}
	for _, d := range p.devices {
		dd := DevDevice{Device: *d, Secret: d.token}
		if v := p.vehicles[d.VehicleID]; v != nil {
			dd.Plate, dd.Mode = v.Plate, v.Mode
			if l := p.lines[v.LineID]; l != nil {
				dd.LineCode = l.Code
			}
		}
		devs = append(devs, dd)
	}
	sort.Slice(devs, func(i, j int) bool { return devs[i].ID < devs[j].ID })
	cards := []DevCard{}
	for _, c := range p.cards {
		dc := DevCard{Card: *c}
		if t := p.travelers[c.TravelerID]; t != nil {
			dc.Holder, dc.Phone = t.Name, t.Phone
		}
		cards = append(cards, dc)
	}
	sort.Slice(cards, func(i, j int) bool { return cards[i].IssuedAt.Before(cards[j].IssuedAt) })
	return devs, cards
}

// PaymentByID est utilisé par le simulateur PSP.
func (p *Platform) PaymentByID(id string) (*Payment, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	pay, ok := p.payments[id]
	if !ok {
		return nil, false
	}
	cp := *pay
	return &cp, true
}
