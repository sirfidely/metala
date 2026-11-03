package platform

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
)

// Simulation du protocole carte ↔ terminal ↔ serveur (DEC-05/06) :
//
//  1. le terminal demande un challenge aléatoire au serveur ;
//  2. la carte calcule une preuve dynamique = HMAC(clé diversifiée, challenge‖UID)
//     (sur une vraie DESFire EV3 : authentification mutuelle AES) ;
//  3. le terminal transmet UID + challenge + preuve au serveur en HTTPS ;
//  4. le serveur vérifie, choisit le titre, débite une seule fois et journalise.
//
// L'UID seul n'est jamais suffisant ; un challenge ne sert qu'une fois.

// cardKey dérive la clé diversifiée d'une carte (KDF HMAC-SHA256).
func (p *Platform) cardKey(uid string) []byte {
	m := hmac.New(sha256.New, p.cfg.CardMasterKey)
	m.Write([]byte("metala-card-kdf|" + uid))
	return m.Sum(nil)
}

// CardProof calcule la réponse d'une carte authentique à un challenge.
func CardProof(key []byte, challengeHex, uid string) string {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(challengeHex + "|" + uid))
	return hex.EncodeToString(m.Sum(nil))
}

// SimulateCard joue le rôle de la puce (mode dev uniquement).
func (p *Platform) SimulateCard(uid, challengeHex string) (string, error) {
	p.mu.Lock()
	_, ok := p.cards[uid]
	p.mu.Unlock()
	if !ok {
		return "", ErrNotFound
	}
	return CardProof(p.cardKey(uid), challengeHex, uid), nil
}

// IssueChallenge délivre un challenge à usage unique au terminal.
func (p *Platform) IssueChallenge(pr Principal) (string, time.Time, error) {
	if pr.Role != RoleDevice {
		return "", time.Time{}, ErrForbidden
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	for k, c := range p.challenges { // purge des challenges expirés
		if now.After(c.expires) {
			delete(p.challenges, k)
		}
	}
	ch := randHex(16)
	exp := now.Add(p.cfg.ChallengeTTL)
	p.challenges[ch] = &challenge{deviceID: pr.DeviceID, expires: exp}
	return ch, exp, nil
}

// TapRequest est envoyée par Metala Scan à chaque présentation de carte.
type TapRequest struct {
	TapID     string `json:"tap_id"` // clé d'idempotence générée par le terminal
	CardUID   string `json:"card_uid"`
	Challenge string `json:"challenge"`
	Proof     string `json:"proof"`
}

func (p *Platform) reject(v *Validation, reason, msg string) *Validation {
	v.Status, v.Reason, v.Message = ValRejected, reason, msg
	return v
}

// Validate décide de la montée. La décision est toujours prise ici, côté
// serveur ; le terminal ne fait qu'afficher le résultat.
func (p *Platform) Validate(pr Principal, req TapRequest) (*Validation, error) {
	if pr.Role != RoleDevice {
		return nil, ErrForbidden
	}
	if req.TapID == "" || len(req.TapID) > 64 {
		return nil, fmt.Errorf("%w : tap_id requis", ErrInvalid)
	}
	req.CardUID = strings.ToUpper(strings.TrimSpace(req.CardUID))
	p.mu.Lock()
	defer p.mu.Unlock()

	tapKey := pr.DeviceID + "|" + req.TapID
	if prev, ok := p.tapResults[tapKey]; ok {
		cp := *prev // rejeu réseau du même tap : même réponse, aucun nouveau débit
		return &cp, nil
	}

	d := p.devices[pr.DeviceID]
	if d == nil || d.Frozen {
		return nil, fmt.Errorf("%w : terminal gelé", ErrForbidden)
	}
	veh := p.vehicles[d.VehicleID]
	now := p.now()
	v := &Validation{
		ID: newID("val"), TapID: req.TapID, CardUID: req.CardUID, DeviceID: d.ID,
		VehicleID: veh.ID, OperatorID: veh.OperatorID, LineID: veh.LineID, At: now,
	}
	record := func(v *Validation) (*Validation, error) {
		p.validations = append(p.validations, v)
		p.tapResults[tapKey] = v
		cp := *v
		return &cp, nil
	}

	// 1. Authentification de la carte.
	ch := p.challenges[req.Challenge]
	switch {
	case req.Proof == "" || req.Challenge == "":
		return record(p.reject(v, "uid_only", "Refusé — carte non authentifiée"))
	case ch == nil || ch.deviceID != d.ID:
		return record(p.reject(v, "bad_challenge", "Refusé — challenge inconnu"))
	case ch.used:
		return record(p.reject(v, "replay", "Refusé — rejeu détecté"))
	case now.After(ch.expires):
		return record(p.reject(v, "challenge_expired", "Refusé — délai dépassé, représentez la carte"))
	}
	ch.used = true
	card := p.cards[req.CardUID]
	if card == nil {
		return record(p.reject(v, "unknown_card", "Refusé — carte inconnue"))
	}
	if !hmac.Equal([]byte(CardProof(p.cardKey(card.UID), req.Challenge, card.UID)), []byte(req.Proof)) {
		return record(p.reject(v, "bad_proof", "Refusé — carte non authentique"))
	}
	v.TravelerID = card.TravelerID
	if card.Status != CardActive {
		return record(p.reject(v, "card_revoked", "Refusé — carte révoquée"))
	}

	// 2. Anti-passback : même carte, même véhicule, fenêtre courte.
	for i := len(p.validations) - 1; i >= 0; i-- {
		prev := p.validations[i]
		if now.Sub(prev.At) > p.cfg.PassbackWindow {
			break
		}
		if prev.CardUID == card.UID && prev.VehicleID == veh.ID && prev.Status == ValAccepted {
			v.Status, v.TitleID, v.TitleName = ValAlready, prev.TitleID, prev.TitleName
			v.TripsRemaining, v.ValidUntil = prev.TripsRemaining, prev.ValidUntil
			v.Message = fmt.Sprintf("Déjà validé il y a %d s — aucun débit", int(now.Sub(prev.At).Seconds()))
			return record(v)
		}
	}

	// 3. Choix du titre : forfait valide d'abord, puis titre à trajets
	// expirant le plus tôt. Uniquement les titres de l'opérateur du véhicule.
	var monthly, trips []*Title
	expired := false
	for _, t := range p.titles {
		if t.TravelerID != card.TravelerID || t.OperatorID != veh.OperatorID {
			continue
		}
		if now.Before(t.ValidFrom) || now.After(t.ValidUntil) {
			expired = true
			continue
		}
		if t.Kind == ProductMonthly {
			monthly = append(monthly, t)
		} else if t.TripsRemaining > 0 {
			trips = append(trips, t)
		}
	}
	byExpiry := func(s []*Title) {
		sort.Slice(s, func(i, j int) bool { return s[i].ValidUntil.Before(s[j].ValidUntil) })
	}
	byExpiry(monthly)
	byExpiry(trips)

	switch {
	case len(monthly) > 0:
		t := monthly[0]
		v.Status, v.TitleID, v.TitleName = ValAccepted, t.ID, t.Name
		vu := t.ValidUntil
		v.ValidUntil = &vu
		v.Message = "Validé — forfait jusqu'au " + vu.Format("02/01")
	case len(trips) > 0:
		t := trips[0]
		value := t.ValueRemaining / int64(t.TripsRemaining) // le dernier trajet absorbe l'arrondi
		t.TripsRemaining--
		t.ValueRemaining -= value
		op := p.operators[veh.OperatorID]
		commission := int64(math.Round(float64(value) * op.CommissionRate))
		p.postLocked("usage", veh.OperatorID, v.ID,
			LedgerLine{Account: AccTitleLiability, Debit: value},
			LedgerLine{Account: AccOperatorRevenue, Credit: value - commission},
			LedgerLine{Account: AccMetalaCommission, Credit: commission})
		rem := t.TripsRemaining
		v.Status, v.TitleID, v.TitleName, v.TripsRemaining, v.Debited = ValAccepted, t.ID, t.Name, &rem, value
		switch rem {
		case 0:
			v.Message = "Validé — dernier trajet"
		case 1:
			v.Message = "Validé — 1 trajet restant"
		default:
			v.Message = fmt.Sprintf("Validé — %d trajets restants", rem)
		}
	case expired:
		return record(p.reject(v, "title_expired", "Refusé — titre expiré"))
	default:
		return record(p.reject(v, "no_title", "Refusé — aucun titre valide pour ce réseau"))
	}
	return record(v)
}

// RevokeCard révoque un Pass perdu ou compromis (admin Metala).
func (p *Platform) RevokeCard(pr Principal, uid string) error {
	if pr.Role != RolePlatformAdmin {
		return ErrForbidden
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	c := p.cards[strings.ToUpper(uid)]
	if c == nil {
		return ErrNotFound
	}
	c.Status = CardRevoked
	return nil
}

// FreezeDevice gèle ou dégèle un terminal (opérateur propriétaire ou admin).
func (p *Platform) FreezeDevice(pr Principal, deviceID string, frozen bool) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	d := p.devices[deviceID]
	if d == nil {
		return ErrNotFound
	}
	if pr.Role == RoleDevice || !canAccessOperator(pr, d.OperatorID) {
		return ErrForbidden
	}
	d.Frozen = frozen
	return nil
}
