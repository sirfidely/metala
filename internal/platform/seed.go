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

// DemoDriverPIN est le code PIN des chauffeurs de démonstration.
const DemoDriverPIN = "1234"

// Seed charge le jeu de démonstration. Le cœur reprend le pilote proposé
// (2 opérateurs, 10 véhicules, 2 corridors) ; trois opérateurs d'autres modes
// (bateau-bus, gbaka, woro-woro) illustrent l'ouverture multimodale.
func (p *Platform) Seed() error {
	p.mu.Lock()
	ops := []*Operator{
		{ID: "op_lagune", Name: "Lagune Express (fictif)", Kind: OpPublic, Color: "#0E7C66", CommissionRate: 0.015},
		{ID: "op_ebene", Name: "Navettes Ébène (fictif)", Kind: OpPrivate, Color: "#C2410C", CommissionRate: 0.01},
		{ID: "op_bateau", Name: "Bateaux de la Lagune (fictif)", Kind: OpPrivate, Color: "#2563EB", CommissionRate: 0.015},
		{ID: "op_gbaka", Name: "Union des gbaka d’Adjamé (fictif)", Kind: OpArtisanal, Color: "#CA8A04", CommissionRate: 0.01},
		{ID: "op_woro", Name: "Woro-woro Riviera (fictif)", Kind: OpArtisanal, Color: "#9333EA", CommissionRate: 0.01},
		{ID: "op_taxi", Name: "Taxis Kouassi & Fils (fictif)", Kind: OpTaxi, Color: "#E11D48", CommissionRate: 0.01},
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
		{ID: "st_yop_wharf", Name: "Yopougon Embarcadère", Lat: 5.3268, Lon: -4.0655},
		{ID: "st_attecoube", Name: "Attécoubé Embarcadère", Lat: 5.3262, Lon: -4.0390},
		{ID: "st_plateau_lag", Name: "Plateau · Gare lagunaire", Lat: 5.3196, Lon: -4.0195},
		{ID: "st_abobo_sogefiha", Name: "Abobo Sogefiha", Lat: 5.4050, Lon: -4.0200},
		{ID: "st_abobo_gare", Name: "Abobo Gare", Lat: 5.4300, Lon: -4.0170},
		{ID: "st_riv_palmeraie", Name: "Riviera Palmeraie", Lat: 5.3720, Lon: -3.9640},
		{ID: "st_deux_plateaux", Name: "II Plateaux · Vallons", Lat: 5.3690, Lon: -3.9950},
	}
	for _, s := range stops {
		p.stops[s.ID] = s
	}
	lines := []*Line{
		{ID: "ln_m2", OperatorID: "op_lagune", Mode: ModeBus, Code: "M2", Name: "Yopougon Selmer ↔ Plateau", Color: "#0E7C66",
			HeadwayMin: 10, FirstDep: "05:00", LastDep: "22:00", SpeedKmh: 18, Reservable: true,
			StopIDs: []string{"st_yop_selmer", "st_yop_siporex", "st_banco", "st_adj_220", "st_adj_liberte", "st_plateau_cite"},
			Shape: []LatLon{{5.3497, -4.0812}, {5.3450, -4.0740}, {5.3400, -4.0660}, {5.3470, -4.0560}, {5.3555, -4.0450},
				{5.3590, -4.0350}, {5.3600, -4.0260}, {5.3520, -4.0210}, {5.3400, -4.0200}, {5.3265, -4.0190}}},
		{ID: "ln_n1", OperatorID: "op_ebene", Mode: ModeShuttle, Code: "N1", Name: "Riviera 2 ↔ Plateau", Color: "#C2410C",
			HeadwayMin: 15, FirstDep: "05:30", LastDep: "21:00", SpeedKmh: 20, Reservable: true,
			StopIDs: []string{"st_riviera2", "st_univ_fhb", "st_stjean", "st_ivoire", "st_plateau_cite"},
			Shape: []LatLon{{5.3600, -3.9620}, {5.3540, -3.9760}, {5.3480, -3.9880}, {5.3430, -3.9990}, {5.3350, -4.0030},
				{5.3270, -4.0040}, {5.3240, -4.0110}, {5.3265, -4.0190}}},
		{ID: "ln_b1", OperatorID: "op_bateau", Mode: ModeBoat, Code: "B1", Name: "Yopougon ↔ Plateau par la lagune", Color: "#2563EB",
			HeadwayMin: 20, FirstDep: "05:30", LastDep: "21:00", SpeedKmh: 20, Reservable: true,
			StopIDs: []string{"st_yop_wharf", "st_attecoube", "st_plateau_lag"},
			Shape:   []LatLon{{5.3268, -4.0655}, {5.3235, -4.0560}, {5.3240, -4.0450}, {5.3262, -4.0390}, {5.3215, -4.0300}, {5.3196, -4.0195}}},
		{ID: "ln_g7", OperatorID: "op_gbaka", Mode: ModeGbaka, Code: "G7", Name: "Adjamé ↔ Abobo Gare", Color: "#CA8A04",
			HeadwayMin: 6, FirstDep: "05:00", LastDep: "23:00", SpeedKmh: 22,
			StopIDs: []string{"st_adj_liberte", "st_adj_220", "st_abobo_sogefiha", "st_abobo_gare"},
			Shape:   []LatLon{{5.3520, -4.0210}, {5.3600, -4.0260}, {5.3750, -4.0230}, {5.3900, -4.0215}, {5.4050, -4.0200}, {5.4180, -4.0180}, {5.4300, -4.0170}}},
		{ID: "ln_w3", OperatorID: "op_woro", Mode: ModeWoro, Code: "W3", Name: "Riviera 2 ↔ II Plateaux", Color: "#9333EA",
			HeadwayMin: 5, FirstDep: "06:00", LastDep: "22:00", SpeedKmh: 22,
			StopIDs: []string{"st_riviera2", "st_riv_palmeraie", "st_deux_plateaux"},
			Shape:   []LatLon{{5.3600, -3.9620}, {5.3720, -3.9640}, {5.3730, -3.9800}, {5.3690, -3.9950}}},
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
	for i := 1; i <= 2; i++ {
		p.addVehicleLocked(fmt.Sprintf("veh_30%d", i), "op_bateau", "ln_b1", fmt.Sprintf("BL-%02d", i), 10)
	}
	for i := 1; i <= 3; i++ {
		p.addVehicleLocked(fmt.Sprintf("veh_40%d", i), "op_gbaka", "ln_g7", fmt.Sprintf("%04d GB 01", 5500+i*13), 0)
	}
	for i := 1; i <= 3; i++ {
		p.addVehicleLocked(fmt.Sprintf("veh_50%d", i), "op_woro", "ln_w3", fmt.Sprintf("%04d WR 01", 7700+i*9), 0)
	}
	for i := 1; i <= 2; i++ {
		p.addVehicleLocked(fmt.Sprintf("veh_60%d", i), "op_taxi", "", fmt.Sprintf("%04d TX 01", 8800+i*21), 0)
	}
	// Un chauffeur par compagnie (code PIN de démonstration : 1234).
	for _, d := range []struct{ id, op, name, phone string }{
		{"drv_kone", "op_lagune", "Ibrahim Koné", "+2250101010101"},
		{"drv_traore", "op_lagune", "Mariam Traoré", "+2250101010102"},
		{"drv_bamba", "op_ebene", "Sékou Bamba", "+2250101010201"},
		{"drv_diallo", "op_bateau", "Moussa Diallo", "+2250101010301"},
		{"drv_ouattara", "op_gbaka", "Lassina Ouattara", "+2250101010401"},
		{"drv_kouame", "op_woro", "Serge Kouamé", "+2250101010501"},
		{"drv_kouassi", "op_taxi", "Jean Kouassi", "+2250101010601"},
	} {
		p.drivers[d.id] = &Driver{ID: d.id, OperatorID: d.op, Name: d.name, Phone: d.phone, pin: DemoDriverPIN}
	}
	prods := []*Product{
		{ID: "prd_lag_single", OperatorID: "op_lagune", Name: "Ticket M2", Kind: ProductSingle, Trips: 1, Price: 300, ValidityDays: 1},
		{ID: "prd_lag_c10", OperatorID: "op_lagune", Name: "Carnet 10 trajets", Kind: ProductCarnet, Trips: 10, Price: 2700, ValidityDays: 30},
		{ID: "prd_lag_c20", OperatorID: "op_lagune", Name: "Carnet 20 trajets", Kind: ProductCarnet, Trips: 20, Price: 5000, ValidityDays: 60},
		{ID: "prd_lag_month", OperatorID: "op_lagune", Name: "Forfait mensuel Lagune", Kind: ProductMonthly, Price: 12000, ValidityDays: 30},
		{ID: "prd_ebe_single", OperatorID: "op_ebene", Name: "Ticket N1", Kind: ProductSingle, Trips: 1, Price: 400, ValidityDays: 1},
		{ID: "prd_ebe_c10", OperatorID: "op_ebene", Name: "Carnet 10 trajets", Kind: ProductCarnet, Trips: 10, Price: 3600, ValidityDays: 30},
		{ID: "prd_ebe_month", OperatorID: "op_ebene", Name: "Forfait mensuel Ébène", Kind: ProductMonthly, Price: 15000, ValidityDays: 30},
		{ID: "prd_bat_single", OperatorID: "op_bateau", Name: "Traversée B1", Kind: ProductSingle, Trips: 1, Price: 300, ValidityDays: 1},
		{ID: "prd_bat_month", OperatorID: "op_bateau", Name: "Forfait mensuel Lagune bateau", Kind: ProductMonthly, Price: 10000, ValidityDays: 30},
		{ID: "prd_gbk_single", OperatorID: "op_gbaka", Name: "Course G7", Kind: ProductSingle, Trips: 1, Price: 200, ValidityDays: 1},
		{ID: "prd_wor_single", OperatorID: "op_woro", Name: "Course W3", Kind: ProductSingle, Trips: 1, Price: 300, ValidityDays: 1},
		{ID: "prd_wallet_1000", Name: "Recharge 1 000 FCFA", Kind: ProductWallet, Price: 1000},
		{ID: "prd_wallet_2000", Name: "Recharge 2 000 FCFA", Kind: ProductWallet, Price: 2000},
		{ID: "prd_wallet_5000", Name: "Recharge 5 000 FCFA", Kind: ProductWallet, Price: 5000},
	}
	for _, pr := range prods {
		p.products[pr.ID] = pr
	}
	p.places = []Place{
		{ID: "pl_adj_marche", Name: "Marché d’Adjamé", Kind: "landmark", Lat: 5.3565, Lon: -4.0235},
		{ID: "pl_chu_cocody", Name: "CHU de Cocody", Kind: "landmark", Lat: 5.3465, Lon: -4.0012},
		{ID: "pl_mairie_abobo", Name: "Mairie d’Abobo", Kind: "landmark", Lat: 5.4262, Lon: -4.0188},
		{ID: "pl_sorbonne", Name: "Plateau · Sorbonne", Kind: "landmark", Lat: 5.3220, Lon: -4.0185},
		{ID: "pl_cite_admin", Name: "Cité administrative · Tour D", Kind: "landmark", Lat: 5.3275, Lon: -4.0178},
		{ID: "pl_palmeraie", Name: "Riviera Palmeraie · Carrefour", Kind: "landmark", Lat: 5.3712, Lon: -3.9655},
		{ID: "pl_selmer_marche", Name: "Yopougon Selmer · Marché", Kind: "landmark", Lat: 5.3505, Lon: -4.0800},
		{ID: "pl_univ", Name: "Université Félix Houphouët-Boigny", Kind: "landmark", Lat: 5.3462, Lon: -3.9878},
	}
	p.staff["fleet@lagune.demo"] = &staffAccount{username: "fleet@lagune.demo", password: DemoStaffPassword,
		p: Principal{Role: RoleOperatorAdmin, OperatorID: "op_lagune", Name: "Exploitation Lagune Express"}}
	p.staff["fleet@ebene.demo"] = &staffAccount{username: "fleet@ebene.demo", password: DemoStaffPassword,
		p: Principal{Role: RoleOperatorAdmin, OperatorID: "op_ebene", Name: "Exploitation Navettes Ébène"}}
	p.staff["fleet@bateau.demo"] = &staffAccount{username: "fleet@bateau.demo", password: DemoStaffPassword,
		p: Principal{Role: RoleOperatorAdmin, OperatorID: "op_bateau", Name: "Exploitation Bateaux de la Lagune"}}
	p.staff["fleet@taxi.demo"] = &staffAccount{username: "fleet@taxi.demo", password: DemoStaffPassword,
		p: Principal{Role: RoleOperatorAdmin, OperatorID: "op_taxi", Name: "Taxis Kouassi & Fils"}}
	p.staff["admin@metala.demo"] = &staffAccount{username: "admin@metala.demo", password: DemoStaffPassword,
		p: Principal{Role: RolePlatformAdmin, Name: "Équipe Metala"}}

	// Départs réservables (lignes éligibles), alignés sur les horaires.
	now := p.now()
	for _, l := range lines {
		if !l.Reservable {
			continue
		}
		var vehs []*Vehicle
		for _, id := range sortedKeys(p.vehicles) {
			if v := p.vehicles[id]; v.LineID == l.ID {
				vehs = append(vehs, v)
			}
		}
		t := now
		for k := 0; k < 48; k++ {
			dep, ok := l.NextPassage(0, 1, t.Add(time.Minute))
			if !ok {
				break
			}
			t = dep
			v := vehs[k%len(vehs)]
			seats := v.ReservableSeats
			if k == 1 {
				seats = 1 // départ à une place : démonstration de la « dernière place »
			}
			d := &Departure{ID: fmt.Sprintf("dep_%s_%02d", l.Code, k), LineID: l.ID, OperatorID: l.OperatorID,
				VehicleID: v.ID, DepartAt: dep, ReservableSeats: seats}
			p.departures[d.ID] = d
		}
	}

	// Voyageurs fictifs, avec 35 jours d'historique pour Awa (via les vrais parcours).
	realNow := p.now
	ref := realNow()
	setNow := func(t time.Time) { p.mu.Lock(); p.now = func() time.Time { return t }; p.mu.Unlock() }
	p.now = func() time.Time { return ref.Add(-36 * 24 * time.Hour) }
	awa := p.demoTravelerLocked(DemoAwa)
	koffi := p.demoTravelerLocked(DemoKoffi)
	p.demoTravelerLocked(DemoYao)
	ta := p.travelers[awa.TravelerID]
	ta.Home = &Place{Name: "Maison · Yopougon Siporex", Kind: "home", Lat: 5.3436, Lon: -4.0708}
	ta.Work = &Place{Name: "Bureau · Plateau, avenue Chardy", Kind: "work", Lat: 5.3232, Lon: -4.0168}
	ta.Budget = 15000
	p.mu.Unlock()

	if err := p.seedAwaHistory(awa, ref, setNow); err != nil {
		return err
	}
	setNow(ref.Add(-20 * time.Minute))
	if err := p.demoPurchase(koffi, "prd_ebe_month"); err != nil {
		return err
	}
	if err := p.ensureWallet(awa, 1500); err != nil {
		return err
	}
	// Awa a déjà fait un trajet ce matin.
	if err := p.ensureTitle(awa, "op_lagune"); err != nil {
		return err
	}
	if _, err := p.demoTap("dev_102", DemoAwa.CardUID); err != nil {
		return err
	}
	p.mu.Lock()
	p.now = realNow
	p.mu.Unlock()
	return nil
}

// seedAwaHistory rejoue 35 jours de déplacements d'Awa : M2 matin et soir en
// semaine (carnet), aller-retour au marché d'Adjamé le mercredi midi, bateau
// le vendredi soir, navette et woro-woro le samedi (porte-monnaie).
func (p *Platform) seedAwaHistory(awa Principal, ref time.Time, setNow func(time.Time)) error {
	day0 := time.Date(ref.Year(), ref.Month(), ref.Day(), 0, 0, 0, 0, abidjan)
	type trip struct {
		h, m int
		dev  string
	}
	for d := 35; d >= 1; d-- {
		day := day0.AddDate(0, 0, -d)
		var trips []trip
		switch day.Weekday() {
		case time.Monday, time.Tuesday, time.Thursday:
			trips = []trip{{6, 58, "dev_102"}, {18, 10, "dev_104"}}
		case time.Wednesday:
			trips = []trip{{6, 58, "dev_102"}, {12, 15, "dev_103"}, {13, 20, "dev_105"}, {18, 10, "dev_104"}}
		case time.Friday:
			trips = []trip{{6, 58, "dev_102"}, {18, 30, "dev_301"}}
		case time.Saturday:
			trips = []trip{{10, 20, "dev_201"}, {11, 5, "dev_501"}, {15, 40, "dev_202"}}
		}
		for i, tr := range trips {
			setNow(day.Add(time.Duration(tr.h)*time.Hour + time.Duration(tr.m+d%5+i)*time.Minute))
			p.mu.Lock()
			op := p.devices[tr.dev].OperatorID
			p.mu.Unlock()
			if op == "op_lagune" {
				if err := p.ensureTitle(awa, op); err != nil {
					return err
				}
			} else if err := p.ensureWallet(awa, 500); err != nil {
				return err
			}
			if _, err := p.demoTap(tr.dev, DemoAwa.CardUID); err != nil {
				return err
			}
		}
	}
	return nil
}

// ensureTitle achète un carnet de 20 trajets si Awa n'a plus de titre actif.
func (p *Platform) ensureTitle(pr Principal, op string) error {
	p.mu.Lock()
	now := p.now()
	has := false
	for _, t := range p.titles {
		if t.TravelerID == pr.TravelerID && t.OperatorID == op && t.TripsRemaining > 0 && now.Before(t.ValidUntil) {
			has = true
		}
	}
	p.mu.Unlock()
	if has {
		return nil
	}
	return p.demoPurchase(pr, "prd_lag_c20")
}

// ensureWallet recharge 2 000 FCFA si le solde passe sous le minimum.
func (p *Platform) ensureWallet(pr Principal, min int64) error {
	p.mu.Lock()
	c := p.travelerCardLocked(pr.TravelerID)
	low := c != nil && c.Balance < min
	p.mu.Unlock()
	if !low {
		return nil
	}
	return p.demoPurchase(pr, "prd_wallet_2000")
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
	capacity := 18
	mode := ModeTaxi
	if l := p.lines[line]; l != nil {
		mode = l.Mode
		switch l.Mode {
		case ModeBus:
			capacity = 60
		case ModeBoat:
			capacity = 80
		case ModeWoro:
			capacity = 4
		}
	}
	if mode == ModeTaxi {
		capacity = 4
	}
	p.vehicles[id] = &Vehicle{ID: id, OperatorID: op, LineID: line, Mode: mode, Plate: plate, Capacity: capacity, ReservableSeats: seats}
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
