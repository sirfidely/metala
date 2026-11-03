package platform

import (
	"crypto/rand"
	"crypto/subtle"
	"fmt"
	"math/big"
	"regexp"
	"strings"
	"time"
)

const (
	sessionTTL     = 12 * time.Hour
	otpTTL         = 5 * time.Minute
	otpMaxAttempts = 5
)

var phoneRe = regexp.MustCompile(`^\+225\d{10}$`)

// NormalizePhone accepte "07 07 00 00 00", "0707000000" ou "+2250707000000".
func NormalizePhone(raw string) (string, error) {
	s := strings.NewReplacer(" ", "", "-", "", ".", "").Replace(raw)
	if strings.HasPrefix(s, "00225") {
		s = "+" + s[2:]
	}
	if !strings.HasPrefix(s, "+") {
		s = "+225" + s
	}
	if !phoneRe.MatchString(s) {
		return "", fmt.Errorf("%w : numéro ivoirien attendu (10 chiffres)", ErrInvalid)
	}
	return s, nil
}

// RequestOTP génère un code à 6 chiffres. En mode dev, le code est renvoyé
// pour être affiché (aucun SMS n'est envoyé par le prototype).
func (p *Platform) RequestOTP(rawPhone string) (phone, code string, err error) {
	phone, err = NormalizePhone(rawPhone)
	if err != nil {
		return "", "", err
	}
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		return "", "", err
	}
	code = fmt.Sprintf("%06d", n.Int64())
	p.mu.Lock()
	defer p.mu.Unlock()
	p.otps[phone] = &otpState{code: code, expires: p.now().Add(otpTTL)}
	return phone, code, nil
}

// VerifyOTP valide le code et ouvre une session voyageur. Un compte et un
// Metala Pass virtuel sont créés au premier login.
func (p *Platform) VerifyOTP(rawPhone, code, name string) (string, *Traveler, error) {
	phone, err := NormalizePhone(rawPhone)
	if err != nil {
		return "", nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	st, ok := p.otps[phone]
	if !ok || p.now().After(st.expires) {
		return "", nil, fmt.Errorf("%w : code expiré, redemandez un code", ErrUnauthorized)
	}
	st.attempts++
	if st.attempts > otpMaxAttempts {
		delete(p.otps, phone)
		return "", nil, fmt.Errorf("%w : trop de tentatives", ErrUnauthorized)
	}
	if subtle.ConstantTimeCompare([]byte(st.code), []byte(code)) != 1 {
		return "", nil, fmt.Errorf("%w : code incorrect", ErrUnauthorized)
	}
	delete(p.otps, phone)
	t := p.travelerLocked(phone, name)
	tok := p.newSessionLocked(Principal{Role: RoleTraveler, TravelerID: t.ID, Name: t.Name})
	return tok, t, nil
}

func (p *Platform) travelerLocked(phone, name string) *Traveler {
	if id, ok := p.travelerByPhone[phone]; ok {
		t := p.travelers[id]
		if name != "" && t.Name == "" {
			t.Name = name
		}
		return t
	}
	t := &Traveler{ID: newID("trv"), Phone: phone, Name: name, CreatedAt: p.now()}
	p.travelers[t.ID] = t
	p.travelerByPhone[phone] = t.ID
	p.issueCardLocked(t.ID)
	return t
}

func (p *Platform) issueCardLocked(travelerID string) *Card {
	c := &Card{UID: strings.ToUpper(randHex(7)), TravelerID: travelerID, Status: CardActive, IssuedAt: p.now()}
	p.cards[c.UID] = c
	return c
}

func (p *Platform) newSessionLocked(pr Principal) string {
	tok := randHex(24)
	p.sessions[tok] = &session{p: pr, expires: p.now().Add(sessionTTL)}
	return tok
}

// StaffLogin authentifie un administrateur opérateur ou Metala.
func (p *Platform) StaffLogin(username, password string) (string, Principal, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	acc, ok := p.staff[strings.ToLower(strings.TrimSpace(username))]
	if !ok || subtle.ConstantTimeCompare([]byte(acc.password), []byte(password)) != 1 {
		return "", Principal{}, fmt.Errorf("%w : identifiants invalides", ErrUnauthorized)
	}
	return p.newSessionLocked(acc.p), acc.p, nil
}

// DeviceLogin ouvre une session pour un terminal Metala Scan enrôlé.
func (p *Platform) DeviceLogin(deviceID, secret string) (string, Principal, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	d, ok := p.devices[deviceID]
	if !ok || subtle.ConstantTimeCompare([]byte(d.token), []byte(secret)) != 1 {
		return "", Principal{}, fmt.Errorf("%w : terminal inconnu", ErrUnauthorized)
	}
	pr := Principal{Role: RoleDevice, DeviceID: d.ID, OperatorID: d.OperatorID, Name: d.ID}
	return p.newSessionLocked(pr), pr, nil
}

// Authenticate résout un jeton de session.
func (p *Platform) Authenticate(token string) (Principal, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	s, ok := p.sessions[token]
	if !ok || p.now().After(s.expires) {
		return Principal{}, ErrUnauthorized
	}
	if s.p.Role == RoleDevice {
		if d := p.devices[s.p.DeviceID]; d == nil || d.Frozen {
			return Principal{}, fmt.Errorf("%w : terminal gelé", ErrForbidden)
		}
	}
	return s.p, nil
}

func (p *Platform) Logout(token string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.sessions, token)
}
