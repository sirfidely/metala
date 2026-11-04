package platform

import (
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Calcul d'itinéraires porte-à-porte : le voyageur part de n'importe quel
// lieu (domicile, travail, repère), marche jusqu'à un arrêt, emprunte une ou
// deux lignes de n'importe quel mode, puis marche jusqu'à destination.
// Les horaires sont théoriques (offre de service des opérateurs) et
// remplacés par la position en direct du véhicule quand elle est connue.

const (
	walkKmh        = 4.5
	walkDetour     = 1.3  // les rues ne sont pas en ligne droite
	maxAccessM     = 1500 // marche maximale vers ou depuis un arrêt
	maxTransferM   = 900  // marche maximale pour une correspondance
	directWalkM    = 1500 // en dessous, on propose aussi d'y aller à pied
	transferBuffer = 2    // minutes de marge en correspondance
	liveWindow     = 45   // minutes : au-delà, on ne cherche pas de véhicule en direct
)

// Abidjan vit à l'heure UTC (GMT, sans heure d'été).
var abidjan = time.UTC

func walkMinutes(m float64) float64 { return m * walkDetour / 1000 / walkKmh * 60 }

func placeDist(a, b Place) float64 { return haversine(LatLon{a.Lat, a.Lon}, LatLon{b.Lat, b.Lon}) }

func parseHM(s string) int {
	parts := strings.SplitN(s, ":", 2)
	if len(parts) != 2 {
		return 0
	}
	h, _ := strconv.Atoi(parts[0])
	m, _ := strconv.Atoi(parts[1])
	return h*60 + m
}

func (l *Line) stopIndex(id string) int {
	for i, s := range l.StopIDs {
		if s == id {
			return i
		}
	}
	return -1
}

// offsetMin : minutes entre le départ du terminus et le passage à l'arrêt.
func (l *Line) offsetMin(stopIdx, dir int) float64 {
	if dir >= 0 {
		return l.StopMinutes[stopIdx]
	}
	return l.StopMinutes[len(l.StopIDs)-1] - l.StopMinutes[stopIdx]
}

// NextPassage renvoie le premier passage théorique à l'arrêt après `after`.
func (l *Line) NextPassage(stopIdx, dir int, after time.Time) (time.Time, bool) {
	if l.HeadwayMin <= 0 {
		return time.Time{}, false
	}
	off := l.offsetMin(stopIdx, dir)
	first, last := parseHM(l.FirstDep), parseHM(l.LastDep)
	after = after.In(abidjan)
	day := time.Date(after.Year(), after.Month(), after.Day(), 0, 0, 0, 0, abidjan)
	for d := 0; d < 3; d++ {
		base := day.AddDate(0, 0, d)
		since := after.Sub(base).Minutes() - off - float64(first)
		k := 0
		if since > 0 {
			k = int(math.Ceil(since / float64(l.HeadwayMin)))
		}
		dep := first + k*l.HeadwayMin
		if dep <= last {
			t := base.Add(time.Duration(float64(dep)+off) * time.Minute)
			if !t.Before(after) {
				return t, true
			}
			if dep+l.HeadwayMin <= last {
				return base.Add(time.Duration(float64(dep+l.HeadwayMin)+off) * time.Minute), true
			}
		}
	}
	return time.Time{}, false
}

// subShape renvoie le morceau de tracé entre deux abscisses curvilignes.
func (l *Line) subShape(d1, d2 float64) []LatLon {
	rev := d1 > d2
	if rev {
		d1, d2 = d2, d1
	}
	a, _ := l.PointAt(d1)
	out := []LatLon{a}
	for i, d := range l.shapeDist {
		if d > d1 && d < d2 {
			out = append(out, l.Shape[i])
		}
	}
	b, _ := l.PointAt(d2)
	out = append(out, b)
	if rev {
		for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
			out[i], out[j] = out[j], out[i]
		}
	}
	return out
}

// LiveInfo : le véhicule réellement attendu pour ce trajet.
type LiveInfo struct {
	VehicleID  string    `json:"vehicle_id"`
	ETAMinutes int       `json:"eta_minutes"`
	Freshness  Freshness `json:"freshness"`
	AgeSeconds int       `json:"age_seconds"`
	Source     string    `json:"source"`
}

type Leg struct {
	Kind       string    `json:"kind"` // walk | ride
	From       Place     `json:"from"`
	To         Place     `json:"to"`
	Depart     time.Time `json:"depart"`
	Arrive     time.Time `json:"arrive"`
	Minutes    int       `json:"minutes"`
	Meters     int       `json:"meters"`
	LineID     string    `json:"line_id,omitempty"`
	LineCode   string    `json:"line_code,omitempty"`
	Mode       Mode      `json:"mode,omitempty"`
	Color      string    `json:"color,omitempty"`
	OperatorID string    `json:"operator_id,omitempty"`
	Direction  int       `json:"direction,omitempty"`
	Headsign   string    `json:"headsign,omitempty"`
	Stops      int       `json:"stops,omitempty"`
	Fare       int64     `json:"fare,omitempty"`
	Reservable bool      `json:"reservable,omitempty"`
	Live       *LiveInfo `json:"live,omitempty"`
	Shape      []LatLon  `json:"shape"`
}

type Journey struct {
	ID          string    `json:"id"`
	Depart      time.Time `json:"depart"` // heure à laquelle quitter le lieu de départ
	Arrive      time.Time `json:"arrive"`
	Minutes     int       `json:"minutes"`
	WalkMinutes int       `json:"walk_minutes"`
	Transfers   int       `json:"transfers"`
	Fare        int64     `json:"fare"`
	Modes       []Mode    `json:"modes"`
	Live        bool      `json:"live"`
	Legs        []Leg     `json:"legs"`
}

type JourneyQuery struct {
	From     Place     `json:"from"`
	To       Place     `json:"to"`
	At       time.Time `json:"at"`
	ArriveBy bool      `json:"arrive_by"`
}

// segment = un tronçon en véhicule : ligne, arrêt de montée, arrêt de descente.
type segment struct {
	line       *Line
	board, off int
	dir        int
}

type access struct {
	stop    *Stop
	meters  float64
	minutes float64
}

func (p *Platform) stopPlace(s *Stop) Place {
	return Place{ID: s.ID, Name: s.Name, Kind: "stop", Lat: s.Lat, Lon: s.Lon}
}

func (p *Platform) accessStopsLocked(pl Place) map[string]access {
	out := map[string]access{}
	for _, s := range p.stops {
		d := placeDist(pl, p.stopPlace(s))
		if d <= maxAccessM {
			out[s.ID] = access{stop: s, meters: d, minutes: walkMinutes(d)}
		}
	}
	return out
}

// PlanJourneys calcule jusqu'à 4 trajets, du plus rapide au plus lent.
func (p *Platform) PlanJourneys(q JourneyQuery) ([]Journey, error) {
	if !validCoord(q.From.Lat, q.From.Lon) || !validCoord(q.To.Lat, q.To.Lon) {
		return nil, fmt.Errorf("%w : lieu hors du Grand Abidjan", ErrInvalid)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	if q.At.IsZero() {
		q.At = now
	}
	orig := p.accessStopsLocked(q.From)
	dest := p.accessStopsLocked(q.To)
	plans := p.candidatePlansLocked(orig, dest)

	best := map[string]Journey{}
	keep := func(sig string, j Journey) {
		cur, ok := best[sig]
		if !ok {
			best[sig] = j
			return
		}
		if q.ArriveBy && j.Depart.After(cur.Depart) || !q.ArriveBy && j.Arrive.Before(cur.Arrive) {
			best[sig] = j
		}
	}
	if q.ArriveBy {
		for t := q.At.Add(-150 * time.Minute); !t.After(q.At); t = t.Add(4 * time.Minute) {
			for sig, segs := range plans {
				if j, ok := p.buildJourneyLocked(q, segs, orig, dest, t, now); ok && !j.Arrive.After(q.At) {
					keep(sig, j)
				}
			}
		}
	} else {
		for sig, segs := range plans {
			if j, ok := p.buildJourneyLocked(q, segs, orig, dest, q.At, now); ok {
				keep(sig, j)
			}
		}
	}
	if d := placeDist(q.From, q.To); d <= directWalkM {
		m := walkMinutes(d)
		start := q.At
		if q.ArriveBy {
			start = q.At.Add(-time.Duration(m) * time.Minute)
		}
		best["walk"] = p.finishLocked(Journey{Legs: []Leg{walkLeg(q.From, q.To, start, d)}})
	}
	out := make([]Journey, 0, len(best))
	for _, j := range best {
		out = append(out, j)
	}
	sort.Slice(out, func(i, k int) bool {
		if q.ArriveBy {
			if !out[i].Depart.Equal(out[k].Depart) {
				return out[i].Depart.After(out[k].Depart)
			}
		} else if !out[i].Arrive.Equal(out[k].Arrive) {
			return out[i].Arrive.Before(out[k].Arrive)
		}
		return out[i].Transfers < out[k].Transfers
	})
	// Écarter les trajets dominés : un autre part au plus tôt aussi tard,
	// arrive au plus tard aussi tôt, avec moins (ou autant) de marche et de
	// correspondances.
	dominated := func(a, b Journey) bool { // b domine a ?
		better := b.Depart.After(a.Depart) || b.Arrive.Before(a.Arrive) || b.WalkMinutes < a.WalkMinutes || b.Transfers < a.Transfers
		return !b.Depart.Before(a.Depart) && !b.Arrive.After(a.Arrive) && b.WalkMinutes <= a.WalkMinutes && b.Transfers <= a.Transfers && better
	}
	pareto := out[:0:0]
	for i, a := range out {
		dom := false
		for k, b := range out {
			if i != k && (dominated(a, b) || (k < i && a.Depart.Equal(b.Depart) && a.Arrive.Equal(b.Arrive) && a.WalkMinutes == b.WalkMinutes && a.Transfers == b.Transfers)) {
				dom = true
				break
			}
		}
		if !dom {
			pareto = append(pareto, a)
		}
	}
	out = pareto
	// Écarter les trajets nettement moins bons que le meilleur.
	if len(out) > 0 {
		ref := out[0].Minutes
		filtered := out[:0]
		for _, j := range out {
			if j.Minutes <= ref+45 {
				filtered = append(filtered, j)
			}
		}
		out = filtered
	}
	if len(out) > 4 {
		out = out[:4]
	}
	return out, nil
}

// candidatePlansLocked énumère les combinaisons directes et à une correspondance.
func (p *Platform) candidatePlansLocked(orig, dest map[string]access) map[string][]segment {
	plans := map[string][]segment{}
	lines := make([]*Line, 0, len(p.lines))
	for _, id := range sortedKeys(p.lines) {
		lines = append(lines, p.lines[id])
	}
	dirOf := func(a, b int) int {
		if b > a {
			return 1
		}
		return -1
	}
	for _, l := range lines {
		for _, os := range l.StopIDs {
			if _, ok := orig[os]; !ok {
				continue
			}
			for _, ds := range l.StopIDs {
				if _, ok := dest[ds]; !ok || ds == os {
					continue
				}
				a, b := l.stopIndex(os), l.stopIndex(ds)
				sig := fmt.Sprintf("%s:%s>%s", l.ID, os, ds)
				plans[sig] = []segment{{line: l, board: a, off: b, dir: dirOf(a, b)}}
			}
		}
	}
	// Une correspondance : L1 (origine → a), marche a → b, L2 (b → destination).
	for _, l1 := range lines {
		for _, os := range l1.StopIDs {
			if _, ok := orig[os]; !ok {
				continue
			}
			for _, l2 := range lines {
				if l2 == l1 {
					continue
				}
				for _, ds := range l2.StopIDs {
					if _, ok := dest[ds]; !ok {
						continue
					}
					for _, a := range l1.StopIDs {
						if a == os {
							continue
						}
						for _, b := range l2.StopIDs {
							if b == ds || placeDist(p.stopPlace(p.stops[a]), p.stopPlace(p.stops[b])) > maxTransferM {
								continue
							}
							i1, j1 := l1.stopIndex(os), l1.stopIndex(a)
							i2, j2 := l2.stopIndex(b), l2.stopIndex(ds)
							sig := fmt.Sprintf("%s:%s>%s|%s:%s>%s", l1.ID, os, a, l2.ID, b, ds)
							plans[sig] = []segment{{l1, i1, j1, dirOf(i1, j1)}, {l2, i2, j2, dirOf(i2, j2)}}
						}
					}
				}
			}
		}
	}
	// Ne garder, par paire de lignes, que les variantes les moins marchées
	// suffit en pratique ; le tri final départage par heure d'arrivée.
	return plans
}

func walkLeg(from, to Place, start time.Time, meters float64) Leg {
	m := walkMinutes(meters)
	return Leg{Kind: "walk", From: from, To: to, Depart: start, Arrive: start.Add(time.Duration(m * float64(time.Minute))),
		Minutes: int(math.Ceil(m)), Meters: int(meters * walkDetour), Shape: []LatLon{{from.Lat, from.Lon}, {to.Lat, to.Lon}}}
}

// liveFor cherche, à l'arrêt de montée, le véhicule réellement attendu.
func (p *Platform) liveForLocked(l *Line, stopID string, dir int, ready, now time.Time) (*LiveInfo, time.Time) {
	if ready.Sub(now) > liveWindow*time.Minute || ready.Before(now.Add(-2*time.Minute)) {
		return nil, time.Time{}
	}
	var best *Arrival
	var at time.Time
	for _, a := range p.arrivalsLocked(stopID) {
		if a.LineID != l.ID || a.Direction != dir {
			continue
		}
		t := now.Add(time.Duration(a.ETAMinutes) * time.Minute)
		if t.Before(ready) {
			continue
		}
		if best == nil || t.Before(at) {
			cp := a
			best, at = &cp, t
		}
	}
	if best == nil {
		return nil, time.Time{}
	}
	return &LiveInfo{VehicleID: best.VehicleID, ETAMinutes: best.ETAMinutes, Freshness: best.Freshness, AgeSeconds: best.AgeSeconds, Source: best.Source}, at
}

func (p *Platform) buildJourneyLocked(q JourneyQuery, segs []segment, orig, dest map[string]access, start, now time.Time) (Journey, bool) {
	var legs []Leg
	first := segs[0]
	os := p.stops[first.line.StopIDs[first.board]]
	acc := orig[os.ID]
	t := start
	legs = append(legs, walkLeg(q.From, p.stopPlace(os), t, acc.meters))
	t = legs[0].Arrive
	for i, sg := range segs {
		l := sg.line
		boardStop := p.stops[l.StopIDs[sg.board]]
		offStop := p.stops[l.StopIDs[sg.off]]
		if i > 0 {
			prev := legs[len(legs)-1].To
			if prev.ID != boardStop.ID {
				w := walkLeg(prev, p.stopPlace(boardStop), t, placeDist(prev, p.stopPlace(boardStop)))
				legs = append(legs, w)
				t = w.Arrive
			}
			t = t.Add(transferBuffer * time.Minute)
		}
		board, ok := l.NextPassage(sg.board, sg.dir, t)
		if !ok {
			return Journey{}, false
		}
		live, liveAt := p.liveForLocked(l, boardStop.ID, sg.dir, t, now)
		if live != nil && (i == 0 || math.Abs(liveAt.Sub(board).Minutes()) < float64(l.HeadwayMin)) {
			board = liveAt
		} else {
			live = nil
		}
		ride := time.Duration((l.offsetMin(sg.off, sg.dir)-l.offsetMin(sg.board, sg.dir))*60) * time.Second
		d1, d2 := l.stopDist[boardStop.ID], l.stopDist[offStop.ID]
		head := l.StopIDs[len(l.StopIDs)-1]
		if sg.dir < 0 {
			head = l.StopIDs[0]
		}
		legs = append(legs, Leg{
			Kind: "ride", From: p.stopPlace(boardStop), To: p.stopPlace(offStop), Depart: board, Arrive: board.Add(ride),
			Minutes: int(math.Round(ride.Minutes())), Meters: int(math.Abs(d2 - d1)),
			LineID: l.ID, LineCode: l.Code, Mode: l.Mode, Color: l.Color, OperatorID: l.OperatorID, Direction: sg.dir,
			Headsign: p.stops[head].Name, Stops: int(math.Abs(float64(sg.off - sg.board))), Fare: p.fareLocked(l.OperatorID),
			Reservable: l.Reservable, Live: live, Shape: l.subShape(d1, d2),
		})
		t = board.Add(ride)
	}
	last := legs[len(legs)-1].To
	legs = append(legs, walkLeg(last, q.To, t, dest[last.ID].meters))
	// Partir juste à temps : on recale la première marche sur l'heure de passage.
	firstRide := legs[1]
	legs[0].Depart = firstRide.Depart.Add(-time.Duration(walkMinutes(acc.meters)*float64(time.Minute)) - time.Minute)
	legs[0].Arrive = firstRide.Depart.Add(-time.Minute)
	if legs[0].Depart.Before(start) && !q.ArriveBy {
		legs[0].Depart = start
	}
	return p.finishLocked(Journey{Legs: legs}), true
}

func (p *Platform) finishLocked(j Journey) Journey {
	j.Depart = j.Legs[0].Depart
	j.Arrive = j.Legs[len(j.Legs)-1].Arrive
	j.Minutes = int(math.Ceil(j.Arrive.Sub(j.Depart).Minutes()))
	rides := 0
	var sig []string
	for _, l := range j.Legs {
		if l.Kind == "walk" {
			j.WalkMinutes += l.Minutes
			continue
		}
		rides++
		j.Fare += l.Fare
		j.Modes = append(j.Modes, l.Mode)
		if l.Live != nil {
			j.Live = true
		}
		sig = append(sig, l.LineID)
	}
	if rides > 0 {
		j.Transfers = rides - 1
	}
	j.ID = fmt.Sprintf("j_%s_%d", strings.Join(sig, "_"), j.Depart.Unix())
	if len(sig) == 0 {
		j.ID = fmt.Sprintf("j_walk_%d", j.Depart.Unix())
	}
	return j
}

// Places : repères connus + arrêts, pour choisir un départ ou une arrivée.
func (p *Platform) Places(query string) []Place {
	p.mu.Lock()
	defer p.mu.Unlock()
	q := strings.ToLower(strings.TrimSpace(query))
	out := []Place{}
	match := func(name string) bool { return q == "" || strings.Contains(strings.ToLower(name), q) }
	for _, pl := range p.places {
		if match(pl.Name) {
			out = append(out, pl)
		}
	}
	for _, id := range sortedKeys(p.stops) {
		if s := p.stops[id]; match(s.Name) {
			out = append(out, p.stopPlace(s))
		}
	}
	return out
}

// SetPlaces enregistre le domicile et le lieu de travail du voyageur.
func (p *Platform) SetPlaces(pr Principal, home, work *Place) error {
	if pr.Role != RoleTraveler {
		return ErrForbidden
	}
	for _, pl := range []*Place{home, work} {
		if pl != nil && !validCoord(pl.Lat, pl.Lon) {
			return fmt.Errorf("%w : lieu hors du Grand Abidjan", ErrInvalid)
		}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	t := p.travelers[pr.TravelerID]
	if t == nil {
		return ErrNotFound
	}
	if home != nil {
		h := *home
		h.Kind = "home"
		t.Home = &h
	}
	if work != nil {
		w := *work
		w.Kind = "work"
		t.Work = &w
	}
	return nil
}
