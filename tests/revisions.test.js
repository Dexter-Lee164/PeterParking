'use strict';

/**
 * The eight revisions: vehicle manufacturer/model catalogue, compatible-only availability, cash-only payments,
 * readable audit details, admin sidebar notifications, priority ordering of reservations, full-name rules and
 * password reuse.
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, setNow, PASSWORD } = require('./helpers');
const users = require('../src/services/users');
const reservations = require('../src/services/reservations');
const payments = require('../src/services/payments');
const sessions = require('../src/services/sessions');
const notifications = require('../src/services/notifications');
const auditFormat = require('../src/utils/auditFormat');
const nameRules = require('../public/js/name-rules');
const catalog = require('../public/js/vehicle-catalog');
const { AppError } = require('../src/utils/errors');

const DAY = '2026-03-10';
const fieldsOf = (fn) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof AppError && err.fields) return err.fields;
    throw err;
  }
  return {};
};

describe('1. vehicle manufacturer and model', () => {
  let env;
  let d;
  before(async () => {
    env = await startApp({ fixture: 'minimal', now: `${DAY} 08:00` });
    d = env.data;
  });
  after(async () => env.stop());

  test('manufacturers depend on the vehicle type and models on the manufacturer', () => {
    assert.ok(catalog.manufacturers('car').includes('Toyota'));
    assert.ok(catalog.manufacturers('motorcycle').includes('Yamaha'));
    assert.ok(!catalog.manufacturers('car').includes('Yamaha'), 'no motorcycle brands for a car');
    assert.ok(catalog.models('car', 'Toyota').includes('Vios'));
    assert.ok(catalog.models('car', 'Toyota').includes('Hiace'), 'vans and SUVs are registered as cars');
    assert.deepEqual(catalog.manufacturers('van'), [], 'there is no van / SUV type');
    assert.deepEqual(catalog.models('car', 'Nope'), []);
    assert.equal(catalog.findModel('motorcycle', 'yamaha', ' nmax '), 'NMAX');
  });

  test('the server accepts only catalogue pairs that fit the type', () => {
    const add = (input) => fieldsOf(() => users.addVehicle(d.bob.id, Object.assign({ plate_number: 'NEW 0001', vehicle_type: 'car' }, input), null));
    assert.ok(add({ make: 'Yamaha', model: 'NMAX' }).make, 'motorcycle manufacturer on a car');
    assert.ok(add({ make: 'Toyota', model: 'Civic' }).model, 'another manufacturer\'s model');
    assert.ok(add({ model: 'Vios' }).model, 'model without a manufacturer');
    assert.ok(add({ make: 'Lada' }).make, 'unknown manufacturer');
    const v = users.addVehicle(d.bob.id, { plate_number: 'NEW 0002', vehicle_type: 'motorcycle', make: 'honda', model: 'click 160' }, null);
    assert.equal(v.make, 'Honda');
    assert.equal(v.model, 'Click 160');
    const bare = users.addVehicle(d.bob.id, { plate_number: 'NEW 0003', vehicle_type: 'car' }, null);
    assert.equal(bare.make, null, 'manufacturer and model stay optional');
  });

  test('a vehicle saved before the catalogue stays editable; a type change must pick again', () => {
    const id = env.db.prepare(`INSERT INTO vehicles (user_id, plate_number, vehicle_type, make, model) VALUES (?, 'OLD 0001', 'car', 'Lada', 'Niva')`).run(d.alice.id).lastInsertRowid;
    users.updateVehicle(d.alice.id, id, { plate_number: 'OLD 0001', vehicle_type: 'car', make: 'Lada', model: 'Niva', color: 'Green' }, null);
    assert.deepEqual(env.db.prepare('SELECT make, model, color FROM vehicles WHERE id = ?').get(id), { make: 'Lada', model: 'Niva', color: 'Green' });
    const f = fieldsOf(() => users.updateVehicle(d.alice.id, id, { plate_number: 'OLD 0001', vehicle_type: 'motorcycle', make: 'Lada', model: 'Niva' }, null));
    assert.ok(f.make, 'the old value does not carry over to another type');
    users.updateVehicle(d.alice.id, id, { plate_number: 'OLD 0001', vehicle_type: 'motorcycle', make: 'Honda', model: 'Click 160' }, null);
    assert.equal(env.db.prepare('SELECT model FROM vehicles WHERE id = ?').get(id).model, 'Click 160');
  });

  test('Other: a manufacturer and model typed in are validated, stored and listed', async () => {
    const OTHER = catalog.OTHER;
    const add = (input) => fieldsOf(() => users.addVehicle(d.bob.id, Object.assign({ plate_number: 'OTH 0001', vehicle_type: 'car' }, input), null));
    assert.ok(add({ make: OTHER, make_other: '' }).make_other, 'Other needs a name');
    assert.ok(add({ make: OTHER, make_other: '<script>' }).make_other, 'only plain names');
    assert.ok(add({ make: 'Toyota', model: OTHER, model_other: '' }).model_other, 'Other model needs a name');
    const custom = users.addVehicle(d.bob.id, { plate_number: 'OTH 0002', vehicle_type: 'car', make: OTHER, make_other: '  Proton ', model: OTHER, model_other: 'Saga  FLX' }, null);
    assert.deepEqual([custom.make, custom.model], ['Proton', 'Saga FLX']);
    const listedMake = users.addVehicle(d.bob.id, { plate_number: 'OTH 0003', vehicle_type: 'car', make: 'Toyota', model: OTHER, model_other: 'Tamaraw' }, null);
    assert.deepEqual([listedMake.make, listedMake.model], ['Toyota', 'Tamaraw']);
    const snapped = users.addVehicle(d.bob.id, { plate_number: 'OTH 0004', vehicle_type: 'motorcycle', make: OTHER, make_other: 'yamaha', model: OTHER, model_other: 'nmax' }, null);
    assert.deepEqual([snapped.make, snapped.model], ['Yamaha', 'NMAX'], 'a typed name that is listed takes the catalogue spelling');
    const noModel = users.addVehicle(d.bob.id, { plate_number: 'OTH 0005', vehicle_type: 'car', make: OTHER, make_other: 'Proton', model: '' }, null);
    assert.equal(noModel.model, null, 'the model stays optional');

    const c = env.client();
    await c.login('bob@test.local');
    const list = await c.get('/driver/vehicles');
    assert.match(list.text, /Proton Saga FLX/);
    // Editing a typed-in vehicle shows Other with its name filled in.
    const edit = await c.get(`/driver/vehicles/${custom.id}/edit`);
    assert.match(edit.text, /<option value="__other__" selected>Other<\/option>/);
    assert.match(edit.text, /name="make_other"\s+value="Proton"/);
    assert.match(edit.text, /name="model_other"\s+value="Saga FLX"/);
  });

  test('the form has Manufacturer and Model dropdowns with an Other choice, and only Car and Motorcycle', async () => {
    const c = env.client();
    await c.login('alice@test.local');
    const page = await c.get(`/driver/vehicles/${d.aliceCar.id}/edit`);
    assert.equal(page.status, 200);
    assert.match(page.text, /<label class="form-label" for="f-make">Manufacturer/);
    assert.doesNotMatch(page.text, />Make</);
    const select = (name) => new RegExp(`<select class="form-select" id="f-${name}"[^]*?</select>`).exec(page.text)[0];
    assert.match(select('make'), /<option value="Toyota" selected>Toyota<\/option>/);
    assert.match(select('make'), /<option value="__other__" >Other<\/option>/);
    assert.match(select('model'), /<option value="Vios" selected>Vios<\/option>/);
    assert.match(select('model'), /<option value="__other__" >Other<\/option>/);
    assert.deepEqual([...select('vehicle_type').matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]), ['car', 'motorcycle'], 'no Van / SUV');
    assert.match(page.text, /\/js\/vehicle-catalog\.js/);
    const bad = await c.post('/driver/vehicles', { plate_number: 'NEW 0009', vehicle_type: 'motorcycle', make: 'Toyota', model: 'Vios' });
    assert.equal(bad.status, 422);
    assert.match(bad.text, /Choose a manufacturer from the list for this vehicle type/);
  });
});

describe('2. find parking keeps every bay on the map, whatever the vehicle filter', () => {
  let env;
  let d;
  let c;
  before(async () => {
    env = await startApp({ fixture: 'minimal', now: `${DAY} 08:00` });
    d = env.data;
    c = env.client();
    await c.login('bob@test.local');
  });
  after(async () => env.stop());

  const frag = async (query) => JSON.parse((await c.get(`/driver/find-parking?date=${DAY}&start=10:00&end=12:00&fragment=1&zone_id=${d.zone.id}&${query}`, { headers: { Accept: 'application/json' } })).text);

  const stall = (html, code) => new RegExp(`<button[^>]*class="([^"]*)"[^>]*data-code="${code}"[^>]*>`).exec(html);

  test('only fitting bays can be chosen; the others stay visible with their state', async () => {
    const moto = await frag('vehicle_type=motorcycle');
    assert.equal(moto.counts.available, 1);
    assert.match(stall(moto.mapHtml, 'M1')[1], /is-available/);
    assert.match(stall(moto.mapHtml, 'T1')[1], /is-unavailable is-other-type/, 'a car bay is shown to a motorcycle, set back');
    assert.match(stall(moto.mapHtml, 'T1')[0], /disabled/);
    const car = await frag('vehicle_type=car');
    assert.equal(car.counts.available, 5);
    assert.equal(car.counts.unavailable, 1);
    assert.match(stall(car.mapHtml, 'M1')[1], /is-unavailable is-other-type/);
    assert.deepEqual(car.zones.find((z) => z.id === d.zone.id).available, 5);
  });

  test('reserved bays keep their state for the other vehicle type too', async () => {
    const reservations = require('../src/services/reservations');
    const r = reservations.createReservation({ userId: d.bob.id, vehicleId: d.bobMoto.id, slotId: d.moto.id, date: DAY, start: '10:00', end: '11:00' }, null);
    const car = await frag('vehicle_type=car');
    assert.match(stall(car.mapHtml, 'M1')[1], /is-reserved is-other-type/);
    assert.equal(car.counts.reserved, 1);
    reservations.cancelReservation(r.id, d.bob, {});
  });

  test('a selected slot that no longer fits the new vehicle type is dropped', async () => {
    const kept = await frag(`vehicle_type=car&slot_id=${d.slots[0].id}`);
    assert.equal(kept.selectedSlotId, d.slots[0].id);
    const dropped = await frag(`vehicle_type=motorcycle&slot_id=${d.slots[0].id}`);
    assert.equal(dropped.selectedSlotId, null);
  });

  test('the page refreshes by itself: no search button except for browsers without JavaScript', async () => {
    const page = await c.get(`/driver/find-parking?date=${DAY}&start=10:00&end=12:00`);
    assert.match(page.text, /id="searchStatus"/);
    assert.match(page.text, /id="retrySearch"/);
    const withoutNoscript = page.text.replace(/<noscript>[^]*?<\/noscript>/g, '');
    assert.doesNotMatch(withoutNoscript, /Search Availability/);
    assert.match(page.text, /<noscript>\s*<div class="tb-field tb-submit">/);
  });
});

describe('3. cash-only payments', () => {
  let env;
  let d;
  const admin = () => ({ id: d.admin.id, role: 'admin' });
  before(async () => {
    env = await startApp({ fixture: 'minimal', now: `${DAY} 08:00` });
    d = env.data;
  });
  after(async () => env.stop());

  test('only cash is accepted, and the database refuses anything else too', () => {
    const r = reservations.createReservation({ userId: d.alice.id, vehicleId: d.aliceCar.id, slotId: d.slots[0].id, date: DAY, start: '10:00', end: '11:00' }, { id: d.alice.id });
    const f = fieldsOf(() => payments.recordPayment({ reservation_id: r.id, amount: '10', method: 'gcash', reference: 'GC-1' }, admin()));
    assert.match(f.method, /Only cash/);
    const p = payments.recordPayment({ reservation_id: r.id, amount: '10' }, admin());
    assert.equal(p.method, 'cash', 'no method means cash');
    assert.throws(
      () => env.db.prepare(`INSERT INTO payments (receipt_no, reservation_id, user_id, amount_centavos, method, paid_at, recorded_by) VALUES ('X-1', ?, ?, 100, 'gcash', '2026-03-10 09:00:00', ?)`).run(r.id, d.alice.id, d.admin.id),
      /PAYMENT_METHOD_NOT_ALLOWED/,
    );
  });

  test('older non-cash records are kept, shown and still counted', async () => {
    const r = reservations.createReservation({ userId: d.bob.id, vehicleId: d.bobCar.id, slotId: d.slots[1].id, date: DAY, start: '10:00', end: '11:00' }, { id: d.bob.id });
    // A record from before the change (the guard is lifted only to create it, then restored by the migration).
    env.db.exec('DROP TRIGGER trg_payments_cash_only');
    env.db.prepare(`INSERT INTO payments (receipt_no, reservation_id, user_id, amount_centavos, method, reference, paid_at, recorded_by) VALUES ('RCT-OLD-1', ?, ?, 1500, 'gcash', 'GC-OLD', '2026-03-09 09:00:00', ?)`).run(r.id, d.bob.id, d.admin.id);
    require('../src/db/migrations/003_admin_notifications_cash_only').up(env.db);
    assert.equal(reservations.getReservation(r.id).paid_centavos, 1500, 'the old payment still counts toward the balance');
    const c = env.client();
    await c.login('admin@test.local');
    const list = await c.get('/admin/payments');
    assert.match(list.text, /GCash \(legacy record\)/);
    assert.match(list.text, /RCT-OLD-1/);
    assert.doesNotMatch(list.text, /<select[^>]*name="method"/, 'the list has no method filter');
    const form = await c.get(`/admin/payments/new?reservation_id=${r.id}`);
    assert.match(form.text, /name="method" value="cash"/);
    assert.doesNotMatch(form.text, /<select[^>]*name="method"/);
  });
});

describe('4. readable audit details', () => {
  test('reservation details become labelled, formatted values', () => {
    const view = auditFormat.describe({
      action: 'reservation.create', entity_type: 'reservation', entity_id: 65, subject_driver: 'Juan Dela Cruz',
      details: JSON.stringify({ ref: 'UP-1', slot: 'SC-15', start: '2026-03-10 09:00:00', end: '2026-03-10 11:00:00', fee: 6000 }),
    });
    assert.equal(view.title, 'Reservation Created');
    assert.deepEqual(view.items, [
      { label: 'Reservation ID', value: '65' },
      { label: 'Driver', value: 'Juan Dela Cruz' },
      { label: 'Booking Reference', value: 'UP-1' },
      { label: 'Slot', value: 'SC-15' },
      { label: 'Start Time', value: 'Tue, Mar 10, 2026, 9:00 AM' },
      { label: 'End Time', value: 'Tue, Mar 10, 2026, 11:00 AM' },
      { label: 'Fee', value: '₱60.00' },
    ]);
  });

  test('changes, nested objects, flags and broken JSON are all handled', () => {
    const resched = auditFormat.describe({ action: 'reservation.reschedule', details: JSON.stringify({ from: ['2026-03-10 09:00:00', '2026-03-10 10:00:00'], to: ['2026-03-11 13:00:00', '2026-03-11 15:00:00'], waived: true }) });
    assert.deepEqual(resched.items, [
      { label: 'Previous Time', value: 'Tue, Mar 10, 2026, 9:00 AM – 10:00 AM' },
      { label: 'New Time', value: 'Wed, Mar 11, 2026, 1:00 PM – 3:00 PM' },
      { label: 'Fee Waived', value: 'Yes' },
    ]);
    const nested = auditFormat.describe({ action: 'settings.update', details: JSON.stringify({ rules: { open_time: '06:00', max_days: 7 } }) });
    assert.equal(nested.title, 'Booking Rules Updated');
    assert.deepEqual(nested.items, [{ label: 'Rules', items: [{ label: 'Open Time', value: '06:00' }, { label: 'Max Days', value: '7' }] }]);
    assert.deepEqual(auditFormat.describe({ action: 'x.y', details: '{not json' }).items, [{ label: 'Details', value: '{not json' }]);
    assert.deepEqual(auditFormat.describe({ action: 'x.y', details: null }).items, []);
    assert.equal(auditFormat.describe({ action: 'mystery.thing_done' }).title, 'Mystery Thing Done');
  });
});

describe('5. sidebar notifications and highlighted records', () => {
  let env;
  let d;
  let adminC;
  const admin = () => ({ id: d.admin.id, role: 'admin' });
  before(async () => {
    env = await startApp({ fixture: 'minimal', now: `${DAY} 08:00` });
    d = env.data;
    adminC = env.client();
    await adminC.login('admin@test.local');
  });
  after(async () => env.stop());

  const badges = async () => JSON.parse((await adminC.get('/admin/notifications', { headers: { Accept: 'application/json' } })).text);

  test('start empty, then count real driver activity', async () => {
    assert.deepEqual(await badges(), { reservations: 0, payments: 0, reports: 0 });
    const r = reservations.createReservation({ userId: d.alice.id, vehicleId: d.aliceCar.id, slotId: d.slots[0].id, date: DAY, start: '10:00', end: '12:00' }, { id: d.alice.id });
    reservations.createReservation({ userId: d.bob.id, vehicleId: d.bobCar.id, slotId: d.slots[1].id, date: DAY, start: '10:00', end: '11:00' }, { id: d.bob.id });
    assert.deepEqual(await badges(), { reservations: 2, payments: 0, reports: 0 });
    // A balance owed is not announced (the Payments page lists paid bookings only); a payment recorded by another
    // staff member is, and the administrator's own payment does not notify them.
    setNow(`${DAY} 10:00`);
    sessions.checkIn(r.id, admin());
    setNow(`${DAY} 12:00`);
    sessions.checkOut(r.id, admin());
    assert.equal((await badges()).payments, 0);
    payments.recordPayment({ reservation_id: r.id, amount: '5' }, admin());
    payments.recordPayment({ reservation_id: r.id, amount: '5' }, { id: d.bob.id, role: 'admin' }); // another staff member
    assert.deepEqual(await badges(), { reservations: 2, payments: 1, reports: 0 });
  });

  test('the sidebar shows badges on Reservations, Payments and Etiquette Reports; reviewing a section highlights then clears it', async () => {
    const dash = await adminC.get('/admin');
    assert.match(dash.text, /data-badge-for="reservations"><span aria-hidden="true">2<\/span>/);
    assert.match(dash.text, /data-badge-for="payments"><span aria-hidden="true">1<\/span>/);
    assert.equal((dash.text.match(/data-badge-for=/g) || []).length, 3);
    const list = await adminC.get('/admin/reservations');
    assert.equal((list.text.match(/<tr class="is-unread">/g) || []).length, 2, 'the two new bookings are highlighted');
    assert.match(list.text, /class="unread-banner"/);
    const again = await adminC.get('/admin/reservations');
    assert.doesNotMatch(again.text, /<tr class="is-unread">|unread-banner/, 'the highlight goes once the page has been seen');
    assert.deepEqual(await badges(), { reservations: 0, payments: 1, reports: 0 }, 'acknowledged, and it does not come back');
    assert.deepEqual(await badges(), { reservations: 0, payments: 1, reports: 0 });
    await adminC.get('/admin/payments');
    assert.deepEqual(await badges(), { reservations: 0, payments: 0, reports: 0 });
    // A new cancellation shows up again.
    setNow(`${DAY} 07:00`);
    const later = reservations.createReservation({ userId: d.alice.id, vehicleId: d.aliceCar2.id, slotId: d.slots[2].id, date: DAY, start: '15:00', end: '16:00' }, { id: d.alice.id });
    reservations.cancelReservation(later.id, d.alice, { actor: { id: d.alice.id } });
    assert.equal((await badges()).reservations, 2);
  });

  test('drivers get their own badges, only about their own records, and cannot read the admin counts', async () => {
    const c = env.client();
    await c.login('alice@test.local');
    const driverBadges = async () => JSON.parse((await c.get('/driver/notifications', { headers: { Accept: 'application/json' } })).text);
    assert.deepEqual(await driverBadges(), { reservations: 0, payments: 0, reports: 0 });
    assert.match((await c.get('/driver')).text, /data-nav-badges="\/driver\/notifications"/);
    assert.notEqual((await c.get('/admin/notifications')).status, 200);
    assert.deepEqual(notifications.SECTIONS, { admin: ['reservations', 'payments', 'reports'], driver: ['reservations', 'payments', 'reports'] });
    // Staff cancel one of Alice's bookings: she is notified; her own booking and Bob's activity do not count.
    setNow(`${DAY} 07:00`);
    const mine = reservations.createReservation({ userId: d.alice.id, vehicleId: d.aliceCar.id, slotId: d.slots[3].id, date: DAY, start: '17:00', end: '18:00' }, { id: d.alice.id });
    reservations.createReservation({ userId: d.bob.id, vehicleId: d.bobCar.id, slotId: d.slots[4].id, date: DAY, start: '17:00', end: '18:00' }, { id: d.bob.id });
    assert.deepEqual(await driverBadges(), { reservations: 0, payments: 0, reports: 0 });
    reservations.cancelReservation(mine.id, { id: d.admin.id, role: 'admin' }, { reason: 'Lot closed for an event', actor: { id: d.admin.id } });
    assert.deepEqual(await driverBadges(), { reservations: 1, payments: 0, reports: 0 });
    const list = await c.get('/driver/reservations?tab=all');
    assert.equal((list.text.match(/<tr class="is-unread">/g) || []).length, 1);
    assert.deepEqual(await driverBadges(), { reservations: 0, payments: 0, reports: 0 });
  });
});

describe('6. reservation priority order', () => {
  let env;
  let d;
  let refs;
  before(async () => {
    env = await startApp({ fixture: 'minimal', now: '2026-03-08 07:00' });
    d = env.data;
    const mk = (who, car, slot, date, start, end) =>
      reservations.createReservation({ userId: who.id, vehicleId: car.id, slotId: slot.id, date, start, end }, { id: who.id }).booking_ref;
    refs = {
      past1: mk(d.alice, d.aliceCar, d.slots[0], '2026-03-08', '10:00', '11:00'),
      past2: mk(d.alice, d.aliceCar, d.slots[0], '2026-03-09', '10:00', '11:00'),
      future2: mk(d.alice, d.aliceCar, d.slots[0], '2026-03-12', '10:00', '11:00'),
      future1: mk(d.alice, d.aliceCar2, d.slots[1], '2026-03-11', '15:00', '16:00'),
      today2: mk(d.bob, d.bobCar, d.slots[2], DAY, '13:00', '14:00'),
      today1: mk(d.bob, d.bobCar, d.slots[3], DAY, '09:00', '10:00'),
    };
    setNow(`${DAY} 08:00`);
  });
  after(async () => env.stop());

  const expected = () => [refs.today1, refs.today2, refs.future1, refs.future2, refs.past2, refs.past1];

  test('today, then future (soonest first), then past (most recent first), across pages', () => {
    const all = reservations.listReservations({ sort: 'priority' }, { all: true }).rows.map((r) => r.booking_ref);
    assert.deepEqual(all, expected());
    const page1 = reservations.listReservations({ sort: 'priority' }, { page: 1, perPage: 4 }).rows.map((r) => r.booking_ref);
    const page2 = reservations.listReservations({ sort: 'priority' }, { page: 2, perPage: 4 }).rows.map((r) => r.booking_ref);
    assert.deepEqual(page1.concat(page2), expected());
    const filtered = reservations.listReservations({ sort: 'priority', paymentStatus: 'unpaid' }, { page: 1, perPage: 10 }).rows.map((r) => r.booking_ref);
    assert.deepEqual(filtered, expected(), 'the in-memory filter path keeps the same order');
  });

  test('the administrator page splits today (latest first), upcoming (soonest first) and past (latest first), and keeps search', async () => {
    const c = env.client();
    await c.login('admin@test.local');
    const page = await c.get('/admin/reservations');
    const order = [...page.text.matchAll(/font-mono fw-semibold" href="\/admin\/reservations\/\d+">([A-Z0-9-]+)</g)].map((m) => m[1]);
    assert.deepEqual(order, [refs.today2, refs.today1, refs.future1, refs.future2, refs.past2, refs.past1]);
    assert.match(page.text, /id="panel-today"[\s\S]*id="panel-upcoming"[\s\S]*id="panel-past"/);
    assert.doesNotMatch(page.text, /day-tier/);
    const search = await c.get(`/admin/reservations?q=${refs.future1}`);
    assert.match(search.text, new RegExp(refs.future1));
    assert.doesNotMatch(search.text, new RegExp(refs.today1));
  });
});

describe('7 & 8. full name rules and password reuse', () => {
  let env;
  before(async () => {
    env = await startApp({ fixture: 'minimal', now: `${DAY} 08:00` });
  });
  after(async () => env.stop());

  test('the shared name rules', () => {
    for (const ok of ['Juan Dela Cruz', 'Mary-Ann Santos', 'José María López', 'Zoë Ng', 'Nguyễn Văn An', 'Ab']) {
      assert.equal(nameRules.validate(ok).ok, true, ok);
    }
    assert.equal(nameRules.validate('  Juan   Dela  Cruz ').name, 'Juan Dela Cruz');
    const msg = (v) => nameRules.validate(v).message;
    assert.equal(msg(''), nameRules.MESSAGES.empty);
    assert.equal(msg('    '), nameRules.MESSAGES.empty);
    assert.equal(msg('Juan 2'), nameRules.MESSAGES.digits);
    assert.equal(msg('Juan٣'), nameRules.MESSAGES.digits, 'any script\'s digits');
    for (const bad of ['J@ne', 'Ann#', 'Cash$', 'Fifty%', 'Hi!', 'O.K.', 'Dela_Cruz']) assert.equal(msg(bad), nameRules.MESSAGES.chars, bad);
    for (const bad of ['-Ann', 'Ann-', 'Mary--Ann', 'Mary - Ann']) assert.equal(msg(bad), nameRules.MESSAGES.hyphen, bad);
    assert.equal(msg('A'.repeat(81)), nameRules.MESSAGES.long);
  });

  test('profile and sign-up both enforce them on the server', async () => {
    const c = env.client();
    await c.login('alice@test.local');
    const bad = await c.post('/driver/profile', { full_name: 'Alice 123', email: 'alice@test.local' });
    assert.equal(bad.status, 422);
    assert.match(bad.text, /Full name cannot contain numbers\./);
    assert.match((await c.post('/driver/profile', { full_name: 'Alice @ Home', email: 'alice@test.local' })).text, /letters, spaces and hyphens/);
    assert.equal((await c.post('/driver/profile', { full_name: '   ', email: 'alice@test.local' })).status, 422);
    assert.equal(env.db.prepare(`SELECT full_name FROM users WHERE email = 'alice@test.local'`).get().full_name, 'Alice Driver', 'unchanged');
    const ok = await c.post('/driver/profile', { full_name: ' Alice  Mae-Driver ', email: 'alice@test.local' });
    assert.equal(ok.status, 302);
    assert.equal(env.db.prepare(`SELECT full_name FROM users WHERE email = 'alice@test.local'`).get().full_name, 'Alice Mae-Driver');

    const reg = env.client();
    await reg.get('/register');
    const signup = await reg.post('/register', { full_name: 'R2D2', email: 'robot@example.com', password: 'Passw0rd1', confirm_password: 'Passw0rd1' });
    assert.equal(signup.status, 422);
    assert.match(signup.text, /Full name cannot contain numbers\./);
    assert.match((await reg.get('/register')).text, /\/js\/name-rules\.js/);
  });

  test('a new password equal to the current one is refused and nothing changes', async () => {
    const c = env.client();
    await c.login('bob@test.local');
    const before = env.db.prepare(`SELECT password_hash FROM users WHERE email = 'bob@test.local'`).get().password_hash;
    const reuse = await c.post('/driver/profile/password', { current_password: PASSWORD, new_password: PASSWORD, confirm_password: PASSWORD });
    assert.equal(reuse.status, 422);
    assert.match(reuse.text, /must be different from your current password/);
    assert.equal(env.db.prepare(`SELECT password_hash FROM users WHERE email = 'bob@test.local'`).get().password_hash, before);
    const mismatch = await c.post('/driver/profile/password', { current_password: PASSWORD, new_password: 'Fresh1pass', confirm_password: 'Fresh1passX' });
    assert.equal(mismatch.status, 422);
    assert.equal(env.db.prepare(`SELECT password_hash FROM users WHERE email = 'bob@test.local'`).get().password_hash, before);
    const ok = await c.post('/driver/profile/password', { current_password: PASSWORD, new_password: 'Fresh1pass', confirm_password: 'Fresh1pass' });
    assert.equal(ok.status, 302);
    assert.notEqual(env.db.prepare(`SELECT password_hash FROM users WHERE email = 'bob@test.local'`).get().password_hash, before);
  });
});
