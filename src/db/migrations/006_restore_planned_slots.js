'use strict';

/**
 * 006 — bring back retired slots that are in the lot plans again.
 *
 * Migration 004 retired the old motorcycle bays of Engineering and Science that had booking history. Migration 005
 * planned motorcycle bays there again under some of the same codes (e.g. EN-27, SC-31), but applying the plans left
 * those slots retired, so they were missing from the map and their bays were drawn as unavailable. Applying the plans
 * now restores them (src/db/lotPlans.js): active again, with their booking history kept.
 *
 * Idempotent: applying the plans again changes nothing.
 */

function up(db) {
  const campus = db.prepare(`SELECT COUNT(*) AS n FROM parking_zones WHERE code IN ('MB', 'EN', 'SC', 'AD')`).get().n;
  if (campus) require('../lotPlans').applyPlans(db);
}

module.exports = { up };
