'use strict';

/**
 * Parking etiquette reports and plate penalties: drivers report a plate, administrators review it and penalise the plate
 * (permanent additional fee, temporary or permanent ban), and the penalties are enforced when booking. Also covers the
 * notifications for both sides and migration 008 (vans become cars; notification read state moves to one table).
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, setNow } = require('./helpers');
const { openDatabase, migrate } = require('../src/db');
const etiquette = require('../src/services/etiquette');
const reservations = require('../src/services/reservations');
const users = require('../src/services/users');
const fees = require('../src/services/fees');
const settingsService = require('../src/services/settings');
const { AppError } = require('../src/utils/errors');

const DAY = '2026-03-10';
// The smallest valid PNG (1×1, transparent).
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const fieldsOf = (fn) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof AppError && err.fields) return err.fields;
    throw err;
  }
  return {};
};
const failsWith = (fn, code) => assert.throws(fn, (err) => err instanceof AppError && err.code === code);

describe('drivers report a plate; administrators review it', () => {
  let env;
  let d;
  let alice;
  let adminC;
  before(async () => {
    env = await startApp({ fixture: 'minimal', now: `${DAY} 08:00` });
    d = env.data;
    alice = env.client();
    await alice.login('alice@test.local');
    adminC = env.client();
    await adminC.login('admin@test.local');
  });
  after(async () => env.stop());

  const report = (input) => Object.assign({ plate_number: 'bbb 3333', violation_type: 'improper_parking', description: 'Parked across T1 and T2 all morning.', incident_date: DAY, incident_time: '07:30' }, input);

  test('the form is validated on the server', () => {
    const f = (input) => fieldsOf(() => etiquette.submitReport(d.alice.id, report(input), null));
    assert.ok(f({ plate_number: '!' }).plate_number);
    assert.match(f({ plate_number: 'AAA 1111' }).plate_number, /your own/);
    assert.match(f({ plate_number: 'ZZZ 9999' }).plate_number, /not registered in the system/, 'only registered plates can be reported');
    assert.ok(f({ violation_type: 'littering' }).violation_type);
    assert.ok(f({ description: 'bad' }).description, 'too short');
    assert.ok(f({ incident_time: '09:30' }).incident_time, 'in the future');
    assert.ok(f({ incident_date: '2026-01-01' }).incident_date, 'too long ago');
    assert.ok(f({ evidence_data: 'data:text/html;base64,PGgxPg==' }).evidence, 'not an image');
    assert.ok(f({ evidence_data: 'data:image/png;base64,PGgxPg==' }).evidence, 'says PNG but is not');
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM etiquette_reports').get().n, 0, 'nothing saved');
  });

  test('a report with an image is stored, listed with its status, and visible only to its reporter and administrators', async () => {
    const page = await alice.get('/driver/reports');
    assert.equal(page.status, 200);
    assert.match(page.text, /Report a violation/);
    const res = await alice.post('/driver/reports', report({ evidence_data: PNG }));
    assert.equal(res.status, 302);
    const row = env.db.prepare('SELECT * FROM etiquette_reports').get();
    assert.deepEqual([row.plate_number, row.plate_key, row.status, row.incident_at], ['BBB 3333', 'BBB3333', 'under_review', `${DAY} 07:30:00`]);
    assert.equal(env.db.prepare('SELECT mime FROM etiquette_evidence WHERE report_id = ?').get(row.id).mime, 'image/png');
    assert.ok(env.db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'etiquette.submit' AND entity_id = ?`).get(row.id));

    const list = await alice.get('/driver/reports');
    assert.match(list.text, /BBB 3333/);
    assert.match(list.text, /Under review/);
    const img = await alice.get(`/driver/reports/${row.id}/evidence`);
    assert.equal(img.status, 200);
    assert.match(img.type, /image\/png/);
    assert.equal((await adminC.get(`/admin/reports/${row.id}/evidence`)).status, 200);

    const bob = env.client();
    await bob.login('bob@test.local');
    assert.equal((await bob.get(`/driver/reports/${row.id}`)).status, 404, 'another driver cannot open it');
    assert.equal((await bob.get(`/driver/reports/${row.id}/evidence`)).status, 404);
    assert.doesNotMatch((await bob.get('/driver/reports')).text, /BBB 3333<\/span><\/td>/, 'nor see it listed');
  });

  test('administrators are notified, see the report highlighted, and review it; the reporter is notified of the decision', async () => {
    const id = env.db.prepare('SELECT id FROM etiquette_reports').get().id;
    const badges = JSON.parse((await adminC.get('/admin/notifications', { headers: { Accept: 'application/json' } })).text);
    assert.equal(badges.reports, 1);
    const list = await adminC.get('/admin/reports');
    assert.match(list.text, /<tr class="is-unread">[\s\S]*?#<%?\d*|<tr class="is-unread">/);
    assert.match(list.text, /new-pill">New/);
    assert.doesNotMatch((await adminC.get('/admin/reports')).text, /<tr class="is-unread">/, 'seen once, no longer highlighted');

    const dismissNoNote = await adminC.post(`/admin/reports/${id}/review`, { status: 'dismissed', severity: '', admin_notes: '' });
    assert.equal(dismissNoNote.status, 422, 'dismissing needs a reason');
    const ok = await adminC.post(`/admin/reports/${id}/review`, { status: 'under_review', severity: 'major', admin_notes: 'Checking the CCTV.' });
    assert.equal(ok.status, 302);
    const r = etiquette.getReport(id);
    assert.deepEqual([r.status, r.severity, r.admin_notes, r.reviewed_by], ['under_review', 'major', 'Checking the CCTV.', d.admin.id]);

    const driverBadges = JSON.parse((await alice.get('/driver/notifications', { headers: { Accept: 'application/json' } })).text);
    assert.equal(driverBadges.reports, 1);
    const mine = await alice.get('/driver/reports');
    assert.match(mine.text, /is-unread/);
    assert.match(mine.text, /Under review/);
    const detail = await alice.get(`/driver/reports/${id}`);
    assert.match(detail.text, /Checking the CCTV\./);
  });

  test('the list has three statuses and no severity column; a report is dismissed from its page with a reason', async () => {
    const id = env.db.prepare('SELECT id FROM etiquette_reports').get().id;
    const list = await adminC.get('/admin/reports');
    const statusSelect = list.text.match(/<select[^>]*name="status"[\s\S]*?<\/select>/)[0];
    assert.deepEqual([...statusSelect.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1].trim()), ['Any status', 'Under review', 'Resolved', 'Dismissed']);
    assert.doesNotMatch(list.text, /Severity|Pending/);

    const page = await adminC.get(`/admin/reports/${id}`);
    assert.match(page.text, new RegExp(`action="/admin/reports/${id}/dismiss"[^>]*data-confirm-reason="Why is it dismissed\\?"`));
    const noReason = await adminC.post(`/admin/reports/${id}/dismiss`, { reason: '' });
    assert.equal(noReason.status, 302);
    assert.equal(etiquette.getReport(id).status, 'under_review', 'a reason is required');
    await adminC.post(`/admin/reports/${id}/dismiss`, { reason: 'The CCTV shows the car parked correctly.' });
    const r = etiquette.getReport(id);
    assert.deepEqual([r.status, r.admin_notes, r.reviewed_by], ['dismissed', 'The CCTV shows the car parked correctly.', d.admin.id]);
    const after = await adminC.get(`/admin/reports/${id}`);
    assert.doesNotMatch(after.text, /\/dismiss"/, 'no dismiss button once dismissed');
    assert.match(after.text, /This report was dismissed, so it cannot lead to a penalty\./);
    assert.ok(fieldsOf(() => etiquette.applyPenalty({ plate: 'BBB 3333', reportId: id, kind: 'perm_ban', reason: 'Trying anyway.' }, { id: d.admin.id })).kind);
    assert.match((await alice.get(`/driver/reports/${id}`)).text, /The CCTV shows the car parked correctly\./);
  });
});

describe('penalties on a plate are stored, enforced and audited', () => {
  let env;
  let d;
  let adminC;
  let reportId;
  const admin = () => ({ id: d.admin.id, role: 'admin' });
  before(async () => {
    env = await startApp({ fixture: 'minimal', now: `${DAY} 08:00` });
    d = env.data;
    adminC = env.client();
    await adminC.login('admin@test.local');
    reportId = etiquette.submitReport(d.alice.id, { plate_number: 'BBB 3333', violation_type: 'blocking', description: 'Blocked the exit lane for an hour.', incident_date: DAY, incident_time: '07:00' }, null).id;
  });
  after(async () => env.stop());

  const book = (slot, start, end, vehicle = d.bobCar) =>
    reservations.createReservation({ userId: d.bob.id, vehicleId: vehicle.id, slotId: slot.id, date: DAY, start, end }, { id: d.bob.id });

  test('penalty input is validated', () => {
    const f = (input) => fieldsOf(() => etiquette.applyPenalty(Object.assign({ plate: 'BBB 3333', reason: 'Blocked the exit lane.' }, input), admin()));
    assert.ok(f({ kind: 'fine' }).kind);
    assert.ok(f({ kind: 'surcharge', amount: '0' }).amount);
    assert.ok(f({ kind: 'surcharge', amount: '99999' }).amount);
    assert.ok(f({ kind: 'temp_ban', days: '0' }).days);
    assert.ok(f({ kind: 'perm_ban', reason: 'no' }).reason);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM plate_penalties').get().n, 0);
  });

  test('an additional fee is added to every new reservation for that plate, and to fees charged on it', async () => {
    const res = await adminC.post(`/admin/reports/${reportId}/penalties`, { kind: 'surcharge', amount: '50', reason: 'Blocked the exit lane.' });
    assert.equal(res.status, 302);
    assert.equal(etiquette.getReport(reportId).status, 'resolved', 'the penalty resolves its report');
    // One penalty per report: a second one is refused, and the report can no longer be dismissed.
    const again = await adminC.post(`/admin/reports/${reportId}/penalties`, { kind: 'temp_ban', days: '3', reason: 'Second penalty on one report.' });
    assert.equal(again.status, 422);
    assert.match(again.text, /Only one penalty is allowed per report/);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM plate_penalties WHERE report_id = ?').get(reportId).n, 1);
    assert.throws(() => etiquette.dismissReport(reportId, 'Changed my mind.', admin()), /cannot be dismissed/);
    const page = await adminC.get(`/admin/reports/${reportId}`);
    assert.doesNotMatch(page.text, /data-penalty-form|\/dismiss"/);
    assert.equal(etiquette.activeSurcharge('bbb3333'), 5000);
    const r = book(d.slots[0], '10:00', '12:00');
    assert.equal(r.surcharge_centavos, 5000);
    assert.equal(r.fee_estimated_centavos, 6000 + 5000, '2 h at ₱30 plus ₱50');
    const other = book(d.moto, '10:00', '11:00', d.bobMoto);
    assert.equal(other.surcharge_centavos, 0, 'another plate is not affected');
    // A late cancellation is charged on the reserved fee, plus the additional fee in full.
    setNow(`${DAY} 09:30`);
    const cancelled = reservations.cancelReservation(r.id, d.bob, { actor: { id: d.bob.id } });
    const settings = settingsService.getAll();
    assert.equal(cancelled.fee_final_centavos, fees.cancellationFee(6000, r.start_at, `${DAY} 09:30:00`, settings) + 5000);
    setNow(`${DAY} 08:00`);
    const confirm = await (async () => {
      const bob = env.client();
      await bob.login('bob@test.local');
      return bob.get(`/driver/reserve?slot_id=${d.slots[1].id}&date=${DAY}&start=13:00&end=14:00&vehicle_type=car&vehicle_id=${d.bobCar.id}`);
    })();
    assert.match(confirm.text, /additional fee of ₱50\.00 on every reservation/);
  });

  test('a temporary ban stops new reservations and reschedules until it ends; the driver is told why', async () => {
    const upcoming = book(d.slots[2], '15:00', '16:00');
    const res = await adminC.post('/admin/reports/plate/BBB3333/penalties', { kind: 'temp_ban', days: '3', reason: 'Second blocking incident.' });
    assert.equal(res.status, 302);
    failsWith(() => book(d.slots[3], '10:00', '11:00'), 'VEHICLE_BANNED');
    failsWith(() => reservations.rescheduleReservation(upcoming.id, d.bob, { date: DAY, start: '16:00', end: '17:00' }, null), 'VEHICLE_BANNED');
    assert.equal(reservations.getReservation(upcoming.id).status, 'confirmed', 'existing bookings are kept');
    assert.ok(book(d.moto, '13:00', '14:00', d.bobMoto), 'other plates of the same driver still book');

    const bob = env.client();
    await bob.login('bob@test.local');
    const post = await bob.post('/driver/reserve', { slot_id: d.slots[3].id, date: DAY, start: '10:00', end: '11:00', vehicle_type: 'car', vehicle_id: d.bobCar.id });
    assert.equal(post.status, 422);
    assert.match(post.text, /banned from parking reservations until/);
    const find = await bob.get(`/driver/find-parking?date=${DAY}&start=10:00&end=11:00&vehicle_id=${d.bobCar.id}`);
    assert.match(find.text, /id="banNotice" role="alert">/, 'the ban notice is shown, not hidden');
    const badges = JSON.parse((await bob.get('/driver/notifications', { headers: { Accept: 'application/json' } })).text);
    assert.equal(badges.reports, 1, 'the ban on his plate (his badge counts from his first visit, after the fee)');
    const reportsPage = await bob.get('/driver/reports');
    assert.match(reportsPage.text, /Penalties on your vehicles/);
    assert.match(reportsPage.text, /Temporary ban/);
    assert.equal((reportsPage.text.match(/summary-row is-unread/g) || []).length, 1, 'the new ban is highlighted');

    setNow('2026-03-13 08:30');
    assert.equal(etiquette.activeBan('BBB 3333'), null, 'over after three days');
    assert.ok(reservations.createReservation({ userId: d.bob.id, vehicleId: d.bobCar.id, slotId: d.slots[3].id, date: '2026-03-13', start: '10:00', end: '11:00' }, null));
    setNow(`${DAY} 08:00`);
  });

  test('a permanent ban follows the plate, even if the vehicle is removed and registered again', () => {
    const p = etiquette.applyPenalty({ plate: 'BBB 4444', kind: 'perm_ban', reason: 'Reckless driving, repeated.' }, admin());
    failsWith(() => book(d.moto, '16:00', '17:00', d.bobMoto), 'VEHICLE_BANNED');
    assert.ok(fieldsOf(() => etiquette.applyPenalty({ plate: 'BBB 4444', kind: 'temp_ban', days: '2', reason: 'Another one.' }, admin())).kind, 'already banned for good');
    // Bob has no booking on the motorcycle that is still active? Cancel its upcoming ones, then remove and re-add it.
    env.db.prepare(`UPDATE reservations SET status = 'cancelled', cancelled_at = ? WHERE vehicle_id = ? AND status = 'confirmed'`).run(`${DAY} 08:00:00`, d.bobMoto.id);
    users.removeVehicle(d.bob.id, d.bobMoto.id, null);
    const again = users.addVehicle(d.bob.id, { plate_number: 'bbb4444', vehicle_type: 'motorcycle' }, null);
    failsWith(() => book(d.moto, '16:00', '17:00', again), 'VEHICLE_BANNED');
    // Lifting needs a reason and is audited; then the plate books again.
    assert.ok(fieldsOf(() => etiquette.liftPenalty(p.id, 'no', admin())).lift_reason);
    etiquette.liftPenalty(p.id, 'Appeal accepted by the parking office.', admin());
    assert.ok(book(d.moto, '16:00', '17:00', again));
    const actions = env.db.prepare(`SELECT action FROM audit_logs WHERE entity_type = 'plate_penalty' ORDER BY id`).all().map((a) => a.action);
    assert.deepEqual(actions, ['penalty.apply', 'penalty.apply', 'penalty.apply', 'penalty.lift']);
  });

  test('the plate page shows its owner, reports and penalties, and penalties can be applied from it', async () => {
    const page = await adminC.get('/admin/reports/plate/BBB3333');
    assert.equal(page.status, 200);
    assert.match(page.text, /Bob Driver/);
    assert.match(page.text, /Additional fee on every reservation/);
    assert.match(page.text, /Temporary ban/);
    assert.match(page.text, /data-confirm="Apply this penalty to BBB 3333\?/, 'applying asks for confirmation');
    assert.match(page.text, /data-confirm-title="Lift penalty"/, 'lifting asks for confirmation and a reason');
    const res = await adminC.post('/admin/reports/plate/XYZ987/penalties', { kind: 'surcharge', amount: '20', reason: 'Seen on camera parking on the lawn.' });
    assert.equal(res.status, 302);
    assert.equal(etiquette.activeSurcharge('XYZ 987'), 2000, 'a plate nobody has registered yet can be penalised');
    const detail = await adminC.get(`/admin/reports/${reportId}`);
    assert.match(detail.text, /this report/);
    assert.match(detail.text, /Penalties/);
  });

  test('the driver page lists the etiquette reports on their plates, and only when they have some', async () => {
    const bob = await adminC.get(`/admin/drivers/${d.bob.id}`);
    assert.match(bob.text, /id="driver-etiquette"/);
    assert.match(bob.text, new RegExp(`href="/admin/reports/${reportId}"`));
    assert.match(bob.text, /Blocking another vehicle/);
    const alice = await adminC.get(`/admin/drivers/${d.alice.id}`);
    assert.doesNotMatch(alice.text, /id="driver-etiquette"/, 'no section for a driver without violations');
    // His banned car shows the ban, not "Active"; his other vehicle is still active.
    assert.match(bob.text, /<span class="plate">BBB 3333<\/span>[\s\S]*?Banned until/);
  });

  test('migration 009: pending reports go under review; a report that led to a penalty is resolved', () => {
    const db = openDatabase(':memory:');
    db.prepare('DELETE FROM schema_migrations WHERE version = 9').run();
    const user = db.prepare(`INSERT INTO users (full_name, email, password_hash, role) VALUES ('Rep', 'rep@test.local', 'x', 'driver')`).run().lastInsertRowid;
    const add = (status) => db.prepare(`INSERT INTO etiquette_reports (reporter_id, plate_number, plate_key, violation_type, description, incident_at, status)
      VALUES (?, 'ABC 123', 'ABC123', 'other', 'Something happened here.', '2026-03-01 10:00:00', ?)`).run(user, status).lastInsertRowid;
    const pending = add('pending');
    const penalised = add('under_review');
    const dismissed = add('dismissed');
    db.prepare(`INSERT INTO plate_penalties (plate_number, plate_key, report_id, kind, starts_at, reason) VALUES ('ABC 123', 'ABC123', ?, 'perm_ban', '2026-03-01 11:00:00', 'Reckless.')`).run(penalised);
    migrate(db);
    const statusOf = (id) => db.prepare('SELECT status FROM etiquette_reports WHERE id = ?').get(id).status;
    assert.deepEqual([statusOf(pending), statusOf(penalised), statusOf(dismissed)], ['under_review', 'resolved', 'dismissed']);
    db.close();
  });
});

describe('migration 008 on an older database', () => {
  test('vans become cars and new vans are refused; admin notification read state is kept', () => {
    const db = openDatabase(':memory:');
    db.prepare('DELETE FROM schema_migrations WHERE version = 8').run();
    db.exec(`
      DROP TRIGGER trg_vehicles_no_van_insert; DROP TRIGGER trg_vehicles_no_van_update;
      CREATE TABLE admin_notification_reads (user_id INTEGER NOT NULL, section TEXT NOT NULL, last_seen_audit_id INTEGER NOT NULL DEFAULT 0,
        seen_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')), PRIMARY KEY (user_id, section));
    `);
    const user = db.prepare(`INSERT INTO users (full_name, email, password_hash, role) VALUES ('Old Admin', 'old@test.local', 'x', 'admin')`).run().lastInsertRowid;
    const van = db.prepare(`INSERT INTO vehicles (user_id, plate_number, vehicle_type, make, model) VALUES (?, 'VAN 0001', 'van', 'Toyota', 'Hiace')`).run(user).lastInsertRowid;
    db.prepare(`INSERT INTO admin_notification_reads (user_id, section, last_seen_audit_id) VALUES (?, 'payments', 42)`).run(user);

    migrate(db);

    assert.equal(db.prepare('SELECT vehicle_type FROM vehicles WHERE id = ?').get(van).vehicle_type, 'car');
    assert.throws(() => db.prepare(`INSERT INTO vehicles (user_id, plate_number, vehicle_type) VALUES (?, 'VAN 0002', 'van')`).run(user), /VEHICLE_TYPE_NOT_ALLOWED/);
    assert.throws(() => db.prepare(`UPDATE vehicles SET vehicle_type = 'van' WHERE id = ?`).run(van), /VEHICLE_TYPE_NOT_ALLOWED/);
    assert.equal(db.prepare(`SELECT last_seen_audit_id FROM notification_reads WHERE user_id = ? AND section = 'payments'`).get(user).last_seen_audit_id, 42);
    assert.equal(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'admin_notification_reads'`).get(), undefined);
    db.close();
  });
});
