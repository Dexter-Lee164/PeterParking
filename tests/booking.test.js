'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { start, Client, T, futureWindow, slotId, userId, vehicleOf, db, clock, seedPasswords: pw } = H;
const svc = require('../src/services/reservations');
const avail = require('../src/services/availability');
const users = require('../src/services/users');
const { AppError, ValidationError } = require('../src/utils/errors');

const actorOf = (email, role = 'driver') => ({ id: userId(email), role, ip: 'test' });
const book = (email, code, w, vehicleId) => svc.createReservation({ userId: userId(email), vehicleId: vehicleId || vehicleOf(email), slotId: slotId(code), ...w }, actorOf(email));
const rejects = (fn, code) => assert.throws(fn, (e) => { assert.ok(e instanceof AppError, String(e)); if (code) assert.equal(e.code, code); return true; });
const openCount = (code, w) => db.prepare("SELECT COUNT(*) c FROM reservations WHERE slot_id = ? AND status IN ('confirmed','active') AND start_at < ? AND end_at > ?")
  .get(slotId(code), T.localToIso(w.date, w.end), T.localToIso(w.date, w.start)).c;
const makeDriver = (n) => {
  const email = `driver${n}@university.test`;
  users.createUser({ name: `Test Driver ${n}`, email, driverType: 'student', password: 'Parking123' });
  users.addVehicle(userId(email), { plateNumber: `TST${1000 + n}`, vehicleType: 'car' }, { id: userId(email) });
  return email;
};

const setLimit = (n) => db.prepare("INSERT INTO settings (key, value) VALUES ('max_open_reservations', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(n));
let app;
test.before(async () => {
  app = await start();
  setLimit(50); // tests book many slots for the same seeded drivers; the limit itself is tested separately
});
test.after(async () => { clock.reset(); await app.close(); });

test('booking rules validate date, hours, increments and duration', () => {
  const w = futureWindow(3);
  assert.equal(avail.validateRange(w).ok, true);
  const bad = (patch, field) => { const r = avail.validateRange({ ...w, ...patch }); assert.equal(r.ok, false); assert.ok(r.errors[field], `${field}: ${JSON.stringify(r.errors)}`); };
  bad({ end: '09:00' }, 'end');                         // zero length
  bad({ start: '10:00', end: '09:00' }, 'end');         // reversed
  bad({ start: '05:00', end: '07:00' }, 'start');       // before opening
  bad({ start: '20:00', end: '23:00' }, 'end');         // after closing
  bad({ start: '09:15', end: '11:00' }, 'start');       // off the hourly grid
  bad({ start: '08:00', end: '17:00' }, 'end');         // 9 h exceeds the 8 h maximum
  bad({ date: T.addDays(T.todayLocal(), -1) }, 'start');// in the past
  bad({ date: T.addDays(T.todayLocal(), 40) }, 'date'); // beyond the booking horizon
  bad({ date: '2026-02-30' }, 'date');                  // impossible date
  bad({ start: '9am' }, 'start');                       // malformed time
});

test('slot states come from live reservation data: available, reserved, unavailable', () => {
  const w = futureWindow(3, 9, 11);
  const state = (code, win = w) => avail.listSlotAvailability({ startAt: T.localToIso(win.date, win.start), endAt: T.localToIso(win.date, win.end) }).find((s) => s.code === code).state;
  assert.equal(state('MB-02'), 'available');
  book('maria@university.test', 'MB-02', w);
  assert.equal(state('MB-02'), 'reserved');
  assert.equal(state('MB-02', { ...w, start: '11:00', end: '12:00' }), 'available', 'the slot is free again when the booking ends');
  assert.equal(state('MB-08'), 'unavailable', 'maintenance slots are shown as unavailable');
});

test('motorcycle filter only lists motorcycle slots and car filter hides them', () => {
  const w = futureWindow(3);
  const q = (vehicleType) => avail.listSlotAvailability({ startAt: T.localToIso(w.date, w.start), endAt: T.localToIso(w.date, w.end), vehicleType });
  assert.ok(q('motorcycle').length > 0 && q('motorcycle').every((s) => s.slot_type === 'motorcycle'));
  assert.ok(q('car').every((s) => s.slot_type !== 'motorcycle'));
});

test('successful reservation through the web flow shows the booking reference and details', async () => {
  const w = futureWindow(4, 9, 12);
  const c = new Client(app.base); await c.login('maria@university.test', pw.driver);
  const confirm = await c.get(`/driver/reserve?slot=${slotId('MB-03')}&date=${w.date}&start=${w.start}&end=${w.end}`);
  assert.equal(confirm.status, 200); assert.match(confirm.text, /Review your booking/); assert.match(confirm.text, /₱60\.00/);
  const r = await c.post('/driver/reservations', { slotId: slotId('MB-03'), vehicleId: vehicleOf('maria@university.test'), ...w });
  assert.equal(r.status, 302); assert.match(r.location, /^\/driver\/reservations\/UP-\d{8}-[A-Z0-9]{5}\?new=1$/);
  const page = await c.get(r.location);
  assert.match(page.text, /Your reservation is confirmed/);
  for (const bit of ['MB-03', 'Main Building', 'Upcoming', '₱60.00', '9:00 AM', '12:00 PM']) assert.ok(page.text.includes(bit), `detail page shows ${bit}`);
  const row = db.prepare('SELECT * FROM reservations WHERE reference = ?').get(r.location.split('/').pop().split('?')[0]);
  assert.equal(row.status, 'confirmed'); assert.equal(row.estimated_fee_centavos, 6000); assert.equal(row.hourly_rate_centavos, 2000);
});

test('overlapping reservations are rejected (partial, containing and contained); the loser sees no success message', async () => {
  const w = futureWindow(5, 10, 12);
  book('maria@university.test', 'MB-04', w);
  for (const o of [{ start: '09:00', end: '11:00' }, { start: '11:00', end: '13:00' }, { start: '10:00', end: '12:00' }, { start: '08:00', end: '14:00' }, { start: '10:00', end: '11:00' }]) {
    rejects(() => book('juan@university.test', 'MB-04', { ...w, ...o }), 'RESERVATION_CONFLICT');
  }
  assert.equal(openCount('MB-04', w), 1);
  const c = new Client(app.base); await c.login('juan@university.test', pw.driver);
  const r = await c.post('/driver/reservations', { slotId: slotId('MB-04'), vehicleId: vehicleOf('juan@university.test'), ...w });
  assert.equal(r.status, 302); assert.match(r.location, /^\/driver\/find-parking/);
  const follow = await c.get(r.location);
  assert.match(follow.text, /already reserved|just booked/); assert.doesNotMatch(follow.text, /reservation is confirmed/i);
});

test('adjacent reservations are allowed when one ends exactly when the next begins', () => {
  const day = 6; const a = futureWindow(day, 9, 11), b = futureWindow(day, 11, 13), c = futureWindow(day, 7, 9);
  book('maria@university.test', 'MB-06', a);
  assert.doesNotThrow(() => book('juan@university.test', 'MB-06', b));
  assert.doesNotThrow(() => book('juan@university.test', 'MB-06', c));
  const b2 = T.dayBoundsUtc(a.date);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM reservations WHERE slot_id = ? AND status = 'confirmed' AND start_at >= ? AND start_at < ?").get(slotId('MB-06'), b2.start, b2.end).c, 3, 'three back-to-back bookings share the slot');
});

test('cancelled reservations release the slot but stay in the history', () => {
  const w = futureWindow(7, 13, 15);
  const ref = book('maria@university.test', 'EN-01', w);
  rejects(() => book('juan@university.test', 'EN-01', w), 'RESERVATION_CONFLICT');
  svc.cancelReservation(ref, 'Plans changed', actorOf('maria@university.test'));
  const row = db.prepare('SELECT status, final_fee_centavos, cancel_reason FROM reservations WHERE reference = ?').get(ref);
  assert.deepEqual({ ...row }, { status: 'cancelled', final_fee_centavos: 0, cancel_reason: 'Plans changed' });
  assert.doesNotThrow(() => book('juan@university.test', 'EN-01', w));
  rejects(() => svc.cancelReservation(ref, '', actorOf('maria@university.test')), 'BAD_STATE');
});

test('maintenance and inactive slots cannot be newly reserved', () => {
  const w = futureWindow(7, 9, 10);
  rejects(() => book('maria@university.test', 'MB-08', w), 'SLOT_NOT_BOOKABLE');
  db.prepare("UPDATE parking_slots SET status = 'inactive' WHERE code = 'EN-12'").run();
  rejects(() => book('maria@university.test', 'EN-12', w), 'SLOT_NOT_BOOKABLE');
  db.prepare("UPDATE parking_slots SET status = 'active' WHERE code = 'EN-12'").run();
});

test('vehicle type must fit the slot type, and a vehicle cannot be double-booked', () => {
  const w = futureWindow(8, 9, 11);
  assert.throws(() => book('ana@university.test', 'SC-01', w), (e) => e instanceof ValidationError);
  assert.throws(() => book('maria@university.test', 'AD-10', w), (e) => e instanceof ValidationError);
  assert.doesNotThrow(() => book('ana@university.test', 'AD-11', w));
  book('maria@university.test', 'SC-02', w);
  rejects(() => book('maria@university.test', 'SC-03', { ...w, start: '10:00', end: '12:00' }), 'VEHICLE_CONFLICT');
});

test('only the owner (or an administrator) can see or change a reservation', async () => {
  const w = futureWindow(8, 14, 16);
  const ref = book('maria@university.test', 'SC-04', w);
  const juan = new Client(app.base); await juan.login('juan@university.test', pw.driver);
  assert.equal((await juan.get(`/driver/reservations/${ref}`)).status, 404);
  const cancel = await juan.post(`/driver/reservations/${ref}/cancel`, { reason: 'x' });
  assert.equal(cancel.status, 302);
  assert.equal(db.prepare('SELECT status FROM reservations WHERE reference = ?').get(ref).status, 'confirmed');
  rejects(() => svc.rescheduleReservation(ref, { ...w, start: '15:00', end: '17:00' }, actorOf('juan@university.test')));
  const admin = new Client(app.base); await admin.login(pw.adminEmail, pw.admin);
  assert.equal((await admin.get(`/admin/reservations/${ref}`)).status, 200);
});

test('rescheduling keeps the slot, recomputes the fee and is conflict-checked', () => {
  const w = futureWindow(9, 9, 11);
  const ref = book('maria@university.test', 'SC-05', w);
  book('juan@university.test', 'SC-05', { ...w, start: '13:00', end: '15:00' });
  rejects(() => svc.rescheduleReservation(ref, { ...w, start: '12:00', end: '14:00' }, actorOf('maria@university.test')), 'RESERVATION_CONFLICT');
  svc.rescheduleReservation(ref, { ...w, start: '11:00', end: '13:00' }, actorOf('maria@university.test'));   // adjacent to the other booking
  svc.rescheduleReservation(ref, { ...w, start: '16:00', end: '19:00' }, actorOf('maria@university.test'));
  const row = db.prepare('SELECT * FROM reservations WHERE reference = ?').get(ref);
  assert.equal(T.localParts(row.start_at).time, '16:00'); assert.equal(row.estimated_fee_centavos, 6000); assert.equal(row.rescheduled_count, 2);
});

test('drivers can change bookings only before the cutoff; administrators need a reason', () => {
  const w = futureWindow(10, 9, 11);
  const ref = book('maria@university.test', 'SC-06', w);
  const start = T.localToIso(w.date, w.start);
  clock.setOffset(new Date(start).getTime() - 30 * 60000 - Date.now());       // 30 minutes before start (cutoff is 60)
  rejects(() => svc.cancelReservation(ref, '', actorOf('maria@university.test')), 'PAST_CUTOFF');
  rejects(() => svc.rescheduleReservation(ref, { ...w, start: '13:00', end: '15:00' }, actorOf('maria@university.test')));
  assert.throws(() => svc.cancelReservation(ref, '  ', actorOf(pw.adminEmail, 'admin')), (e) => e instanceof ValidationError);
  assert.doesNotThrow(() => svc.cancelReservation(ref, 'Driver called the office', actorOf(pw.adminEmail, 'admin')));
  clock.reset();
});

test('concurrent booking attempts for the same slot create exactly one reservation', async () => {
  const w = futureWindow(11, 9, 11);
  const emails = [1, 2, 3, 4, 5, 6].map(makeDriver);
  const clients = await Promise.all(emails.map(async (e) => { const c = new Client(app.base); await c.login(e, 'Parking123'); return [e, c]; }));
  const results = await Promise.all(clients.map(([e, c]) => c.post('/driver/reservations', { slotId: slotId('SC-07'), vehicleId: vehicleOf(e), ...w })));
  const wins = results.filter((r) => /^\/driver\/reservations\/UP-/.test(r.location));
  assert.equal(wins.length, 1, `exactly one booking wins: ${results.map((r) => r.location).join(' | ')}`);
  assert.equal(openCount('SC-07', w), 1);
});

test('the database itself refuses overlapping active bookings, even from raw SQL', () => {
  const w = futureWindow(12, 9, 11);
  book('maria@university.test', 'SC-08', w);
  const ins = (s, e) => db.prepare(`INSERT INTO reservations (reference, user_id, vehicle_id, slot_id, start_at, end_at, status, hourly_rate_centavos, estimated_fee_centavos)
    VALUES (?,?,?,?,?,?, 'confirmed', 2000, 4000)`).run(`RAW-${Math.random()}`, userId('juan@university.test'), vehicleOf('juan@university.test'), slotId('SC-08'), T.localToIso(w.date, s), T.localToIso(w.date, e));
  assert.throws(() => ins('10:00', '12:00'), /RESERVATION_CONFLICT/);
  assert.doesNotThrow(() => ins('11:00', '12:00'));
});

test('open reservations per driver are limited by the booking rules', () => {
  const email = makeDriver(50);
  setLimit(2);
  book(email, 'AD-01', futureWindow(3, 8, 9)); book(email, 'AD-01', futureWindow(4, 8, 9));
  rejects(() => book(email, 'AD-01', futureWindow(5, 8, 9)), 'LIMIT_REACHED');
  setLimit(50);
});

test('Find Parking page renders the filters, map, list fallback and summary panel from live data', async () => {
  const w = futureWindow(3, 9, 11);
  const c = new Client(app.base); await c.login('maria@university.test', pw.driver);
  const p = await c.get(`/driver/find-parking?date=${w.date}&start=${w.start}&end=${w.end}`);
  assert.equal(p.status, 200);
  for (const id of ['id="flt-date"', 'id="flt-start"', 'id="flt-end"', 'id="flt-zone"', 'id="flt-vehicleType"', 'Search availability', 'id="duration-out"', 'id="slot-results"',
    'class="zone-tabs"', 'data-view-btn="map"', 'data-view-btn="list"', 'id="sum-fee"', 'id="continue-btn"', 'id="sel-card"', 'class="slot slot-available"', 'class="slot slot-reserved"', 'class="slot slot-unavailable"', 'js-select-slot']) {
    assert.ok(p.text.includes(id), `page contains ${id}`);
  }
  assert.match(p.text, /aria-label="Slot MB-01, Main Building, Accessible, available/);
  const bad = await c.get(`/driver/find-parking/results?date=${w.date}&start=11:00&end=09:00`);
  assert.equal(bad.status, 422); assert.match(bad.text, /End time must be after the start time/);
  const api = await c.get(`/api/availability?date=${w.date}&start=${w.start}&end=${w.end}`);
  const json = JSON.parse(api.text);
  const free = json.zones.flatMap((z) => z.slots).filter((s) => s.state === 'available').length;
  assert.equal(free, (p.text.match(/class="slot slot-available"/g) || []).length, 'JSON and HTML agree on availability');
});

test('reservations are listed by status and cancelled bookings are kept', async () => {
  const c = new Client(app.base); await c.login('maria@university.test', pw.driver);
  for (const tab of ['upcoming', 'active', 'completed', 'cancelled', 'no-show']) assert.equal((await c.get(`/driver/reservations?tab=${tab}`)).status, 200);
  const cancelled = await c.get('/driver/reservations?tab=cancelled');
  assert.match(cancelled.text, /Cancelled/); assert.match(cancelled.text, /UP-/);
});
