package platform

import (
	"fmt"
	"math"
	"sort"
	"time"
)

// VehicleState est la vue temps réel d'un véhicule.
type VehicleState struct {
	VehicleID       string    `json:"vehicle_id"`
	OperatorID      string    `json:"operator_id"`
	LineID          string    `json:"line_id"`
	LineCode        string    `json:"line_code"`
	Plate           string    `json:"plate"`
	ReservableSeats int       `json:"reservable_seats"`
	HasPosition     bool      `json:"has_position"`
	Lat             float64   `json:"lat"`
	Lon             float64   `json:"lon"`
	Heading         float64   `json:"heading"`
	SpeedKmh        float64   `json:"speed_kmh"`
	Direction       int       `json:"direction"`
	Freshness       Freshness `json:"freshness"`
	AgeSeconds      int       `json:"age_seconds"`
	Source          string    `json:"source"`
	LastSeen        time.Time `json:"last_seen,omitempty"`
	DeviceFrozen    bool      `json:"device_frozen"`
}

// TelemetryInput est le point GPS envoyé par un terminal embarqué.
type TelemetryInput struct {
	Lat        float64   `json:"lat"`
	Lon        float64   `json:"lon"`
	SpeedKmh   float64   `json:"speed_kmh"`
	Heading    float64   `json:"heading"`
	Direction  int       `json:"direction"`
	RecordedAt time.Time `json:"recorded_at"`
}

func validCoord(lat, lon float64) bool {
	// Filtrage grossier : emprise du Grand Abidjan élargie.
	return lat > 4.9 && lat < 5.8 && lon > -4.6 && lon < -3.5
}

// IngestTelemetry enregistre un point GPS envoyé par un terminal authentifié.
func (p *Platform) IngestTelemetry(pr Principal, in TelemetryInput) error {
	if pr.Role != RoleDevice {
		return ErrForbidden
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	d := p.devices[pr.DeviceID]
	if d == nil || d.Frozen {
		return ErrForbidden
	}
	return p.ingestLocked(d.VehicleID, in, "device")
}

// IngestSimulated est réservé au simulateur de démonstration.
func (p *Platform) IngestSimulated(vehicleID string, in TelemetryInput) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.ingestLocked(vehicleID, in, "simulator")
}

func (p *Platform) ingestLocked(vehicleID string, in TelemetryInput, source string) error {
	if _, ok := p.vehicles[vehicleID]; !ok {
		return ErrNotFound
	}
	if !validCoord(in.Lat, in.Lon) || math.IsNaN(in.Lat) {
		return fmt.Errorf("%w : position hors zone", ErrInvalid)
	}
	now := p.now()
	rec := in.RecordedAt
	if rec.IsZero() || rec.After(now.Add(5*time.Second)) {
		rec = now // horodatage absent ou dans le futur : on retient la réception
	}
	if prev := p.telemetry[vehicleID]; prev != nil && rec.Before(prev.RecordedAt) {
		return nil // point plus ancien que le dernier connu : ignoré
	}
	dir := in.Direction
	if dir != -1 {
		dir = 1
	}
	p.telemetry[vehicleID] = &Telemetry{
		VehicleID: vehicleID, Lat: in.Lat, Lon: in.Lon, SpeedKmh: in.SpeedKmh,
		Heading: in.Heading, Direction: dir, RecordedAt: rec, ReceivedAt: now, Source: source,
	}
	return nil
}

func (p *Platform) freshnessLocked(t *Telemetry) (Freshness, int) {
	if t == nil {
		return FreshnessUnknown, -1
	}
	age := p.now().Sub(t.RecordedAt)
	switch {
	case age < p.cfg.FreshAfter:
		return FreshnessFresh, int(age.Seconds())
	case age <= p.cfg.UnknownAfter:
		return FreshnessDelayed, int(age.Seconds())
	default:
		return FreshnessUnknown, int(age.Seconds())
	}
}

func (p *Platform) stateLocked(v *Vehicle) VehicleState {
	st := VehicleState{
		VehicleID: v.ID, OperatorID: v.OperatorID, LineID: v.LineID, Plate: v.Plate,
		ReservableSeats: v.ReservableSeats,
	}
	if l := p.lines[v.LineID]; l != nil {
		st.LineCode = l.Code
	}
	for _, d := range p.devices {
		if d.VehicleID == v.ID && d.Frozen {
			st.DeviceFrozen = true
		}
	}
	t := p.telemetry[v.ID]
	st.Freshness, st.AgeSeconds = p.freshnessLocked(t)
	if t != nil {
		st.HasPosition = true
		st.Lat, st.Lon, st.Heading, st.SpeedKmh, st.Direction = t.Lat, t.Lon, t.Heading, t.SpeedKmh, t.Direction
		st.Source, st.LastSeen = t.Source, t.RecordedAt
	}
	return st
}

// Snapshot renvoie l'état temps réel ; operatorID vide = tous les opérateurs.
func (p *Platform) Snapshot(operatorID string) []VehicleState {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := []VehicleState{}
	for _, v := range p.vehicles {
		if operatorID != "" && v.OperatorID != operatorID {
			continue
		}
		out = append(out, p.stateLocked(v))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].VehicleID < out[j].VehicleID })
	return out
}

// Arrival est une estimation de passage à un arrêt.
type Arrival struct {
	VehicleID   string    `json:"vehicle_id"`
	LineID      string    `json:"line_id"`
	LineCode    string    `json:"line_code"`
	OperatorID  string    `json:"operator_id"`
	Direction   int       `json:"direction"`
	DistanceM   int       `json:"distance_m"`
	ETAMinutes  int       `json:"eta_minutes"`
	Freshness   Freshness `json:"freshness"`
	AgeSeconds  int       `json:"age_seconds"`
	Degraded    bool      `json:"degraded"` // GPS retardé : estimation dégradée
	SeatsToBook int       `json:"reservable_seats"`
	Source      string    `json:"source"`
}

// Arrivals estime les prochains passages à un arrêt. Aucun ETA n'est produit
// à partir d'une position inconnue (> 120 s) : pas de faux temps réel.
func (p *Platform) Arrivals(stopID string) ([]Arrival, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if _, ok := p.stops[stopID]; !ok {
		return nil, ErrNotFound
	}
	out := []Arrival{}
	speed := p.cfg.AvgSpeedKmh / 3.6 // m/s
	for _, v := range p.vehicles {
		l := p.lines[v.LineID]
		if l == nil {
			continue
		}
		sd, served := l.stopDist[stopID]
		if !served {
			continue
		}
		t := p.telemetry[v.ID]
		fr, age := p.freshnessLocked(t)
		if fr == FreshnessUnknown {
			continue
		}
		vd := l.project(LatLon{t.Lat, t.Lon})
		var remaining float64
		if t.Direction >= 0 {
			remaining = sd - vd
		} else {
			remaining = vd - sd
		}
		if remaining < -30 { // arrêt déjà dépassé
			continue
		}
		remaining = math.Max(0, remaining)
		eta := remaining / speed
		if fr == FreshnessDelayed {
			// le véhicule a probablement avancé depuis le dernier point
			eta = math.Max(0, eta-float64(age)*0.5)
		}
		out = append(out, Arrival{
			VehicleID: v.ID, LineID: l.ID, LineCode: l.Code, OperatorID: v.OperatorID, Direction: t.Direction,
			DistanceM: int(remaining), ETAMinutes: int(math.Ceil(eta / 60)),
			Freshness: fr, AgeSeconds: age, Degraded: fr == FreshnessDelayed,
			SeatsToBook: v.ReservableSeats, Source: t.Source,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].DistanceM < out[j].DistanceM })
	return out, nil
}
