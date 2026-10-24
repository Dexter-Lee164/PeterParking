-- University Parking Slot Reservation System — initial schema (SQLite)
-- All monetary amounts are INTEGER centavos. All date-times are local campus time
-- stored as 'YYYY-MM-DD HH:MM:SS' text so they sort and compare lexicographically.

CREATE TABLE users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  university_id  TEXT,
  full_name      TEXT NOT NULL CHECK (length(trim(full_name)) > 0),
  email          TEXT NOT NULL COLLATE NOCASE,
  phone          TEXT,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'driver' CHECK (role IN ('driver', 'admin')),
  is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  last_login_at  TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE UNIQUE INDEX ux_users_email ON users(email);
CREATE UNIQUE INDEX ux_users_university_id ON users(university_id) WHERE university_id IS NOT NULL AND university_id <> '';
CREATE INDEX ix_users_role ON users(role, is_active);

CREATE TABLE vehicles (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  plate_number  TEXT NOT NULL CHECK (length(trim(plate_number)) > 0),
  vehicle_type  TEXT NOT NULL DEFAULT 'car' CHECK (vehicle_type IN ('car', 'motorcycle', 'van')),
  make          TEXT,
  model         TEXT,
  color         TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE UNIQUE INDEX ux_vehicles_plate_active ON vehicles(replace(plate_number, ' ', '')) WHERE is_active = 1;
CREATE INDEX ix_vehicles_user ON vehicles(user_id, is_active);

CREATE TABLE parking_zones (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT NOT NULL CHECK (length(trim(code)) > 0),
  name         TEXT NOT NULL CHECK (length(trim(name)) > 0),
  description  TEXT,
  map_columns  INTEGER NOT NULL DEFAULT 6 CHECK (map_columns BETWEEN 2 AND 12),
  sort_order   INTEGER NOT NULL DEFAULT 0,
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE UNIQUE INDEX ux_zones_code ON parking_zones(code COLLATE NOCASE);
CREATE UNIQUE INDEX ux_zones_name ON parking_zones(name COLLATE NOCASE);

CREATE TABLE slot_types (
  code          TEXT PRIMARY KEY CHECK (code GLOB '[a-z0-9_]*'),
  label         TEXT NOT NULL,
  vehicle_type  TEXT NOT NULL DEFAULT 'car' CHECK (vehicle_type IN ('car', 'motorcycle', 'any')),
  icon          TEXT NOT NULL DEFAULT 'bi-car-front',
  sort_order    INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

CREATE TABLE parking_slots (
  id                              INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id                         INTEGER NOT NULL REFERENCES parking_zones(id),
  slot_code                       TEXT NOT NULL CHECK (length(trim(slot_code)) > 0),
  slot_type                       TEXT NOT NULL REFERENCES slot_types(code),
  status                          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'maintenance', 'inactive')),
  hourly_rate_override_centavos   INTEGER CHECK (hourly_rate_override_centavos IS NULL OR hourly_rate_override_centavos >= 0),
  notes                           TEXT,
  sort_order                      INTEGER NOT NULL DEFAULT 0,
  created_at                      TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at                      TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE (zone_id, slot_code)
);
CREATE INDEX ix_slots_zone ON parking_slots(zone_id, status, sort_order);

CREATE TABLE parking_rates (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  name                  TEXT NOT NULL,
  zone_id               INTEGER REFERENCES parking_zones(id),
  slot_type             TEXT REFERENCES slot_types(code),
  hourly_rate_centavos  INTEGER NOT NULL CHECK (hourly_rate_centavos >= 0),
  is_active             INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at            TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE reservations (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_ref             TEXT NOT NULL UNIQUE,
  user_id                 INTEGER NOT NULL REFERENCES users(id),
  vehicle_id              INTEGER NOT NULL REFERENCES vehicles(id),
  slot_id                 INTEGER NOT NULL REFERENCES parking_slots(id),
  start_at                TEXT NOT NULL,
  end_at                  TEXT NOT NULL,
  duration_minutes        INTEGER NOT NULL CHECK (duration_minutes > 0),
  hourly_rate_centavos    INTEGER NOT NULL CHECK (hourly_rate_centavos >= 0),
  fee_estimated_centavos  INTEGER NOT NULL CHECK (fee_estimated_centavos >= 0),
  fee_final_centavos      INTEGER CHECK (fee_final_centavos IS NULL OR fee_final_centavos >= 0),
  status                  TEXT NOT NULL DEFAULT 'confirmed'
                          CHECK (status IN ('confirmed', 'checked_in', 'completed', 'cancelled', 'no_show')),
  cancelled_at            TEXT,
  cancelled_by            INTEGER REFERENCES users(id),
  cancel_reason           TEXT,
  no_show_at              TEXT,
  notes                   TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  CHECK (end_at > start_at)
);
CREATE INDEX ix_res_slot_interval ON reservations(slot_id, start_at, end_at) WHERE status IN ('confirmed', 'checked_in');
CREATE INDEX ix_res_user ON reservations(user_id, start_at);
CREATE INDEX ix_res_status ON reservations(status, start_at);
CREATE INDEX ix_res_start ON reservations(start_at);

-- Defence in depth: even if application code were bypassed, SQLite itself refuses
-- to hold two overlapping active reservations for the same slot. Reservations that
-- end exactly when another begins are adjacent, not overlapping.
CREATE TRIGGER trg_reservations_no_overlap_insert
BEFORE INSERT ON reservations
WHEN NEW.status IN ('confirmed', 'checked_in')
BEGIN
  SELECT RAISE(ABORT, 'RESERVATION_OVERLAP')
  WHERE EXISTS (
    SELECT 1 FROM reservations r
    WHERE r.slot_id = NEW.slot_id
      AND r.status IN ('confirmed', 'checked_in')
      AND r.start_at < NEW.end_at
      AND r.end_at > NEW.start_at
  );
END;

CREATE TRIGGER trg_reservations_no_overlap_update
BEFORE UPDATE OF slot_id, start_at, end_at, status ON reservations
WHEN NEW.status IN ('confirmed', 'checked_in')
BEGIN
  SELECT RAISE(ABORT, 'RESERVATION_OVERLAP')
  WHERE EXISTS (
    SELECT 1 FROM reservations r
    WHERE r.slot_id = NEW.slot_id
      AND r.id <> NEW.id
      AND r.status IN ('confirmed', 'checked_in')
      AND r.start_at < NEW.end_at
      AND r.end_at > NEW.start_at
  );
END;

-- A maintenance / inactive slot cannot receive new reservations.
CREATE TRIGGER trg_reservations_slot_must_be_active
BEFORE INSERT ON reservations
WHEN (SELECT status FROM parking_slots WHERE id = NEW.slot_id) <> 'active'
BEGIN
  SELECT RAISE(ABORT, 'SLOT_NOT_ACTIVE');
END;

CREATE TABLE parking_sessions (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id         INTEGER NOT NULL UNIQUE REFERENCES reservations(id),
  slot_id                INTEGER NOT NULL REFERENCES parking_slots(id),
  vehicle_id             INTEGER NOT NULL REFERENCES vehicles(id),
  check_in_at            TEXT NOT NULL,
  check_out_at           TEXT,
  checked_in_by          INTEGER REFERENCES users(id),
  checked_out_by         INTEGER REFERENCES users(id),
  late_arrival_minutes   INTEGER NOT NULL DEFAULT 0 CHECK (late_arrival_minutes >= 0),
  overstay_minutes       INTEGER NOT NULL DEFAULT 0 CHECK (overstay_minutes >= 0),
  overstay_fee_centavos  INTEGER NOT NULL DEFAULT 0 CHECK (overstay_fee_centavos >= 0),
  notes                  TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  CHECK (check_out_at IS NULL OR check_out_at >= check_in_at)
);
-- Only one open (not yet checked-out) session per slot: prevents double occupancy.
CREATE UNIQUE INDEX ux_sessions_open_slot ON parking_sessions(slot_id) WHERE check_out_at IS NULL;
CREATE INDEX ix_sessions_checkin ON parking_sessions(check_in_at);

CREATE TABLE payments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_no       TEXT NOT NULL UNIQUE,
  reservation_id   INTEGER NOT NULL REFERENCES reservations(id),
  user_id          INTEGER NOT NULL REFERENCES users(id),
  amount_centavos  INTEGER NOT NULL CHECK (amount_centavos > 0),
  method           TEXT NOT NULL CHECK (method IN ('cash', 'gcash', 'bank_transfer', 'other')),
  reference        TEXT,
  notes            TEXT,
  status           TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'voided')),
  paid_at          TEXT NOT NULL,
  recorded_by      INTEGER NOT NULL REFERENCES users(id),
  voided_at        TEXT,
  voided_by        INTEGER REFERENCES users(id),
  void_reason      TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  CHECK (status = 'valid' OR (void_reason IS NOT NULL AND length(trim(void_reason)) > 0))
);
CREATE INDEX ix_payments_res ON payments(reservation_id, status);
CREATE INDEX ix_payments_user ON payments(user_id);
CREATE INDEX ix_payments_paid_at ON payments(paid_at);

CREATE TABLE audit_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action       TEXT NOT NULL,
  entity_type  TEXT,
  entity_id    INTEGER,
  details      TEXT,
  ip_address   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX ix_audit_created ON audit_logs(created_at);
CREATE INDEX ix_audit_entity ON audit_logs(entity_type, entity_id);

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE sessions (
  sid      TEXT PRIMARY KEY,
  sess     TEXT NOT NULL,
  expires  INTEGER NOT NULL
);
CREATE INDEX ix_sessions_expires ON sessions(expires);

-- Reference data needed for the application to function (not demo data).
INSERT INTO slot_types (code, label, vehicle_type, icon, sort_order) VALUES
  ('regular',    'Regular',        'car',        'bi-car-front',    1),
  ('ev',         'EV Charging',    'car',        'bi-ev-front',     2),
  ('accessible', 'Accessible',     'any',        'bi-person-wheelchair', 3),
  ('motorcycle', 'Motorcycle',     'motorcycle', 'bi-bicycle',      4);

INSERT INTO parking_rates (name, zone_id, slot_type, hourly_rate_centavos) VALUES
  ('Default hourly rate', NULL, NULL,         2000),
  ('Regular slots',       NULL, 'regular',    3000),
  ('EV charging slots',   NULL, 'ev',         5000),
  ('Accessible slots',    NULL, 'accessible', 2000),
  ('Motorcycle slots',    NULL, 'motorcycle', 1500);
