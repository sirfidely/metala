package platform

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"
)

// Erreurs métier exposées à l'API.
var (
	ErrNotFound     = errors.New("introuvable")
	ErrForbidden    = errors.New("accès refusé")
	ErrUnauthorized = errors.New("authentification requise")
	ErrInvalid      = errors.New("requête invalide")
	ErrConflict     = errors.New("conflit")
)

// Config regroupe les paramètres du socle.
type Config struct {
	// DevMode active les simulateurs (PSP, cartes virtuelles, OTP affiché).
	DevMode bool
	// CardMasterKey : clé maître de diversification des cartes (SAM en prod).
	CardMasterKey []byte
	// PSPWebhookSecret : secret partagé de signature des webhooks PSP.
	PSPWebhookSecret []byte
	// Seuils de fraîcheur GPS (cahier des charges : 30 s / 120 s).
	FreshAfter   time.Duration
	UnknownAfter time.Duration
	// Vitesse commerciale moyenne utilisée pour l'ETA (km/h).
	AvgSpeedKmh float64
	// Fenêtre anti-passback : un même Pass revalidé dans le même véhicule
	// pendant cette durée n'est pas débité une seconde fois.
	PassbackWindow time.Duration
	// Durée de validité d'un challenge NFC.
	ChallengeTTL time.Duration
}

func DefaultConfig() Config {
	return Config{
		DevMode:          true,
		CardMasterKey:    []byte("metala-dev-card-master-key-change-me"),
		PSPWebhookSecret: []byte("metala-dev-psp-webhook-secret"),
		FreshAfter:       30 * time.Second,
		UnknownAfter:     120 * time.Second,
		AvgSpeedKmh:      18,
		PassbackWindow:   60 * time.Second,
		ChallengeTTL:     15 * time.Second,
	}
}

type otpState struct {
	code     string
	expires  time.Time
	attempts int
}

type session struct {
	p       Principal
	expires time.Time
}

type staffAccount struct {
	username string
	password string // prototype : en clair en mémoire ; prod : argon2id
	p        Principal
}

type challenge struct {
	deviceID string
	expires  time.Time
	used     bool
}

// Platform est le monolithe modulaire Metala (état en mémoire).
type Platform struct {
	mu  sync.Mutex
	cfg Config
	now func() time.Time

	operators map[string]*Operator
	stops     map[string]*Stop
	lines     map[string]*Line
	vehicles  map[string]*Vehicle
	devices   map[string]*Device
	products  map[string]*Product

	telemetry map[string]*Telemetry // dernier point par véhicule

	travelers       map[string]*Traveler
	travelerByPhone map[string]string
	otps            map[string]*otpState
	sessions        map[string]*session
	staff           map[string]*staffAccount

	cards  map[string]*Card
	titles map[string]*Title

	payments      map[string]*Payment
	paymentByPSP  map[string]string
	webhookEvents map[string]bool // idempotence des événements PSP
	validations   []*Validation
	tapResults    map[string]*Validation // idempotence par tap_id
	challenges    map[string]*challenge
	departures    map[string]*Departure
	reservations  map[string]*Reservation
	ledger        []*LedgerEntry
	epoch         int
	order         []string // ordre d'insertion des IDs de titres (historique)
}

func New(cfg Config) *Platform {
	p := &Platform{cfg: cfg, now: time.Now}
	p.resetStateLocked()
	return p
}

// resetStateLocked remet l'état à vide (appelant : verrou tenu ou objet neuf).
func (p *Platform) resetStateLocked() {
	p.operators = map[string]*Operator{}
	p.stops = map[string]*Stop{}
	p.lines = map[string]*Line{}
	p.vehicles = map[string]*Vehicle{}
	p.devices = map[string]*Device{}
	p.products = map[string]*Product{}
	p.telemetry = map[string]*Telemetry{}
	p.travelers = map[string]*Traveler{}
	p.travelerByPhone = map[string]string{}
	p.otps = map[string]*otpState{}
	p.sessions = map[string]*session{}
	p.staff = map[string]*staffAccount{}
	p.cards = map[string]*Card{}
	p.titles = map[string]*Title{}
	p.payments = map[string]*Payment{}
	p.paymentByPSP = map[string]string{}
	p.webhookEvents = map[string]bool{}
	p.validations = nil
	p.tapResults = map[string]*Validation{}
	p.challenges = map[string]*challenge{}
	p.departures = map[string]*Departure{}
	p.reservations = map[string]*Reservation{}
	p.ledger = nil
}

// Reset remet la démonstration dans son état initial (mode démo uniquement).
// Les sessions ouvertes sont invalidées ; Epoch permet aux simulateurs de
// reconstruire leurs voyageurs fictifs.
func (p *Platform) Reset() error {
	p.mu.Lock()
	p.resetStateLocked()
	p.epoch++
	p.mu.Unlock()
	return p.Seed()
}

// Epoch change à chaque réinitialisation.
func (p *Platform) Epoch() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.epoch
}

func (p *Platform) Config() Config { return p.cfg }

// SetClock permet aux tests de contrôler le temps.
func (p *Platform) SetClock(now func() time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.now = now
}

func (p *Platform) Now() time.Time {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.now()
}

func newID(prefix string) string {
	return prefix + "_" + randHex(8)
}

func randHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Sprintf("crypto/rand: %v", err))
	}
	return hex.EncodeToString(b)
}

// canAccessOperator applique l'isolation stricte par operator_id.
func canAccessOperator(pr Principal, operatorID string) bool {
	switch pr.Role {
	case RolePlatformAdmin:
		return true
	case RoleOperatorAdmin, RoleDevice:
		return operatorID != "" && pr.OperatorID == operatorID
	}
	return false
}

// resolveOperatorScope renvoie l'opérateur à filtrer ("" = tous, admin seulement).
func resolveOperatorScope(pr Principal, requested string) (string, error) {
	switch pr.Role {
	case RolePlatformAdmin:
		return requested, nil
	case RoleOperatorAdmin:
		if requested != "" && requested != pr.OperatorID {
			return "", ErrForbidden
		}
		return pr.OperatorID, nil
	}
	return "", ErrForbidden
}
