// Package platform contient le socle commun Metala : identité, référentiel
// réseau, temps réel, billettique, validation, réservation, flotte et
// rapprochement. Le prototype garde l'état en mémoire derrière un verrou
// unique (sémantique transactionnelle simple) ; la cible de production est
// PostgreSQL/PostGIS (voir docs/schema.sql).
package platform

import "time"

// Rôles RBAC.
type Role string

const (
	RoleTraveler      Role = "traveler"
	RoleDevice        Role = "device"         // terminal Metala Scan embarqué
	RoleOperatorAdmin Role = "operator_admin" // portail Metala Fleet
	RolePlatformAdmin Role = "platform_admin" // équipe Metala
)

// Principal est l'identité authentifiée d'une requête.
type Principal struct {
	Role       Role   `json:"role"`
	TravelerID string `json:"traveler_id,omitempty"`
	OperatorID string `json:"operator_id,omitempty"`
	DeviceID   string `json:"device_id,omitempty"`
	DriverID   string `json:"driver_id,omitempty"`
	ShiftID    string `json:"shift_id,omitempty"`
	Name       string `json:"name,omitempty"`
}

// Catégorie d'opérateur : Metala sert aussi bien l'entreprise publique que
// le propriétaire d'un seul taxi.
type OperatorKind string

const (
	OpPublic    OperatorKind = "public"    // entreprise publique de transport
	OpPrivate   OperatorKind = "prive"     // compagnie privée, navettes
	OpArtisanal OperatorKind = "artisanal" // gbaka, woro-woro (syndicats, propriétaires)
	OpTaxi      OperatorKind = "taxi"      // taxis compteurs
)

type Operator struct {
	ID             string       `json:"id"`
	Name           string       `json:"name"`
	Kind           OperatorKind `json:"kind"`
	Color          string       `json:"color"`
	CommissionRate float64      `json:"commission_rate"` // ex. 0.015 = 1,5 %
}

type Stop struct {
	ID   string  `json:"id"`
	Name string  `json:"name"`
	Lat  float64 `json:"lat"`
	Lon  float64 `json:"lon"`
}

type LatLon [2]float64 // [lat, lon]

// Mode de transport : Metala fédère tout transport collectif.
type Mode string

const (
	ModeBus     Mode = "bus"     // autobus
	ModeGbaka   Mode = "gbaka"   // minibus
	ModeBoat    Mode = "bateau"  // bateau-bus lagunaire
	ModeShuttle Mode = "navette" // navette (entreprise, privée)
	ModeWoro    Mode = "woro"    // woro-woro (taxi collectif)
	ModeTaxi    Mode = "taxi"    // taxi compteur : pas de ligne, prix au compteur
)

type Line struct {
	ID         string   `json:"id"`
	OperatorID string   `json:"operator_id"`
	Mode       Mode     `json:"mode"`
	Code       string   `json:"code"`
	Name       string   `json:"name"`
	Color      string   `json:"color"`
	StopIDs    []string `json:"stop_ids"`
	Shape      []LatLon `json:"shape"`
	// Offre de service (horaires théoriques) : un départ de chaque terminus
	// toutes les HeadwayMin minutes entre FirstDep et LastDep.
	HeadwayMin int     `json:"headway_min"`
	FirstDep   string  `json:"first_dep"` // "05:00"
	LastDep    string  `json:"last_dep"`  // "22:00"
	SpeedKmh   float64 `json:"speed_kmh"` // vitesse commerciale
	Reservable bool    `json:"reservable"`
	// Minutes depuis le départ du terminus (sens aller) pour chaque arrêt.
	StopMinutes []float64 `json:"stop_minutes"`
	// distances cumulées (m) le long du tracé, calculées au chargement
	shapeDist []float64
	stopDist  map[string]float64
}

type Vehicle struct {
	ID              string `json:"id"`
	OperatorID      string `json:"operator_id"`
	LineID          string `json:"line_id"` // vide pour un taxi compteur
	Mode            Mode   `json:"mode"`
	Plate           string `json:"plate"`
	Capacity        int    `json:"capacity"`
	ReservableSeats int    `json:"reservable_seats"`
}

type Device struct {
	ID         string `json:"id"`
	OperatorID string `json:"operator_id"`
	VehicleID  string `json:"vehicle_id"`
	Frozen     bool   `json:"frozen"`
	token      string
}

// Telemetry est un point GPS reçu d'un véhicule.
type Telemetry struct {
	VehicleID  string    `json:"vehicle_id"`
	Lat        float64   `json:"lat"`
	Lon        float64   `json:"lon"`
	SpeedKmh   float64   `json:"speed_kmh"`
	Heading    float64   `json:"heading"`
	Direction  int       `json:"direction"` // +1 aller, -1 retour
	RecordedAt time.Time `json:"recorded_at"`
	ReceivedAt time.Time `json:"received_at"`
	Source     string    `json:"source"` // "device" ou "simulator"
}

type Freshness string

const (
	FreshnessFresh   Freshness = "fresh"   // < 30 s
	FreshnessDelayed Freshness = "delayed" // 30–120 s
	FreshnessUnknown Freshness = "unknown" // > 120 s ou jamais reçu
)

type Traveler struct {
	ID        string    `json:"id"`
	Phone     string    `json:"phone"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
	Home      *Place    `json:"home,omitempty"`
	Work      *Place    `json:"work,omitempty"`
	Budget    int64     `json:"budget"` // budget transport mensuel (FCFA), 0 = non défini
}

// Place est un lieu quelconque (domicile, travail, repère) : pas forcément un arrêt.
type Place struct {
	ID   string  `json:"id,omitempty"`
	Name string  `json:"name"`
	Kind string  `json:"kind,omitempty"` // home | work | landmark | stop
	Lat  float64 `json:"lat"`
	Lon  float64 `json:"lon"`
}

type CardStatus string

const (
	CardActive  CardStatus = "active"
	CardRevoked CardStatus = "revoked"
)

// Card représente un Metala Pass (carte NFC passive de classe DESFire EV3).
// La clé diversifiée n'est jamais stockée : elle est dérivée de la clé maître
// et de l'UID (KDF), comme dans un SAM.
type Card struct {
	UID        string     `json:"uid"`
	TravelerID string     `json:"traveler_id"`
	Status     CardStatus `json:"status"`
	IssuedAt   time.Time  `json:"issued_at"`
	// Porte-monnaie stocké sur la puce (fichier valeur DESFire). Il peut être
	// débité hors ligne par un valideur ; la puce incrémente son compteur et
	// signe chaque débit.
	Balance int64 `json:"balance"`
	Counter int   `json:"counter"`
	// Journal de la puce : débits hors ligne pas encore remontés au serveur
	// (connu ici uniquement parce que la puce est simulée).
	pendingOffline map[int]int64
}

type ProductKind string

const (
	ProductSingle  ProductKind = "single"  // ticket unitaire
	ProductCarnet  ProductKind = "carnet"  // N trajets
	ProductMonthly ProductKind = "monthly" // forfait illimité
	ProductWallet  ProductKind = "wallet"  // recharge du porte-monnaie Metala
)

type Product struct {
	ID           string      `json:"id"`
	OperatorID   string      `json:"operator_id"`
	Name         string      `json:"name"`
	Kind         ProductKind `json:"kind"`
	Trips        int         `json:"trips"`
	Price        int64       `json:"price"` // FCFA
	ValidityDays int         `json:"validity_days"`
}

type Title struct {
	ID             string      `json:"id"`
	TravelerID     string      `json:"traveler_id"`
	ProductID      string      `json:"product_id"`
	OperatorID     string      `json:"operator_id"`
	Name           string      `json:"name"`
	Kind           ProductKind `json:"kind"`
	TripsTotal     int         `json:"trips_total"`
	TripsRemaining int         `json:"trips_remaining"`
	Price          int64       `json:"price"`
	ValueRemaining int64       `json:"value_remaining"` // FCFA non encore consommés
	ValidFrom      time.Time   `json:"valid_from"`
	ValidUntil     time.Time   `json:"valid_until"`
	PaymentID      string      `json:"payment_id"`
}

type PaymentStatus string

const (
	PaymentPending   PaymentStatus = "pending"
	PaymentSucceeded PaymentStatus = "succeeded"
	PaymentFailed    PaymentStatus = "failed"
)

type Payment struct {
	ID         string        `json:"id"`
	TravelerID string        `json:"traveler_id"`
	ProductID  string        `json:"product_id"`
	OperatorID string        `json:"operator_id"`
	Amount     int64         `json:"amount"`
	Status     PaymentStatus `json:"status"`
	PSPRef     string        `json:"psp_ref"`
	TitleID    string        `json:"title_id,omitempty"`
	CreatedAt  time.Time     `json:"created_at"`
	SettledAt  *time.Time    `json:"settled_at,omitempty"`
}

type ValidationStatus string

const (
	ValAccepted ValidationStatus = "accepted"
	ValAlready  ValidationStatus = "already_validated" // anti double débit
	ValRejected ValidationStatus = "rejected"
)

type Validation struct {
	ID             string           `json:"id"`
	TapID          string           `json:"tap_id"`
	CardUID        string           `json:"card_uid"`
	TravelerID     string           `json:"traveler_id,omitempty"`
	TitleID        string           `json:"title_id,omitempty"`
	TitleName      string           `json:"title_name,omitempty"`
	DeviceID       string           `json:"device_id"`
	VehicleID      string           `json:"vehicle_id"`
	OperatorID     string           `json:"operator_id"`
	LineID         string           `json:"line_id"`
	At             time.Time        `json:"at"`
	Status         ValidationStatus `json:"status"`
	Reason         string           `json:"reason,omitempty"`
	Message        string           `json:"message"`
	TripsRemaining *int             `json:"trips_remaining,omitempty"`
	ValidUntil     *time.Time       `json:"valid_until,omitempty"`
	Debited        int64            `json:"debited"`           // valeur reconnue (FCFA)
	Source         string           `json:"source,omitempty"`  // title | wallet
	Channel        string           `json:"channel,omitempty"` // card | phone
	DriverID       string           `json:"driver_id,omitempty"`
	Offline        bool             `json:"offline,omitempty"`
	WalletBalance  *int64           `json:"wallet_balance,omitempty"`
}

type Departure struct {
	ID              string    `json:"id"`
	LineID          string    `json:"line_id"`
	OperatorID      string    `json:"operator_id"`
	VehicleID       string    `json:"vehicle_id"`
	DepartAt        time.Time `json:"depart_at"`
	ReservableSeats int       `json:"reservable_seats"`
	Reserved        int       `json:"reserved"`
}

type Reservation struct {
	ID          string    `json:"id"`
	TravelerID  string    `json:"traveler_id"`
	DepartureID string    `json:"departure_id"`
	OperatorID  string    `json:"operator_id"`
	Status      string    `json:"status"` // confirmed | cancelled
	CreatedAt   time.Time `json:"created_at"`
}

// Comptes du grand livre (partie double).
const (
	AccPSPClearing      = "psp_clearing"      // fonds encaissés chez le PSP habilité
	AccTitleLiability   = "titles_liability"  // titres vendus non consommés
	AccOperatorRevenue  = "operator_revenue"  // recette du transporteur
	AccMetalaCommission = "metala_commission" // commission Metala
	AccWalletLiability  = "wallet_liability"  // soldes des porte-monnaie voyageurs
)

type LedgerLine struct {
	Account string `json:"account"`
	Debit   int64  `json:"debit"`
	Credit  int64  `json:"credit"`
}

type LedgerEntry struct {
	ID         string       `json:"id"`
	At         time.Time    `json:"at"`
	Kind       string       `json:"kind"` // sale | usage
	OperatorID string       `json:"operator_id"`
	Ref        string       `json:"ref"` // payment_id ou validation_id
	Lines      []LedgerLine `json:"lines"`
}
