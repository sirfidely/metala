# API Metala (prototype)

L'API échange du JSON. L'authentification passe par l'en-tête `Authorization: Bearer <jeton>`.
Erreurs : `{"error": "..."}` avec un code 400, 401, 403, 404 ou 409.

## Public

| Méthode | Chemin | Description |
|---|---|---|
| GET | `/api/health` | état du service |
| GET | `/api/network` | opérateurs, lignes (tracés), arrêts |
| GET | `/api/vehicles` | positions temps réel avec fraîcheur, sans immatriculation |
| GET | `/api/stream/vehicles` | flux SSE `event: vehicles` toutes les 2 s |
| GET | `/api/stops/{id}/arrivals` | arrivées estimées : `eta_minutes`, `freshness`, `degraded`, `direction` |
| GET | `/api/products?operator_id=` | catalogue de titres |
| GET | `/api/departures?line_id=` | départs réservables |
| GET | `/api/places?q=` | lieux (repères et arrêts) pour choisir un départ ou une arrivée |
| POST | `/api/journeys` | `{from: {lat, lon, name}, to: {…}, at?, arrive_by?}` → jusqu'à 4 trajets porte-à-porte (marche, lignes, correspondance, horaires, véhicule en direct, prix) |

Le réseau (`/api/network`) décrit pour chaque ligne son mode (`bus`, `navette`, `bateau`, `gbaka`, `woro`), sa fréquence,
ses heures de service et les minutes de passage à chaque arrêt (`stop_minutes`). Chaque opérateur porte une catégorie
(`public`, `prive`, `artisanal`, `taxi`).

## Authentification

| Méthode | Chemin | Corps |
|---|---|---|
| POST | `/api/auth/otp/request` | `{phone}` (en mode démo, la réponse contient `dev_code`) |
| POST | `/api/auth/otp/verify` | `{phone, code, name?}` → `{token, traveler}` |
| POST | `/api/auth/staff` | `{username, password}` → `{token, principal}` |
| POST | `/api/auth/device` | `{device_id, secret}` → `{token, principal}` |
| POST | `/api/auth/driver` | `{phone, pin, vehicle_id}` → ouvre un service sur le valideur du véhicule |
| POST | `/api/auth/logout` | — |

## Voyageur (`traveler`)

| Méthode | Chemin | Description |
|---|---|---|
| GET | `/api/me` | profil, cartes, titres |
| GET | `/api/me/history` | achats et montées |
| POST | `/api/purchases` | `{product_id}` → paiement `pending` + `psp_ref` |
| GET | `/api/me/reservations` | réservations |
| POST | `/api/reservations` | `{departure_id}` (renvoie 409 si le départ est complet) |
| DELETE | `/api/reservations/{id}` | annulation |
| GET / PUT | `/api/me/budget` | budget du mois (dépensé, projection, 30 derniers jours, par mode, conseils) / `{amount}` |
| PUT | `/api/me/places` | `{home?, work?}` : domicile et lieu de travail |
| GET | `/api/me/pay-token` | QR de paiement signé, à usage unique, valable 60 s |
| POST | `/api/me/cards/{uid}/block` | le voyageur bloque sa carte perdue (le solde est conservé) |

Le catalogue contient aussi des recharges du porte-monnaie (`kind: "wallet"`, sans opérateur). Plafond : 20 000 FCFA.

## PSP

| Méthode | Chemin | Description |
|---|---|---|
| POST | `/api/psp/webhook` | en-tête `X-PSP-Signature: hex(HMAC-SHA256(secret, corps))` ; corps `{event_id, psp_ref, status, amount}` |

## Terminal Metala Scan (`device`)

| Méthode | Chemin | Description |
|---|---|---|
| POST | `/api/scan/challenge` | → `{challenge, expires_at}` |
| GET | `/api/scan/shift` | service en cours : chauffeur, véhicule, recette, passagers, dernières transactions |
| POST | `/api/scan/shift/end` | clôt le service et renvoie son bilan |
| POST | `/api/scan/validate` | `{tap_id, card_uid, challenge, proof}` (carte) ou `{tap_id, pay_token}` (téléphone), `amount` pour un taxi compteur → validation (`accepted` \| `already_validated` \| `rejected`, `reason`, `message`, `trips_remaining`) |
| GET | `/api/scan/config` | tarif porte-monnaie et liste noire, pour décider hors ligne |
| POST | `/api/scan/offline-sync` | `{txs: [OfflineTx]}` → `{synced, duplicates, rejected}` ; signature de la puce vérifiée, idempotent par (carte, compteur) |
| POST | `/api/telemetry` | `{lat, lon, speed_kmh, heading, direction, recorded_at}` |

Valeurs de `reason` en cas de refus : `uid_only`, `bad_challenge`, `replay`, `challenge_expired`, `unknown_card`,
`bad_proof`, `card_revoked`, `title_expired`, `no_title`, `insufficient_balance`.
Une validation payée par le porte-monnaie porte `source: "wallet"` et `wallet_balance` ; une validation hors ligne synchronisée porte `offline: true`.

## Metala Fleet (`operator_admin`, `platform_admin`)

Un `operator_admin` est limité à son opérateur. S'il demande `?operator_id=` pour un autre opérateur, l'API renvoie **403**.

| Méthode | Chemin | Description |
|---|---|---|
| GET | `/api/fleet/dashboard` | indicateurs du jour |
| GET | `/api/fleet/vehicles` | flotte, fraîcheur GPS, terminaux |
| GET | `/api/fleet/validations?limit=` | journal (UID masqué côté interface, identité voyageur jamais exposée) |
| GET | `/api/fleet/reconciliation` | rapprochement PSP ↔ grand livre ↔ registres |
| POST | `/api/fleet/devices/{id}/freeze` | `{frozen: bool}` |
| POST | `/api/fleet/vehicles` | `{plate, line_id | mode: "taxi", reservable_seats}` : ajoute un véhicule et son valideur |
| GET / POST | `/api/fleet/drivers` | chauffeurs (statut de service, recette) / `{name, phone, pin}` |
| GET / POST | `/api/admin/operators` | super administrateur : compagnies / `{name, kind, admin_email, password}` |
| POST | `/api/admin/cards/{uid}/revoke` | `platform_admin` uniquement |

## Simulateurs (mode démo uniquement)

Ces routes ne sont pas exposées si `METALA_ENV=production`.

| Méthode | Chemin | Description |
|---|---|---|
| GET | `/api/dev/inventory` | terminaux (avec secrets), cartes, comptes de démonstration |
| POST | `/api/dev/cards/{uid}/respond` | joue le rôle de la puce : `{challenge}` → `{proof}` |
| POST | `/api/dev/psp/{payment_id}/confirm?status=succeeded\|failed&duplicate=1` | joue le rôle du PSP |
| POST | `/api/dev/cards/{uid}/offline-debit` | joue le rôle de la puce lors d’un débit hors ligne : `{device_id, amount}` → transaction signée |
| POST | `/api/dev/travelers/{phone}/pay-token` | joue le rôle de la caméra du valideur qui lit le QR de l'App |
| POST | `/api/dev/reset` | remet la démonstration à zéro (utilisé par la démo guidée) |
