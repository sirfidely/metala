package platform

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ---------- Chauffeurs et services (Metala Scan) ----------

type Driver struct {
	ID         string `json:"id"`
	OperatorID string `json:"operator_id"`
	Name       string `json:"name"`
	Phone      string `json:"phone"`
	pin        string
}

// Shift est un service : un chauffeur, un véhicule, une plage horaire.
type Shift struct {
	ID        string     `json:"id"`
	DriverID  string     `json:"driver_id"`
	VehicleID string     `json:"vehicle_id"`
	Start     time.Time  `json:"start"`
	End       *time.Time `json:"end,omitempty"`
}

// DriverLogin : le chauffeur prend son service sur un véhicule de sa
// compagnie. La session obtenue est celle du valideur de ce véhicule.
func (p *Platform) DriverLogin(rawPhone, pin, vehicleID string) (string, Principal, error) {
	phone, err := NormalizePhone(rawPhone)
	if err != nil {
		return "", Principal{}, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	var dr *Driver
	for _, d := range p.drivers {
		if d.Phone == phone {
			dr = d
		}
	}
	if dr == nil || subtle.ConstantTimeCompare([]byte(dr.pin), []byte(pin)) != 1 {
		return "", Principal{}, fmt.Errorf("%w : téléphone ou code PIN incorrect", ErrUnauthorized)
	}
	veh := p.vehicles[vehicleID]
	if veh == nil || veh.OperatorID != dr.OperatorID {
		return "", Principal{}, fmt.Errorf("%w : véhicule d'une autre compagnie", ErrForbidden)
	}
	var dev *Device
	for _, d := range p.devices {
		if d.VehicleID == veh.ID {
			dev = d
		}
	}
	if dev == nil || dev.Frozen {
		return "", Principal{}, fmt.Errorf("%w : valideur indisponible ou gelé", ErrForbidden)
	}
	// Un chauffeur n'a qu'un service ouvert à la fois.
	now := p.now()
	for _, s := range p.shifts {
		if s.DriverID == dr.ID && s.End == nil {
			s.End = &now
		}
	}
	sh := &Shift{ID: newID("shf"), DriverID: dr.ID, VehicleID: veh.ID, Start: now}
	p.shifts[sh.ID] = sh
	pr := Principal{Role: RoleDevice, DeviceID: dev.ID, OperatorID: dr.OperatorID, DriverID: dr.ID, ShiftID: sh.ID, Name: dr.Name}
	return p.newSessionLocked(pr), pr, nil
}

// ShiftView : ce que le chauffeur voit de son service.
type ShiftView struct {
	Shift      Shift        `json:"shift"`
	Driver     Driver       `json:"driver"`
	Vehicle    Vehicle      `json:"vehicle"`
	LineCode   string       `json:"line_code,omitempty"`
	LineName   string       `json:"line_name,omitempty"`
	Fare       int64        `json:"fare"` // 0 = au compteur
	Passengers int          `json:"passengers"`
	Revenue    int64        `json:"revenue"`
	Refused    int          `json:"refused"`
	Recent     []Validation `json:"recent"`
	// Recette du jour : du véhicule (tous services) et de la ligne (tous véhicules).
	VehicleToday Takings `json:"vehicle_today"`
	LineToday    Takings `json:"line_today"`
	Reservations int     `json:"reservations"` // places réservées à venir sur ce véhicule
}

type Takings struct {
	Revenue    int64 `json:"revenue"`
	Passengers int   `json:"passengers"`
}

func (p *Platform) ShiftSummary(pr Principal) (*ShiftView, error) {
	if pr.Role != RoleDevice || pr.ShiftID == "" {
		return nil, ErrForbidden
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.shiftViewLocked(pr.ShiftID)
}

func (p *Platform) shiftViewLocked(id string) (*ShiftView, error) {
	sh := p.shifts[id]
	if sh == nil {
		return nil, ErrNotFound
	}
	v := &ShiftView{Shift: *sh, Driver: *p.drivers[sh.DriverID], Vehicle: *p.vehicles[sh.VehicleID], Recent: []Validation{}}
	if l := p.lines[v.Vehicle.LineID]; l != nil {
		v.LineCode, v.LineName = l.Code, l.Name
	}
	if v.Vehicle.Mode != ModeTaxi {
		v.Fare = p.fareLocked(v.Vehicle.OperatorID)
	}
	end := p.now()
	if sh.End != nil {
		end = *sh.End
	}
	day := startOfDay(p.now())
	for _, val := range p.validations {
		if val.Status != ValAccepted || val.At.Before(day) {
			continue
		}
		if val.VehicleID == sh.VehicleID {
			v.VehicleToday.Revenue += val.Debited
			v.VehicleToday.Passengers++
		}
		if v.Vehicle.LineID != "" && val.LineID == v.Vehicle.LineID {
			v.LineToday.Revenue += val.Debited
			v.LineToday.Passengers++
		}
	}
	for _, r := range p.reservations {
		if d := p.departures[r.DepartureID]; d != nil && r.Status == "confirmed" && d.VehicleID == sh.VehicleID && d.DepartAt.After(p.now().Add(-30*time.Minute)) {
			v.Reservations++
		}
	}
	for i := len(p.validations) - 1; i >= 0; i-- {
		val := p.validations[i]
		if val.VehicleID != sh.VehicleID || val.At.Before(sh.Start) || val.At.After(end) {
			continue
		}
		switch val.Status {
		case ValAccepted:
			v.Passengers++
			v.Revenue += val.Debited
		case ValRejected:
			v.Refused++
		}
		if len(v.Recent) < 8 {
			cp := *val
			cp.TravelerID = ""
			v.Recent = append(v.Recent, cp)
		}
	}
	return v, nil
}

// EndShift clôt le service et renvoie son bilan.
func (p *Platform) EndShift(pr Principal, token string) (*ShiftView, error) {
	if pr.Role != RoleDevice || pr.ShiftID == "" {
		return nil, ErrForbidden
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	sh := p.shifts[pr.ShiftID]
	if sh == nil {
		return nil, ErrNotFound
	}
	if sh.End == nil {
		now := p.now()
		sh.End = &now
	}
	delete(p.sessions, token)
	return p.shiftViewLocked(sh.ID)
}

// ---------- Paiement par téléphone (QR signé) ----------

const payTokenTTL = 60 * time.Second

func (p *Platform) payTokenMAC(payload string) string {
	m := hmac.New(sha256.New, p.cfg.CardMasterKey)
	m.Write([]byte("metala-pay|" + payload))
	return hex.EncodeToString(m.Sum(nil))[:32]
}

// PayToken émet un jeton à usage unique, valable 60 s, lié au Pass du voyageur.
func (p *Platform) PayToken(pr Principal) (string, time.Time, error) {
	if pr.Role != RoleTraveler {
		return "", time.Time{}, ErrForbidden
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	c := p.travelerCardLocked(pr.TravelerID)
	if c == nil {
		return "", time.Time{}, fmt.Errorf("%w : aucune carte active", ErrConflict)
	}
	exp := p.now().Add(payTokenTTL)
	payload := fmt.Sprintf("%s.%d.%s", c.UID, exp.Unix(), randHex(6))
	tok := "MTL1." + base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." + p.payTokenMAC(payload)
	return tok, exp, nil
}

func (p *Platform) checkPayTokenLocked(tok string) (uid, reason string) {
	parts := strings.Split(tok, ".")
	if len(parts) != 3 || parts[0] != "MTL1" {
		return "", "bad_token"
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !hmac.Equal([]byte(p.payTokenMAC(string(raw))), []byte(parts[2])) {
		return "", "bad_token"
	}
	f := strings.Split(string(raw), ".")
	if len(f) != 3 {
		return "", "bad_token"
	}
	exp, _ := strconv.ParseInt(f[1], 10, 64)
	if p.now().Unix() > exp {
		return "", "token_expired"
	}
	if p.usedTokens[f[2]] {
		return "", "replay"
	}
	p.usedTokens[f[2]] = true
	return f[0], ""
}

// ---------- Gestion de flotte (Metala Fleet) ----------

var plateRe = regexp.MustCompile(`^[A-Z0-9 -]{4,14}$`)

type NewVehicle struct {
	OperatorID      string `json:"operator_id"`
	Plate           string `json:"plate"`
	LineID          string `json:"line_id"`
	Mode            Mode   `json:"mode"`
	ReservableSeats int    `json:"reservable_seats"`
}

// AddVehicle inscrit un véhicule et crée son valideur Metala Scan.
func (p *Platform) AddVehicle(pr Principal, in NewVehicle) (*FleetVehicle, error) {
	op, err := resolveOperatorScope(pr, in.OperatorID)
	if err != nil {
		return nil, err
	}
	if op == "" {
		return nil, fmt.Errorf("%w : opérateur requis", ErrInvalid)
	}
	in.Plate = strings.ToUpper(strings.TrimSpace(in.Plate))
	if !plateRe.MatchString(in.Plate) {
		return nil, fmt.Errorf("%w : immatriculation invalide", ErrInvalid)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.operators[op] == nil {
		return nil, ErrNotFound
	}
	for _, v := range p.vehicles {
		if v.Plate == in.Plate {
			return nil, fmt.Errorf("%w : immatriculation déjà inscrite", ErrConflict)
		}
	}
	if in.LineID != "" {
		l := p.lines[in.LineID]
		if l == nil || l.OperatorID != op {
			return nil, fmt.Errorf("%w : ligne inconnue pour cet opérateur", ErrInvalid)
		}
	} else if in.Mode != ModeTaxi {
		return nil, fmt.Errorf("%w : ligne requise (sauf taxi compteur)", ErrInvalid)
	}
	if in.ReservableSeats < 0 || in.ReservableSeats > 80 {
		return nil, fmt.Errorf("%w : places réservables invalides", ErrInvalid)
	}
	id := fmt.Sprintf("veh_%d", 900+len(p.vehicles))
	p.addVehicleLocked(id, op, in.LineID, in.Plate, in.ReservableSeats)
	if in.LineID == "" {
		p.vehicles[id].Mode = ModeTaxi
		p.vehicles[id].Capacity = 4
	}
	fv := FleetVehicle{VehicleState: p.stateLocked(p.vehicles[id]), DeviceID: "dev_" + id[4:]}
	return &fv, nil
}

type NewDriver struct {
	OperatorID string `json:"operator_id"`
	Name       string `json:"name"`
	Phone      string `json:"phone"`
	PIN        string `json:"pin"`
}

var pinRe = regexp.MustCompile(`^\d{4}$`)

func (p *Platform) AddDriver(pr Principal, in NewDriver) (*Driver, error) {
	op, err := resolveOperatorScope(pr, in.OperatorID)
	if err != nil {
		return nil, err
	}
	if op == "" {
		return nil, fmt.Errorf("%w : opérateur requis", ErrInvalid)
	}
	phone, err := NormalizePhone(in.Phone)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(in.Name) == "" || !pinRe.MatchString(in.PIN) {
		return nil, fmt.Errorf("%w : nom et code PIN à 4 chiffres requis", ErrInvalid)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, d := range p.drivers {
		if d.Phone == phone {
			return nil, fmt.Errorf("%w : chauffeur déjà inscrit", ErrConflict)
		}
	}
	d := &Driver{ID: newID("drv"), OperatorID: op, Name: strings.TrimSpace(in.Name), Phone: phone, pin: in.PIN}
	p.drivers[d.ID] = d
	cp := *d
	return &cp, nil
}

// DriverRow : un chauffeur et son service en cours, pour le portail Fleet.
type DriverRow struct {
	Driver
	OnDuty     bool       `json:"on_duty"`
	VehicleID  string     `json:"vehicle_id,omitempty"`
	Plate      string     `json:"plate,omitempty"`
	Since      *time.Time `json:"since,omitempty"`
	Passengers int        `json:"passengers"`
	Revenue    int64      `json:"revenue"`
}

func (p *Platform) Drivers(pr Principal, requested string) ([]DriverRow, error) {
	op, err := resolveOperatorScope(pr, requested)
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	out := []DriverRow{}
	for _, d := range p.drivers {
		if op != "" && d.OperatorID != op {
			continue
		}
		row := DriverRow{Driver: *d}
		for _, s := range p.shifts {
			if s.DriverID == d.ID && s.End == nil {
				row.OnDuty, row.VehicleID = true, s.VehicleID
				st := s.Start
				row.Since = &st
				row.Plate = p.vehicles[s.VehicleID].Plate
				if sv, err := p.shiftViewLocked(s.ID); err == nil {
					row.Passengers, row.Revenue = sv.Passengers, sv.Revenue
				}
			}
		}
		out = append(out, row)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// ---------- Super administrateur : opérateurs ----------

type OperatorRow struct {
	Operator
	Vehicles int    `json:"vehicles"`
	Drivers  int    `json:"drivers"`
	Lines    int    `json:"lines"`
	Admin    string `json:"admin,omitempty"`
}

func (p *Platform) Operators(pr Principal) ([]OperatorRow, error) {
	if pr.Role != RolePlatformAdmin {
		return nil, ErrForbidden
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	out := []OperatorRow{}
	for _, id := range sortedKeys(p.operators) {
		row := OperatorRow{Operator: *p.operators[id]}
		for _, v := range p.vehicles {
			if v.OperatorID == id {
				row.Vehicles++
			}
		}
		for _, d := range p.drivers {
			if d.OperatorID == id {
				row.Drivers++
			}
		}
		for _, l := range p.lines {
			if l.OperatorID == id {
				row.Lines++
			}
		}
		for _, a := range p.staff {
			if a.p.OperatorID == id {
				row.Admin = a.username
			}
		}
		out = append(out, row)
	}
	return out, nil
}

type NewOperator struct {
	Name       string       `json:"name"`
	Kind       OperatorKind `json:"kind"`
	AdminEmail string       `json:"admin_email"`
	Password   string       `json:"password"`
}

var emailRe = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[a-z]{2,}$`)

// AddOperator inscrit une compagnie et son compte administrateur.
func (p *Platform) AddOperator(pr Principal, in NewOperator) (*OperatorRow, error) {
	if pr.Role != RolePlatformAdmin {
		return nil, ErrForbidden
	}
	in.Name = strings.TrimSpace(in.Name)
	in.AdminEmail = strings.ToLower(strings.TrimSpace(in.AdminEmail))
	switch in.Kind {
	case OpPublic, OpPrivate, OpArtisanal, OpTaxi:
	default:
		return nil, fmt.Errorf("%w : catégorie inconnue", ErrInvalid)
	}
	if len(in.Name) < 3 || !emailRe.MatchString(in.AdminEmail) || len(in.Password) < 8 {
		return nil, fmt.Errorf("%w : nom, e-mail et mot de passe (8 caractères min.) requis", ErrInvalid)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if _, ok := p.staff[in.AdminEmail]; ok {
		return nil, fmt.Errorf("%w : compte déjà existant", ErrConflict)
	}
	palette := []string{"#0891B2", "#DB2777", "#65A30D", "#7C3AED", "#EA580C"}
	o := &Operator{ID: newID("op"), Name: in.Name, Kind: in.Kind, Color: palette[len(p.operators)%len(palette)], CommissionRate: 0.015}
	p.operators[o.ID] = o
	p.staff[in.AdminEmail] = &staffAccount{username: in.AdminEmail, password: in.Password,
		p: Principal{Role: RoleOperatorAdmin, OperatorID: o.ID, Name: "Administration " + o.Name}}
	return &OperatorRow{Operator: *o, Admin: in.AdminEmail}, nil
}

// DevPayToken : jeton QR d'un voyageur (simulation de la lecture par caméra).
func (p *Platform) DevPayToken(rawPhone string) (string, error) {
	phone, err := NormalizePhone(rawPhone)
	if err != nil {
		return "", err
	}
	p.mu.Lock()
	id, ok := p.travelerByPhone[phone]
	p.mu.Unlock()
	if !ok {
		return "", ErrNotFound
	}
	tok, _, err := p.PayToken(Principal{Role: RoleTraveler, TravelerID: id})
	return tok, err
}

// DevDriver expose les chauffeurs de démonstration au simulateur Scan.
type DevDriver struct {
	Driver
	Vehicles []DevDevice `json:"vehicles"`
}

func (p *Platform) DevDrivers() []DevDriver {
	devs, _ := p.DevInventory()
	p.mu.Lock()
	defer p.mu.Unlock()
	out := []DevDriver{}
	for _, id := range sortedKeys(p.drivers) {
		d := p.drivers[id]
		dd := DevDriver{Driver: *d, Vehicles: []DevDevice{}}
		for _, dev := range devs {
			if dev.OperatorID == d.OperatorID {
				dev.Secret = ""
				dd.Vehicles = append(dd.Vehicles, dev)
			}
		}
		out = append(out, dd)
	}
	return out
}
