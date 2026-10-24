'use strict';

/**
 * 004 — no more EV charging slots, and one zone for every motorcycle bay.
 *
 *   parking_slots.retired_at   set when a slot is taken out of its zone but has booking history: it stays (inactive)
 *                              so past reservations, sessions and payments keep pointing at it, and is hidden from
 *                              maps, counts and slot lists.
 *   EV charging                every 'ev' slot becomes a 'regular' car slot (same bay, same code, same history); the
 *                              'ev' slot type and its rates are removed. Bookings keep the rate they were made at.
 *   Motorcycle Parking (MC)    on a database that already has the campus lots, the lot plans are applied
 *                              (src/db/lotPlans.js): the MC zone and its 80 bays are created, and the motorcycle bays of
 *                              the other zones are removed (upcoming bookings move to MC first; slots with history are
 *                              retired, the rest deleted). A fresh database gets all of this from the demo seed instead.
 *   Accessible slots           take cars and vans only (they were "any vehicle"), so motorcycles park only in MC.
 *
 * Idempotent: each step checks before it changes anything.
 */

function up(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(parking_slots)').all().map((c) => c.name));
  if (!columns.has('retired_at')) db.exec('ALTER TABLE parking_slots ADD COLUMN retired_at TEXT');

  if (db.prepare(`SELECT 1 FROM slot_types WHERE code = 'ev'`).get()) {
    db.prepare(`UPDATE parking_slots SET slot_type = 'regular', updated_at = datetime('now', 'localtime') WHERE slot_type = 'ev'`).run();
    db.prepare(`DELETE FROM parking_rates WHERE slot_type = 'ev'`).run();
    db.prepare(`DELETE FROM slot_types WHERE code = 'ev'`).run();
  }

  // Accessible bays sit in the car lots, so they now take cars and vans only: a motorcycle always parks in MC.
  db.prepare(`UPDATE slot_types SET vehicle_type = 'car' WHERE code = 'accessible' AND vehicle_type = 'any'`).run();

  const campus = db.prepare(`SELECT COUNT(*) AS n FROM parking_zones WHERE code IN ('MB', 'EN', 'SC', 'AD')`).get().n;
  if (campus) require('../lotPlans').applyPlans(db);
}

module.exports = { up };
