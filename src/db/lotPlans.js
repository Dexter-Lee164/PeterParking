'use strict';

const time = require('../utils/time');

/**
 * The four campus lots: which slots each has, of which type, in which order. The demo seed creates them from here,
 * and `npm run db:lots` brings an existing database in line (adds missing slots, aligns types and order).
 * Their drawings on Find Parking live in src/utils/lotLayout.js and expect these codes in this order.
 */

function range(code, from, to, type = 'regular', overrides = {}) {
  const out = [];
  for (let n = from; n <= to; n += 1) {
    const slotCode = `${code}-${String(n).padStart(2, '0')}`;
    out.push(Object.assign({ code: slotCode, type, status: 'active' }, overrides[n] || {}));
  }
  return out;
}

const PLANS = [
  {
    code: 'MB',
    name: 'Main Building',
    description: 'Covered parking under solar canopies beside the main lobby.',
    columns: 12,
    slots: range('MB', 1, 72, 'regular', { 1: { type: 'accessible' }, 2: { type: 'accessible' }, 6: { status: 'maintenance' } }),
  },
  {
    code: 'EN',
    name: 'Engineering',
    description: 'Angled one-way lot beside the engineering workshops, with motorcycle bays on the exit road.',
    columns: 10,
    slots: [...range('EN', 1, 20, 'regular', { 1: { type: 'accessible' } }), ...range('EN', 21, 30, 'motorcycle')],
  },
  {
    code: 'SC',
    name: 'Science',
    description: 'Lot along the science complex and laboratories.',
    columns: 10,
    slots: [
      ...range('SC', 1, 30, 'regular', { 1: { type: 'accessible' }, 2: { type: 'accessible' }, 4: { status: 'maintenance' } }),
      ...range('SC', 31, 38, 'motorcycle'),
    ],
  },
  {
    code: 'AD',
    name: 'Administration',
    description: 'Visitor parking around the administration drop-off circle.',
    columns: 8,
    slots: [...range('AD', 1, 16, 'regular', { 1: { type: 'accessible' }, 2: { type: 'accessible' } }), ...range('AD', 17, 22, 'motorcycle')],
  },
  {
    // Most motorcycle bays on campus are here; Engineering, Science and Administration have a few each.
    code: 'MC',
    name: 'Motorcycle Parking',
    description: 'Covered motorcycle-only parking beside the student center.',
    columns: 10,
    slots: range('MC', 1, 80, 'motorcycle'),
  },
];

/**
 * Take a slot out of its zone. Upcoming confirmed bookings first move to a free slot of the same type (in the
 * motorcycle zone for motorcycle bays); a slot with no booking history is deleted, one with history is kept but retired
 * (inactive, hidden from maps and lists) so past reservations, sessions and payments still point at it.
 */
function retireSlot(db, slot, now, report) {
  const upcoming = db.prepare(`SELECT id, booking_ref, start_at, end_at FROM reservations WHERE slot_id = ? AND status = 'confirmed' AND end_at > ? ORDER BY start_at`).all(slot.id, now);
  const candidates = db.prepare(
    `SELECT s.id, s.slot_code FROM parking_slots s JOIN parking_zones z ON z.id = s.zone_id
      WHERE s.slot_type = ? AND s.status = 'active' AND s.retired_at IS NULL AND z.is_active = 1 AND s.id <> ?
      ORDER BY (z.code = 'MC') DESC, z.sort_order, s.sort_order, s.slot_code`,
  ).all(slot.slot_type, slot.id);
  const busy = db.prepare(`SELECT 1 FROM reservations WHERE slot_id = ? AND status IN ('confirmed', 'checked_in') AND start_at < ? AND end_at > ? LIMIT 1`);
  const log = db.prepare(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, created_at) VALUES (NULL, ?, ?, ?, ?, ?)`);
  for (const r of upcoming) {
    const target = candidates.find((c) => !busy.get(c.id, r.end_at, r.start_at));
    if (!target) {
      report.push(`${r.booking_ref}: no free ${slot.slot_type} slot to move to; it stays on ${slot.slot_code}`);
      continue;
    }
    db.prepare(`UPDATE reservations SET slot_id = ?, updated_at = ? WHERE id = ?`).run(target.id, now, r.id);
    log.run('reservation.move', 'reservation', r.id, JSON.stringify({ ref: r.booking_ref, from: slot.slot_code, to: target.slot_code, reason: 'slot retired' }), now);
    report.push(`${r.booking_ref}: moved from ${slot.slot_code} to ${target.slot_code}`);
  }
  const history = db.prepare('SELECT COUNT(*) AS n FROM reservations WHERE slot_id = ?').get(slot.id).n;
  if (history) {
    db.prepare(`UPDATE parking_slots SET status = 'inactive', retired_at = ?, updated_at = ? WHERE id = ?`).run(now, now, slot.id);
    log.run('slot.retire', 'parking_slot', slot.id, JSON.stringify({ slot: slot.slot_code, history }), now);
    report.push(`${slot.slot_code}: retired (${history} past booking(s) kept)`);
  } else {
    db.prepare('DELETE FROM parking_slots WHERE id = ?').run(slot.id);
    report.push(`${slot.slot_code}: removed`);
  }
}

/**
 * Apply the plans to an open database. Zones are matched by code (created when missing). Missing slots are added;
 * existing ones get the planned type and order, except when a booking that has not happened yet would no longer fit
 * the new type (that slot keeps its type and is reported). Operational status of existing slots is never changed, except
 * that a retired slot which is back in the plan is restored (its history is kept) with the planned status.
 * Slots of a planned zone that are no longer in its plan are taken out with retireSlot().
 */
function applyPlans(db) {
  const report = [];
  const fits = (slotVehicle, vehicleType) =>
    slotVehicle === 'any' || (slotVehicle === 'motorcycle' ? vehicleType === 'motorcycle' : vehicleType !== 'motorcycle');
  const typeVehicle = new Map(db.prepare('SELECT code, vehicle_type FROM slot_types').all().map((t) => [t.code, t.vehicle_type]));
  const blockingBookings = db.prepare(
    `SELECT v.vehicle_type FROM reservations r JOIN vehicles v ON v.id = r.vehicle_id
      WHERE r.slot_id = ? AND r.status IN ('confirmed', 'checked_in') AND r.end_at > datetime('now', 'localtime')`,
  );

  const zones = [];
  db.transaction(() => {
    PLANS.forEach((plan, zi) => {
      let zone = db.prepare('SELECT * FROM parking_zones WHERE code = ?').get(plan.code);
      if (!zone) {
        const id = db
          .prepare('INSERT INTO parking_zones (code, name, description, map_columns, sort_order) VALUES (?, ?, ?, ?, ?)')
          .run(plan.code, plan.name, plan.description, plan.columns, zi + 1).lastInsertRowid;
        zone = db.prepare('SELECT * FROM parking_zones WHERE id = ?').get(id);
        report.push(`${plan.code}: zone created`);
      } else {
        db.prepare(`UPDATE parking_zones SET map_columns = ?, description = ?, updated_at = datetime('now','localtime') WHERE id = ?`)
          .run(plan.columns, plan.description, zone.id);
      }
      let added = 0;
      let retyped = 0;
      let restored = 0;
      plan.slots.forEach((s, i) => {
        const existing = db.prepare('SELECT * FROM parking_slots WHERE zone_id = ? AND slot_code = ?').get(zone.id, s.code);
        if (!existing) {
          db.prepare('INSERT INTO parking_slots (zone_id, slot_code, slot_type, status, sort_order) VALUES (?, ?, ?, ?, ?)')
            .run(zone.id, s.code, s.type, s.status, i + 1);
          added += 1;
          return;
        }
        let type = existing.slot_type;
        if (existing.slot_type !== s.type) {
          const clash = blockingBookings.all(existing.id).some((b) => !fits(typeVehicle.get(s.type), b.vehicle_type));
          if (clash) report.push(`${s.code}: kept as ${existing.slot_type} (an upcoming booking would not fit ${s.type})`);
          else {
            type = s.type;
            retyped += 1;
          }
        }
        if (existing.retired_at) {
          db.prepare(`UPDATE parking_slots SET status = ?, retired_at = NULL WHERE id = ?`).run(s.status, existing.id);
          restored += 1;
        }
        db.prepare(`UPDATE parking_slots SET slot_type = ?, sort_order = ?, updated_at = datetime('now','localtime') WHERE id = ?`)
          .run(type, i + 1, existing.id);
      });
      report.push(`${plan.code}: ${plan.slots.length} slots planned, ${added} added, ${retyped} retyped, ${restored} restored`);
      zones.push({ zone, codes: new Set(plan.slots.map((s) => s.code)) });
    });
    // Only after every zone (the motorcycle zone included) has its planned slots, so moved bookings have somewhere to go.
    const now = time.nowLocal();
    zones.forEach(({ zone, codes }) => {
      db.prepare('SELECT * FROM parking_slots WHERE zone_id = ? AND retired_at IS NULL ORDER BY sort_order, slot_code').all(zone.id)
        .filter((s) => !codes.has(s.slot_code))
        .forEach((s) => retireSlot(db, s, now, report));
    });
  })();
  return report;
}

module.exports = { PLANS, applyPlans, retireSlot };
