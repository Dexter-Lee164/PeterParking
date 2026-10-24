'use strict';

/**
 * 005 — a few motorcycle bays in the car lots, next to the Motorcycle Parking zone (MC).
 *
 *   Engineering (EN)       the side bay on the exit road becomes motorcycle bays: EN-21..EN-26 change from car slots to
 *                          motorcycle slots and EN-27..EN-30 are added.
 *   Science (SC)           SC-31..SC-38, motorcycle bays along the right road.
 *   Administration (AD)    AD-17..AD-22, motorcycle bays below the drop-off circle.
 *
 * On a database that already has the campus lots, the lot plans are applied (src/db/lotPlans.js). A side-bay slot with
 * an upcoming car booking stays a car slot (and is reported); `npm run db:lots` retypes it once that booking is over.
 * A fresh database gets all of this from the demo seed instead.
 *
 * Idempotent: applying the plans again changes nothing.
 */

function up(db) {
  const campus = db.prepare(`SELECT COUNT(*) AS n FROM parking_zones WHERE code IN ('MB', 'EN', 'SC', 'AD')`).get().n;
  if (campus) require('../lotPlans').applyPlans(db);
}

module.exports = { up };
