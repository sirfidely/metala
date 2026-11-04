package platform

import (
	"errors"
	"testing"
)

func TestScanReservationsAndBoarding(t *testing.T) {
	p, _ := setup(t)
	dev := device(p, "dev_101")
	deps, err := p.VehicleReservations(dev)
	if err != nil || len(deps) == 0 || len(deps[0].Passengers) != 3 {
		t.Fatalf("réservations du véhicule : %+v %v", deps, err)
	}
	if deps[0].Passengers[0].Name == "" || deps[0].Passengers[0].BoardedAt != nil {
		t.Fatalf("passager : %+v", deps[0].Passengers[0])
	}
	tap(t, p, dev, DemoAwa.CardUID, "board")
	deps, _ = p.VehicleReservations(dev)
	boarded := 0
	for _, ps := range deps[0].Passengers {
		if ps.BoardedAt != nil {
			boarded++
		}
	}
	if boarded != 1 {
		t.Fatalf("Awa doit être à bord après avoir payé : %+v", deps[0].Passengers)
	}
	if _, err := p.VehicleReservations(awa(p)); !errors.Is(err, ErrForbidden) {
		t.Fatal("un voyageur ne voit pas les réservations d'un véhicule")
	}
}

func TestShiftTakings(t *testing.T) {
	p, _ := setup(t)
	_, pr, err := p.DriverLogin("0101010101", DemoDriverPIN, "veh_101")
	if err != nil {
		t.Fatal(err)
	}
	v := tap(t, p, pr, DemoAwa.CardUID, "tk")
	sv, _ := p.ShiftSummary(pr)
	if sv.VehicleToday.Revenue < v.Debited || sv.LineToday.Revenue < sv.VehicleToday.Revenue || sv.Reservations != 3 {
		t.Fatalf("recette du jour : %+v", sv)
	}
}

func TestOperatorSelfRegistrationAndNetwork(t *testing.T) {
	p, _ := setup(t)
	if _, _, err := p.RegisterOperator(NewOperator{Name: "Transports Eburnea", Kind: OpPrivate, AdminEmail: "x", Password: "court"}); !errors.Is(err, ErrInvalid) {
		t.Fatal("inscription incomplète acceptée")
	}
	_, pr, err := p.RegisterOperator(NewOperator{Name: "Transports Eburnea", Kind: OpPrivate, AdminEmail: "direction@eburnea.ci", Password: "motdepasse"})
	if err != nil || pr.Role != RoleOperatorAdmin {
		t.Fatalf("inscription : %+v %v", pr, err)
	}
	st, err := p.AddStop(pr, NewStop{Name: "Marcory Zone 4", Lat: 5.2950, Lon: -3.9800})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.AddStop(pr, NewStop{Name: "Doublon", Lat: 5.2951, Lon: -3.9801}); !errors.Is(err, ErrConflict) {
		t.Fatal("arrêt en double accepté")
	}
	l, err := p.AddLine(pr, NewLine{Code: "E1", Name: "Marcory ↔ Plateau", Mode: ModeBus, StopIDs: []string{st.ID, "st_plateau_cite"},
		HeadwayMin: 15, FirstDep: "06:00", LastDep: "20:00", Fare: 350, Reservable: true})
	if err != nil || l.OperatorID != pr.OperatorID || len(l.StopMinutes) != 2 {
		t.Fatalf("ligne : %+v %v", l, err)
	}
	if _, err := p.AddLine(pr, NewLine{Code: "E1", Name: "Doublon", Mode: ModeBus, StopIDs: []string{st.ID, "st_ivoire"}, HeadwayMin: 15, FirstDep: "06:00", LastDep: "20:00", Fare: 350}); !errors.Is(err, ErrConflict) {
		t.Fatal("code de ligne en double accepté")
	}
	prods, _ := p.OperatorProducts(pr, "")
	if len(prods) != 1 || prods[0].Price != 350 {
		t.Fatalf("le tarif de la ligne crée un ticket : %+v", prods)
	}
	c, err := p.AddProduct(pr, ProductInput{Name: "Carnet 10", Kind: ProductCarnet, Trips: 10, Price: 3000, ValidityDays: 30})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.UpdatePrice(pr, c.ID, 2900); err != nil {
		t.Fatal(err)
	}
	_, lagune, _ := p.StaffLogin("fleet@lagune.demo", DemoStaffPassword)
	if _, err := p.UpdatePrice(lagune, c.ID, 1); !errors.Is(err, ErrForbidden) {
		t.Fatal("une compagnie modifie le tarif d'une autre")
	}
	// La nouvelle ligne est aussitôt utilisable par le calculateur d'itinéraires.
	js, _ := p.PlanJourneys(JourneyQuery{From: Place{Lat: 5.2955, Lon: -3.9805}, To: Place{Lat: 5.3268, Lon: -4.0185}})
	found := false
	for _, j := range js {
		for _, lg := range j.Legs {
			if lg.LineID == l.ID {
				found = true
			}
		}
	}
	if !found {
		t.Fatalf("la ligne E1 doit apparaître dans les trajets : %+v", js)
	}
}

func TestDriverActivity(t *testing.T) {
	p, _ := setup(t)
	_, lagune, _ := p.StaffLogin("fleet@lagune.demo", DemoStaffPassword)
	_, ebene, _ := p.StaffLogin("fleet@ebene.demo", DemoStaffPassword)
	tap(t, p, device(p, "dev_101"), DemoAwa.CardUID, "da") // conducteur en service : Ibrahim Koné
	a, err := p.DriverActivity(lagune, "drv_kone")
	if err != nil || a.Today.Passengers < 1 || len(a.Shifts) == 0 {
		t.Fatalf("activité : %+v %v", a, err)
	}
	if _, err := p.DriverActivity(ebene, "drv_kone"); !errors.Is(err, ErrForbidden) {
		t.Fatal("une compagnie voit les conducteurs d'une autre")
	}
}
