'use strict';

/**
 * 011 — Etiquette Reports & Penalty Management.
 *
 *   etiquette_reports      (re)created when missing; gains zone_id (where it happened), and the vehicle an
 *                          administrator verified it is about: vehicle_id / owner_id / verified_by / verified_at.
 *                          A report never names a vehicle or a driver until an administrator verifies the match.
 *                          Status: pending (new) → under_review → resolved (approved) | dismissed.
 *   etiquette_evidence     one optional image per report, kept in the database; gains sha256 (spots the same photo
 *                          sent twice).
 *   penalties              what an administrator decided against a driver account, through one of its verified
 *                          vehicles: fee_once (a one-time fee, charged on one booking), surcharge (added to every new
 *                          booking until ends_at, or until revoked when ends_at is NULL), temp_ban (no new bookings in
 *                          [starts_at, ends_at)), perm_ban (no new bookings until revoked). Never deleted: revoked
 *                          with a reason. At most one active permanent ban per account (unique index).
 *   penalty_charges        which booking carried which penalty fee, and how much. A one-time fee has at most one
 *                          applied charge (unique index), so it can never be charged twice.
 *   penalty_appeals        one appeal per penalty, by the penalised driver: pending → upheld | revoked.
 *   appeal_evidence        one optional image per appeal.
 *   penalty_events         the history of each penalty (issued, modified, charged, appealed, revoked), each linked to
 *                          its audit_logs entry.
 *   payments.penalty_centavos   the part of a cash payment that settled penalty fees, so receipts show it apart.
 *
 * Existing records are kept. Penalties from the older plate-based table (plate_penalties) are copied into penalties
 * when the plate belongs to a registered vehicle (its owner becomes the penalised account); the old table and its
 * rows are left untouched. reservations.surcharge_centavos (added in 008) holds the total penalty fees of a booking.
 *
 * Idempotent: every step checks before it changes anything.
 */

const columnNames = (db, table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
const tableExists = (db, name) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);

function addColumns(db, table, defs) {
  const have = columnNames(db, table);
  for (const [name, def] of defs) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
}

function up(db) {
  // Same definition as migration 008, for a database whose copy was dropped by the old migration 010.
  db.exec(`
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
  `);

  addColumns(db, 'etiquette_reports', [
    ['zone_id', 'INTEGER REFERENCES parking_zones(id)'],
    ['vehicle_id', 'INTEGER REFERENCES vehicles(id)'],
    ['owner_id', 'INTEGER REFERENCES users(id)'],
    ['verified_by', 'INTEGER REFERENCES users(id)'],
    ['verified_at', 'TEXT'],
  ]);
  addColumns(db, 'etiquette_evidence', [['sha256', 'TEXT']]);
  addColumns(db, 'payments', [['penalty_centavos', 'INTEGER NOT NULL DEFAULT 0 CHECK (penalty_centavos >= 0)']]);
  if (!columnNames(db, 'reservations').has('surcharge_centavos')) {
    db.exec('ALTER TABLE reservations ADD COLUMN surcharge_centavos INTEGER NOT NULL DEFAULT 0 CHECK (surcharge_centavos >= 0)');
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS ix_etiquette_owner ON etiquette_reports(owner_id, created_at);
    CREATE INDEX IF NOT EXISTS ix_etiquette_evidence_hash ON etiquette_evidence(sha256);

    CREATE TABLE IF NOT EXISTS penalties (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id                  INTEGER NOT NULL REFERENCES users(id),
      vehicle_id               INTEGER REFERENCES vehicles(id),
      plate_number             TEXT NOT NULL CHECK (length(trim(plate_number)) > 0),
      plate_key                TEXT NOT NULL,
      report_id                INTEGER REFERENCES etiquette_reports(id),
      kind                     TEXT NOT NULL CHECK (kind IN ('fee_once', 'surcharge', 'temp_ban', 'perm_ban')),
      amount_centavos          INTEGER CHECK (amount_centavos IS NULL OR amount_centavos > 0),
      starts_at                TEXT NOT NULL,
      ends_at                  TEXT,
      reason                   TEXT NOT NULL CHECK (length(trim(reason)) > 0),
      status                   TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
      issued_by                INTEGER REFERENCES users(id),
      issued_at                TEXT NOT NULL,
      updated_at               TEXT NOT NULL,
      revoked_by               INTEGER REFERENCES users(id),
      revoked_at               TEXT,
      revoke_reason            TEXT,
      legacy_plate_penalty_id  INTEGER UNIQUE,
      CHECK (kind NOT IN ('fee_once', 'surcharge') OR amount_centavos IS NOT NULL),
      CHECK (kind IN ('fee_once', 'surcharge') OR amount_centavos IS NULL),
      CHECK (kind <> 'temp_ban' OR (ends_at IS NOT NULL AND ends_at > starts_at)),
      CHECK (kind NOT IN ('fee_once', 'perm_ban') OR ends_at IS NULL),
      CHECK (status = 'active' OR (revoke_reason IS NOT NULL AND length(trim(revoke_reason)) > 0))
    );
    CREATE INDEX IF NOT EXISTS ix_penalties_user ON penalties(user_id, status, kind);
    CREATE INDEX IF NOT EXISTS ix_penalties_plate ON penalties(plate_key, status, kind);
    CREATE INDEX IF NOT EXISTS ix_penalties_report ON penalties(report_id);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_penalties_one_perm_ban ON penalties(user_id) WHERE kind = 'perm_ban' AND status = 'active';

    CREATE TABLE IF NOT EXISTS penalty_charges (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      penalty_id       INTEGER NOT NULL REFERENCES penalties(id),
      reservation_id   INTEGER NOT NULL REFERENCES reservations(id),
      kind             TEXT NOT NULL CHECK (kind IN ('fee_once', 'surcharge')),
      amount_centavos  INTEGER NOT NULL CHECK (amount_centavos > 0),
      status           TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied', 'released', 'removed')),
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL,
      UNIQUE (penalty_id, reservation_id)
    );
    CREATE INDEX IF NOT EXISTS ix_penalty_charges_res ON penalty_charges(reservation_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_penalty_charges_fee_once ON penalty_charges(penalty_id) WHERE kind = 'fee_once' AND status = 'applied';

    CREATE TABLE IF NOT EXISTS penalty_appeals (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      penalty_id       INTEGER NOT NULL UNIQUE REFERENCES penalties(id),
      user_id          INTEGER NOT NULL REFERENCES users(id),
      explanation      TEXT NOT NULL CHECK (length(trim(explanation)) > 0),
      status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'upheld', 'revoked')),
      decision_reason  TEXT,
      decided_by       INTEGER REFERENCES users(id),
      decided_at       TEXT,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL,
      CHECK (status = 'pending' OR (decision_reason IS NOT NULL AND length(trim(decision_reason)) > 0))
    );
    CREATE INDEX IF NOT EXISTS ix_penalty_appeals_status ON penalty_appeals(status, created_at);

    CREATE TABLE IF NOT EXISTS appeal_evidence (
      appeal_id   INTEGER PRIMARY KEY REFERENCES penalty_appeals(id) ON DELETE CASCADE,
      mime        TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif')),
      size_bytes  INTEGER NOT NULL CHECK (size_bytes > 0),
      sha256      TEXT,
      data        BLOB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS penalty_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      penalty_id    INTEGER NOT NULL REFERENCES penalties(id),
      action        TEXT NOT NULL,
      actor_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      details       TEXT,
      audit_log_id  INTEGER REFERENCES audit_logs(id) ON DELETE SET NULL,
      created_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_penalty_events_penalty ON penalty_events(penalty_id, id);
  `);

  // Penalties from the plate-based table of migration 008, carried over to the account that owns the plate.
  if (tableExists(db, 'plate_penalties')) {
    const legacy = db.prepare(`SELECT * FROM plate_penalties WHERE id NOT IN (SELECT legacy_plate_penalty_id FROM penalties WHERE legacy_plate_penalty_id IS NOT NULL) ORDER BY id`).all();
    const owner = db.prepare(
      `SELECT id, user_id, plate_number FROM vehicles WHERE replace(plate_number, ' ', '') = ? ORDER BY is_active DESC, id DESC LIMIT 1`,
    );
    const reportExists = db.prepare('SELECT 1 FROM etiquette_reports WHERE id = ?');
    const insert = db.prepare(
      `INSERT INTO penalties (user_id, vehicle_id, plate_number, plate_key, report_id, kind, amount_centavos, starts_at, ends_at, reason,
         status, issued_by, issued_at, updated_at, revoked_by, revoked_at, revoke_reason, legacy_plate_penalty_id)
       VALUES (@user_id, @vehicle_id, @plate_number, @plate_key, @report_id, @kind, @amount, @starts_at, @ends_at, @reason,
         @status, @issued_by, @issued_at, @issued_at, @revoked_by, @revoked_at, @revoke_reason, @legacy_id)`,
    );
    const event = db.prepare(`INSERT INTO penalty_events (penalty_id, action, actor_id, details, created_at) VALUES (?, 'migrated', NULL, ?, ?)`);
    for (const p of legacy) {
      const v = owner.get(p.plate_key);
      if (!v) continue; // no registered vehicle has this plate: there is no verified account to hold the penalty
      // An account holds one active permanent ban; a second one on the same account is kept as a revoked duplicate.
      const duplicateBan = p.kind === 'perm_ban' && p.status !== 'lifted'
        && db.prepare(`SELECT 1 FROM penalties WHERE user_id = ? AND kind = 'perm_ban' AND status = 'active'`).get(v.user_id);
      const lifted = p.status === 'lifted' || !!duplicateBan;
      if (duplicateBan) p.lift_reason = 'Duplicate permanent ban on the same account, merged during the upgrade.';
      const info = insert.run({
        user_id: v.user_id,
        vehicle_id: v.id,
        plate_number: p.plate_number,
        plate_key: p.plate_key,
        report_id: p.report_id && reportExists.get(p.report_id) ? p.report_id : null,
        kind: p.kind, // 'surcharge' (every reservation, no end), 'temp_ban', 'perm_ban' mean the same here
        amount: p.kind === 'surcharge' ? p.amount_centavos : null,
        starts_at: p.starts_at,
        ends_at: p.kind === 'perm_ban' ? null : p.ends_at,
        reason: p.reason,
        status: lifted ? 'revoked' : 'active',
        issued_by: p.created_by,
        issued_at: p.created_at,
        revoked_by: lifted ? p.lifted_by : null,
        revoked_at: lifted ? p.lifted_at : null,
        revoke_reason: lifted ? p.lift_reason || 'Lifted' : null,
        legacy_id: p.id,
      });
      event.run(info.lastInsertRowid, JSON.stringify({ from: 'plate_penalties', legacy_id: p.id }), p.created_at);
    }
    // A report that already led to one of these penalties is about that vehicle: it counts as verified.
    db.exec(`
      UPDATE etiquette_reports SET
        vehicle_id = (SELECT p.vehicle_id FROM penalties p WHERE p.report_id = etiquette_reports.id AND p.legacy_plate_penalty_id IS NOT NULL ORDER BY p.id LIMIT 1),
        owner_id = (SELECT p.user_id FROM penalties p WHERE p.report_id = etiquette_reports.id AND p.legacy_plate_penalty_id IS NOT NULL ORDER BY p.id LIMIT 1),
        verified_by = (SELECT p.issued_by FROM penalties p WHERE p.report_id = etiquette_reports.id AND p.legacy_plate_penalty_id IS NOT NULL ORDER BY p.id LIMIT 1),
        verified_at = (SELECT p.issued_at FROM penalties p WHERE p.report_id = etiquette_reports.id AND p.legacy_plate_penalty_id IS NOT NULL ORDER BY p.id LIMIT 1)
      WHERE vehicle_id IS NULL AND EXISTS (SELECT 1 FROM penalties p WHERE p.report_id = etiquette_reports.id AND p.legacy_plate_penalty_id IS NOT NULL);
    `);
  }
}

module.exports = { up };
