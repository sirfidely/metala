package platform

import (
	"fmt"
	"sort"
)

// Departures liste les prochains départs réservables d'une ligne.
func (p *Platform) Departures(lineID string) []Departure {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	out := []Departure{}
	for _, d := range p.departures {
		if (lineID == "" || d.LineID == lineID) && d.DepartAt.After(now.Add(-10*60e9)) {
			out = append(out, *d)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].DepartAt.Before(out[j].DepartAt) })
	return out
}

// Reserve réserve une place. La vérification et l'incrément sont faits sous
// le même verrou : deux demandes simultanées pour la dernière place
// n'aboutissent qu'une fois (test T-011). En production : SELECT … FOR UPDATE.
func (p *Platform) Reserve(pr Principal, departureID string) (*Reservation, error) {
	if pr.Role != RoleTraveler {
		return nil, ErrForbidden
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	d := p.departures[departureID]
	if d == nil {
		return nil, ErrNotFound
	}
	if !d.DepartAt.After(p.now()) {
		return nil, fmt.Errorf("%w : départ passé", ErrConflict)
	}
	for _, r := range p.reservations {
		if r.DepartureID == d.ID && r.TravelerID == pr.TravelerID && r.Status == "confirmed" {
			return nil, fmt.Errorf("%w : vous avez déjà une place sur ce départ", ErrConflict)
		}
	}
	if d.Reserved >= d.ReservableSeats {
		return nil, fmt.Errorf("%w : plus de place réservable", ErrConflict)
	}
	d.Reserved++
	r := &Reservation{ID: newID("rsv"), TravelerID: pr.TravelerID, DepartureID: d.ID,
		OperatorID: d.OperatorID, Status: "confirmed", CreatedAt: p.now()}
	p.reservations[r.ID] = r
	cp := *r
	return &cp, nil
}

func (p *Platform) CancelReservation(pr Principal, id string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	r := p.reservations[id]
	if r == nil || r.TravelerID != pr.TravelerID {
		return ErrNotFound
	}
	if r.Status != "confirmed" {
		return nil
	}
	r.Status = "cancelled"
	if d := p.departures[r.DepartureID]; d != nil && d.Reserved > 0 {
		d.Reserved--
	}
	return nil
}

// ReservationView enrichit une réservation avec son départ.
type ReservationView struct {
	Reservation
	Departure Departure `json:"departure"`
}

func (p *Platform) MyReservations(pr Principal) []ReservationView {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := []ReservationView{}
	for _, r := range p.reservations {
		if r.TravelerID == pr.TravelerID {
			rv := ReservationView{Reservation: *r}
			if d := p.departures[r.DepartureID]; d != nil {
				rv.Departure = *d
			}
			out = append(out, rv)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Departure.DepartAt.Before(out[j].Departure.DepartAt) })
	return out
}
