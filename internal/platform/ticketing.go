package platform

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"time"
)

func (p *Platform) Products(operatorID string) []Product {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := []Product{}
	for _, pr := range p.products {
		if operatorID == "" || pr.OperatorID == operatorID {
			out = append(out, *pr)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].OperatorID != out[j].OperatorID {
			return out[i].OperatorID < out[j].OperatorID
		}
		return out[i].Price < out[j].Price
	})
	return out
}

// CreatePurchase ouvre un paiement en attente chez le PSP habilité (via
// GeniusPay). Aucun titre n'est émis tant que le webhook n'a pas confirmé.
func (p *Platform) CreatePurchase(pr Principal, productID string) (*Payment, error) {
	if pr.Role != RoleTraveler {
		return nil, ErrForbidden
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	prod := p.products[productID]
	if prod == nil {
		return nil, ErrNotFound
	}
	pay := &Payment{
		ID: newID("pay"), TravelerID: pr.TravelerID, ProductID: prod.ID, OperatorID: prod.OperatorID,
		Amount: prod.Price, Status: PaymentPending, PSPRef: "PSP-" + randHex(6), CreatedAt: p.now(),
	}
	p.payments[pay.ID] = pay
	p.paymentByPSP[pay.PSPRef] = pay.ID
	cp := *pay
	return &cp, nil
}

// PSPEvent est la charge utile du webhook PSP.
type PSPEvent struct {
	EventID string `json:"event_id"`
	PSPRef  string `json:"psp_ref"`
	Status  string `json:"status"` // succeeded | failed
	Amount  int64  `json:"amount"`
}

// SignWebhook calcule la signature HMAC-SHA256 d'un corps de webhook.
func SignWebhook(secret, body []byte) string {
	m := hmac.New(sha256.New, secret)
	m.Write(body)
	return hex.EncodeToString(m.Sum(nil))
}

// HandlePSPWebhook vérifie la signature puis applique l'événement de façon
// idempotente : un webhook doublé n'émet qu'un seul titre (test T-009).
func (p *Platform) HandlePSPWebhook(body []byte, signature string) (*Payment, error) {
	want := SignWebhook(p.cfg.PSPWebhookSecret, body)
	if !hmac.Equal([]byte(want), []byte(signature)) {
		return nil, fmt.Errorf("%w : signature webhook invalide", ErrUnauthorized)
	}
	var ev PSPEvent
	if err := json.Unmarshal(body, &ev); err != nil || ev.EventID == "" || ev.PSPRef == "" {
		return nil, fmt.Errorf("%w : événement PSP mal formé", ErrInvalid)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	payID, ok := p.paymentByPSP[ev.PSPRef]
	if !ok {
		return nil, ErrNotFound
	}
	pay := p.payments[payID]
	if p.webhookEvents[ev.EventID] || pay.Status != PaymentPending {
		cp := *pay // rejeu ou doublon : aucun effet
		return &cp, nil
	}
	p.webhookEvents[ev.EventID] = true
	switch ev.Status {
	case "succeeded":
		if ev.Amount != pay.Amount {
			pay.Status = PaymentFailed
			cp := *pay
			return &cp, fmt.Errorf("%w : montant PSP (%d) ≠ montant attendu (%d)", ErrConflict, ev.Amount, pay.Amount)
		}
		now := p.now()
		pay.Status = PaymentSucceeded
		pay.SettledAt = &now
		t := p.issueTitleLocked(pay)
		pay.TitleID = t.ID
	case "failed":
		pay.Status = PaymentFailed
	default:
		return nil, fmt.Errorf("%w : statut PSP inconnu", ErrInvalid)
	}
	cp := *pay
	return &cp, nil
}

func (p *Platform) issueTitleLocked(pay *Payment) *Title {
	prod := p.products[pay.ProductID]
	now := p.now()
	t := &Title{
		ID: newID("ttl"), TravelerID: pay.TravelerID, ProductID: prod.ID, OperatorID: prod.OperatorID,
		Name: prod.Name, Kind: prod.Kind, TripsTotal: prod.Trips, TripsRemaining: prod.Trips,
		Price: prod.Price, ValueRemaining: prod.Price, ValidFrom: now,
		ValidUntil: now.Add(time.Duration(prod.ValidityDays) * 24 * time.Hour), PaymentID: pay.ID,
	}
	p.titles[t.ID] = t
	op := p.operators[prod.OperatorID]
	if prod.Kind == ProductMonthly {
		// Simplification prototype : le forfait est reconnu à la vente.
		commission := int64(math.Round(float64(prod.Price) * op.CommissionRate))
		t.ValueRemaining = 0
		p.postLocked("sale", prod.OperatorID, pay.ID,
			LedgerLine{Account: AccPSPClearing, Debit: prod.Price},
			LedgerLine{Account: AccOperatorRevenue, Credit: prod.Price - commission},
			LedgerLine{Account: AccMetalaCommission, Credit: commission})
	} else {
		p.postLocked("sale", prod.OperatorID, pay.ID,
			LedgerLine{Account: AccPSPClearing, Debit: prod.Price},
			LedgerLine{Account: AccTitleLiability, Credit: prod.Price})
	}
	return t
}

// postLocked inscrit une écriture équilibrée au grand livre (append-only).
func (p *Platform) postLocked(kind, operatorID, ref string, lines ...LedgerLine) {
	var d, c int64
	for _, l := range lines {
		d += l.Debit
		c += l.Credit
	}
	if d != c {
		panic(fmt.Sprintf("écriture déséquilibrée %s/%s : %d ≠ %d", kind, ref, d, c))
	}
	p.ledger = append(p.ledger, &LedgerEntry{
		ID: newID("led"), At: p.now(), Kind: kind, OperatorID: operatorID, Ref: ref, Lines: lines,
	})
}

// TravelerView regroupe le compte voyageur.
type TravelerView struct {
	Traveler Traveler `json:"traveler"`
	Cards    []Card   `json:"cards"`
	Titles   []Title  `json:"titles"`
}

func (p *Platform) Me(pr Principal) (*TravelerView, error) {
	if pr.Role != RoleTraveler {
		return nil, ErrForbidden
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	t := p.travelers[pr.TravelerID]
	if t == nil {
		return nil, ErrNotFound
	}
	v := &TravelerView{Traveler: *t, Cards: []Card{}, Titles: []Title{}}
	for _, c := range p.cards {
		if c.TravelerID == t.ID {
			v.Cards = append(v.Cards, *c)
		}
	}
	for _, ti := range p.titles {
		if ti.TravelerID == t.ID {
			v.Titles = append(v.Titles, *ti)
		}
	}
	sort.Slice(v.Titles, func(i, j int) bool { return v.Titles[i].ValidFrom.After(v.Titles[j].ValidFrom) })
	return v, nil
}

// HistoryItem est une ligne de l'historique voyageur.
type HistoryItem struct {
	At     time.Time `json:"at"`
	Kind   string    `json:"kind"` // purchase | validation
	Label  string    `json:"label"`
	Detail string    `json:"detail"`
	Amount int64     `json:"amount,omitempty"`
	Status string    `json:"status"`
}

func (p *Platform) History(pr Principal) ([]HistoryItem, error) {
	if pr.Role != RoleTraveler {
		return nil, ErrForbidden
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	out := []HistoryItem{}
	for _, pay := range p.payments {
		if pay.TravelerID != pr.TravelerID {
			continue
		}
		name := pay.ProductID
		if prod := p.products[pay.ProductID]; prod != nil {
			name = prod.Name
		}
		out = append(out, HistoryItem{At: pay.CreatedAt, Kind: "purchase", Label: "Achat · " + name,
			Detail: p.operators[pay.OperatorID].Name, Amount: pay.Amount, Status: string(pay.Status)})
	}
	for _, v := range p.validations {
		if v.TravelerID != pr.TravelerID {
			continue
		}
		label := "Montée"
		if l := p.lines[v.LineID]; l != nil {
			label = "Montée · ligne " + l.Code
		}
		out = append(out, HistoryItem{At: v.At, Kind: "validation", Label: label, Detail: v.Message, Status: string(v.Status)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].At.After(out[j].At) })
	return out, nil
}
