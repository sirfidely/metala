package platform

import (
	"encoding/json"
	"fmt"
	"time"
)

// Données de démonstration : opérateurs, lignes, personnes et horaires sont
// FICTIFS. Les arrêts reprennent des lieux réels du Grand Abidjan avec des
// coordonnées approximatives, à remplacer par les relevés terrain (S5–S7).

type DemoTraveler struct {
	Phone, Name, CardUID string
}

var DemoAwa = DemoTraveler{Phone: "+2250700000001", Name: "Awa K. (fictive)", CardUID: "04A1B2C3D4E5F6"}
var DemoKoffi = DemoTraveler{Phone: "+2250700000002", Name: "Koffi B. (fictif)", CardUID: "04B7C8D9E0F1A2"}
var DemoYao = DemoTraveler{Phone: "+2250700000003", Name: "Yao T. (fictif, sans titre)", CardUID: "04C3D4E5F6A7B8"}

const DemoStaffPassword = "metala-demo"

// Seed charge le jeu de données du pilote : 2 opérateurs, 2 corridors,
// 10 véhicules (cible du document de proposition).
func (p *Platform) Seed() error {
	p.mu.Lock()
	ops := []*Operator{
		{ID: "op_lagune", Name: "Lagune Express (fictif)", Color: "#0E7C66", CommissionRate: 0.015},
		{ID: "op_ebene", Name: "Navettes Ébène (fictif)", Color: "#C2410C", CommissionRate: 0.01},
	}
	for _, o := range ops {
		p.operators[o.ID] = o
	}
	stops := []*Stop{
		{ID: "st_yop_selmer", Name: "Yopougon Selmer", Lat: 5.3497, Lon: -4.0812},
		{ID: "st_yop_siporex", Name: "Yopougon Siporex", Lat: 5.3400, Lon: -4.0660},
		{ID: "st_banco", Name: "Autoroute du Nord · Banco", Lat: 5.3555, Lon: -4.0450},
		{ID: "st_adj_220", Name: "Adjamé 220 Logements", Lat: 5.3600, Lon: -4.0260},
		{ID: "st_adj_liberte", Name: "Adjamé Liberté", Lat: 5.3520, Lon: -4.0210},
		{ID: "st_plateau_cite", Name: "Plateau · Cité administrative", Lat: 5.3265, Lon: -4.0190},
		{ID: "st_riviera2", Name: "Riviera 2", Lat: 5.3600, Lon: -3.9620},
		{ID: "st_univ_fhb", Name: "Cocody · Université FHB", Lat: 5.3480, Lon: -3.9880},
		{ID: "st_stjean", Name: "Cocody Saint-Jean", Lat: 5.3430, Lon: -3.9990},
		{ID: "st_ivoire", Name: "Hôtel Ivoire", Lat: 5.3270, Lon: -4.0040},
	}
	for _, s := range stops {
		p.stops[s.ID] = s
	}
	lines := []*Line{
		{ID: "ln_m2", OperatorID: "op_lagune", Code: "M2", Name: "Yopougon Selmer ↔ Plateau", Color: "#0E7C66",
			StopIDs: []string{"st_yop_selmer", "st_yop_siporex", "st_banco", "st_adj_220", "st_adj_liberte", "st_plateau_cite"},
			Shape: []LatLon{{5.3497, -4.0812}, {5.3450, -4.0740}, {5.3400, -4.0660}, {5.3470, -4.0560}, {5.3555, -4.0450},
				{5.3590, -4.0350}, {5.3600, -4.0260}, {5.3520, -4.0210}, {5.3400, -4.0200}, {5.3265, -4.0190}}},
		{ID: "ln_n1", OperatorID: "op_ebene", Code: "N1", Name: "Riviera 2 ↔ Plateau", Color: "#C2410C",
			StopIDs: []string{"st_riviera2", "st_univ_fhb", "st_stjean", "st_ivoire", "st_plateau_cite"},
			Shape: []LatLon{{5.3600, -3.9620}, {5.3540, -3.9760}, {5.3480, -3.9880}, {5.3430, -3.9990}, {5.3350, -4.0030},
				{5.3270, -4.0040}, {5.3240, -4.0110}, {5.3265, -4.0190}}},
	}
	for _, l := range lines {
		l.prepare(p.stops)
		p.lines[l.ID] = l
	}
	for i := 1; i <= 6; i++ {
		p.addVehicleLocked(fmt.Sprintf("veh_10%d", i), "op_lagune", "ln_m2", fmt.Sprintf("%04d LG 01", 1200+i*7), 4)
	}
	for i := 1; i <= 4; i++ {
		p.addVehicleLocked(fmt.Sprintf("veh_20%d", i), "op_ebene", "ln_n1", fmt.Sprintf("%04d EB 01", 3400+i*11), 6)
	}
	prods := []*Product{
		{ID: "prd_lag_single", OperatorID: "op_lagune", Name: "Ticket M2", Kind: ProductSingle, Trips: 1, Price: 300, ValidityDays: 1},
		{ID: "prd_lag_c10", OperatorID: "op_lagune", Name: "Carnet 10 trajets", Kind: ProductCarnet, Trips: 10, Price: 2700, ValidityDays: 30},
		{ID: "prd_lag_c20", OperatorID: "op_lagune", Name: "Carnet 20 trajets", Kind: ProductCarnet, Trips: 20, Price: 5000, ValidityDays: 60},
		{ID: "prd_lag_month", OperatorID: "op_lagune", Name: "Forfait mensuel Lagune", Kind: ProductMonthly, Price: 12000, ValidityDays: 30},
		{ID: "prd_ebe_single", OperatorID: "op_ebene", Name: "Ticket N1", Kind: ProductSingle, Trips: 1, Price: 400, ValidityDays: 1},
		{ID: "prd_ebe_c10", OperatorID: "op_ebene", Name: "Carnet 10 trajets", Kind: ProductCarnet, Trips: 10, Price: 3600, ValidityDays: 30},
		{ID: "prd_ebe_month", OperatorID: "op_ebene", Name: "Forfait mensuel Ébène", Kind: ProductMonthly, Price: 15000, ValidityDays: 30},
	}
	prods = append(prods,
		&Product{ID: "prd_wallet_1000", Name: "Recharge 1 000 FCFA", Kind: ProductWallet, Price: 1000},
		&Product{ID: "prd_wallet_2000", Name: "Recharge 2 000 FCFA", Kind: ProductWallet, Price: 2000},
		&Product{ID: "prd_wallet_5000", Name: "Recharge 5 000 FCFA", Kind: ProductWallet, Price: 5000},
	)
	for _, pr := range prods {
		p.products[pr.ID] = pr
	}
	p.staff["fleet@lagune.demo"] = &staffAccount{username: "fleet@lagune.demo", password: DemoStaffPassword,
		p: Principal{Role: RoleOperatorAdmin, OperatorID: "op_lagune", Name: "Exploitation Lagune Express"}}
	p.staff["fleet@ebene.demo"] = &staffAccount{username: "fleet@ebene.demo", password: DemoStaffPassword,
		p: Principal{Role: RoleOperatorAdmin, OperatorID: "op_ebene", Name: "Exploitation Navettes Ébène"}}
	p.staff["admin@metala.demo"] = &staffAccount{username: "admin@metala.demo", password: DemoStaffPassword,
		p: Principal{Role: RolePlatformAdmin, Name: "Équipe Metala"}}

	// Départs réservables : toutes les 15 min pendant 12 h.
	now := p.now()
	base := now.Truncate(15 * time.Minute)
	for _, l := range lines {
		var vehs []*Vehicle
		for _, id := range sortedKeys(p.vehicles) {
			if v := p.vehicles[id]; v.LineID == l.ID {
				vehs = append(vehs, v)
			}
		}
		for k := 0; k < 48; k++ {
			v := vehs[k%len(vehs)]
			seats := v.ReservableSeats
			if k == 1 {
				seats = 1 // départ à une place : démonstration de la « dernière place »
			}
			d := &Departure{ID: fmt.Sprintf("dep_%s_%02d", l.Code, k), LineID: l.ID, OperatorID: l.OperatorID,
				VehicleID: v.ID, DepartAt: base.Add(time.Duration(k+1) * 15 * time.Minute), ReservableSeats: seats}
			p.departures[d.ID] = d
		}
	}

	// Voyageurs fictifs, créés « il y a 20 min » via les vrais parcours.
	realNow := p.now
	p.now = func() time.Time { return realNow().Add(-20 * time.Minute) }
	awa := p.demoTravelerLocked(DemoAwa)
	koffi := p.demoTravelerLocked(DemoKoffi)
	p.demoTravelerLocked(DemoYao)
	p.mu.Unlock()

	if err := p.demoPurchase(awa, "prd_lag_c20"); err != nil {
		return err
	}
	if err := p.demoPurchase(koffi, "prd_ebe_month"); err != nil {
		return err
	}
	// Awa a aussi 2 000 FCFA sur le porte-monnaie de sa carte.
	if err := p.demoPurchase(awa, "prd_wallet_2000"); err != nil {
		return err
	}
	// Awa a déjà fait un trajet ce matin : il lui en reste 19.
	if _, err := p.demoTap("dev_102", DemoAwa.CardUID); err != nil {
		return err
	}
	p.mu.Lock()
	p.now = realNow
	p.mu.Unlock()
	return nil
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
	return keys
}

func (p *Platform) addVehicleLocked(id, op, line, plate string, seats int) {
	p.vehicles[id] = &Vehicle{ID: id, OperatorID: op, LineID: line, Plate: plate, Capacity: 18, ReservableSeats: seats}
	devID := "dev_" + id[4:]
	p.devices[devID] = &Device{ID: devID, OperatorID: op, VehicleID: id, token: "scan-" + randHex(12)}
}

func (p *Platform) demoTravelerLocked(d DemoTraveler) Principal {
	t := &Traveler{ID: newID("trv"), Phone: d.Phone, Name: d.Name, CreatedAt: p.now()}
	p.travelers[t.ID] = t
	p.travelerByPhone[t.Phone] = t.ID
	p.cards[d.CardUID] = &Card{UID: d.CardUID, TravelerID: t.ID, Status: CardActive, IssuedAt: p.now()}
	return Principal{Role: RoleTraveler, TravelerID: t.ID, Name: t.Name}
}

func (p *Platform) demoPurchase(pr Principal, productID string) error {
	pay, err := p.CreatePurchase(pr, productID)
	if err != nil {
		return err
	}
	_, err = p.SimulatePSP(pay.ID, "succeeded", false)
	return err
}

// demoTap rejoue le protocole complet carte ↔ terminal ↔ serveur.
func (p *Platform) demoTap(deviceID, uid string) (*Validation, error) {
	p.mu.Lock()
	d := p.devices[deviceID]
	p.mu.Unlock()
	if d == nil {
		return nil, ErrNotFound
	}
	return p.SimulatedTap(Principal{Role: RoleDevice, DeviceID: d.ID, OperatorID: d.OperatorID}, uid)
}

// SimulatedTap enchaîne challenge, réponse de la carte virtuelle et validation.
func (p *Platform) SimulatedTap(dev Principal, uid string) (*Validation, error) {
	ch, _, err := p.IssueChallenge(dev)
	if err != nil {
		return nil, err
	}
	proof, err := p.SimulateCard(uid, ch)
	if err != nil {
		return nil, err
	}
	return p.Validate(dev, TapRequest{TapID: "tap_" + randHex(8), CardUID: uid, Challenge: ch, Proof: proof})
}

// SimulatePSP joue le rôle du PSP habilité : il signe et envoie le webhook.
// duplicate=true envoie deux fois le même événement (démonstration T-009).
func (p *Platform) SimulatePSP(paymentID, status string, duplicate bool) (*Payment, error) {
	pay, ok := p.PaymentByID(paymentID)
	if !ok {
		return nil, ErrNotFound
	}
	body, _ := json.Marshal(PSPEvent{EventID: "evt_" + randHex(8), PSPRef: pay.PSPRef, Status: status, Amount: pay.Amount})
	sig := SignWebhook(p.cfg.PSPWebhookSecret, body)
	res, err := p.HandlePSPWebhook(body, sig)
	if err == nil && duplicate {
		res, err = p.HandlePSPWebhook(body, sig)
	}
	return res, err
}
