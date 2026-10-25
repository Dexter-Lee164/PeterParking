'use strict';

/**
 * 010 — parking etiquette reports and plate penalties are retired.
 *
 *   etiquette_evidence, plate_penalties, etiquette_reports   dropped with their rows (children first, so foreign keys
 *                              hold while they go).
 *   notification_reads         the 'reports' section's read markers are removed; the section no longer exists.
 *
 * Kept on purpose: reservations.surcharge_centavos (bookings made under a penalty keep the fee they were made with,
 * and cancellation and no-show fees still read it; new bookings store 0), and the audit log entries of past
 * etiquette decisions.
 *
 * Idempotent: running it again finds nothing to drop.
 */

const tableExists = (db, name) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);

function up(db) {
  db.exec(`
    DROP TABLE IF EXISTS etiquette_evidence;
    DROP TABLE IF EXISTS plate_penalties;
    DROP TABLE IF EXISTS etiquette_reports;
  `);
  if (tableExists(db, 'notification_reads')) db.prepare(`DELETE FROM notification_reads WHERE section = 'reports'`).run();
}

module.exports = { up };
