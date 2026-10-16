'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, Client, T, futureWindow, slotId, userId, vehicleOf, db, clock, seedPasswords: pw } = require('./helpers');
const svc = require('../src/services/reservations');
const parking = require('../src/services/parking');
const catalog = require('../src/services/catalog');
const avail = require('../src/services/availability');
const { AppError } = require('../src/utils/errors');

const driver = (email) => ({ id: userId(email), role: 'driver', ip: 'test' });
const admin = () => ({ id: userId(pw.adminEmail), role: 'admin', ip: 'test' });
const book = (email, code, w) => svc.createReservation({ userId: userId(email), vehicleId: vehicleOf(email), slotId: slotId(code), ...w }, driver(email));
const resRow = (ref) => db.prepare('SELECT * FROM reservations WHERE reference = ?').get(ref);
const setNow = (date, hm, plusMin = 0) => clock.setOffset(new Date(T.localToIso(date, hm)).getTime() + plusMin * 60000 - Date.now());
const rejects = (fn, code) => assert.throws(fn, (e) => { assert.ok(e instanceof AppError, String(e)); if (code) assert.equal(e.code, code); return true; });

let app;
test.before(async () => { app = await start(); db.prepare("INSERT INTO settings (key, value) VALUES ('max_open_reservations', '50')").run(); });
test.after(async () => { clock.reset(); await app.close(); });

test('check-in is blocked before the early window, then succeeds and marks the slot occupied', () => {
  const w = futureWindow(4, 9, 11); const ref = book('maria@university.test', 'EN-04', w);
  setNow(w.date, '09:00', -31);
  rejects(() => parking.checkIn(ref, admin()), 'CHECKIN_NOT_ALLOWED');
  assert.equal(resRow(ref).status, 'confirmed');
  setNow(w.date, '09:00', 5);
  const r = parking.checkIn(ref, admin());
  assert.equal(r.isLate, false);
  assert.equal(resRow(ref).status, 'active');
  const slot = avail.listSlotAvailability({ startAt: T.localToIso(w.date, '09:00'), endAt: T.localToIso(w.date, '11:00') }).find((s) => s.code === 'EN-04');
  assert.equal(slot.state, 'occupied', 'physically occupied is distinct from merely reserved');
  rejects(() => parking.checkIn(ref, admin()), 'ALREADY_CHECKED_IN');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM parking_sessions WHERE reservation_id = (SELECT id FROM reservations WHERE reference = ?)").get(ref).c, 1);
  setNow(w.date, '11:00'); parking.checkOut(db.prepare("SELECT id FROM parking_sessions WHERE status = 'active' AND slot_id = ?").get(slotId('EN-04')).id, admin());
  clock.reset();
});

test('check-out records departure, finalizes the fee and cannot be repeated', () => {
  const w = futureWindow(4, 12, 14); const ref = book('maria@university.test', 'EN-05', w);
  setNow(w.date, '12:00', 0); parking.checkIn(ref, admin());
  const sid = db.prepare('SELECT id FROM parking_sessions WHERE reservation_id = (SELECT id FROM reservations WHERE reference = ?)').get(ref).id;
  setNow(w.date, '14:00', 0);
  const out = parking.checkOut(sid, admin());
  assert.equal(out.fee, 4000); assert.equal(out.isOverstay, false);
  const row = resRow(ref); assert.equal(row.status, 'completed'); assert.equal(row.final_fee_centavos, 4000); assert.ok(row.finalized_at);
  rejects(() => parking.checkOut(sid, admin()), 'INVALID_CHECKOUT');
  rejects(() => parking.checkOut(999999, admin()));
  clock.reset();
});

test('late arrivals and overstays are flagged and billed by policy', () => {
  const w = futureWindow(5, 9, 11); const ref = book('juan@university.test', 'EN-06', w);
  setNow(w.date, '09:00', 20);
  const r = parking.checkIn(ref, admin());
  assert.equal(r.isLate, true); assert.equal(r.lateMinutes, 20);
  const s = db.prepare('SELECT * FROM parking_sessions WHERE reservation_id = (SELECT id FROM reservations WHERE reference = ?)').get(ref);
  assert.equal(s.is_late, 1);
  setNow(w.date, '11:00', 25);
  const active = parking.activeSessions().find((x) => x.reference === ref);
  assert.equal(active.overstaying, true); assert.equal(active.projectedFee, 6000);
  const out = parking.checkOut(s.id, admin());
  assert.equal(out.isOverstay, true); assert.equal(out.overstayHours, 1); assert.equal(out.fee, 6000);
  assert.equal(db.prepare('SELECT is_overstay, overstay_minutes FROM parking_sessions WHERE id = ?').get(s.id).overstay_minutes, 25);
  clock.reset();
});

test('lookup finds open bookings by reference or plate and explains why check-in is not yet possible', () => {
  const w = futureWindow(6, 15, 17); const ref = book('juan@university.test', 'EN-07', w);
  setNow(w.date, '09:00', 0);
  const byRef = parking.lookup(ref.toLowerCase()); assert.equal(byRef.length, 1);
  assert.equal(byRef[0].eligibility.ok, false); assert.match(byRef[0].eligibility.reason, /Too early/);
  const byPlate = parking.lookup('abc 5678'); assert.ok(byPlate.some((r) => r.reference === ref));
  assert.deepEqual(parking.lookup('NOPE0000'), []);
  clock.reset();
});

test('no-shows can only be recorded after the delay and release the slot', () => {
  const w = futureWindow(6, 9, 11); const ref = book('juan@university.test', 'EN-08', w);
  const ref2 = book('maria@university.test', 'EN-09', futureWindow(6, 9, 10));
  setNow(w.date, '09:00', 29); rejects(() => svc.markNoShow(ref, admin()), 'TOO_EARLY');
  setNow(w.date, '09:00', 31); svc.markNoShow(ref, admin());
  const row = resRow(ref); assert.equal(row.status, 'no_show'); assert.equal(row.final_fee_centavos, 0);
  assert.equal(avail.conflictsFor({ slotId: slotId('EN-08'), startAt: row.start_at, endAt: row.end_at }).length, 0);
  rejects(() => svc.markNoShow(ref, admin()), 'BAD_STATE');
  setNow(w.date, '09:00', 40);
  assert.ok(svc.markAllOverdueNoShows(admin()) >= 1);
  assert.equal(resRow(ref2).status, 'no_show');
  clock.reset();
});

test('slots cannot be taken out of service while a vehicle is parked or bookings are upcoming', () => {
  const w = futureWindow(7, 9, 11); const ref = book('maria@university.test', 'SC-09', w);
  rejects(() => catalog.updateSlot(slotId('SC-09'), { slotType: 'standard', status: 'maintenance' }, admin()), 'HAS_RESERVATIONS');
  rejects(() => catalog.updateZone(db.prepare("SELECT id FROM parking_zones WHERE name = 'Science'").get().id, { name: 'Science', mapColumns: 5, isActive: '' }, admin()), 'HAS_RESERVATIONS');
  setNow(w.date, '09:00', 2); parking.checkIn(ref, admin());
  rejects(() => catalog.updateSlot(slotId('SC-09'), { slotType: 'standard', status: 'maintenance' }, admin()), 'ACTIVE_SESSION');
  const sid = db.prepare('SELECT id FROM parking_sessions WHERE status = \'active\' AND slot_id = ?').get(slotId('SC-09')).id;
  parking.checkOut(sid, admin());
  assert.doesNotThrow(() => catalog.updateSlot(slotId('SC-09'), { slotType: 'standard', status: 'maintenance' }, admin()));
  clock.reset();
});

test('administrators run check-in and check-out through the web screen', async () => {
  const w = futureWindow(8, 9, 11); const ref = book('maria@university.test', 'SC-10', w);
  const c = new Client(app.base); await c.login(pw.adminEmail, pw.admin);
  setNow(w.date, '09:00', 3);
  const look = await c.get(`/admin/operations?q=${ref}`);
  assert.equal(look.status, 200); assert.match(look.text, /Check in/); assert.match(look.text, /NBC1234/);
  const inn = await c.post('/admin/operations/check-in', { reference: ref });
  assert.equal(inn.location, '/admin/operations');
  const board = await c.get('/admin/operations'); assert.match(board.text, /SC-10/); assert.match(board.text, /Check out/);
  const dup = await c.post('/admin/operations/check-in', { reference: ref });
  const afterDup = await c.get(dup.location); assert.match(afterDup.text, /already checked in/i);
  setNow(w.date, '11:00', 0);
  const sid = db.prepare("SELECT id FROM parking_sessions WHERE status = 'active' AND slot_id = ?").get(slotId('SC-10')).id;
  const out = await c.post('/admin/operations/check-out', { sessionId: sid });
  assert.equal(out.status, 302);
  assert.equal(resRow(ref).status, 'completed');
  const bad = await c.post('/admin/operations/check-out', { sessionId: sid });
  assert.match((await c.get(bad.location)).text, /already been checked out/);
  clock.reset();
});
