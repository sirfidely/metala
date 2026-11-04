package platform

import (
	"fmt"
	"math"
	"sort"
	"time"
)

// Budget transport du voyageur : ce qu'il dépense réellement pour se
// déplacer (trajets consommés, quel que soit le mode de paiement), et non
// ce qu'il recharge. Un forfait compte à son achat.

type ModeSpend struct {
	Mode   Mode  `json:"mode"`
	Amount int64 `json:"amount"`
	Trips  int   `json:"trips"`
}

type DaySpend struct {
	Date   string `json:"date"` // AAAA-MM-JJ
	Amount int64  `json:"amount"`
	Trips  int    `json:"trips"`
}

type Advice struct {
	Title  string `json:"title"`
	Detail string `json:"detail"`
	Saving int64  `json:"saving"`
}

type BudgetView struct {
	Month       string      `json:"month"` // AAAA-MM
	Budget      int64       `json:"budget"`
	Spent       int64       `json:"spent"`
	Projected   int64       `json:"projected"`
	Trips       int         `json:"trips"`
	LastMonth   int64       `json:"last_month"`
	DayOfMonth  int         `json:"day_of_month"`
	DaysInMonth int         `json:"days_in_month"`
	ByMode      []ModeSpend `json:"by_mode"`
	Daily       []DaySpend  `json:"daily"` // 30 derniers jours
	Advice      []Advice    `json:"advice"`
}

type spendItem struct {
	at     time.Time
	amount int64
	mode   Mode
	op     string
	trip   bool
}

func (p *Platform) spendItemsLocked(travelerID string) []spendItem {
	var out []spendItem
	for _, v := range p.validations {
		if v.TravelerID != travelerID || v.Status != ValAccepted {
			continue
		}
		mode := ModeBus
		if l := p.lines[v.LineID]; l != nil {
			mode = l.Mode
		}
		out = append(out, spendItem{at: v.At, amount: v.Debited, mode: mode, op: v.OperatorID, trip: true})
	}
	for _, pay := range p.payments {
		prod := p.products[pay.ProductID]
		if pay.TravelerID != travelerID || pay.Status != PaymentSucceeded || prod == nil || prod.Kind != ProductMonthly {
			continue
		}
		mode := ModeBus
		for _, l := range p.lines {
			if l.OperatorID == prod.OperatorID {
				mode = l.Mode
				break
			}
		}
		out = append(out, spendItem{at: pay.CreatedAt, amount: pay.Amount, mode: mode, op: prod.OperatorID})
	}
	return out
}

func (p *Platform) Budget(pr Principal) (*BudgetView, error) {
	if pr.Role != RoleTraveler {
		return nil, ErrForbidden
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	t := p.travelers[pr.TravelerID]
	if t == nil {
		return nil, ErrNotFound
	}
	now := p.now().In(abidjan)
	monthStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, abidjan)
	prevStart := monthStart.AddDate(0, -1, 0)
	daysIn := monthStart.AddDate(0, 1, -1).Day()
	v := &BudgetView{Month: now.Format("2006-01"), Budget: t.Budget, DayOfMonth: now.Day(), DaysInMonth: daysIn,
		ByMode: []ModeSpend{}, Daily: []DaySpend{}, Advice: []Advice{}}

	items := p.spendItemsLocked(t.ID)
	byMode := map[Mode]*ModeSpend{}
	daily := map[string]*DaySpend{}
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, abidjan)
	for i := 29; i >= 0; i-- {
		d := today.AddDate(0, 0, -i).Format("2006-01-02")
		ds := &DaySpend{Date: d}
		daily[d] = ds
		v.Daily = append(v.Daily, DaySpend{Date: d})
	}
	last30 := map[string]struct {
		trips int
		cost  int64
	}{}
	for _, it := range items {
		at := it.at.In(abidjan)
		switch {
		case !at.Before(monthStart):
			v.Spent += it.amount
			if it.trip {
				v.Trips++
			}
			ms := byMode[it.mode]
			if ms == nil {
				ms = &ModeSpend{Mode: it.mode}
				byMode[it.mode] = ms
			}
			ms.Amount += it.amount
			if it.trip {
				ms.Trips++
			}
		case !at.Before(prevStart):
			v.LastMonth += it.amount
		}
		if ds := daily[at.Format("2006-01-02")]; ds != nil {
			ds.Amount += it.amount
			if it.trip {
				ds.Trips++
			}
		}
		if it.trip && now.Sub(at) <= 30*24*time.Hour {
			x := last30[it.op]
			x.trips++
			x.cost += it.amount
			last30[it.op] = x
		}
	}
	for i := range v.Daily {
		v.Daily[i] = *daily[v.Daily[i].Date]
	}
	for _, ms := range byMode {
		v.ByMode = append(v.ByMode, *ms)
	}
	sort.Slice(v.ByMode, func(i, j int) bool { return v.ByMode[i].Amount > v.ByMode[j].Amount })
	if now.Day() >= 3 {
		v.Projected = int64(math.Round(float64(v.Spent) / float64(now.Day()) * float64(daysIn)))
	} else {
		v.Projected = v.LastMonth
	}

	// Conseils : comparer ce que le voyageur a payé sur 30 jours aux offres.
	for _, op := range sortedKeys(last30) {
		use := last30[op]
		opName := p.operators[op].Name
		var monthly, single *Product
		for _, pr := range p.products {
			if pr.OperatorID != op {
				continue
			}
			if pr.Kind == ProductMonthly {
				monthly = pr
			}
			if pr.Kind == ProductSingle {
				single = pr
			}
		}
		if monthly != nil && use.cost > monthly.Price {
			v.Advice = append(v.Advice, Advice{
				Title:  fmt.Sprintf("%s : passez au forfait", monthly.Name),
				Detail: fmt.Sprintf("%d trajets en 30 jours avec %s ont coûté %d FCFA ; le forfait coûte %d FCFA.", use.trips, opName, use.cost, monthly.Price),
				Saving: use.cost - monthly.Price,
			})
		} else if single != nil && use.trips >= 8 && use.cost >= int64(use.trips)*single.Price {
			for _, pr := range p.products {
				if pr.OperatorID == op && pr.Kind == ProductCarnet {
					per := pr.Price / int64(pr.Trips)
					if per < single.Price {
						v.Advice = append(v.Advice, Advice{
							Title:  fmt.Sprintf("%s : prenez un carnet", opName),
							Detail: fmt.Sprintf("%s : %d FCFA le trajet au lieu de %d FCFA.", pr.Name, per, single.Price),
							Saving: int64(use.trips) * (single.Price - per),
						})
						break
					}
				}
			}
		}
	}
	sort.Slice(v.Advice, func(i, j int) bool { return v.Advice[i].Saving > v.Advice[j].Saving })
	return v, nil
}

func (p *Platform) SetBudget(pr Principal, amount int64) error {
	if pr.Role != RoleTraveler {
		return ErrForbidden
	}
	if amount < 0 || amount > 500000 {
		return fmt.Errorf("%w : budget invalide", ErrInvalid)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	t := p.travelers[pr.TravelerID]
	if t == nil {
		return ErrNotFound
	}
	t.Budget = amount
	return nil
}
