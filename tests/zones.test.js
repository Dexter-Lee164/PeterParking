'use strict';

/**
 * Campus zones after the EV / motorcycle change: no EV charging slots anywhere, most motorcycle bays in the Motorcycle
 * Parking zone (MC) and a few in Engineering, Science and Administration. Covers a fresh demo database and the upgrade
 * of an older one (migrations 004 and 005).
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, PASSWORD } = require('./helpers');
const { openDatabase, migrate } = require('../src/db');
const lotLayout = require('../src/utils/lotLayout');
const { PLANS } = require('../src/db/lotPlans');
const time = require('../src/utils/time');

const SCENE_WIDTHS = { MB: 518, EN: 566, SC: 400, AD: 420, MC: 420 };
// Planned motorcycle bays outside MC: EN-21..30, SC-31..38, AD-17..22.
const LOT_MOTO = PLANS.filter((p) => p.code !== 'MC').flatMap((p) => p.slots.filter((s) => s.type === 'motorcycle').map((s) => s.code));

describe('a fresh demo database', () => {
  let env;
  before(async () => {
    env = await startApp({ fixture: 'demo', now: '2026-03-10 07:00' });
  });
  after(async () => env.stop());

  test('five zones; no EV type or slot; 80 motorcycle bays in MC and a few in EN, SC and AD', () => {
    const zones = env.db.prepare('SELECT code FROM parking_zones ORDER BY sort_order').all().map((z) => z.code);
    assert.deepEqual(zones, ['MB', 'EN', 'SC', 'AD', 'MC']);
    assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM slot_types WHERE code = 'ev'`).get().n, 0);
    assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM parking_rates WHERE slot_type = 'ev'`).get().n, 0);
    const byZone = env.db.prepare(
      `SELECT z.code, s.slot_type, COUNT(*) AS n FROM parking_slots s JOIN parking_zones z ON z.id = s.zone_id GROUP BY z.code, s.slot_type`,
    ).all();
    const moto = Object.fromEntries(byZone.filter((r) => r.slot_type === 'motorcycle').map((r) => [r.code, r.n]));
    assert.deepEqual(moto, { MC: 80, EN: 10, SC: 8, AD: 6 });
    assert.deepEqual(byZone.filter((r) => r.code === 'MC').map((r) => r.slot_type), ['motorcycle'], 'MC holds nothing else');
    const fitsMotorcycle = env.db.prepare(`SELECT code FROM slot_types WHERE vehicle_type IN ('motorcycle', 'any')`).all().map((t) => t.code);
    assert.deepEqual(fitsMotorcycle, ['motorcycle'], 'no car-lot slot type takes a motorcycle');
  });

  test('every zone is drawn with its own scene (no generic fallback), every slot on a fitting bay', () => {
    for (const [code, width] of Object.entries(SCENE_WIDTHS)) {
      const zone = env.db.prepare('SELECT * FROM parking_zones WHERE code = ?').get(code);
      const slots = env.db.prepare('SELECT id, slot_code AS code, slot_type FROM parking_slots WHERE zone_id = ? ORDER BY sort_order').all(zone.id);
      const lot = lotLayout.build(zone, slots);
      assert.equal(lot.width, width, `${code} scene`);
      assert.equal(lot.stalls.length, slots.length);
      for (const p of lot.stalls) assert.equal(p.kind === 'moto', p.slot.slot_type === 'motorcycle', `${p.slot.code} on a ${p.kind} bay`);
      assert.ok(!lot.stalls.concat(lot.empty).some((p) => p.kind === 'ev'), `${code} has no EV bay`);
    }
  });

  test('a motorcycle search stays in a lot with motorcycle bays, and moves on from one without', async () => {
    const c = env.client();
    await c.login('driver@university.local', 'Driver@12345');
    const id = (code) => env.db.prepare('SELECT id FROM parking_zones WHERE code = ?').get(code).id;
    const find = async (type, zoneId) => JSON.parse((await c.get(
      `/driver/find-parking?date=2026-03-11&start=09:00&end=11:00&vehicle_type=${type}&zone_id=${zoneId}&fragment=1`,
      { headers: { Accept: 'application/json' } },
    )).text);
    const total = (json) => json.counts.available + json.counts.reserved + json.counts.occupied + json.counts.unavailable;
    // Main Building has no motorcycle bays: the first zone with free ones (Engineering) is shown instead.
    const mb = await find('motorcycle', id('MB'));
    assert.equal(mb.zoneId, id('EN'));
    assert.equal(total(mb), 30, 'the whole lot is drawn');
    assert.equal(mb.counts.available, 10, 'only its motorcycle bays can be chosen');
    assert.equal(total(await find('motorcycle', id('MC'))), 80);
    const sc = await find('motorcycle', id('SC'));
    assert.equal(sc.zoneId, id('SC'), 'Science has motorcycle bays');
    assert.equal(total(sc), 38, 'every bay stays on the map');
    assert.equal(sc.counts.available, 8, 'only its motorcycle bays can be chosen');
    const car = await find('car', id('EN'));
    assert.equal(car.zoneId, id('EN'), 'a car stays in the lot it asked for');
    assert.equal(total(car), 30);
    assert.equal(car.counts.available, 20, 'the motorcycle bays cannot be chosen for a car');
  });
});

describe('upgrading an older database (migrations 004 to 007)', () => {
  test('EV slots become regular; unplanned motorcycle bays leave SC; upcoming bookings move to MC; history is kept', () => {
    const db = openDatabase(':memory:');
    // Recreate the state before 004: the EV type and rate, campus zones with EV and motorcycle slots.
    db.prepare('DELETE FROM schema_migrations WHERE version IN (4, 5, 6, 7, 8)').run();
    db.exec(`INSERT INTO slot_types (code, label, vehicle_type, icon, sort_order) VALUES ('ev', 'EV Charging', 'car', 'bi-ev-front', 2)`);
    db.exec(`INSERT INTO parking_rates (name, slot_type, hourly_rate_centavos) VALUES ('EV charging slots', 'ev', 5000)`);
    const zone = (code, name, order) => db.prepare('INSERT INTO parking_zones (code, name, sort_order) VALUES (?, ?, ?)').run(code, name, order).lastInsertRowid;
    const slot = (zoneId, code, type, order) => db.prepare('INSERT INTO parking_slots (zone_id, slot_code, slot_type, sort_order) VALUES (?, ?, ?, ?)').run(zoneId, code, type, order).lastInsertRowid;
    const sc = zone('SC', 'Science', 3);
    const en = zone('EN', 'Engineering', 2);
    for (let n = 1; n <= 30; n += 1) slot(sc, `SC-${String(n).padStart(2, '0')}`, 'regular', n);
    const moto = {};
    for (let n = 31; n <= 40; n += 1) moto[n] = slot(sc, `SC-${n}`, 'motorcycle', n);
    for (let n = 1; n <= 20; n += 1) slot(en, `EN-${String(n).padStart(2, '0')}`, 'regular', n);
    const evSlot = slot(en, 'EN-21', 'ev', 21);
    const user = db.prepare(`INSERT INTO users (full_name, email, password_hash) VALUES ('Paolo Reyes', 'paolo@legacy.test', ?)`).run(PASSWORD).lastInsertRowid;
    const bike = db.prepare(`INSERT INTO vehicles (user_id, plate_number, vehicle_type) VALUES (?, 'MOTO 001', 'motorcycle')`).run(user).lastInsertRowid;
    const car = db.prepare(`INSERT INTO vehicles (user_id, plate_number, vehicle_type) VALUES (?, 'CAR 0001', 'car')`).run(user).lastInsertRowid;
    const today = time.nowLocal().slice(0, 10);
    const day = (d) => time.addDays(`${today} 00:00:00`, d).slice(0, 10);
    const book = (ref, slotId, vehicle, date, status) => db.prepare(
      `INSERT INTO reservations (booking_ref, user_id, vehicle_id, slot_id, start_at, end_at, duration_minutes, hourly_rate_centavos, fee_estimated_centavos, status)
       VALUES (?, ?, ?, ?, ?, ?, 60, 1500, 1500, ?)`,
    ).run(ref, user, vehicle, slotId, `${date} 09:00:00`, `${date} 10:00:00`, status).lastInsertRowid;
    // SC-31..38 are planned motorcycle bays; SC-39 and SC-40 are not.
    const past = book('UP-PAST', moto[39], bike, day(-3), 'completed');
    const upcoming = book('UP-NEXT', moto[40], bike, day(2), 'confirmed');
    const stays = book('UP-STAY', moto[31], bike, day(2), 'confirmed');
    const evBooking = book('UP-EV', evSlot, car, day(2), 'confirmed');

    migrate(db);

    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM slot_types WHERE code = 'ev'`).get().n, 0);
    // EN-21 is a planned motorcycle bay, but its upcoming car booking keeps it a car slot for now.
    assert.equal(db.prepare(`SELECT slot_type FROM parking_slots WHERE id = ?`).get(evSlot).slot_type, 'regular', 'EV bay kept as a car slot');
    assert.equal(db.prepare('SELECT slot_id FROM reservations WHERE id = ?').get(evBooking).slot_id, evSlot, 'its booking is untouched');

    const mc = db.prepare(`SELECT * FROM parking_zones WHERE code = 'MC'`).get();
    assert.ok(mc, 'motorcycle zone created');
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM parking_slots WHERE zone_id = ? AND slot_type = 'motorcycle' AND retired_at IS NULL`).get(mc.id).n, 80);
    const lotMoto = db.prepare(
      `SELECT s.slot_code FROM parking_slots s JOIN parking_zones z ON z.id = s.zone_id
        WHERE s.slot_type = 'motorcycle' AND z.code <> 'MC' AND s.retired_at IS NULL ORDER BY s.slot_code`,
    ).all().map((r) => r.slot_code);
    assert.deepEqual(lotMoto, LOT_MOTO.filter((code) => code !== 'EN-21').sort(), 'only the planned motorcycle bays are left outside MC');

    // SC-39 had a finished booking: retired, not deleted, and that history still resolves.
    const sc39 = db.prepare('SELECT * FROM parking_slots WHERE id = ?').get(moto[39]);
    assert.ok(sc39.retired_at);
    assert.equal(sc39.status, 'inactive');
    assert.equal(db.prepare('SELECT s.slot_code FROM reservations r JOIN parking_slots s ON s.id = r.slot_id WHERE r.id = ?').get(past).slot_code, 'SC-39');
    // SC-40's upcoming booking moved to the MC zone, after which SC-40 had no history left and was deleted.
    const moved = db.prepare('SELECT s.slot_code, z.code FROM reservations r JOIN parking_slots s ON s.id = r.slot_id JOIN parking_zones z ON z.id = s.zone_id WHERE r.id = ?').get(upcoming);
    assert.deepEqual(moved, { slot_code: 'MC-01', code: 'MC' });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM parking_slots WHERE id = ?').get(moto[40]).n, 0);
    // SC-31 is still a motorcycle bay in the plan, so its booking stays put.
    assert.equal(db.prepare('SELECT slot_id FROM reservations WHERE id = ?').get(stays).slot_id, moto[31]);
    assert.ok(db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'reservation.move' AND entity_id = ?`).get(upcoming));

    // Running it again changes nothing.
    const snapshot = () => db.prepare('SELECT id, zone_id, slot_code, slot_type, status, retired_at FROM parking_slots ORDER BY id').all();
    const before = snapshot();
    db.prepare('DELETE FROM schema_migrations WHERE version IN (4, 5, 6, 7, 8)').run();
    migrate(db);
    assert.deepEqual(snapshot(), before);
    db.close();
  });

  test('a retired slot that is back in the plan is restored, with its history', () => {
    const db = openDatabase(':memory:');
    const { applyPlans } = require('../src/db/lotPlans');
    applyPlans(db);
    // SC-31 as migration 004 left it on an older database: retired, with a past booking.
    const sc31 = db.prepare(`SELECT id FROM parking_slots WHERE slot_code = 'SC-31'`).get().id;
    const user = db.prepare(`INSERT INTO users (full_name, email, password_hash) VALUES ('Paolo Reyes', 'paolo@legacy.test', ?)`).run(PASSWORD).lastInsertRowid;
    const bike = db.prepare(`INSERT INTO vehicles (user_id, plate_number, vehicle_type) VALUES (?, 'MOTO 001', 'motorcycle')`).run(user).lastInsertRowid;
    db.prepare(
      `INSERT INTO reservations (booking_ref, user_id, vehicle_id, slot_id, start_at, end_at, duration_minutes, hourly_rate_centavos, fee_estimated_centavos, status)
       VALUES ('OLD-1', ?, ?, ?, '2025-12-01 09:00:00', '2025-12-01 10:00:00', 60, 1500, 1500, 'completed')`,
    ).run(user, bike, sc31);
    db.prepare(`UPDATE parking_slots SET status = 'inactive', retired_at = '2026-01-01 00:00:00' WHERE id = ?`).run(sc31);

    const report = applyPlans(db);

    assert.deepEqual(db.prepare('SELECT status, retired_at FROM parking_slots WHERE id = ?').get(sc31), { status: 'active', retired_at: null });
    assert.equal(db.prepare(`SELECT slot_id FROM reservations WHERE booking_ref = 'OLD-1'`).get().slot_id, sc31);
    assert.ok(report.some((line) => /^SC: .*1 restored/.test(line)));
    db.close();
  });
});
