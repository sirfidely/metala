package platform

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
)

// ---------- Réservations vues par l'agent (Metala Scan) ----------

// markBoardedLocked : un voyageur qui paie à bord du véhicule qu'il a réservé
// est marqué « à bord ».
func (p *Platform) markBoardedLocked(v *Validation) {
	if v.TravelerID == "" {
		return
	}
	for _, r := range p.reservations {
		d := p.departures[r.DepartureID]
		if r.TravelerID != v.TravelerID || r.Status != "confirmed" || r.BoardedAt != nil || d == nil || d.VehicleID != v.VehicleID {
			continue
		}
		if v.At.After(d.DepartAt.Add(-45*time.Minute)) && v.At.Before(d.DepartAt.Add(30*time.Minute)) {
			t := v.At
			r.BoardedAt = &t
			return
		}
	}
}

type Passenger struct {
	ReservationID string     `json:"reservation_id"`
	Name          string     `json:"name"` // prénom et initiale
	BoardedAt     *time.Time `json:"boarded_at,omitempty"`
}

type DepartureView struct {
	Departure
	LineCode   string      `json:"line_code"`
	From       string      `json:"from"`
	Passengers []Passenger `json:"passengers"`
}

func shortName(n string) string {
	n = strings.TrimSpace(strings.Split(n, "(")[0])
	parts := strings.Fields(n)
	if len(parts) == 0 {
		return "Voyageur"
	}
	if len(parts) == 1 {
		return parts[0]
	}
	return parts[0] + " " + string([]rune(parts[1])[0]) + "."
}

// VehicleReservations : départs à venir du véhicule et voyageurs ayant réservé.
func (p *Platform) VehicleReservations(pr Principal) ([]DepartureView, error) {
	if pr.Role != RoleDevice {
		return nil, ErrForbidden
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	d := p.devices[pr.DeviceID]
	if d == nil {
		return nil, ErrForbidden
	}
	now := p.now()
	out := []DepartureView{}
	for _, dep := range p.departures {
		if dep.VehicleID != d.VehicleID || dep.DepartAt.Before(now.Add(-30*time.Minute)) || dep.DepartAt.After(now.Add(6*time.Hour)) {
			continue
		}
		l := p.lines[dep.LineID]
		dv := DepartureView{Departure: *dep, LineCode: l.Code, From: p.stops[l.StopIDs[0]].Name, Passengers: []Passenger{}}
		for _, r := range p.reservations {
			if r.DepartureID == dep.ID && r.Status == "confirmed" {
				name := "Voyageur"
				if t := p.travelers[r.TravelerID]; t != nil && t.Name != "" {
					name = shortName(t.Name)
				}
				dv.Passengers = append(dv.Passengers, Passenger{ReservationID: r.ID, Name: name, BoardedAt: r.BoardedAt})
			}
		}
		out = append(out, dv)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].DepartAt.Before(out[j].DepartAt) })
	if len(out) > 8 {
		out = out[:8]
	}
	return out, nil
}

// ---------- Inscription des compagnies ----------

// RegisterOperator : une compagnie (publique ou privée, artisanale, taxi)
// s'inscrit elle-même sur Metala Gestion.
func (p *Platform) RegisterOperator(in NewOperator) (string, Principal, error) {
	row, err := p.AddOperator(Principal{Role: RolePlatformAdmin}, in)
	if err != nil {
		return "", Principal{}, err
	}
	return p.StaffLogin(row.Admin, in.Password)
}

// ---------- Arrêts, lignes et tarifs ----------

var hmRe = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)
var codeRe = regexp.MustCompile(`^[A-Z0-9]{1,4}$`)

type NewStop struct {
	Name string  `json:"name"`
	Lat  float64 `json:"lat"`
	Lon  float64 `json:"lon"`
}

// AddStop : un arrêt est partagé par tout le réseau (correspondances).
func (p *Platform) AddStop(pr Principal, in NewStop) (*Stop, error) {
	if pr.Role != RoleOperatorAdmin && pr.Role != RolePlatformAdmin {
		return nil, ErrForbidden
	}
	in.Name = strings.TrimSpace(in.Name)
	if len(in.Name) < 3 || !validCoord(in.Lat, in.Lon) {
		return nil, fmt.Errorf("%w : nom et position dans le Grand Abidjan requis", ErrInvalid)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, s := range p.stops {
		if haversine(LatLon{s.Lat, s.Lon}, LatLon{in.Lat, in.Lon}) < 60 {
			return nil, fmt.Errorf("%w : un arrêt existe déjà ici (%s)", ErrConflict, s.Name)
		}
	}
	s := &Stop{ID: newID("st"), Name: in.Name, Lat: in.Lat, Lon: in.Lon}
	p.stops[s.ID] = s
	cp := *s
	return &cp, nil
}

type NewLine struct {
	OperatorID string   `json:"operator_id"`
	Code       string   `json:"code"`
	Name       string   `json:"name"`
	Mode       Mode     `json:"mode"`
	StopIDs    []string `json:"stop_ids"`
	HeadwayMin int      `json:"headway_min"`
	FirstDep   string   `json:"first_dep"`
	LastDep    string   `json:"last_dep"`
	Reservable bool     `json:"reservable"`
	Fare       int64    `json:"fare"` // tarif du trajet (ticket unitaire)
}

var modeSpeed = map[Mode]float64{ModeBus: 18, ModeShuttle: 20, ModeBoat: 20, ModeGbaka: 22, ModeWoro: 22}

// AddLine publie une ligne : tracé (arrêts dans l'ordre), offre et tarif.
func (p *Platform) AddLine(pr Principal, in NewLine) (*Line, error) {
	op, err := resolveOperatorScope(pr, in.OperatorID)
	if err != nil {
		return nil, err
	}
	if op == "" {
		return nil, fmt.Errorf("%w : opérateur requis", ErrInvalid)
	}
	in.Code = strings.ToUpper(strings.TrimSpace(in.Code))
	in.Name = strings.TrimSpace(in.Name)
	speed, ok := modeSpeed[in.Mode]
	switch {
	case !ok:
		return nil, fmt.Errorf("%w : mode inconnu", ErrInvalid)
	case !codeRe.MatchString(in.Code) || len(in.Name) < 3:
		return nil, fmt.Errorf("%w : code (1 à 4 caractères) et nom requis", ErrInvalid)
	case len(in.StopIDs) < 2:
		return nil, fmt.Errorf("%w : au moins deux arrêts", ErrInvalid)
	case in.HeadwayMin < 2 || in.HeadwayMin > 180:
		return nil, fmt.Errorf("%w : fréquence entre 2 et 180 minutes", ErrInvalid)
	case !hmRe.MatchString(in.FirstDep) || !hmRe.MatchString(in.LastDep) || parseHM(in.LastDep) <= parseHM(in.FirstDep):
		return nil, fmt.Errorf("%w : horaires de service invalides", ErrInvalid)
	case in.Fare <= 0 || in.Fare > 10000:
		return nil, fmt.Errorf("%w : tarif invalide", ErrInvalid)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	o := p.operators[op]
	if o == nil {
		return nil, ErrNotFound
	}
	seen := map[string]bool{}
	shape := []LatLon{}
	for _, sid := range in.StopIDs {
		s := p.stops[sid]
		if s == nil || seen[sid] {
			return nil, fmt.Errorf("%w : arrêt inconnu ou répété", ErrInvalid)
		}
		seen[sid] = true
		shape = append(shape, LatLon{s.Lat, s.Lon})
	}
	for _, l := range p.lines {
		if l.OperatorID == op && l.Code == in.Code {
			return nil, fmt.Errorf("%w : code de ligne déjà utilisé", ErrConflict)
		}
	}
	l := &Line{ID: newID("ln"), OperatorID: op, Mode: in.Mode, Code: in.Code, Name: in.Name, Color: o.Color,
		StopIDs: in.StopIDs, Shape: shape, HeadwayMin: in.HeadwayMin, FirstDep: in.FirstDep, LastDep: in.LastDep,
		SpeedKmh: speed, Reservable: in.Reservable}
	l.prepare(p.stops)
	p.lines[l.ID] = l
	// Tarif : un ticket unitaire par opérateur sert aussi au paiement par porte-monnaie.
	if p.fareLocked(op) == 0 {
		pr := &Product{ID: newID("prd"), OperatorID: op, Name: "Ticket " + l.Code, Kind: ProductSingle, Trips: 1, Price: in.Fare, ValidityDays: 1}
		p.products[pr.ID] = pr
	}
	cp := *l
	return &cp, nil
}

type ProductInput struct {
	OperatorID   string      `json:"operator_id"`
	Name         string      `json:"name"`
	Kind         ProductKind `json:"kind"`
	Trips        int         `json:"trips"`
	Price        int64       `json:"price"`
	ValidityDays int         `json:"validity_days"`
}

func (p *Platform) OperatorProducts(pr Principal, requested string) ([]Product, error) {
	op, err := resolveOperatorScope(pr, requested)
	if err != nil {
		return nil, err
	}
	out := []Product{}
	for _, x := range p.Products("") {
		if x.OperatorID != "" && (op == "" || x.OperatorID == op) {
			out = append(out, x)
		}
	}
	return out, nil
}

func checkProduct(in *ProductInput) error {
	in.Name = strings.TrimSpace(in.Name)
	switch in.Kind {
	case ProductSingle:
		in.Trips, in.ValidityDays = 1, 1
	case ProductCarnet:
		if in.Trips < 2 || in.Trips > 100 {
			return fmt.Errorf("%w : un carnet compte de 2 à 100 trajets", ErrInvalid)
		}
	case ProductMonthly:
		in.Trips = 0
	default:
		return fmt.Errorf("%w : type de titre inconnu", ErrInvalid)
	}
	if in.ValidityDays < 1 || in.ValidityDays > 366 {
		return fmt.Errorf("%w : validité de 1 à 366 jours", ErrInvalid)
	}
	if len(in.Name) < 3 || in.Price <= 0 || in.Price > 200000 {
		return fmt.Errorf("%w : nom et prix requis", ErrInvalid)
	}
	return nil
}

// AddProduct ajoute un tarif (ticket, carnet, forfait).
func (p *Platform) AddProduct(pr Principal, in ProductInput) (*Product, error) {
	op, err := resolveOperatorScope(pr, in.OperatorID)
	if err != nil {
		return nil, err
	}
	if op == "" {
		return nil, fmt.Errorf("%w : opérateur requis", ErrInvalid)
	}
	if err := checkProduct(&in); err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.operators[op] == nil {
		return nil, ErrNotFound
	}
	x := &Product{ID: newID("prd"), OperatorID: op, Name: in.Name, Kind: in.Kind, Trips: in.Trips, Price: in.Price, ValidityDays: in.ValidityDays}
	p.products[x.ID] = x
	cp := *x
	return &cp, nil
}

// UpdatePrice change le prix d'un tarif ; les titres déjà vendus gardent leur prix.
func (p *Platform) UpdatePrice(pr Principal, id string, price int64) (*Product, error) {
	if price <= 0 || price > 200000 {
		return nil, fmt.Errorf("%w : prix invalide", ErrInvalid)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	x := p.products[id]
	if x == nil || x.OperatorID == "" {
		return nil, ErrNotFound
	}
	if pr.Role == RoleDevice || !canAccessOperator(pr, x.OperatorID) {
		return nil, ErrForbidden
	}
	x.Price = price
	cp := *x
	return &cp, nil
}

// ---------- Suivi des conducteurs ----------

type DriverActivity struct {
	Driver Driver      `json:"driver"`
	Shifts []ShiftView `json:"shifts"`
	Today  Takings     `json:"today"`
	Month  Takings     `json:"month"`
}

func (p *Platform) DriverActivity(pr Principal, id string) (*DriverActivity, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	d := p.drivers[id]
	if d == nil {
		return nil, ErrNotFound
	}
	if pr.Role == RoleDevice || !canAccessOperator(pr, d.OperatorID) {
		return nil, ErrForbidden
	}
	a := &DriverActivity{Driver: *d, Shifts: []ShiftView{}}
	var shifts []*Shift
	for _, s := range p.shifts {
		if s.DriverID == id {
			shifts = append(shifts, s)
		}
	}
	sort.Slice(shifts, func(i, j int) bool { return shifts[i].Start.After(shifts[j].Start) })
	for i, s := range shifts {
		if i >= 10 {
			break
		}
		if sv, err := p.shiftViewLocked(s.ID); err == nil {
			a.Shifts = append(a.Shifts, *sv)
		}
	}
	now := p.now()
	day := startOfDay(now)
	month := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())
	for _, v := range p.validations {
		if v.DriverID != id || v.Status != ValAccepted {
			continue
		}
		if !v.At.Before(month) {
			a.Month.Revenue += v.Debited
			a.Month.Passengers++
		}
		if !v.At.Before(day) {
			a.Today.Revenue += v.Debited
			a.Today.Passengers++
		}
	}
	return a, nil
}
