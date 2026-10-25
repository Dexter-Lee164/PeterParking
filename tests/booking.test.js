'use strict';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, setNow } = require('./helpers');
const reservations = require('../src/services/reservations');
const availability = require('../src/services/availability');
const settingsService = require('../src/services/settings');
const parking = require('../src/services/parking');
const { AppError } = require('../src/utils/errors');

const NOW = '2026-03-10 09:00';
const DAY = '2026-03-10';

describe('booking rules (service layer)', () => {
  let env;
  let d;
  before(async () => {
    env = await startApp({ fixture: 'minimal', now: NOW });
    d = env.data;
  });
  after(async () => env.stop());

  // Every test starts from an empty reservation table and default settings.
  beforeEach(() => {
    setNow(NOW);
    env.db.exec('DELETE FROM payments; DELETE FROM parking_sessions; DELETE FROM reservations;');
    env.db.exec(`DELETE FROM settings;`);
    env.db.exec(`UPDATE parking_slots SET status = 'active', hourly_rate_override_centavos = NULL;`);
  });

  const book = (who, slot, start, end, date = DAY, vehicle) =>
    reservations.createReservation(
      { userId: who.id, vehicleId: (vehicle || (who === d.alice ? d.aliceCar : d.bobCar)).id, slotId: slot.id, date, start, end },
      { id: who.id },
    );
  const fails = (fn, code, pattern) => {
    assert.throws(fn, (err) => {
      assert.ok(err instanceof AppError, `expected AppError, got ${err && err.stack}`);
      if (code) assert.equal(err.code, code, err.message);
      if (pattern) assert.match(err.message, pattern);
      return true;
    });
  };
  const count = () => env.db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n;

  test('availability reflects real bookings, vehicle fit and maintenance', () => {
    const range = { startAt: `${DAY} 10:00:00`, endAt: `${DAY} 12:00:00` };
    let a = availability.getAvailability({ ...range, vehicleType: 'car' });
    const mine = a.slots.filter((s) => s.zone_id === d.zone.id);
    assert.equal(mine.filter((s) => s.state === 'available').length, 5, 'five car slots free');
    assert.equal(mine.find((s) => s.code === 'M1').state, 'unavailable', 'motorcycle bay is not for a car');
    assert.equal(a.zones.find((z) => z.id === d.zone.id).available, 5);

    book(d.bob, d.slots[0], '11:00', '13:00');
    parking.setSlotStatus(d.slots[1].id, 'maintenance', { id: d.admin.id });
    a = availability.getAvailability({ ...range, vehicleType: 'car' });
    const byCode = Object.fromEntries(a.slots.filter((s) => s.zone_id === d.zone.id).map((s) => [s.code, s]));
    assert.equal(byCode.T1.state, 'reserved', 'partially overlapping booking blocks the slot');
    assert.equal(byCode.T2.state, 'unavailable');
    assert.equal(byCode.T2.reason, 'Out of service');
    assert.equal(byCode.T3.state, 'available');
    assert.equal(a.zones.find((z) => z.id === d.zone.id).available, 3);

    const moto = availability.getAvailability({ ...range, vehicleType: 'motorcycle' });
    const motoByCode = Object.fromEntries(moto.slots.filter((s) => s.zone_id === d.zone.id).map((s) => [s.code, s]));
    assert.equal(motoByCode.M1.state, 'available');
    assert.equal(motoByCode.T3.state, 'unavailable');
  });

  test('a valid booking stores the locked rate, fee and a unique reference', () => {
    const r = book(d.alice, d.slots[0], '10:00', '12:00');
    assert.equal(r.status, 'confirmed');
    assert.equal(r.start_at, `${DAY} 10:00:00`);
    assert.equal(r.end_at, `${DAY} 12:00:00`);
    assert.equal(r.duration_minutes, 120);
    assert.equal(r.hourly_rate_centavos, 3000);
    assert.equal(r.fee_estimated_centavos, 6000);
    assert.equal(r.fee_final_centavos, null, 'fee is not final until check-out/cancel/no-show');
    assert.match(r.booking_ref, /^UP-\d{6}-[A-Z2-9]{5}$/);
    const r2 = book(d.alice, d.slots[1], '10:00', '11:00', DAY, d.aliceCar2);
    assert.notEqual(r.booking_ref, r2.booking_ref);
    assert.equal(r2.fee_estimated_centavos, 3000);
    const audit = env.db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'reservation.create' AND entity_id = ?`).get(r.id).n;
    assert.equal(audit, 1, 'booking is audit-logged');
  });

  test('overlapping bookings on the same slot are rejected in every overlap shape', () => {
    book(d.alice, d.slots[0], '12:00', '15:00');
    const before = count();
    const attempts = [
      ['10:00', '13:00', 'overlaps the start'],
      ['14:00', '17:00', 'overlaps the end'],
      ['12:00', '15:00', 'identical window'],
      ['11:00', '16:00', 'contains the existing booking'],
      ['13:00', '14:00', 'inside the existing booking'],
    ];
    for (const [s, e, why] of attempts) {
      fails(() => book(d.bob, d.slots[0], s, e), 'CONFLICT', undefined);
      assert.equal(count(), before, `${why} must not create a row`);
    }
  });

  test('adjacent bookings are allowed (one ends exactly when the next begins)', () => {
    book(d.alice, d.slots[0], '12:00', '14:00');
    assert.doesNotThrow(() => book(d.bob, d.slots[0], '14:00', '16:00'));
    assert.doesNotThrow(() => book(d.bob, d.slots[0], '10:00', '12:00'));
    assert.equal(count(), 3);
    // But the bay is now full from 10:00 to 16:00.
    fails(() => book(d.alice, d.slots[0], '09:00', '11:00', DAY, d.aliceCar2), 'CONFLICT');
  });

  test('the same time on a different slot is fine', () => {
    book(d.alice, d.slots[0], '10:00', '12:00');
    assert.doesNotThrow(() => book(d.bob, d.slots[1], '10:00', '12:00'));
  });

  test('cancelled bookings free the slot again, history is kept', () => {
    const r = book(d.alice, d.slots[0], '12:00', '14:00');
    fails(() => book(d.bob, d.slots[0], '12:00', '14:00'), 'CONFLICT');
    reservations.cancelReservation(r.id, d.alice, { actor: { id: d.alice.id } });
    assert.equal(count(), 1, 'cancelled reservation row is NOT deleted');
    assert.doesNotThrow(() => book(d.bob, d.slots[0], '12:00', '14:00'));
    assert.equal(env.db.prepare('SELECT status FROM reservations WHERE id = ?').get(r.id).status, 'cancelled');
  });

  test('input validation: past, order, step, hours, duration, advance window', () => {
    const cases = [
      ['08:00', '10:00', DAY, /already passed/, 'start in the past'],
      ['12:00', '11:00', DAY, /after the start/, 'end before start'],
      ['12:00', '12:00', DAY, /after the start/, 'zero length'],
      ['12:30', '13:30', DAY, /whole hour/, 'off the hourly grid'],
      ['05:00', '07:00', '2026-03-11', /opens at/, 'before opening'],
      ['21:00', '23:00', '2026-03-11', /closes at/, 'after closing'],
      ['06:00', '15:00', '2026-03-11', /Maximum booking/, 'longer than the maximum'],
      ['10:00', '12:00', '2026-04-20', /days in advance/, 'beyond the advance window'],
      ['10:00', '12:00', 'not-a-date', /valid date/, 'garbage date'],
    ];
    for (const [s, e, date, pattern, label] of cases) {
      fails(() => book(d.alice, d.slots[0], s, e, date), 'VALIDATION', pattern);
      assert.equal(count(), 0, `${label} must not create a booking`);
    }
  });

  test('vehicle/slot compatibility and slots out of service', () => {
    fails(() => book(d.bob, d.slots[0], '10:00', '12:00', DAY, d.bobMoto), 'VEHICLE_MISMATCH');
    fails(() => book(d.alice, d.moto, '10:00', '12:00'), 'VEHICLE_MISMATCH');
    assert.doesNotThrow(() => book(d.bob, d.moto, '10:00', '12:00', DAY, d.bobMoto));
    parking.setSlotStatus(d.slots[2].id, 'maintenance', { id: d.admin.id });
    fails(() => book(d.alice, d.slots[2], '10:00', '12:00'), 'SLOT_NOT_ACTIVE');
    parking.setSlotStatus(d.slots[3].id, 'inactive', { id: d.admin.id });
    fails(() => book(d.alice, d.slots[3], '10:00', '12:00'), 'SLOT_NOT_ACTIVE');
    fails(() => book(d.alice, d.slots[0], '10:00', '12:00', DAY, d.bobCar), 'VALIDATION');
  });

  test('a vehicle cannot hold two overlapping reservations', () => {
    book(d.alice, d.slots[0], '10:00', '12:00');
    fails(() => book(d.alice, d.slots[1], '11:00', '13:00'), 'VEHICLE_CLASH');
    assert.doesNotThrow(() => book(d.alice, d.slots[1], '12:00', '13:00'));
  });

  test('per-driver active reservation limit comes from settings', () => {
    settingsService.update(Object.assign(settingsService.getAll(), { max_active_reservations: 2 }));
    book(d.alice, d.slots[0], '10:00', '11:00');
    book(d.alice, d.slots[0], '11:00', '12:00');
    fails(() => book(d.alice, d.slots[0], '12:00', '13:00'), 'LIMIT', /limit 2/);
  });

  test('free cancellation window and late-cancellation fee', () => {
    const far = book(d.alice, d.slots[0], '13:00', '15:00'); // 4h ahead
    const freeCancel = reservations.cancelReservation(far.id, d.alice, { actor: { id: d.alice.id } });
    assert.equal(freeCancel.status, 'cancelled');
    assert.equal(freeCancel.fee_final_centavos, 0);
    assert.equal(freeCancel.payment_status, 'no_charge');

    const near = book(d.alice, d.slots[1], '10:00', '12:00'); // 1h ahead → inside the 2h window
    const lateCancel = reservations.cancelReservation(near.id, d.alice, { actor: { id: d.alice.id } });
    assert.equal(lateCancel.fee_final_centavos, 3000, '50% of ₱60');
    assert.equal(lateCancel.balance_centavos, 3000);
    assert.equal(lateCancel.payment_status, 'unpaid');

    fails(() => reservations.cancelReservation(near.id, d.alice, { actor: { id: d.alice.id } }), 'INVALID_STATE', /already cancelled/);
  });

  test('a driver cannot cancel after the booking started; an admin must give a reason', () => {
    const r = book(d.alice, d.slots[0], '09:00', '11:00');
    setNow('2026-03-10 09:30');
    fails(() => reservations.cancelReservation(r.id, d.alice, { actor: { id: d.alice.id } }), 'TOO_LATE');
    fails(() => reservations.cancelReservation(r.id, d.admin, { reason: '', actor: { id: d.admin.id } }), 'VALIDATION');
    const done = reservations.cancelReservation(r.id, d.admin, { reason: 'Gate repair', waiveFee: true, actor: { id: d.admin.id } });
    assert.equal(done.status, 'cancelled');
    assert.equal(done.fee_final_centavos, 0, 'admin waived the fee');
    assert.equal(done.cancel_reason, 'Gate repair');
  });

  test('reschedule keeps the slot, recomputes the fee and refuses conflicts', () => {
    const r = book(d.alice, d.slots[0], '14:00', '15:00');
    const other = book(d.bob, d.slots[0], '17:00', '19:00');
    const moved = reservations.rescheduleReservation(r.id, d.alice, { date: DAY, start: '15:00', end: '17:00' }, { id: d.alice.id });
    assert.equal(moved.start_at, `${DAY} 15:00:00`);
    assert.equal(moved.fee_estimated_centavos, 6000);
    assert.equal(moved.slot_id, d.slots[0].id);
    fails(() => reservations.rescheduleReservation(r.id, d.alice, { date: DAY, start: '16:00', end: '18:00' }, { id: d.alice.id }), 'CONFLICT');
    assert.equal(env.db.prepare('SELECT start_at FROM reservations WHERE id = ?').get(r.id).start_at, `${DAY} 15:00:00`, 'failed reschedule leaves the booking untouched');
    fails(() => reservations.rescheduleReservation(r.id, d.alice, { date: DAY, start: '15:00', end: '17:00' }, { id: d.alice.id }), 'NO_CHANGE');
    fails(() => reservations.rescheduleReservation(other.id, d.alice, { date: DAY, start: '19:00', end: '20:00' }, { id: d.alice.id }), 'NOT_FOUND');
    // Inside the 2h window it is no longer allowed.
    setNow('2026-03-10 13:30');
    fails(() => reservations.rescheduleReservation(moved.id, d.alice, { date: DAY, start: '18:00', end: '20:00' }, { id: d.alice.id }), 'TOO_LATE');
  });

  test('changing a rate later does not change existing reservations', () => {
    const r = book(d.alice, d.slots[0], '10:00', '12:00');
    env.db.prepare(`UPDATE parking_rates SET hourly_rate_centavos = 9900 WHERE slot_type = 'regular'`).run();
    const unchanged = reservations.getReservation(r.id);
    assert.equal(unchanged.hourly_rate_centavos, 3000);
    assert.equal(unchanged.fee_estimated_centavos, 6000);
    const fresh = book(d.bob, d.slots[1], '10:00', '12:00');
    assert.equal(fresh.hourly_rate_centavos, 9900, 'new bookings use the new rate');
    env.db.prepare(`UPDATE parking_rates SET hourly_rate_centavos = 3000 WHERE slot_type = 'regular'`).run();
  });

  test('a per-slot rate override beats zone and type rates', () => {
    parking.updateSlot(d.slots[4].id, { zone_id: d.zone.id, slot_code: 'T5', slot_type: 'regular', status: 'active', hourly_rate_override: '45.50' }, { id: d.admin.id });
    const r = book(d.alice, d.slots[4], '10:00', '11:00');
    assert.equal(r.hourly_rate_centavos, 4550);
    assert.equal(r.fee_estimated_centavos, 4550);
  });

  test('billing is configurable: 30-minute steps and increments', () => {
    fails(() => book(d.alice, d.slots[0], '10:00', '10:30'), 'VALIDATION');
    const res = settingsService.update(Object.assign(settingsService.getAll(), { time_step_minutes: 30, min_duration_minutes: 30, billing_increment_minutes: 30 }));
    assert.equal(res.errors, null);
    const r = book(d.alice, d.slots[0], '10:00', '11:30');
    assert.equal(r.duration_minutes, 90);
    assert.equal(r.fee_estimated_centavos, 4500, '90 minutes × ₱30/hr billed in 30-minute blocks');
  });

  test('settings validation rejects inconsistent values', () => {
    const base = settingsService.getAll();
    const bad = settingsService.update(Object.assign({}, base, { open_time: '22:00', close_time: '06:00', min_duration_minutes: 600, max_duration_minutes: 60 }));
    assert.ok(bad.errors.close_time);
    assert.ok(bad.errors.max_duration_minutes);
    const nan = settingsService.update(Object.assign({}, base, { cancel_free_hours: 'abc' }));
    assert.ok(nan.errors.cancel_free_hours);
    assert.equal(settingsService.getAll().cancel_free_hours, 2, 'nothing was saved by the failed updates');
  });

  test('the database itself refuses overlapping rows even if the app check is bypassed', () => {
    book(d.alice, d.slots[0], '10:00', '12:00');
    const insert = (start, end, ref) =>
      env.db
        .prepare(
          `INSERT INTO reservations (booking_ref, user_id, vehicle_id, slot_id, start_at, end_at, duration_minutes,
             hourly_rate_centavos, fee_estimated_centavos, status) VALUES (?, ?, ?, ?, ?, ?, 60, 3000, 3000, 'confirmed')`,
        )
        .run(ref, d.bob.id, d.bobCar.id, d.slots[0].id, start, end);
    assert.throws(() => insert(`${DAY} 11:00:00`, `${DAY} 13:00:00`, 'RAW-1'), /RESERVATION_OVERLAP/);
    assert.doesNotThrow(() => insert(`${DAY} 12:00:00`, `${DAY} 13:00:00`, 'RAW-2'));
  });
});

describe('Find Parking and booking over HTTP', () => {
  let env;
  let alice;
  before(async () => {
    env = await startApp({ fixture: 'minimal', now: NOW });
    alice = env.client();
    await alice.login('alice@test.local');
  });
  after(async () => env.stop());

  const search = '/driver/find-parking?date=2026-03-10&start=10:00&end=12:00&vehicle_type=car';

  test('the page and the AJAX fragment return live availability', async () => {
    const page = await alice.get(search);
    assert.equal(page.status, 200);
    assert.match(page.text, /data-slot-id=/);
    assert.match(page.text, /Test Zone/);

    const frag = await alice.get(`${search}&fragment=1&zone_id=${env.data.zone.id}`, { headers: { Accept: 'application/json' } });
    assert.equal(frag.status, 200);
    const json = JSON.parse(frag.text);
    assert.equal(json.ok, true);
    assert.equal(json.counts.available, 5);
    // Every bay stays on the map: the motorcycle bay is shown to a car, as unavailable and not selectable.
    assert.equal(json.counts.unavailable, 1);
    assert.match(json.mapHtml, /class="slot is-unavailable is-other-type[^"]*"[^>]*data-code="M1"[\s\S]*?disabled/);
    assert.match(json.mapHtml, /class="slot is-available/);
    assert.equal(json.listHtml, undefined, 'there is no list view any more');
    assert.equal(json.durationMinutes, 120);

    const bad = await alice.get('/driver/find-parking?date=2026-03-10&start=12:00&end=10:00&fragment=1', { headers: { Accept: 'application/json' } });
    assert.equal(bad.status, 422);
    assert.equal(JSON.parse(bad.text).ok, false);
  });

  test('confirm page → booking → confirmation, then the slot is no longer offered', async () => {
    const slot = env.data.slots[0];
    const confirm = await alice.get(`/driver/reserve?slot_id=${slot.id}&date=2026-03-10&start=10:00&end=12:00&vehicle_type=car`);
    assert.equal(confirm.status, 200);
    assert.match(confirm.text, /Confirm/);
    assert.match(confirm.text, /₱60\.00/);

    const res = await alice.post('/driver/reserve', {
      slot_id: slot.id, vehicle_id: env.data.aliceCar.id, date: '2026-03-10', start: '10:00', end: '12:00', vehicle_type: 'car',
    });
    assert.equal(res.status, 302);
    assert.match(res.location, /^\/driver\/reservations\/\d+$/);
    const page = await alice.get(res.location);
    assert.equal(page.status, 200);
    assert.match(page.text, /Reservation confirmed/);
    const row = env.db.prepare('SELECT * FROM reservations ORDER BY id DESC LIMIT 1').get();
    assert.equal(row.slot_id, slot.id);
    assert.equal(row.status, 'confirmed');
    assert.match(page.text, new RegExp(row.booking_ref));

    // Booking the same slot/time again is refused and nothing is created.
    const again = await alice.post('/driver/reserve', {
      slot_id: slot.id, vehicle_id: env.data.aliceCar2.id, date: '2026-03-10', start: '11:00', end: '12:00', vehicle_type: 'car',
    });
    assert.equal(again.status, 302);
    assert.match(again.location, /find-parking/);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n, 1);
    const follow = await alice.get(again.location);
    assert.match(follow.text, /no longer available|just booked|not free/i);

    const frag = await alice.get(`${search}&fragment=1&zone_id=${env.data.zone.id}`, { headers: { Accept: 'application/json' } });
    const json = JSON.parse(frag.text);
    assert.equal(json.counts.available, 4);
    assert.equal(json.counts.reserved, 1);
  });

  test('driver cancels from the UI and sees the fee notice and history', async () => {
    const row = env.db.prepare('SELECT id FROM reservations ORDER BY id DESC LIMIT 1').get();
    const res = await alice.post(`/driver/reservations/${row.id}/cancel`);
    assert.equal(res.status, 302);
    const page = await alice.get(res.location);
    assert.match(page.text, /cancelled/i);
    const list = await alice.get('/driver/reservations?tab=cancelled');
    assert.match(list.text, /UP-/);
    assert.equal(env.db.prepare('SELECT status FROM reservations WHERE id = ?').get(row.id).status, 'cancelled');
  });

  test('the booking form rejects a tampered slot, vehicle or time with a friendly message', async () => {
    const res = await alice.post('/driver/reserve', { slot_id: 999999, vehicle_id: env.data.aliceCar.id, date: '2026-03-10', start: '10:00', end: '12:00' });
    assert.equal(res.status, 302);
    const msg = await alice.get(res.location);
    assert.match(msg.text, /does not exist|Please/i);
    const past = await alice.post('/driver/reserve', { slot_id: env.data.slots[0].id, vehicle_id: env.data.aliceCar.id, date: '2026-03-09', start: '10:00', end: '12:00' });
    assert.equal(past.status, 302);
    assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM reservations WHERE status = 'confirmed'`).get().n, 0);
  });
});
