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

// Porte-monnaie Metala rattaché au Pass.
//
// Le solde vit sur la puce (fichier valeur sécurisé). En ligne, le serveur
// débite et met la puce à jour ; hors ligne, le valideur débite directement
// la puce, qui incrémente son compteur et signe la transaction. Le valideur
// conserve ces transactions et les remonte dès que le réseau revient.
// La double dépense est impossible : on ne peut dépenser que le solde
// prépayé présent sur la carte.

// WalletCap est le plafond du porte-monnaie (à valider avec le PSP et au
// regard de l'Instruction BCEAO n° 001-01-2024 sur la monnaie électronique).
const WalletCap int64 = 20000

func (p *Platform) travelerCardLocked(travelerID string) *Card {
	var best *Card
	for _, c := range p.cards {
		if c.TravelerID == travelerID && c.Status == CardActive && (best == nil || c.IssuedAt.Before(best.IssuedAt)) {
			best = c
		}
	}
	return best
}

func (p *Platform) creditWalletLocked(pay *Payment) {
	c := p.travelerCardLocked(pay.TravelerID)
	c.Balance += pay.Amount
	p.postLocked("wallet_load", "", pay.ID,
		LedgerLine{Account: AccPSPClearing, Debit: pay.Amount},
		LedgerLine{Account: AccWalletLiability, Credit: pay.Amount})
}

// FareFor renvoie le tarif d'un trajet payé au porte-monnaie (ticket unitaire de l'opérateur).
func (p *Platform) fareLocked(operatorID string) int64 {
	var fare int64
	for _, pr := range p.products {
		if pr.OperatorID == operatorID && pr.Kind == ProductSingle && (fare == 0 || pr.Price < fare) {
			fare = pr.Price
		}
	}
	return fare
}

// postWalletUsageLocked reconnaît un trajet payé au porte-monnaie.
func (p *Platform) postWalletUsageLocked(operatorID, ref string, amount int64) {
	op := p.operators[operatorID]
	commission := int64(math.Round(float64(amount) * op.CommissionRate))
	p.postLocked("usage", operatorID, ref,
		LedgerLine{Account: AccWalletLiability, Debit: amount},
		LedgerLine{Account: AccOperatorRevenue, Credit: amount - commission},
		LedgerLine{Account: AccMetalaCommission, Credit: commission})
}

// OfflineTx est un débit hors ligne signé par la puce.
type OfflineTx struct {
	CardUID  string    `json:"card_uid"`
	Counter  int       `json:"counter"`
	Amount   int64     `json:"amount"`
	DeviceID string    `json:"device_id"`
	At       time.Time `json:"at"`
	Cert     string    `json:"cert"`
	Balance  int64     `json:"balance"` // solde de la puce après débit
}

func offlineCert(key []byte, tx OfflineTx) string {
	m := hmac.New(sha256.New, key)
	fmt.Fprintf(m, "offline|%s|%d|%d|%s|%d", tx.CardUID, tx.Counter, tx.Amount, tx.DeviceID, tx.At.Unix())
	return hex.EncodeToString(m.Sum(nil))
}

// ChipOfflineDebit simule la puce : débit local, sans serveur (mode démo).
func (p *Platform) ChipOfflineDebit(uid, deviceID string, amount int64) (*OfflineTx, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	c := p.cards[strings.ToUpper(uid)]
	if c == nil {
		return nil, ErrNotFound
	}
	if amount <= 0 {
		return nil, fmt.Errorf("%w : montant invalide", ErrInvalid)
	}
	if c.Balance < amount {
		return nil, fmt.Errorf("%w : solde insuffisant sur la carte (%d FCFA)", ErrConflict, c.Balance)
	}
	c.Balance -= amount
	c.Counter++
	if c.pendingOffline == nil {
		c.pendingOffline = map[int]int64{}
	}
	c.pendingOffline[c.Counter] = amount
	tx := OfflineTx{CardUID: c.UID, Counter: c.Counter, Amount: amount, DeviceID: deviceID, At: p.now().Truncate(time.Second), Balance: c.Balance}
	tx.Cert = offlineCert(p.cardKey(c.UID), tx)
	return &tx, nil
}

// ScanConfig est téléchargée par le valideur quand il est en ligne : tarif
// porte-monnaie et liste noire des cartes bloquées, pour décider hors ligne.
type ScanConfig struct {
	Fare      int64     `json:"fare"`
	Blacklist []string  `json:"blacklist"`
	WalletCap int64     `json:"wallet_cap"`
	At        time.Time `json:"at"`
}

func (p *Platform) ScanConfig(pr Principal) (*ScanConfig, error) {
	if pr.Role != RoleDevice {
		return nil, ErrForbidden
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	cfg := &ScanConfig{Fare: p.fareLocked(pr.OperatorID), Blacklist: []string{}, WalletCap: WalletCap, At: p.now()}
	for _, c := range p.cards {
		if c.Status != CardActive {
			cfg.Blacklist = append(cfg.Blacklist, c.UID)
		}
	}
	sort.Strings(cfg.Blacklist)
	return cfg, nil
}

// SyncResult résume une remontée de transactions hors ligne.
type SyncResult struct {
	Synced     int      `json:"synced"`
	Duplicates int      `json:"duplicates"`
	Rejected   int      `json:"rejected"`
	Errors     []string `json:"errors"`
}

// OfflineSync intègre les débits hors ligne d'un valideur : vérification de la
// signature de la puce, idempotence par (carte, compteur), écriture comptable.
func (p *Platform) OfflineSync(pr Principal, txs []OfflineTx) (*SyncResult, error) {
	if pr.Role != RoleDevice {
		return nil, ErrForbidden
	}
	if len(txs) > 500 {
		return nil, fmt.Errorf("%w : lot trop volumineux", ErrInvalid)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	d := p.devices[pr.DeviceID]
	if d == nil || d.Frozen {
		return nil, ErrForbidden
	}
	veh := p.vehicles[d.VehicleID]
	res := &SyncResult{Errors: []string{}}
	for _, tx := range txs {
		c := p.cards[strings.ToUpper(tx.CardUID)]
		if c == nil || tx.DeviceID != d.ID || !hmac.Equal([]byte(offlineCert(p.cardKey(c.UID), tx)), []byte(tx.Cert)) {
			res.Rejected++
			res.Errors = append(res.Errors, fmt.Sprintf("%s#%d : signature invalide", tx.CardUID, tx.Counter))
			continue
		}
		amount, pending := c.pendingOffline[tx.Counter]
		if !pending {
			res.Duplicates++ // déjà remontée (par ce valideur ou un autre)
			continue
		}
		if amount != tx.Amount {
			res.Rejected++
			res.Errors = append(res.Errors, fmt.Sprintf("%s#%d : montant incohérent", tx.CardUID, tx.Counter))
			continue
		}
		delete(c.pendingOffline, tx.Counter)
		bal := tx.Balance
		v := &Validation{
			ID: newID("val"), TapID: fmt.Sprintf("offline-%s-%d", c.UID, tx.Counter), CardUID: c.UID, TravelerID: c.TravelerID,
			DeviceID: d.ID, VehicleID: veh.ID, OperatorID: veh.OperatorID, LineID: veh.LineID, At: tx.At,
			Status: ValAccepted, Message: fmt.Sprintf("Validé hors ligne — solde %d FCFA", tx.Balance),
			Debited: tx.Amount, Source: "wallet", Offline: true, WalletBalance: &bal, TitleName: "Porte-monnaie",
		}
		p.markBoardedLocked(v)
		p.validations = append(p.validations, v)
		sort.SliceStable(p.validations, func(i, j int) bool { return p.validations[i].At.Before(p.validations[j].At) })
		p.postWalletUsageLocked(veh.OperatorID, v.ID, tx.Amount)
		res.Synced++
	}
	return res, nil
}

// OfflineTap est utilisé par le simulateur et les tests : débit de la puce
// par le valideur, sans contact avec le serveur.
func (p *Platform) OfflineTap(deviceID, uid string) (*OfflineTx, error) {
	p.mu.Lock()
	d := p.devices[deviceID]
	var fare int64
	if d != nil {
		fare = p.fareLocked(d.OperatorID)
	}
	p.mu.Unlock()
	if d == nil {
		return nil, ErrNotFound
	}
	return p.ChipOfflineDebit(uid, deviceID, fare)
}

// BlockMyCard permet au voyageur de bloquer sa carte perdue depuis l'App.
// Le solde du porte-monnaie reste au grand livre et pourra être reporté sur
// une nouvelle carte.
func (p *Platform) BlockMyCard(pr Principal, uid string) error {
	if pr.Role != RoleTraveler {
		return ErrForbidden
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	c := p.cards[strings.ToUpper(uid)]
	if c == nil || c.TravelerID != pr.TravelerID {
		return ErrNotFound
	}
	c.Status = CardRevoked
	return nil
}
