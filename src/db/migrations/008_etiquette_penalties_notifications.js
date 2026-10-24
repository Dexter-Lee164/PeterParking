'use strict';

/**
 * 008 — parking etiquette reports, plate penalties, cars and motorcycles only, and notification read state for everyone.
 *
 *   vehicles                   'van' is no longer a vehicle type: existing vans/SUVs become cars (same plate, same
 *                              history; a car slot fits them exactly as before) and triggers refuse new ones.
 *   etiquette_reports          a driver reports another vehicle by plate number: violation type, what happened, when,
 *                              and a review status (pending, under review, resolved, dismissed) with severity and notes.
 *   etiquette_evidence         an optional image per report, kept in the database (so backups carry it).
 *   plate_penalties            what an administrator decided against a plate: a permanent additional fee added to every
 *                              new reservation for that plate, a temporary ban (until ends_at) or a permanent ban. Keyed
 *                              by plate (spaces ignored), so a penalty survives the vehicle being re-registered.
 *   reservations.surcharge_centavos  the additional fee a booking carried when it was made (part of its estimated fee).
 *   notification_reads         per user and section, the newest audit entry already seen; replaces
 *                              admin_notification_reads (its rows are copied) so drivers get unread updates too.
 *
 * Idempotent: every step checks before it changes anything.
 */

const columnNames = (db, table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
const tableExists = (db, name) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);

function up(db) {
  db.prepare(`UPDATE vehicles SET vehicle_type = 'car', updated_at = datetime('now', 'localtime') WHERE vehicle_type = 'van'`).run();
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_vehicles_no_van_insert
    BEFORE INSERT ON vehicles WHEN NEW.vehicle_type NOT IN ('car', 'motorcycle')
    BEGIN SELECT RAISE(ABORT, 'VEHICLE_TYPE_NOT_ALLOWED'); END;

    CREATE TRIGGER IF NOT EXISTS trg_vehicles_no_van_update
    BEFORE UPDATE OF vehicle_type ON vehicles WHEN NEW.vehicle_type NOT IN ('car', 'motorcycle')
    BEGIN SELECT RAISE(ABORT, 'VEHICLE_TYPE_NOT_ALLOWED'); END;

    CREATE TABLE IF NOT EXISTS etiquette_reports (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      reporter_id     INTEGER NOT NULL REFERENCES users(id),
      plate_number    TEXT NOT NULL CHECK (length(trim(plate_number)) > 0),
      plate_key       TEXT NOT NULL,
      violation_type  TEXT NOT NULL CHECK (violation_type IN ('improper_parking', 'blocking', 'wrong_slot', 'accessible_misuse', 'overstay', 'reckless', 'other')),
      description     TEXT NOT NULL CHECK (length(trim(description)) > 0),
      incident_at     TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'under_review', 'resolved', 'dismissed')),
      severity        TEXT CHECK (severity IS NULL OR severity IN ('minor', 'moderate', 'major', 'severe')),
      admin_notes     TEXT,
      reviewed_by     INTEGER REFERENCES users(id),
      reviewed_at     TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE INDEX IF NOT EXISTS ix_etiquette_plate ON etiquette_reports(plate_key, created_at);
    CREATE INDEX IF NOT EXISTS ix_etiquette_status ON etiquette_reports(status, created_at);
    CREATE INDEX IF NOT EXISTS ix_etiquette_reporter ON etiquette_reports(reporter_id, created_at);

    CREATE TABLE IF NOT EXISTS etiquette_evidence (
      report_id   INTEGER PRIMARY KEY REFERENCES etiquette_reports(id) ON DELETE CASCADE,
      mime        TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif')),
      size_bytes  INTEGER NOT NULL CHECK (size_bytes > 0),
      data        BLOB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plate_penalties (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      plate_number     TEXT NOT NULL,
      plate_key        TEXT NOT NULL,
      report_id        INTEGER REFERENCES etiquette_reports(id),
      kind             TEXT NOT NULL CHECK (kind IN ('surcharge', 'temp_ban', 'perm_ban')),
      amount_centavos  INTEGER CHECK (amount_centavos IS NULL OR amount_centavos > 0),
      starts_at        TEXT NOT NULL,
      ends_at          TEXT,
      reason           TEXT NOT NULL CHECK (length(trim(reason)) > 0),
      status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'lifted')),
      created_by       INTEGER REFERENCES users(id),
      created_at       TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      lifted_by        INTEGER REFERENCES users(id),
      lifted_at        TEXT,
      lift_reason      TEXT,
      CHECK (kind <> 'surcharge' OR amount_centavos IS NOT NULL),
      CHECK (kind <> 'temp_ban' OR (ends_at IS NOT NULL AND ends_at > starts_at))
    );
    CREATE INDEX IF NOT EXISTS ix_penalties_plate ON plate_penalties(plate_key, status);

    CREATE TABLE IF NOT EXISTS notification_reads (
      user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      section             TEXT NOT NULL,
      last_seen_audit_id  INTEGER NOT NULL DEFAULT 0,
      seen_at             TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      PRIMARY KEY (user_id, section)
    );
  `);

  if (!columnNames(db, 'reservations').has('surcharge_centavos')) {
    db.exec('ALTER TABLE reservations ADD COLUMN surcharge_centavos INTEGER NOT NULL DEFAULT 0 CHECK (surcharge_centavos >= 0)');
  }

  if (tableExists(db, 'admin_notification_reads')) {
    db.exec(`
      INSERT OR IGNORE INTO notification_reads (user_id, section, last_seen_audit_id, seen_at)
        SELECT user_id, section, last_seen_audit_id, seen_at FROM admin_notification_reads;
      DROP TABLE admin_notification_reads;
    `);
  }
}

module.exports = { up };
