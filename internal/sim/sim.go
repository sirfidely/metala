// Package sim fournit les simulateurs de démonstration : télémétrie GPS des
// 10 véhicules du pilote et flux de montées de voyageurs fictifs. Toutes les
// données produites portent la source "simulator" et sont affichées comme
// telles dans les interfaces : aucune simulation n'est présentée comme du
// temps réel.
package sim

import (
	"context"
	"fmt"
	"log"
	"math/rand"
	"time"

	"github.com/sirfidely/metala/internal/platform"
)

type vehicleSim struct {
	v        platform.Vehicle
	line     *platform.Line
	dist     float64
	dir      int
	speedKmh float64
	nextPost time.Time
	dwell    time.Time
	// scénarios de dégradation GPS
	mode string // normal | intermittent | lost
}

// Run anime la flotte jusqu'à l'annulation du contexte.
func Run(ctx context.Context, p *platform.Platform, withRiders bool) {
	rng := rand.New(rand.NewSource(time.Now().UnixNano()))
	var sims []*vehicleSim
	for i, v := range p.Vehicles() {
		l, ok := p.LineByID(v.LineID)
		if !ok {
			continue
		}
		s := &vehicleSim{v: v, line: l, dir: 1, speedKmh: 16 + rng.Float64()*8, mode: "normal"}
		s.dist = l.Length() * float64(i%6) / 6
		if i%2 == 1 {
			s.dir = -1
		}
		switch v.ID {
		case "veh_104":
			s.mode = "intermittent" // coupures de 75 s : GPS « retardé »
		case "veh_204":
			s.mode = "lost" // plus de signal après 20 s : GPS « inconnu »
		}
		sims = append(sims, s)
	}
	start := time.Now()
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	riders := newRiders(p, rng)
	last := time.Now()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-tick.C:
			dt := now.Sub(last).Seconds()
			last = now
			for _, s := range sims {
				s.step(now, dt)
				if now.Before(s.nextPost) || !s.reporting(now, start) {
					continue
				}
				s.nextPost = now.Add(5 * time.Second) // cadence cible : 5 à 10 s
				pt, heading := s.line.PointAt(s.dist)
				speed := s.speedKmh
				if now.Before(s.dwell) {
					speed = 0
				}
				_ = p.IngestSimulated(s.v.ID, platform.TelemetryInput{
					Lat: pt[0], Lon: pt[1], SpeedKmh: speed, Heading: heading, Direction: s.dir, RecordedAt: now,
				})
			}
			if withRiders {
				riders.maybeTap(now)
			}
		}
	}
}

func (s *vehicleSim) step(now time.Time, dt float64) {
	if now.Before(s.dwell) {
		return
	}
	s.dist += float64(s.dir) * s.speedKmh / 3.6 * dt
	if s.dist >= s.line.Length() {
		s.dist, s.dir, s.dwell = s.line.Length(), -1, now.Add(30*time.Second)
	} else if s.dist <= 0 {
		s.dist, s.dir, s.dwell = 0, 1, now.Add(30*time.Second)
	}
}

func (s *vehicleSim) reporting(now, start time.Time) bool {
	switch s.mode {
	case "intermittent":
		return int(now.Sub(start).Seconds())%240 < 165
	case "lost":
		return now.Sub(start) < 20*time.Second
	}
	return true
}

// riders simule des voyageurs fictifs qui montent à bord avec un Pass,
// en rejouant le protocole complet (challenge, preuve, validation serveur).
type riders struct {
	p    *platform.Platform
	rng  *rand.Rand
	pool []rider
	next time.Time
	devs []platform.DevDevice
}

type rider struct {
	pr       platform.Principal
	uid      string
	operator string
	product  string
}

func newRiders(p *platform.Platform, rng *rand.Rand) *riders {
	r := &riders{p: p, rng: rng}
	r.devs, _ = p.DevInventory()
	for i := 0; i < 16; i++ {
		phone := fmt.Sprintf("+22501%08d", 10000+i)
		_, code, err := p.RequestOTP(phone)
		if err != nil {
			continue
		}
		_, t, err := p.VerifyOTP(phone, code, fmt.Sprintf("Voyageur simulé %02d", i+1))
		if err != nil {
			continue
		}
		pr := platform.Principal{Role: platform.RoleTraveler, TravelerID: t.ID}
		me, _ := p.Me(pr)
		op, prod := "op_lagune", "prd_lag_c10"
		if i%3 == 0 {
			op, prod = "op_ebene", "prd_ebe_c10"
		}
		rd := rider{pr: pr, uid: me.Cards[0].UID, operator: op, product: prod}
		r.refill(rd)
		r.pool = append(r.pool, rd)
	}
	return r
}

func (r *riders) maybeTap(now time.Time) {
	if now.Before(r.next) || len(r.pool) == 0 {
		return
	}
	r.next = now.Add(time.Duration(6+r.rng.Intn(10)) * time.Second)
	rd := r.pool[r.rng.Intn(len(r.pool))]
	var candidates []platform.DevDevice
	for _, d := range r.devs {
		if d.OperatorID == rd.operator {
			candidates = append(candidates, d)
		}
	}
	if len(candidates) == 0 {
		return
	}
	d := candidates[r.rng.Intn(len(candidates))]
	dev := platform.Principal{Role: platform.RoleDevice, DeviceID: d.ID, OperatorID: d.OperatorID}
	v, err := r.p.SimulatedTap(dev, rd.uid)
	if err != nil {
		return // terminal gelé, par exemple
	}
	if v.Status == platform.ValRejected && v.Reason == "no_title" {
		r.refill(rd) // rechargement automatique, via le PSP simulé
	}
}

func (r *riders) refill(rd rider) {
	pay, err := r.p.CreatePurchase(rd.pr, rd.product)
	if err != nil {
		return
	}
	if _, err := r.p.SimulatePSP(pay.ID, "succeeded", false); err != nil {
		log.Printf("sim: PSP: %v", err)
	}
}
