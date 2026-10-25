'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, setNow, PASSWORD } = require('./helpers');
const reservations = require('../src/services/reservations');
const sessions = require('../src/services/sessions');
const payments = require('../src/services/payments');
const parking = require('../src/services/parking');
const users = require('../src/services/users');
const dashboard = require('../src/services/dashboard');
const settingsService = require('../src/services/settings');
const { AppError } = require('../src/utils/errors');

const DAY = '2026-03-10';

const fails = (fn, code, pattern) =>
  assert.throws(fn, (err) => {
    assert.ok(err instanceof AppError, `expected AppError, got ${err && err.stack}`);
    if (code) assert.equal(err.code, code, err.message);
    if (pattern) assert.match(err.message, pattern);
    return true;
  });

describe('zones, slots, slot types and rates', () => {
  let env;
  let d;
  const admin = () => ({ id: d.admin.id });
  before(async () => {
    env = await startApp({ fixture: 'minimal', now: `${DAY} 09:00` });
    d = env.data;
  });
  after(async () => env.stop());

  test('zones: validation, unique code/name, edit, delete guards', () => {
    fails(() => parking.createZone({ code: 'tz', name: 'Another', map_columns: 4 }, admin()), 'VALIDATION');
    fails(() => parking.createZone({ code: 'NEW', name: 'test zone', map_columns: 4 }, admin()), 'VALIDATION');
    fails(() => parking.createZone({ code: '', name: '', map_columns: 99 }, admin()), 'VALIDATION');
    const z = parking.createZone({ code: 'NZ', name: 'North Zone', description: 'Spare lot', map_columns: 4, sort_order: 5 }, admin());
    assert.equal(z.code, 'NZ');
    assert.equal(parking.updateZone(z.id, { code: 'NZ', name: 'North Lot', map_columns: 5, sort_order: 5 }, admin()).name, 'North Lot');
    parking.createSlot({ zone_id: z.id, slot_code: 'N1', slot_type: 'regular' }, admin());
    fails(() => parking.deleteZone(z.id, admin()), 'ZONE_HAS_SLOTS');
    parking.deleteSlot(env.db.prepare(`SELECT id FROM parking_slots WHERE slot_code = 'N1'`).get().id, admin());
    parking.deleteZone(z.id, admin());
    assert.equal(parking.getZone(z.id), undefined);
  });

  test('a zone with upcoming reservations cannot be deactivated; inactive zones vanish from Find Parking', async () => {
    const r = reservations.createReservation(
      { userId: d.alice.id, vehicleId: d.aliceCar.id, slotId: d.slots[0].id, date: DAY, start: '10:00', end: '12:00' },
      { id: d.alice.id },
    );
    fails(() => parking.updateZone(d.zone.id, { code: 'TZ', name: 'Test Zone', map_columns: 3, is_active: '0' }, admin()), 'ZONE_BUSY');
    reservations.cancelReservation(r.id, d.admin, { reason: 'Test cleanup', actor: admin() });
    const spare = parking.createZone({ code: 'SP', name: 'Spare', map_columns: 3 }, admin());
    parking.createSlot({ zone_id: spare.id, slot_code: 'S1', slot_type: 'regular' }, admin());
    const alice = env.client();
    await alice.login('alice@test.local');
    const visible = await alice.get('/driver/find-parking?date=2026-03-10&start=14:00&end=15:00');
    assert.match(visible.text, /Spare/);
    parking.updateZone(spare.id, { code: 'SP', name: 'Spare', map_columns: 3, is_active: '0' }, admin());
    const hidden = await alice.get('/driver/find-parking?date=2026-03-10&start=14:00&end=15:00');
    assert.doesNotMatch(hidden.text, /Spare/);
  });

  test('slots: duplicate codes per zone, bulk creation is all-or-nothing', () => {
    fails(() => parking.createSlot({ zone_id: d.zone.id, slot_code: 't1', slot_type: 'regular' }, admin()), 'VALIDATION');
    fails(() => parking.createSlot({ zone_id: d.zone.id, slot_code: 'X9', slot_type: 'nope' }, admin()), 'VALIDATION');
    fails(() => parking.createSlot({ zone_id: 99999, slot_code: 'X9', slot_type: 'regular' }, admin()), 'VALIDATION');
    const made = parking.createSlotsBulk({ zone_id: d.zone.id, slot_type: 'accessible', prefix: 'AC-', from: '1', to: '4' }, admin());
    assert.deepEqual(made.map((s) => s.slot_code), ['AC-01', 'AC-02', 'AC-03', 'AC-04']);
    assert.equal(made[0].hourly_rate_centavos, 2000, 'accessible rate from the rate table');
    const before = env.db.prepare('SELECT COUNT(*) AS n FROM parking_slots').get().n;
    fails(() => parking.createSlotsBulk({ zone_id: d.zone.id, slot_type: 'accessible', prefix: 'AC-', from: '3', to: '7' }, admin()));
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM parking_slots').get().n, before, 'a failed bulk run creates nothing');
    fails(() => parking.createSlotsBulk({ zone_id: d.zone.id, slot_type: 'ev', prefix: 'Z-', from: '1', to: '2' }, admin()), 'VALIDATION');
    fails(() => parking.createSlotsBulk({ zone_id: d.zone.id, slot_type: 'accessible', prefix: 'Z-', from: '1', to: '500' }, admin()), 'VALIDATION');
  });

  test('rate precedence: slot override > zone+type > zone > type > default', () => {
    const z = parking.createZone({ code: 'RZ', name: 'Rate Zone', map_columns: 3 }, admin());
    const slot = parking.createSlot({ zone_id: z.id, slot_code: 'R1', slot_type: 'regular' }, admin());
    assert.equal(parking.getSlot(slot.id).hourly_rate_centavos, 3000, 'type rate for regular');
    parking.createRate({ name: 'Rate Zone any', zone_id: z.id, slot_type: '', hourly_rate: '40', is_active: '1' }, admin());
    assert.equal(parking.getSlot(slot.id).hourly_rate_centavos, 4000, 'zone-wide beats type-only');
    parking.createRate({ name: 'Rate Zone regular', zone_id: z.id, slot_type: 'regular', hourly_rate: '55', is_active: '1' }, admin());
    assert.equal(parking.getSlot(slot.id).hourly_rate_centavos, 5500, 'zone + type is most specific');
    parking.updateSlot(slot.id, { zone_id: z.id, slot_code: 'R1', slot_type: 'regular', status: 'active', hourly_rate_override: '70' }, admin());
    assert.equal(parking.getSlot(slot.id).hourly_rate_centavos, 7000, 'override wins');
    fails(() => parking.createRate({ name: 'x', hourly_rate: 'free' }, admin()), 'VALIDATION');
    fails(() => parking.createRate({ name: '', hourly_rate: '10' }, admin()), 'VALIDATION');
  });

  test('slot types: create, in-use guard on delete', () => {
    parking.createSlotType({ code: 'compact', label: 'Compact', vehicle_type: 'car', icon: 'bi-car-front', sort_order: 9 }, admin());
    fails(() => parking.createSlotType({ code: 'compact', label: 'Dup', vehicle_type: 'car' }, admin()), 'VALIDATION');
    fails(() => parking.createSlotType({ code: 'Bad Code!', label: 'Dup', vehicle_type: 'car' }, admin()), 'VALIDATION');
    parking.createSlot({ zone_id: d.zone.id, slot_code: 'C1', slot_type: 'compact' }, admin());
    fails(() => parking.deleteSlotType('compact', admin()), 'TYPE_IN_USE');
    parking.updateSlotType('compact', { label: 'Compact bay', vehicle_type: 'car', icon: 'bi-car-front', is_active: '0' }, admin());
    assert.equal(parking.listSlotTypes().find((t) => t.code === 'compact').is_active, 0);
  });

  test('admin pages: the layout is fixed, but slot operations (status, rate, notes) still work', async () => {
    const c = env.client();
    await c.login('admin@test.local');
    const before = env.db.prepare('SELECT COUNT(*) AS n FROM parking_slots').get().n;
    const page = await c.get(`/admin/slots?zone=${d.zone.id}`);
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.text, /New zone|Add several|New slot|Delete zone|Edit zone|\/delete"/);
    assert.match(page.text, /data-admin-slot-map/, 'the zone map is shown read-only');
    // No route creates, deletes or restructures zones and slots any more.
    for (const url of ['/admin/slots/new', '/admin/slots/bulk', '/admin/slots/zones/new', `/admin/slots/zones/${d.zone.id}/edit`]) {
      assert.equal((await c.get(url)).status, 404, url);
    }
    for (const url of ['/admin/slots', '/admin/slots/bulk', '/admin/slots/zones', `/admin/slots/zones/${d.zone.id}`, `/admin/slots/zones/${d.zone.id}/delete`, `/admin/slots/${d.slots[4].id}/delete`]) {
      assert.equal((await c.post(url, { zone_id: d.zone.id, slot_code: 'H1', slot_type: 'regular', code: 'NZ', name: 'New' })).status, 404, url);
    }
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM parking_slots').get().n, before);
    // Editing a slot changes how it operates, never where it is or what it is.
    const slot = d.slots[3];
    const bad = await c.post(`/admin/slots/${slot.id}`, { status: 'active', hourly_rate_override: 'abc' });
    assert.equal(bad.status, 422);
    assert.match(bad.text, /is-invalid|invalid-feedback/);
    const ok = await c.post(`/admin/slots/${slot.id}`, { status: 'active', hourly_rate_override: '33', notes: 'Near the gate', zone_id: 999, slot_code: 'MOVED', slot_type: 'motorcycle' });
    assert.equal(ok.status, 302);
    assert.deepEqual(
      env.db.prepare('SELECT zone_id, slot_code, slot_type, hourly_rate_override_centavos AS r, notes FROM parking_slots WHERE id = ?').get(slot.id),
      { zone_id: d.zone.id, slot_code: slot.slot_code, slot_type: 'regular', r: 3300, notes: 'Near the gate' },
    );
    const maint = await c.post(`/admin/slots/${d.slots[4].id}/status`, { status: 'maintenance' });
    assert.equal(maint.status, 302);
    assert.equal(env.db.prepare('SELECT status FROM parking_slots WHERE id = ?').get(d.slots[4].id).status, 'maintenance');
  });
});

describe('users and driver self-service', () => {
  let env;
  let d;
  const admin = () => ({ id: d.admin.id });
  before(async () => {
    env = await startApp({ fixture: 'minimal', now: `${DAY} 09:00` });
    d = env.data;
  });
  after(async () => env.stop());

  test('the last active administrator cannot be demoted or deactivated, and nobody can lock themselves out', () => {
    fails(() => users.setUserActive(d.admin.id, false, admin()), 'LAST_ADMIN');
    fails(() => users.adminUpdateUser(d.admin.id, { full_name: 'Ada Admin', email: 'admin@test.local', role: 'driver' }, admin()), 'LAST_ADMIN');
    const second = users.adminCreateUser({ full_name: 'Second Admin', email: 'admin2@test.local', password: PASSWORD, role: 'admin' }, admin());
    fails(() => users.setUserActive(d.admin.id, false, admin()), 'SELF_LOCKOUT');
    assert.doesNotThrow(() => users.setUserActive(second.id, false, admin()));
  });

  test('admin-created users: validation, duplicate email, password reset', async () => {
    fails(() => users.adminCreateUser({ full_name: 'X', email: 'not-an-email', password: PASSWORD, role: 'driver' }, admin()), 'VALIDATION');
    fails(() => users.adminCreateUser({ full_name: 'Dup Mail', email: 'ALICE@test.local', password: PASSWORD, role: 'driver' }, admin()), 'VALIDATION');
    fails(() => users.adminCreateUser({ full_name: 'Weak Pass', email: 'weak@test.local', password: 'abc', role: 'driver' }, admin()), 'VALIDATION');
    fails(() => users.adminCreateUser({ full_name: 'Bad Role', email: 'role@test.local', password: PASSWORD, role: 'superuser' }, admin()), 'VALIDATION');
    const c = env.client();
    await c.login('admin@test.local');
    // The email address cannot be changed from the driver page: a different one posted with the form is ignored.
    const page = await c.get(`/admin/drivers/${d.bob.id}`);
    assert.match(page.text, /name="email"[^>]*readonly/);
    const res = await c.post(`/admin/drivers/${d.bob.id}`, { full_name: 'Bob Driver', email: 'robert@test.local', role: 'driver', is_active: '1', new_password: 'NewPassw0rd1' });
    assert.equal(users.getUser(d.bob.id).email, 'bob@test.local');
    assert.equal(res.status, 302);
    const bob = env.client();
    await bob.get('/login');
    assert.equal((await bob.post('/login', { email: 'bob@test.local', password: PASSWORD })).status, 401, 'old password no longer works');
    assert.equal((await bob.post('/login', { email: 'bob@test.local', password: 'NewPassw0rd1' })).status, 302);
  });

  test('a driver with a vehicle currently parked cannot be deactivated', () => {
    const r = reservations.createReservation(
      { userId: d.alice.id, vehicleId: d.aliceCar.id, slotId: d.slots[0].id, date: DAY, start: '10:00', end: '12:00' },
      { id: d.alice.id },
    );
    setNow(`${DAY} 10:00`);
    sessions.checkIn(r.id, { id: d.admin.id });
    fails(() => users.setUserActive(d.alice.id, false, admin()), 'USER_PARKED');
    sessions.checkOut(r.id, { id: d.admin.id });
    assert.doesNotThrow(() => users.setUserActive(d.alice.id, false, admin()));
    users.setUserActive(d.alice.id, true, admin());
    setNow(`${DAY} 09:00`);
  });

  test('driver vehicles: add, duplicate plate, edit, and archive instead of delete when history exists', async () => {
    const c = env.client();
    await c.login('bob@test.local', 'NewPassw0rd1');
    const dup = await c.post('/driver/vehicles', { plate_number: 'aaa 1111', vehicle_type: 'car' });
    assert.equal(dup.status, 422);
    assert.match(dup.text, /already registered/);
    const bad = await c.post('/driver/vehicles', { plate_number: '!', vehicle_type: 'boat' });
    assert.equal(bad.status, 422);
    assert.equal((await c.post('/driver/vehicles', { plate_number: 'cde 5678', vehicle_type: 'van', make: 'Toyota', model: 'Hiace' })).status, 422, 'Van / SUV is no longer a vehicle type');
    const ok = await c.post('/driver/vehicles', { plate_number: 'cde 5678', vehicle_type: 'car', make: 'Toyota', model: 'Hiace', color: 'White' });
    assert.equal(ok.status, 302);
    const v = env.db.prepare(`SELECT * FROM vehicles WHERE plate_number = 'CDE 5678'`).get();
    assert.ok(v, 'plate is normalised to upper case');
    const edit = await c.post(`/driver/vehicles/${v.id}`, { plate_number: 'CDE 5678', vehicle_type: 'car', make: 'toyota', model: 'hiace commuter', color: 'Grey' });
    assert.equal(edit.status, 302);
    assert.deepEqual(env.db.prepare('SELECT make, model FROM vehicles WHERE id = ?').get(v.id), { make: 'Toyota', model: 'Hiace Commuter' }, 'snapped to the catalogue spelling');

    // A vehicle with an active booking cannot be removed; one with history is archived.
    const r = reservations.createReservation({ userId: d.bob.id, vehicleId: v.id, slotId: d.slots[0].id, date: DAY, start: '10:00', end: '11:00' }, { id: d.bob.id });
    const blocked = await c.post(`/driver/vehicles/${v.id}/delete`);
    assert.equal(blocked.status, 302);
    assert.equal(env.db.prepare('SELECT is_active FROM vehicles WHERE id = ?').get(v.id).is_active, 1);
    reservations.cancelReservation(r.id, d.bob, { actor: { id: d.bob.id } });
    await c.post(`/driver/vehicles/${v.id}/delete`);
    assert.equal(env.db.prepare('SELECT is_active FROM vehicles WHERE id = ?').get(v.id).is_active, 0, 'archived, history kept');
    const fresh = await c.post('/driver/vehicles', { plate_number: 'ZZZ 0001', vehicle_type: 'car' });
    assert.equal(fresh.status, 302);
    const idZ = env.db.prepare(`SELECT id FROM vehicles WHERE plate_number = 'ZZZ 0001'`).get().id;
    await c.post(`/driver/vehicles/${idZ}/delete`);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM vehicles WHERE id = ?').get(idZ).n, 0, 'no history → deleted');
    // Another driver cannot edit this driver's vehicle.
    const alice = env.client();
    await alice.login('alice@test.local');
    const hack = await alice.post(`/driver/vehicles/${d.bobCar.id}`, { plate_number: 'HAK 0001', vehicle_type: 'car' });
    assert.equal(hack.status, 404);
    assert.equal(env.db.prepare('SELECT plate_number FROM vehicles WHERE id = ?').get(d.bobCar.id).plate_number, 'BBB 3333', 'the other driver\'s vehicle is untouched');
    assert.equal((await alice.post(`/driver/vehicles/${d.bobCar.id}/delete`)).status, 404);
    assert.equal(env.db.prepare('SELECT is_active FROM vehicles WHERE id = ?').get(d.bobCar.id).is_active, 1);
  });

  test('profile and password changes', async () => {
    const c = env.client();
    await c.login('alice@test.local');
    const prof = await c.post('/driver/profile', { full_name: '  Alice  Quinn-Driver ', email: 'alice@test.local', university_id: 'U-001', phone: '0917 123 4567' });
    assert.equal(prof.status, 302);
    assert.equal(env.db.prepare(`SELECT full_name FROM users WHERE email = 'alice@test.local'`).get().full_name, 'Alice Quinn-Driver');
    const clash = await c.post('/driver/profile', { full_name: 'Alice', email: 'bob@test.local' });
    assert.equal(clash.status, 422);
    const wrong = await c.post('/driver/profile/password', { current_password: 'incorrect1', new_password: 'Another1pass', confirm_password: 'Another1pass' });
    assert.equal(wrong.status, 422);
    const weak = await c.post('/driver/profile/password', { current_password: PASSWORD, new_password: 'short', confirm_password: 'short' });
    assert.equal(weak.status, 422);
    const ok = await c.post('/driver/profile/password', { current_password: PASSWORD, new_password: 'Another1pass', confirm_password: 'Another1pass' });
    assert.equal(ok.status, 302);
    const again = env.client();
    await again.get('/login');
    assert.equal((await again.post('/login', { email: 'alice@test.local', password: 'Another1pass' })).status, 302);
  });
});

describe('dashboard and settings (deterministic data)', () => {
  let env;
  let d;
  let adminC;
  let refs;
  const admin = () => ({ id: d.admin.id, role: 'admin' });
  before(async () => {
    env = await startApp({ fixture: 'minimal', now: `${DAY} 09:00` });
    d = env.data;
    const mk = (who, slot, vehicle, start, end) =>
      reservations.createReservation({ userId: who.id, vehicleId: vehicle.id, slotId: slot.id, date: DAY, start, end }, { id: who.id });
    const A = mk(d.alice, d.slots[0], d.aliceCar, '10:00', '12:00'); // completed with overstay
    const B = mk(d.bob, d.slots[1], d.bobCar, '10:00', '12:00'); // cancelled inside the window
    const C = mk(d.alice, d.slots[2], d.aliceCar2, '14:00', '16:00'); // no-show
    const D = mk(d.bob, d.slots[3], d.bobCar, '17:00', '18:00'); // still upcoming
    reservations.cancelReservation(B.id, d.bob, { actor: { id: d.bob.id } });
    setNow(`${DAY} 10:00`);
    sessions.checkIn(A.id, admin());
    setNow(`${DAY} 12:30`);
    sessions.checkOut(A.id, admin());
    payments.recordPayment({ reservation_id: A.id, amount: '105', method: 'cash', reference: 'OR-1' }, admin());
    setNow(`${DAY} 14:30`);
    reservations.markNoShow(C.id, admin());
    refs = { A, B, C, D };
    adminC = env.client();
    await adminC.login('admin@test.local');
  });
  after(async () => env.stop());

  test('the old analytics Reports page and its CSV export are gone; Reports now means parking etiquette reports', async () => {
    assert.equal((await adminC.get(`/admin/reports/export.csv?type=daily&date=${DAY}`)).status, 404);
    const page = await adminC.get('/admin/reports');
    assert.equal(page.status, 200);
    assert.match(page.text, /Parking Etiquette Reports/);
    assert.doesNotMatch(page.text, /Reports &amp; CSV|chartReportDaily/);
  });

  test('admin dashboard KPIs and chart series come from the database', () => {
    const data = dashboard.adminDashboard();
    assert.equal(data.kpis.todaysReservations, 3, 'today excluding the cancelled booking');
    assert.equal(data.kpis.maintenance, 0);
    assert.equal(data.kpis.totalSlots, 6);
    assert.equal(data.kpis.occupied, 0);
    assert.equal(data.charts.outcomes.values.join(','), '1,1,1,1');
    assert.equal(data.charts.outcomes.cancellationRate, 25);
    assert.equal(data.charts.collections.totalCentavos, 10500);
    assert.equal(data.charts.reservationsOverTime.values.at(-1), 3);
    assert.equal(data.charts.reservationsOverTime.values.reduce((a, b) => a + b, 0), 3);
    assert.equal(data.recentActivity.length > 0, true);
  });

  test('settings form: valid change takes effect and is audit-logged; invalid values are rejected', async () => {
    const values = settingsService.getAll();
    const bad = await adminC.post('/admin/settings/rules', Object.assign({}, values, { max_duration_minutes: '30', min_duration_minutes: '120', overstay_multiplier_percent: '5' }));
    assert.equal(bad.status, 422);
    assert.match(bad.text, /Maximum must be at least the minimum/);
    assert.equal(settingsService.getAll().min_duration_minutes, 60, 'rejected submission saved nothing');

    const ok = await adminC.post('/admin/settings/rules', Object.assign({}, values, { cancel_free_hours: '4', no_show_fee_percent: '100', max_active_reservations: '9' }));
    assert.equal(ok.status, 302);
    const now = settingsService.getAll();
    assert.equal(now.cancel_free_hours, 4);
    assert.equal(now.no_show_fee_percent, 100);
    assert.equal(now.max_active_reservations, 9);
    assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'settings.update'`).get().n, 1);
    const page = await adminC.get('/admin/settings/rules');
    assert.match(page.text, /value="4"/);
  });

  test('audit log lists consequential actions and supports filtering', async () => {
    const page = await adminC.get('/admin/settings/audit');
    assert.equal(page.status, 200);
    for (const action of ['reservation.create', 'session.check_in', 'session.check_out', 'payment.record', 'reservation.no_show']) {
      assert.match(page.text, new RegExp(action.replace('.', '\\.')), action);
    }
    const filtered = await adminC.get('/admin/settings/audit?action=payment.');
    assert.match(filtered.text, /payment\.record/);
    assert.doesNotMatch(filtered.text, /sub font-mono">session\.check_in/, 'filtered table has no check-in rows');
    assert.match(page.text, /sub font-mono">session\.check_in/);
    // Details are a labelled list, not a JSON string.
    assert.match(page.text, /Reservation Created/);
    assert.match(page.text, /<dt>Booking Reference<\/dt>/);
    assert.match(page.text, /<dt>Driver<\/dt>/);
    assert.match(page.text, /<dt>Start Time<\/dt>\s*<dd>Tue, Mar 10, 2026, 10:00 AM<\/dd>/);
    assert.doesNotMatch(page.text, /\{&#34;ref&#34;|\{"ref"/, 'no raw JSON');
  });

  test('every admin list page paginates and filters without error', async () => {
    for (const url of [
      '/admin/reservations?status=no_show', '/admin/reservations?payment=partial', `/admin/reservations?from=${DAY}&to=${DAY}`,
      '/admin/reservations?page=999', '/admin/payments?q=GC-1', '/admin/payments?page=-3', '/admin/drivers?q=bob', '/admin/slots?status=maintenance',
    ]) {
      const res = await adminC.get(url);
      assert.equal(res.status, 200, url);
    }
    const found = await adminC.get(`/admin/reservations?q=${refs.A.booking_ref}`);
    assert.match(found.text, new RegExp(refs.A.booking_ref));
    assert.doesNotMatch(found.text, new RegExp(refs.D.booking_ref));
  });
});
