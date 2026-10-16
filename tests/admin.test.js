'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, Client, T, futureWindow, slotId, userId, vehicleOf, db, seedPasswords: pw } = require('./helpers');
const catalog = require('../src/services/catalog');
const settingsSvc = require('../src/services/settings');
const users = require('../src/services/users');
const svc = require('../src/services/reservations');
const { AppError, ValidationError } = require('../src/utils/errors');

const admin = () => ({ id: userId(pw.adminEmail), role: 'admin', ip: 'test' });
const driver = (e) => ({ id: userId(e), role: 'driver', ip: 'test' });
const fields = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof ValidationError, String(e)); return e.fields; } assert.fail('expected a ValidationError'); };
const conflicts = (fn, code) => assert.throws(fn, (e) => { assert.ok(e instanceof AppError, String(e)); assert.equal(e.code, code); return true; });

let app;
test.before(async () => { app = await start(); });
test.after(async () => { await app.close(); });

test('zone CRUD: unique names, edits, and deletion only for empty zones', () => {
  const id = catalog.createZone({ name: 'Library', description: 'Behind the library', mapColumns: '4' }, admin());
  assert.ok(fields(() => catalog.createZone({ name: 'library' }, admin())).name, 'names are unique, case-insensitively');
  assert.ok(fields(() => catalog.createZone({ name: 'X' }, admin())).name);
  catalog.updateZone(id, { name: 'Library North', description: '', mapColumns: '5', isActive: '1' }, admin());
  assert.equal(catalog.getZone(id).name, 'Library North');
  catalog.createSlot({ zoneId: id, code: 'LB-01', slotType: 'standard' }, admin());
  conflicts(() => catalog.deleteZone(id, admin()), 'CONFLICT');
  catalog.deleteSlot(slotId('LB-01'), admin());
  catalog.deleteZone(id, admin());
  assert.equal(catalog.getZone(id), undefined);
});

test('slot CRUD: unique code per zone, bulk creation, status changes and history protection', () => {
  const zoneId = db.prepare("SELECT id FROM parking_zones WHERE name = 'Administration'").get().id;
  assert.ok(fields(() => catalog.createSlot({ zoneId, code: 'AD-01', slotType: 'standard' }, admin())).code);
  assert.ok(fields(() => catalog.createSlot({ zoneId, code: 'bad code!', slotType: 'standard' }, admin())).code);
  assert.ok(fields(() => catalog.createSlot({ zoneId, code: 'AD-90', slotType: 'hover' }, admin())).slotType);
  assert.equal(catalog.bulkCreateSlots({ zoneId, prefix: 'AD-', startNumber: '20', count: '3', slotType: 'compact' }, admin()), 3);
  assert.ok(db.prepare("SELECT 1 FROM parking_slots WHERE code = 'AD-22'").get());
  assert.ok(fields(() => catalog.bulkCreateSlots({ zoneId, prefix: 'AD-', startNumber: '20', count: '2', slotType: 'compact' }, admin())).startNumber, 'bulk creation never overwrites existing slots');
  catalog.updateSlot(slotId('AD-20'), { slotType: 'compact', status: 'maintenance' }, admin());
  assert.equal(catalog.getSlot(slotId('AD-20')).status, 'maintenance');
  catalog.deleteSlot(slotId('AD-21'), admin());
  svc.createReservation({ userId: userId('maria@university.test'), vehicleId: vehicleOf('maria@university.test'), slotId: slotId('AD-05'), ...futureWindow(9, 9, 10) }, driver('maria@university.test'));
  conflicts(() => catalog.deleteSlot(slotId('AD-05'), admin()), 'CONFLICT');
});

test('hourly rates apply to new bookings only', () => {
  const w = futureWindow(10, 9, 11);
  const first = svc.createReservation({ userId: userId('maria@university.test'), vehicleId: vehicleOf('maria@university.test'), slotId: slotId('SC-01'), ...w }, driver('maria@university.test'));
  assert.ok(fields(() => catalog.updateRates({ standard: 'abc', compact: '15', accessible: '20', motorcycle: '10' }, admin())).standard);
  catalog.updateRates({ standard: '25.50', compact: '15', accessible: '20', motorcycle: '10' }, admin());
  const second = svc.createReservation({ userId: userId('juan@university.test'), vehicleId: vehicleOf('juan@university.test'), slotId: slotId('SC-02'), ...w }, driver('juan@university.test'));
  const get = (r) => db.prepare('SELECT hourly_rate_centavos r, estimated_fee_centavos f FROM reservations WHERE reference = ?').get(r);
  assert.deepEqual({ ...get(first) }, { r: 2000, f: 4000 }); assert.deepEqual({ ...get(second) }, { r: 2550, f: 5100 });
  assert.equal(db.prepare("SELECT hourly_rate_centavos c FROM parking_rates WHERE slot_type = 'standard'").get().c, 2550);
  catalog.updateRates({ standard: '20', compact: '15', accessible: '20', motorcycle: '10' }, admin());
});

test('booking rules are validated and take effect', () => {
  const base = settingsSvc.getAll();
  const form = { ...base };
  assert.ok(fields(() => settingsSvc.update({ ...form, operating_end: '05:00' }, admin())).operating_end);
  assert.ok(fields(() => settingsSvc.update({ ...form, booking_increment_minutes: '45' }, admin())).booking_increment_minutes);
  assert.ok(fields(() => settingsSvc.update({ ...form, min_duration_minutes: '600' }, admin())).min_duration_minutes);
  assert.ok(fields(() => settingsSvc.update({ ...form, advance_booking_days: 'x' }, admin())).advance_booking_days);
  const w = futureWindow(11, 9, 11);
  assert.equal(require('../src/services/availability').validateRange({ ...w, start: '09:30', end: '11:30' }).ok, false, 'half hours are rejected with a 60-minute increment');
  settingsSvc.update({ ...form, booking_increment_minutes: '30', min_duration_minutes: '30' }, admin());
  assert.equal(require('../src/services/availability').validateRange({ ...w, start: '09:30', end: '11:30' }).ok, true);
  assert.equal(require('../src/services/availability').validateRange({ ...w, start: '09:30', end: '10:00' }).hours, 1, 'a half hour still bills one started hour');
  settingsSvc.update(form, admin());
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'settings.update'").get());
});

test('account management: create, deactivate, reset password; admins cannot lock themselves out', async () => {
  const u = users.createUser({ name: 'Walk In', email: 'walkin@university.test', driverType: 'personnel', password: 'Parking123' }, { allowRole: true, actor: admin() });
  assert.equal(u.role, 'driver');
  assert.ok(fields(() => users.createUser({ name: 'Walk In', email: 'walkin@university.test', driverType: 'personnel', password: 'Parking123' }, { actor: admin() })).email);
  conflicts(() => users.setActive(admin().id, false, admin()), 'CONFLICT');
  users.setActive(u.id, false, admin());
  const c = new Client(app.base);
  assert.equal((await c.post('/login', { email: 'walkin@university.test', password: 'Parking123' })).status, 401);
  users.setActive(u.id, true, admin());
  users.resetPassword(u.id, 'NewPass456', admin());
  assert.equal((await c.post('/login', { email: 'walkin@university.test', password: 'Parking123' })).status, 401);
  assert.equal((await c.post('/login', { email: 'walkin@university.test', password: 'NewPass456' })).status, 302);
  assert.ok(fields(() => users.resetPassword(u.id, 'short', admin())).password);
  const a = new Client(app.base); await a.login(pw.adminEmail, pw.admin);
  const search = await a.get('/admin/drivers?q=maria'); assert.match(search.text, /Maria Santos/); assert.doesNotMatch(search.text, /Juan Dela Cruz/);
  const byPlate = await a.get('/admin/drivers?q=NBC1234'); assert.match(byPlate.text, /Maria Santos/);
});

test('drivers manage their own vehicles; plates are unique and history is preserved', async () => {
  const d = new Client(app.base); await d.login('ana@university.test', pw.driver);
  const dup = await d.post('/driver/vehicles', { plateNumber: 'nbc 1234', vehicleType: 'car' });
  assert.equal(dup.status, 422); assert.match(dup.text, /already registered/);
  const bad = await d.post('/driver/vehicles', { plateNumber: '!', vehicleType: 'boat' });
  assert.equal(bad.status, 422);
  const ok = await d.post('/driver/vehicles', { plateNumber: 'zz 9999', vehicleType: 'car', makeModel: 'Mirage', color: 'Blue' });
  assert.equal(ok.status, 302);
  const v = db.prepare("SELECT * FROM vehicles WHERE plate_number = 'ZZ9999'").get();
  assert.equal(v.user_id, userId('ana@university.test'));
  const maria = new Client(app.base); await maria.login('maria@university.test', pw.driver);
  assert.equal((await maria.get(`/driver/vehicles/${v.id}/edit`)).status, 404, "a driver cannot open another driver's vehicle");
  await maria.post(`/driver/vehicles/${v.id}/delete`);
  assert.ok(db.prepare('SELECT 1 FROM vehicles WHERE id = ?').get(v.id), "and cannot remove it");
  await d.post(`/driver/vehicles/${v.id}/delete`);
  assert.equal(db.prepare('SELECT 1 FROM vehicles WHERE id = ?').get(v.id), undefined);
  const used = vehicleOf('ana@university.test');
  await d.post(`/driver/vehicles/${used}/delete`);
  assert.equal(db.prepare('SELECT is_active FROM vehicles WHERE id = ?').get(used).is_active, 1, 'a vehicle with open reservations cannot be removed');
  db.prepare("UPDATE reservations SET status = 'cancelled', final_fee_centavos = 0 WHERE vehicle_id = ? AND status IN ('confirmed','active')").run(used);
  await d.post(`/driver/vehicles/${used}/delete`);
  assert.equal(db.prepare('SELECT is_active FROM vehicles WHERE id = ?').get(used).is_active, 0, 'vehicles with bookings are retired, not deleted');
  assert.ok(db.prepare('SELECT 1 FROM reservations WHERE vehicle_id = ?').get(used), 'their booking history is untouched');
});

test('consequential actions are written to the audit log', () => {
  const actions = new Set(db.prepare('SELECT DISTINCT action FROM audit_logs').all().map((r) => r.action));
  for (const a of ['zone.create', 'slot.create', 'slot.bulk_create', 'rates.update', 'settings.update', 'user.create', 'user.deactivate', 'user.password_reset', 'reservation.create']) assert.ok(actions.has(a), `audit has ${a}`);
});

test('navigation is role-aware, accessible and mobile-ready', async () => {
  const a = new Client(app.base); await a.login(pw.adminEmail, pw.admin);
  const ap = (await a.get('/admin/dashboard')).text;
  for (const item of ['Dashboard', 'Parking Slots', 'Reservations', 'Check-in / Check-out', 'Payments', 'Drivers', 'Reports', 'Settings']) assert.ok(ap.includes(`<span>${item}</span>`), `admin nav has ${item}`);
  const d = new Client(app.base); await d.login('maria@university.test', pw.driver);
  const dp = (await d.get('/driver/dashboard')).text;
  for (const item of ['Dashboard', 'Find Parking', 'My Reservations', 'Payments', 'My Vehicles', 'Profile']) assert.ok(dp.includes(`<span>${item}</span>`), `driver nav has ${item}`);
  assert.ok(!dp.includes('<span>Reports</span>') && !dp.includes('<span>Drivers</span>'));
  for (const html of [ap, dp]) {
    assert.match(html, /name="viewport" content="width=device-width, initial-scale=1"/);
    assert.match(html, /class="app-sidebar offcanvas-lg offcanvas-start"/, 'sidebar collapses to an off-canvas menu below the lg breakpoint');
    assert.match(html, /aria-controls="sidebar"/); assert.match(html, /aria-current="page"/); assert.match(html, /class="skip-link"/);
    assert.match(html, /data-bs-theme="dark"/);
  }
  assert.match(ap, /placeholder="Booking reference, driver or plate"/, 'admin header search');
});
