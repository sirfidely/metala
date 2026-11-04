# Architecture du prototype Metala

## Vue d'ensemble

```
 Metala App (web, mobile-first)   Metala Scan (web, terminal)   Metala Fleet (web, portail)
              │                              │                              │
              └──────────── HTTPS · REST JSON · SSE (cible : WebSocket) ────┘
                                             │
               Backend Go : monolithe modulaire (cmd/metala)
   identité · réseau · temps réel · réservation · billettique · paiements · validation · flotte · reporting
                                             │
              État en mémoire (prototype) → PostgreSQL + PostGIS + Redis (cible)
                                             │
              Simulateurs (prototype) : GPS ×10, PSP signé, puce NFC, voyageurs fictifs
```

Le backend applique l'architecture cible de la proposition (slide 12) : un **monolithe modulaire** en Go,
**multi-opérateurs dès la conception** (isolation par `operator_id`), avec une seule dépendance réseau
côté client (l'API). Chaque module correspond à un fichier de `internal/platform`.

## Protocole de validation (Metala Pass → Scan → serveur)

```
Terminal Scan                 Carte (puce)                  Serveur Metala
     │ POST /api/scan/challenge ───────────────────────────────▶│ challenge aléatoire 128 bits, 15 s, usage unique
     │◀─────────────────────────────────────────────── challenge │
     │ ── challenge ──────────▶│                                │
     │                          │ preuve = HMAC(K_uid, challenge‖UID)
     │◀───────────── UID, preuve│                                │
     │ POST /api/scan/validate {tap_id, UID, challenge, preuve} ─▶│
     │                                                          │ 1. tap_id déjà vu ? → même réponse (idempotence)
     │                                                          │ 2. terminal gelé ? → 403
     │                                                          │ 3. challenge : connu, de ce terminal, non utilisé, non expiré
     │                                                          │ 4. K_uid = HMAC(clé maître, UID) ; preuve vérifiée en temps constant
     │                                                          │ 5. carte active ?
     │                                                          │ 6. anti-passback (même carte, même véhicule, 60 s)
     │                                                          │ 7. titre : forfait valide, sinon titre à trajets expirant le plus tôt
     │                                                          │ 8. débit + écriture au grand livre (même transaction)
     │◀──────────────────────────────── Validé / Déjà validé / Refusé
```

- **Jamais l'UID seul.** Un UID copié sans clé est refusé (`uid_only`, `bad_proof`).
- **Jamais de faux succès.** Si le terminal ne joint pas le serveur dans les 2,5 s, il affiche un refus.
  Le MVP ne prévoit aucune validation financière hors ligne.
- **Cible matérielle.** Sur une MIFARE DESFire EV3, l'étape « preuve » devient une authentification mutuelle
  AES-128 avec une clé diversifiée (AN10922), idéalement relayée par un SAM. Le serveur garde la décision.

## Paiement et grand livre

1. `POST /api/purchases` crée un paiement **en attente** chez le PSP. Aucun titre n'est émis à ce stade.
2. Le PSP appelle `POST /api/psp/webhook`, signé en HMAC-SHA256 (`X-PSP-Signature`).
3. Le serveur vérifie la signature, l'idempotence (par `event_id` et par statut du paiement) et le montant, puis émet le titre.

Écritures en partie double :

| Événement | Débit | Crédit |
|---|---|---|
| Vente d'un ticket ou d'un carnet | `psp_clearing` | `titles_liability` |
| Montée avec un titre à trajets | `titles_liability` (valeur d'un trajet) | `operator_revenue` + `metala_commission` |
| Vente d'un forfait *(simplification du prototype)* | `psp_clearing` | `operator_revenue` + `metala_commission` |

Le **rapprochement** vérifie que :

- ventes PSP = ventes au grand livre ;
- paiements réussis = titres émis ;
- validations débitrices = écritures de consommation ;
- solde de `titles_liability` = valeur restante au registre des titres ;
- encaissements = passif + recettes + commissions.

Le seuil attendu est **0 écart non expliqué** (cible du pilote).

## Temps réel et fraîcheur GPS

| État | Âge du dernier point | Carte voyageur | ETA |
|---|---|---|---|
| `fresh` | < 30 s | couleur de la ligne | calculée |
| `delayed` | 30–120 s | contour pointillé orange | dégradée (« ~ »), signalée |
| `unknown` | > 120 s | grisé | **aucune** |

L'ETA se calcule par projection de la position sur le tracé, puis distance restante jusqu'à l'arrêt dans le sens
de circulation, divisée par la vitesse commerciale (18 km/h par défaut, à calibrer sur les données terrain).
Les points plus anciens que le dernier point connu et les points hors de l'emprise du Grand Abidjan sont ignorés.

## Sécurité : état du prototype

| Contrôle | Prototype | À faire avant le pilote |
|---|---|---|
| Authentification voyageur | OTP à 6 chiffres, 5 min, 5 tentatives | passerelle SMS, limitation par IP et par numéro |
| Comptes staff | mot de passe comparé en temps constant | argon2id, MFA, SSO |
| Sessions | jeton aléatoire de 192 bits, 12 h | rotation, révocation, stockage Redis |
| RBAC | 4 rôles, isolation par opérateur | tests d'intrusion |
| Secrets | défauts de démonstration | coffre de secrets, rotation |
| Données personnelles | minimisation dans Fleet | registre des traitements, durées de conservation, formalités ARTCI |

## Passage à l'échelle

Le passage en production se fait module par module, sans changer l'API :

1. `platform.Platform` devient un ensemble de *repositories* PostgreSQL (`docs/schema.sql`).
2. Le verrou global est remplacé par des transactions : `SELECT … FOR UPDATE` sur le titre et le départ, et des contraintes `UNIQUE` sur `tap_id` et `event_id`.
3. Le dernier point GPS de chaque véhicule passe dans Redis ; l'historique va en base avec rétention.
4. La diffusion temps réel passe en WebSocket derrière la passerelle API.

## Porte-monnaie et paiement hors ligne

Le Metala Pass embarque un **porte-monnaie** : un solde en FCFA stocké sur la puce (fichier valeur
sécurisé DESFire), rechargé à l'avance depuis l'App en Mobile Money.

| Situation | Qui décide | Ce qui est débité |
|---|---|---|
| En ligne, titre valide (forfait, carnet) | serveur | le titre |
| En ligne, pas de titre | serveur | le porte-monnaie (tarif du ticket unitaire de l'opérateur) |
| Hors ligne | valideur (SAM + liste noire en cache) | le porte-monnaie, **sur la puce** |

Déroulé hors ligne :

1. En ligne, le valideur télécharge sa configuration (`GET /api/scan/config`), qui contient le tarif et la liste noire des cartes bloquées.
2. Réseau coupé : le valideur authentifie la carte localement (SAM), vérifie qu'elle n'est pas sur la liste noire et applique un anti-passback local.
3. La puce débite son solde, incrémente son compteur et **signe** la transaction (HMAC de la clé diversifiée ; MAC de transaction DESFire en production).
4. Le valideur stocke la transaction. Au retour du réseau, il l'envoie (`POST /api/scan/offline-sync`).
5. Le serveur vérifie la signature, déduplique par (carte, compteur), crée la validation et passe l'écriture « porte-monnaie → recette transporteur ».

Garanties :

- **Pas de double dépense.** Le solde vit sur la puce : on ne peut dépenser que ce qui a été prépayé, même sur plusieurs bus hors ligne.
- **Pas de falsification.** Une transaction modifiée (montant, compteur, terminal) est rejetée à la synchronisation.
- **Pas de double comptage.** Une transaction remontée deux fois, par le même valideur ou par un autre, est ignorée.
- **Carte perdue.** Le voyageur la bloque depuis l'App ; la liste noire est diffusée aux valideurs à leur prochaine connexion.
- **Rapprochement.** Le solde du compte porte-monnaie doit égaler la somme des soldes des cartes plus les transactions hors ligne pas encore remontées.

Plafond de démonstration : 20 000 FCFA. Le statut réglementaire du porte-monnaie (monnaie électronique,
Instruction BCEAO n° 001-01-2024) doit être validé avec le PSP et un avis juridique avant tout encaissement réel.
Dans le prototype, la puce est simulée côté serveur (`/api/dev/cards/{uid}/offline-debit`) ; le serveur ne
connaît son journal que pour cette raison.

## Trajets porte-à-porte

Le voyageur part d'un **lieu quelconque** (domicile, travail, repère, point choisi sur la carte), pas d'un arrêt.
`POST /api/journeys` :

1. Arrêts accessibles à pied (≤ 1,5 km) autour du départ et de l'arrivée ; marche à 4,5 km/h avec un facteur de détour de 1,3.
2. Combinaisons directes et à **une correspondance** (≤ 900 m de marche entre deux arrêts), toutes lignes et tous modes confondus.
3. Horaires **théoriques** de chaque ligne (fréquence, premier et dernier départ, temps de parcours par arrêt) ; en « arriver avant », recherche à rebours sur 2 h 30.
4. Si le départ est dans les 45 minutes, le **véhicule réellement attendu** (GPS) remplace l'horaire théorique.
5. Les trajets dominés (partir plus tôt pour arriver plus tard, plus de marche ou de correspondances) sont écartés ; 4 au maximum sont proposés.

L'heure de départ affichée est celle à laquelle **quitter son domicile**.

## Budget transport

Le budget compte ce que le voyageur **dépense pour se déplacer**, pas ce qu'il recharge : chaque trajet débité (valeur
d'un trajet de carnet ou montant payé au porte-monnaie), plus le prix des forfaits au mois d'achat. La projection
de fin de mois est linéaire ; les conseils comparent les 30 derniers jours aux offres (forfait, carnet) de chaque opérateur.

## Chauffeurs et paiement par téléphone

- **Metala Scan** n'est utilisable qu'en service : le chauffeur s'identifie (téléphone + code PIN) sur un véhicule de sa
  compagnie. Chaque paiement est rattaché à son service ; la recette du service est calculée par le serveur.
- **Taxi compteur** : véhicule sans ligne ; le chauffeur saisit le montant, payé au porte-monnaie (en ligne ou hors ligne).
- **QR du téléphone** : jeton `MTL1.<charge>.<HMAC>` lié au Pass, valable 60 s et à usage unique (anti-rejeu). Il
  exige le réseau côté valideur ; hors ligne, seule la carte NFC paie (porte-monnaie sur la puce).
