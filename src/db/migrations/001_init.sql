-- University Parking Slot Reservation System - initial schema (SQLite).
-- All monetary amounts are integer centavos. All timestamps are UTC ISO-8601 (YYYY-MM-DDTHH:MM:SSZ).

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 100),
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  university_id TEXT,
  phone         TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'driver' CHECK (role IN ('driver','admin')),
  driver_type   TEXT CHECK (driver_type IS NULL OR driver_type IN ('student','faculty','personnel')),
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  last_login_at TEXT
);

CREATE TABLE vehicles (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  plate_number TEXT NOT NULL UNIQUE COLLATE NOCASE,
  vehicle_type TEXT NOT NULL CHECK (vehicle_type IN ('car','motorcycle')),
  make_model   TEXT,
  color        TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_vehicles_user ON vehicles(user_id);

CREATE TABLE parking_zones (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(name) BETWEEN 2 AND 60),
  description TEXT,
  map_columns INTEGER NOT NULL DEFAULT 6 CHECK (map_columns BETWEEN 2 AND 12),
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE parking_slots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id    INTEGER NOT NULL REFERENCES parking_zones(id) ON DELETE RESTRICT,
  code       TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 12),
  slot_type  TEXT NOT NULL DEFAULT 'standard' CHECK (slot_type IN ('standard','compact','accessible','motorcycle')),
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','maintenance','inactive')),
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (zone_id, code)
);
CREATE INDEX idx_slots_zone ON parking_slots(zone_id, status);

CREATE TABLE parking_rates (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_type             TEXT NOT NULL UNIQUE CHECK (slot_type IN ('standard','compact','accessible','motorcycle')),
  hourly_rate_centavos  INTEGER NOT NULL CHECK (hourly_rate_centavos >= 0),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_by            INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE reservations (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  reference              TEXT NOT NULL UNIQUE,
  user_id                INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  vehicle_id             INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
  slot_id                INTEGER NOT NULL REFERENCES parking_slots(id) ON DELETE RESTRICT,
  start_at               TEXT NOT NULL,
  end_at                 TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','active','completed','cancelled','no_show')),
  hourly_rate_centavos   INTEGER NOT NULL CHECK (hourly_rate_centavos >= 0),
  estimated_fee_centavos INTEGER NOT NULL CHECK (estimated_fee_centavos >= 0),
  final_fee_centavos     INTEGER CHECK (final_fee_centavos IS NULL OR final_fee_centavos >= 0),
  finalized_at           TEXT,
  cancel_reason          TEXT,
  cancelled_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at           TEXT,
  rescheduled_count      INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (end_at > start_at)
);
CREATE INDEX idx_res_slot_time ON reservations(slot_id, start_at, end_at);
CREATE INDEX idx_res_user ON reservations(user_id, status, start_at);
CREATE INDEX idx_res_vehicle_time ON reservations(vehicle_id, start_at, end_at);
CREATE INDEX idx_res_status_start ON reservations(status, start_at);

-- Defence in depth: the service layer checks conflicts inside a BEGIN IMMEDIATE transaction,
-- and these triggers make it impossible for any code path to store overlapping active bookings.
CREATE TRIGGER trg_res_bookable_insert BEFORE INSERT ON reservations
WHEN NEW.status IN ('confirmed','active')
BEGIN
  SELECT RAISE(ABORT, 'SLOT_NOT_BOOKABLE')
  WHERE NOT EXISTS (
    SELECT 1 FROM parking_slots s JOIN parking_zones z ON z.id = s.zone_id
    WHERE s.id = NEW.slot_id AND s.status = 'active' AND z.is_active = 1);
  SELECT RAISE(ABORT, 'RESERVATION_CONFLICT')
  WHERE EXISTS (
    SELECT 1 FROM reservations r
    WHERE r.slot_id = NEW.slot_id AND r.status IN ('confirmed','active')
      AND r.start_at < NEW.end_at AND r.end_at > NEW.start_at);
END;

CREATE TRIGGER trg_res_conflict_update BEFORE UPDATE OF slot_id, start_at, end_at, status ON reservations
WHEN NEW.status IN ('confirmed','active')
BEGIN
  SELECT RAISE(ABORT, 'RESERVATION_CONFLICT')
  WHERE EXISTS (
    SELECT 1 FROM reservations r
    WHERE r.id <> NEW.id AND r.slot_id = NEW.slot_id AND r.status IN ('confirmed','active')
      AND r.start_at < NEW.end_at AND r.end_at > NEW.start_at);
END;

CREATE TABLE parking_sessions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id       INTEGER NOT NULL UNIQUE REFERENCES reservations(id) ON DELETE RESTRICT,
  slot_id              INTEGER NOT NULL REFERENCES parking_slots(id) ON DELETE RESTRICT,
  vehicle_id           INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed')),
  checked_in_at        TEXT NOT NULL,
  checked_in_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  checked_out_at       TEXT,
  checked_out_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  is_late              INTEGER NOT NULL DEFAULT 0 CHECK (is_late IN (0,1)),
  late_minutes         INTEGER NOT NULL DEFAULT 0,
  is_overstay          INTEGER NOT NULL DEFAULT 0 CHECK (is_overstay IN (0,1)),
  overstay_minutes     INTEGER NOT NULL DEFAULT 0,
  rate_centavos        INTEGER NOT NULL CHECK (rate_centavos >= 0),
  final_fee_centavos   INTEGER CHECK (final_fee_centavos IS NULL OR final_fee_centavos >= 0),
  CHECK ((status = 'active' AND checked_out_at IS NULL) OR (status = 'completed' AND checked_out_at IS NOT NULL))
);
CREATE UNIQUE INDEX ux_active_session_slot    ON parking_sessions(slot_id)    WHERE status = 'active';
CREATE UNIQUE INDEX ux_active_session_vehicle ON parking_sessions(vehicle_id) WHERE status = 'active';

CREATE TABLE payments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_number   TEXT NOT NULL UNIQUE,
  reservation_id   INTEGER NOT NULL REFERENCES reservations(id) ON DELETE RESTRICT,
  amount_centavos  INTEGER NOT NULL CHECK (amount_centavos > 0),
  method           TEXT NOT NULL CHECK (method IN ('cash','gcash','bank_transfer','other')),
  reference        TEXT,
  notes            TEXT,
  status           TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','voided')),
  recorded_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  recorded_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  voided_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  voided_at        TEXT,
  void_reason      TEXT,
  CHECK (status = 'valid' OR (void_reason IS NOT NULL AND voided_at IS NOT NULL))
);
CREATE INDEX idx_payments_res ON payments(reservation_id, status);
CREATE INDEX idx_payments_recorded ON payments(recorded_at);

CREATE TABLE audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  details     TEXT,
  ip_address  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_audit_created ON audit_logs(created_at);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
