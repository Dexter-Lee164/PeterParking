'use strict';

/**
 * 007 — Main Building doubles to 72 car slots: three covered double rows of twelve instead of two of nine.
 *
 * On a database that already has the campus lots, the lot plans are applied (src/db/lotPlans.js): MB-37..MB-72 are
 * added and the map uses twelve columns. MB-01..MB-36 keep their codes, status and bookings. A fresh database gets all
 * of this from the demo seed instead.
 *
 * Idempotent: applying the plans again changes nothing.
 */

function up(db) {
  const campus = db.prepare(`SELECT COUNT(*) AS n FROM parking_zones WHERE code IN ('MB', 'EN', 'SC', 'AD')`).get().n;
  if (campus) require('../lotPlans').applyPlans(db);
}

module.exports = { up };
