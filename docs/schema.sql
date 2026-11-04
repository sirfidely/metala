-- Schéma cible PostgreSQL 16 + PostGIS pour le socle Metala.
-- Le prototype garde ces entités en mémoire (internal/platform) ; ce schéma
-- en est la transposition pour la phase « Fondations » (S3–S4).

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Référentiel ---------------------------------------------------------------
CREATE TABLE operators (
  id               text PRIMARY KEY,
  name             text NOT NULL,
  color            text NOT NULL,
  commission_rate  numeric(5,4) NOT NULL CHECK (commission_rate BETWEEN 0 AND 0.10),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stops (
  id    text PRIMARY KEY,
  name  text NOT NULL,
  geom  geography(Point, 4326) NOT NULL
);
CREATE INDEX stops_geom_idx ON stops USING gist (geom);

CREATE TABLE lines (
  id           text PRIMARY KEY,
  operator_id  text NOT NULL REFERENCES operators(id),
  code         text NOT NULL,
  name         text NOT NULL,
  color        text NOT NULL,
  shape        geography(LineString, 4326) NOT NULL,
  UNIQUE (operator_id, code)
);

CREATE TABLE line_stops (
  line_id   text NOT NULL REFERENCES lines(id),
  seq       int  NOT NULL,
  stop_id   text NOT NULL REFERENCES stops(id),
  dist_m    double precision NOT NULL, -- abscisse curviligne (ST_LineLocatePoint)
  PRIMARY KEY (line_id, seq)
);

CREATE TABLE vehicles (
  id                text PRIMARY KEY,
  operator_id       text NOT NULL REFERENCES operators(id),
  line_id           text REFERENCES lines(id),
  plate             text NOT NULL,
  capacity          int  NOT NULL,
  reservable_seats  int  NOT NULL DEFAULT 0
);

CREATE TABLE devices (
  id            text PRIMARY KEY,
  operator_id   text NOT NULL REFERENCES operators(id),
  vehicle_id    text REFERENCES vehicles(id),
  secret_hash   text NOT NULL,
  frozen        boolean NOT NULL DEFAULT false,
  enrolled_at   timestamptz NOT NULL DEFAULT now()
);

-- Temps réel (le dernier point vit dans Redis ; historique ici, rétention limitée)
CREATE TABLE telemetry (
  vehicle_id   text NOT NULL REFERENCES vehicles(id),
  recorded_at  timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  geom         geography(Point, 4326) NOT NULL,
  speed_kmh    real,
  heading      real,
  direction    smallint NOT NULL CHECK (direction IN (-1, 1)),
  PRIMARY KEY (vehicle_id, recorded_at)
);

-- Identité ------------------------------------------------------------------
CREATE TABLE travelers (
  id          text PRIMARY KEY,
  phone       text NOT NULL UNIQUE,
  name        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE staff_accounts (
  username       text PRIMARY KEY,
  password_hash  text NOT NULL, -- argon2id
  role           text NOT NULL CHECK (role IN ('operator_admin', 'platform_admin')),
  operator_id    text REFERENCES operators(id),
  CHECK ((role = 'operator_admin') = (operator_id IS NOT NULL))
);

CREATE TABLE cards (
  uid          text PRIMARY KEY,
  traveler_id  text REFERENCES travelers(id),
  status       text NOT NULL CHECK (status IN ('active', 'revoked')),
  key_version  int  NOT NULL DEFAULT 1, -- version de la clé maître de diversification
  issued_at    timestamptz NOT NULL DEFAULT now(),
  balance      bigint NOT NULL DEFAULT 0 CHECK (balance BETWEEN 0 AND 20000), -- miroir du porte-monnaie de la puce
  counter      int    NOT NULL DEFAULT 0                                       -- compteur de transactions de la puce
);

-- Transactions hors ligne remontées par les valideurs (porte-monnaie).
CREATE TABLE offline_transactions (
  card_uid     text   NOT NULL REFERENCES cards(uid),
  counter      int    NOT NULL,
  amount       bigint NOT NULL CHECK (amount > 0),
  device_id    text   NOT NULL REFERENCES devices(id),
  at           timestamptz NOT NULL,
  cert         text   NOT NULL,          -- signature de la puce
  synced_at    timestamptz NOT NULL DEFAULT now(),
  validation_id text  NOT NULL,
  PRIMARY KEY (card_uid, counter)        -- une transaction ne peut être comptée qu'une fois
);

-- Billettique ---------------------------------------------------------------
CREATE TABLE products (
  id             text PRIMARY KEY,
  operator_id    text REFERENCES operators(id), -- NULL pour les recharges du porte-monnaie
  name           text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('single', 'carnet', 'monthly')),
  trips          int  NOT NULL DEFAULT 0,
  price          bigint NOT NULL CHECK (price > 0), -- FCFA
  validity_days  int  NOT NULL
);

CREATE TABLE payments (
  id           text PRIMARY KEY,
  traveler_id  text NOT NULL REFERENCES travelers(id),
  product_id   text NOT NULL REFERENCES products(id),
  operator_id  text NOT NULL REFERENCES operators(id),
  amount       bigint NOT NULL,
  status       text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  psp_ref      text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  settled_at   timestamptz
);

CREATE TABLE psp_events (
  event_id     text PRIMARY KEY, -- idempotence des webhooks (T-009)
  psp_ref      text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  payload      jsonb NOT NULL
);

CREATE TABLE titles (
  id               text PRIMARY KEY,
  traveler_id      text NOT NULL REFERENCES travelers(id),
  product_id       text NOT NULL REFERENCES products(id),
  operator_id      text NOT NULL REFERENCES operators(id),
  payment_id       text NOT NULL UNIQUE REFERENCES payments(id), -- 1 paiement = 1 titre
  kind             text NOT NULL,
  trips_total      int  NOT NULL,
  trips_remaining  int  NOT NULL CHECK (trips_remaining >= 0),
  value_remaining  bigint NOT NULL CHECK (value_remaining >= 0),
  valid_from       timestamptz NOT NULL,
  valid_until      timestamptz NOT NULL
);
CREATE INDEX titles_traveler_idx ON titles (traveler_id, operator_id, valid_until);

CREATE TABLE validations (
  id           text PRIMARY KEY,
  device_id    text NOT NULL REFERENCES devices(id),
  tap_id       text NOT NULL,
  card_uid     text NOT NULL,
  traveler_id  text REFERENCES travelers(id),
  title_id     text REFERENCES titles(id),
  vehicle_id   text NOT NULL REFERENCES vehicles(id),
  operator_id  text NOT NULL REFERENCES operators(id),
  line_id      text REFERENCES lines(id),
  at           timestamptz NOT NULL DEFAULT now(),
  status       text NOT NULL CHECK (status IN ('accepted', 'already_validated', 'rejected')),
  reason       text,
  debited      bigint NOT NULL DEFAULT 0,
  UNIQUE (device_id, tap_id) -- idempotence du tap (T-004)
);
CREATE INDEX validations_op_at_idx ON validations (operator_id, at DESC);
CREATE INDEX validations_card_at_idx ON validations (card_uid, at DESC);

-- Grand livre (append-only) -------------------------------------------------
CREATE TABLE ledger_entries (
  id           text PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  kind         text NOT NULL CHECK (kind IN ('sale', 'wallet_load', 'usage')),
  operator_id  text REFERENCES operators(id),
  ref          text NOT NULL,
  UNIQUE (kind, ref)
);

CREATE TABLE ledger_lines (
  entry_id  text NOT NULL REFERENCES ledger_entries(id),
  account   text NOT NULL CHECK (account IN ('psp_clearing', 'titles_liability', 'wallet_liability', 'operator_revenue', 'metala_commission')),
  debit     bigint NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit    bigint NOT NULL DEFAULT 0 CHECK (credit >= 0)
);

-- Équilibre de chaque écriture vérifié en fin de transaction.
CREATE FUNCTION ledger_check_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT sum(debit) - sum(credit) FROM ledger_lines WHERE entry_id = NEW.entry_id) <> 0 THEN
    RAISE EXCEPTION 'écriture % déséquilibrée', NEW.entry_id;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_balanced AFTER INSERT ON ledger_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced();

REVOKE UPDATE, DELETE ON ledger_entries, ledger_lines FROM PUBLIC;

-- Réservations ----------------------------------------------------------------
CREATE TABLE departures (
  id                text PRIMARY KEY,
  line_id           text NOT NULL REFERENCES lines(id),
  operator_id       text NOT NULL REFERENCES operators(id),
  vehicle_id        text REFERENCES vehicles(id),
  depart_at         timestamptz NOT NULL,
  reservable_seats  int NOT NULL,
  reserved          int NOT NULL DEFAULT 0 CHECK (reserved <= reservable_seats) -- dernière place (T-011)
);

CREATE TABLE reservations (
  id            text PRIMARY KEY,
  traveler_id   text NOT NULL REFERENCES travelers(id),
  departure_id  text NOT NULL REFERENCES departures(id),
  operator_id   text NOT NULL REFERENCES operators(id),
  status        text NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX reservations_one_per_departure ON reservations (traveler_id, departure_id) WHERE status = 'confirmed';

-- Isolation par opérateur (T-014) : Row-Level Security pour le portail Fleet.
ALTER TABLE validations ENABLE ROW LEVEL SECURITY;
CREATE POLICY validations_by_operator ON validations
  USING (operator_id = current_setting('metala.operator_id', true) OR current_setting('metala.role', true) = 'platform_admin');
