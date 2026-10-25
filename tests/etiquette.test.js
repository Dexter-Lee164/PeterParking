'use strict';

/**
 * Etiquette Reports & Penalty Management, end to end: a driver reports a plate, an administrator reviews it, verifies
 * the vehicle, approves it and issues penalties (one-time fee, recurring surcharge, temporary and permanent bans) that
 * flow into reservation fees, cash payments and booking restrictions; the penalised driver appeals; penalties are
 * modified and revoked. Plus privacy, access control, evidence checks, duplicates and the audit trail.
 */
const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, setNow } = require('./helpers');
const etiquette = require('../src/services/etiquette');
const penalties = require('../src/services/penalties');
const reservations = require('../src/services/reservations');
const payments = require('../src/services/payments');
const users = require('../src/services/users');
const notifications = require('../src/services/notifications');
const evidence = require('../src/services/evidence');
const { AppError } = require('../src/utils/errors');

const DAY = '2026-03-10';
const NOW = `${DAY} 08:00`;
// A real 1×1 PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG2 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const failure = (fn) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  assert.fail('expected an AppError');
};
const fieldsOf = (fn) => failure(fn).fields || {};

describe('etiquette reports, penalties and appeals', () => {
  let env;
  let d;
  let admin;
  let alice;
  let bob;
  let adminC;
  let reportForm;
  before(async () => {
    env = await startApp({ fixture: 'minimal', now: NOW });
    d = env.data;
    admin = { id: d.admin.id };
    reportForm = (extra = {}) => Object.assign({
      plate_number: 'bbb-3333', violation_type: 'improper_parking', zone_id: String(d.zone.id),
      incident_date: DAY, incident_time: '07:30', description: 'Parked across T1 and T2 for the whole morning.',
    }, extra);
    alice = env.client();
    await alice.login('alice@test.local');
    bob = env.client();
    await bob.login('bob@test.local');
    adminC = env.client();
    await adminC.login('admin@test.local');
  });
  after(async () => env.stop());
  beforeEach(() => setNow(NOW));

  const clearBookings = () => env.db.exec('DELETE FROM payments; DELETE FROM penalty_charges; DELETE FROM parking_sessions; DELETE FROM reservations;');
  const book = (who, vehicle, slot, start, end, date = DAY) =>
    reservations.createReservation({ userId: who.id, vehicleId: vehicle.id, slotId: slot.id, date, start, end }, { id: who.id });
  const issue = (input) => penalties.issuePenalty(Object.assign({ vehicle_id: d.bobCar.id, reason: 'Confirmed by parking staff.' }, input), admin);

  // ------------------------------------------------------------ submitting

  let reportId;
  test('a signed-in driver submits a report with a photo; nobody is penalised by it', async () => {
    const res = await alice.post('/driver/etiquette/reports', reportForm({ evidence_data: PNG }));
    assert.equal(res.status, 302, res.text.slice(0, 400));
    assert.equal(res.location, '/driver/etiquette?tab=reports');
    const row = env.db.prepare('SELECT * FROM etiquette_reports ORDER BY id DESC LIMIT 1').get();
    reportId = row.id;
    assert.equal(row.status, 'pending');
    assert.equal(row.plate_key, 'BBB3333', 'plates are normalized (case, spaces and hyphens ignored)');
    assert.equal(row.zone_id, d.zone.id);
    assert.equal(row.vehicle_id, null, 'the plate is not assumed to be a registered vehicle');
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM penalties').get().n, 0, 'no automatic penalty');
    assert.ok(env.db.prepare('SELECT sha256 FROM etiquette_evidence WHERE report_id = ?').get(reportId).sha256);

    const mine = await alice.get('/driver/etiquette?tab=reports');
    assert.match(mine.text, new RegExp(`#${reportId}`));
    assert.match(mine.text, /Under review/, 'a new report shows as under review to the reporter');
  });

  test('the report form validates everything on the server', async () => {
    const f = (extra) => fieldsOf(() => etiquette.submitReport(d.alice.id, reportForm(extra), null));
    assert.ok(f({ plate_number: 'AAA 1111' }).plate_number, 'own vehicle');
    assert.ok(f({ plate_number: '!' }).plate_number, 'not a plate');
    assert.ok(f({ violation_type: 'murder' }).violation_type);
    assert.ok(f({ zone_id: '9999' }).zone_id, 'unknown zone');
    assert.ok(f({ incident_time: '23:00' }).incident_time, 'future incident');
    assert.ok(f({ incident_date: '2026-01-01' }).incident_date, 'older than 30 days');
    assert.ok(f({ description: 'short' }).description);
    assert.ok(f({ evidence_data: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }).evidence, 'SVG is refused');
    assert.ok(f({ evidence_data: 'data:image/png;base64,SGVsbG8gd29ybGQh' }).evidence, 'bytes that are not a PNG');
    assert.ok(f({ evidence_data: `data:image/jpeg;base64,${Buffer.alloc(2 * 1024 * 1024 + 10, 0xff).toString('base64')}` }).evidence, 'over 2 MB');
    const res = await alice.post('/driver/etiquette/reports', reportForm({ zone_id: '' }));
    assert.equal(res.status, 422);
    assert.match(res.text, /Choose the parking zone/);
  });

  test('the same incident cannot be sent twice; the same photo neither', () => {
    const dup = fieldsOf(() => etiquette.submitReport(d.alice.id, reportForm({ incident_time: '07:50', plate_number: 'BBB 3333' }), null));
    assert.match(dup.plate_number, new RegExp(`report #${reportId}`));
    const samePhoto = fieldsOf(() => etiquette.submitReport(d.alice.id, reportForm({ plate_number: 'ZZZ 0001', evidence_data: PNG }), null));
    assert.match(samePhoto.evidence, /already sent this photo/);
    // Another driver reporting the same incident is fine (it corroborates it); admins see it as a possible duplicate.
    const other = etiquette.submitReport(d.bob.id, reportForm({ plate_number: 'AAA 2222', incident_time: '07:40' }), null);
    assert.equal(other.status, 'pending');
  });

  test('an unregistered plate is accepted but never linked to anyone', () => {
    const r = etiquette.submitReport(d.alice.id, reportForm({ plate_number: 'ZZZ 9999', violation_type: 'blocking', incident_time: '06:00', evidence_data: PNG2 }), null);
    assert.equal(etiquette.vehiclesForPlate(r.plate_number).length, 0);
    etiquette.approveReport(r.id, 'Seen on the camera footage.', admin);
    const err = failure(() => issue({ report_id: r.id, kind: 'perm_ban' }));
    assert.match(err.message, /Verify which registered vehicle/);
    const wrong = failure(() => etiquette.verifyVehicle(r.id, d.bobCar.id, admin));
    assert.match(wrong.message, /does not have the reported plate/);
  });

  // ------------------------------------------------------------ privacy and access

  test('reports and their photos are visible only to the reporter and administrators', async () => {
    assert.equal((await bob.get(`/driver/etiquette/reports/${reportId}`)).status, 404);
    assert.equal((await bob.get(`/driver/etiquette/reports/${reportId}/evidence`)).status, 404);
    const own = await alice.get(`/driver/etiquette/reports/${reportId}/evidence`);
    assert.equal(own.status, 200);
    assert.equal(own.headers.get('content-type'), 'image/png');
    assert.equal(own.headers.get('x-content-type-options'), 'nosniff');
    assert.match(own.headers.get('cache-control'), /no-store/);
    assert.equal((await adminC.get(`/admin/etiquette/reports/${reportId}/evidence`)).status, 200);
    const anon = env.client();
    assert.equal((await anon.get(`/admin/etiquette/reports/${reportId}/evidence`)).status, 302);
    assert.equal((await anon.post('/driver/etiquette/reports', reportForm())).status, 403, 'no session, no CSRF token: refused');
    // A driver cannot reach the admin area, so cannot issue or revoke anything.
    assert.equal((await alice.get('/admin/etiquette')).status, 302);
    const sneaky = await alice.post(`/admin/etiquette/vehicles/${d.bobCar.id}/penalties`, { kind: 'perm_ban', reason: 'I do not like Bob.' });
    assert.equal(sneaky.status, 302);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM penalties').get().n, 0);
  });

  // ------------------------------------------------------------ administrator review

  test('admin lists, filters and searches reports; finds the vehicle by normalized plate', async () => {
    const list = await adminC.get('/admin/etiquette?tab=reports&q=bbb3333');
    assert.equal(list.status, 200);
    assert.match(list.text, new RegExp(`/admin/etiquette/reports/${reportId}`));
    const fresh = await adminC.get(`/admin/etiquette?tab=reports&status=pending&zone_id=${d.zone.id}`);
    assert.match(fresh.text, new RegExp(`#${reportId}`), 'a new report is listed under "New"');
    assert.match(fresh.text, /<option value="pending" selected>New<\/option>/);
    assert.doesNotMatch(fresh.text, /value="open"|name="violation"|reportFilter-submit/, 'no Open status, no violation filter, no Filter button');
    assert.doesNotMatch((await adminC.get('/admin/etiquette?tab=reports&status=under_review')).text, new RegExp(`/admin/etiquette/reports/${reportId}"`), 'not yet under review');
    assert.doesNotMatch((await adminC.get('/admin/etiquette?tab=reports&status=dismissed')).text, new RegExp(`/admin/etiquette/reports/${reportId}"`));
    const found = etiquette.searchVehicles('bbb-33');
    assert.deepEqual(found.map((v) => v.plate_number), ['BBB 3333']);
    const page = await adminC.get(`/admin/etiquette/reports/${reportId}`);
    assert.match(page.text, /Alice Driver/, 'the administrator sees the reporter');
    assert.match(page.text, /Bob Driver/, 'and the registered owner of the matching vehicle');
  });

  test('mark under review → verify the vehicle → approve with a documented reason', async () => {
    assert.ok(failure(() => issue({ report_id: reportId, kind: 'fee_once', amount: '100' })).message.match(/Approve the report/));
    let res = await adminC.post(`/admin/etiquette/reports/${reportId}/review`, {});
    assert.equal(res.status, 302);
    assert.equal(etiquette.getReport(reportId).status, 'under_review');
    res = await adminC.post(`/admin/etiquette/reports/${reportId}/verify`, { vehicle_id: d.aliceCar.id });
    assert.equal(etiquette.getReport(reportId).vehicle_id, null, 'a vehicle with another plate is refused');
    await adminC.post(`/admin/etiquette/reports/${reportId}/verify`, { vehicle_id: d.bobCar.id });
    const verified = etiquette.getReport(reportId);
    assert.equal(verified.vehicle_id, d.bobCar.id);
    assert.equal(verified.owner_id, d.bob.id);
    await adminC.post(`/admin/etiquette/reports/${reportId}/approve`, { reason: 'ok' });
    assert.equal(etiquette.getReport(reportId).status, 'under_review', 'a reason is required');
    await adminC.post(`/admin/etiquette/reports/${reportId}/approve`, { reason: 'Confirmed with the camera footage.' });
    const approved = etiquette.getReport(reportId);
    assert.equal(approved.status, 'resolved');
    assert.equal(approved.admin_notes, 'Confirmed with the camera footage.');
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM penalties').get().n, 0, 'approving is not penalising');
    const mine = await alice.get(`/driver/etiquette/reports/${reportId}`);
    assert.match(mine.text, /Confirmed with the camera footage/);
    assert.match(mine.text, /Resolved/);
  });

  test('dismiss needs a reason; the reporter sees it', () => {
    const r = etiquette.submitReport(d.alice.id, reportForm({ plate_number: 'BBB 4444', violation_type: 'overstay', incident_time: '05:00' }), null);
    assert.ok(failure(() => etiquette.dismissReport(r.id, '', admin)).fields.reason);
    const done = etiquette.dismissReport(r.id, 'The bay was marked for two vehicles that day.', admin);
    assert.equal(done.status, 'dismissed');
    assert.equal(done.driver_status, 'dismissed');
    assert.ok(failure(() => etiquette.approveReport(r.id, 'Changed my mind.', admin)).message.match(/already dismissed/));
  });

  // ------------------------------------------------------------ fees

  let surchargeId;
  test('recurring surcharge: added to new bookings only, shown apart, recorded on cash payments', async () => {
    clearBookings();
    const before = book(d.bob, d.bobCar, d.slots[0], '10:00', '12:00');
    assert.equal(before.fee_estimated_centavos, 6000);

    const res = await adminC.post(`/admin/etiquette/reports/${reportId}/penalties`, { kind: 'surcharge', amount: '50', expires_on: '', reason: 'Parked across two slots (report confirmed).' });
    assert.equal(res.status, 302, res.text.slice(0, 300));
    const p = penalties.penaltiesForUser(d.bob.id)[0];
    surchargeId = p.id;
    assert.equal(p.kind, 'surcharge');
    assert.equal(p.report_id, reportId);
    assert.equal(p.user_id, d.bob.id);
    assert.equal(p.state, 'active');
    assert.equal(reservations.getReservation(before.id).fee_estimated_centavos, 6000, 'existing bookings keep their fee');

    // A second active surcharge on the account is refused: change the first one instead.
    assert.match(fieldsOf(() => issue({ kind: 'surcharge', amount: '20' })).kind, /already has an active recurring surcharge/);

    const preview = await bob.get(`/driver/reserve?date=${DAY}&start=16:00&end=17:00&slot_id=${d.slots[4].id}&vehicle_id=${d.bobCar.id}`);
    assert.equal(preview.status, 200);
    assert.match(preview.text, /Base parking fee/);
    assert.match(preview.text, /Recurring surcharge \(penalty\)/);
    assert.match(preview.text, /₱80\.00/, 'estimated fee ₱30 + ₱50');

    const after = book(d.bob, d.bobMoto, d.moto, '13:00', '15:00');
    assert.equal(after.surcharge_centavos, 5000);
    assert.equal(after.fee_estimated_centavos, 3000 + 5000, 'base fee + surcharge');
    assert.equal(penalties.chargesForReservation(after.id).length, 1);

    const page = await bob.get(`/driver/reservations/${after.id}`);
    assert.match(page.text, /Base parking fee/);
    assert.match(page.text, /Additional penalty fee/);

    const pay = payments.recordPayment({ reservation_id: after.id, amount: '80', method: 'cash' }, admin);
    assert.equal(pay.penalty_centavos, 5000);
    const receipt = await adminC.get(`/admin/payments/${pay.id}/receipt`);
    assert.match(receipt.text, /Penalty fee \(parking etiquette\)/);
    assert.match(receipt.text, /₱30\.00/);
  });

  test('the reported driver is notified, sees the decision but never the reporter', async () => {
    const counts = notifications.counts({ id: d.bob.id, role: 'driver' });
    assert.ok(counts.etiquette >= 1, 'badge for the new penalty');
    const list = await bob.get('/driver/etiquette?tab=penalties');
    assert.match(list.text, /Recurring surcharge/);
    const page = await bob.get(`/driver/etiquette/penalties/${surchargeId}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Parked across two slots \(report confirmed\)/, 'the administrator\'s reason');
    assert.match(page.text, /₱50\.00/);
    assert.match(page.text, /Parked over the lines or across two slots/, 'the violation');
    assert.doesNotMatch(page.text, /Alice|alice@test\.local/, 'never the reporter');
    assert.doesNotMatch(page.text, /Parked across T1 and T2/, 'nor the reporter\'s own words');
    assert.equal((await alice.get(`/driver/etiquette/penalties/${surchargeId}`)).status, 404, 'nor someone else\'s penalty');
  });

  test('modifying the surcharge changes future bookings only; revoking can explicitly clear unpaid ones', () => {
    clearBookings();
    const old = book(d.bob, d.bobCar, d.slots[0], '10:00', '11:00');
    assert.equal(old.surcharge_centavos, 5000);
    assert.ok(failure(() => penalties.modifyPenalty(surchargeId, { amount: '80', reason: 'Parked across two slots (report confirmed).', change_note: '' }, admin)).fields.change_note);
    penalties.modifyPenalty(surchargeId, { amount: '80', expires_on: '2026-03-20', reason: 'Parked across two slots (report confirmed).', change_note: 'Second offence this month.' }, admin);
    assert.equal(reservations.getReservation(old.id).surcharge_centavos, 5000, 'the booking already made keeps its fee');
    const next = book(d.bob, d.bobCar, d.slots[1], '12:00', '13:00');
    assert.equal(next.surcharge_centavos, 8000);
    payments.recordPayment({ reservation_id: next.id, amount: '110', method: 'cash' }, admin);

    const { removed } = penalties.revokePenalty(surchargeId, { reason: 'Reduced after review.', removeUnpaid: true }, admin);
    assert.deepEqual(removed, [old.booking_ref], 'only the unpaid upcoming booking is changed');
    assert.equal(reservations.getReservation(old.id).fee_estimated_centavos, 3000);
    assert.equal(reservations.getReservation(next.id).fee_estimated_centavos, 11000, 'a paid booking is never changed');
    assert.equal(penalties.getPenalty(surchargeId).state, 'revoked');
    assert.equal(book(d.bob, d.bobCar, d.slots[2], '14:00', '15:00').surcharge_centavos, 0);
  });

  test('a recurring surcharge ends by itself on its expiry date', () => {
    clearBookings();
    const p = issue({ kind: 'surcharge', amount: '25', expires_on: DAY });
    assert.equal(book(d.bob, d.bobCar, d.slots[0], '10:00', '11:00').surcharge_centavos, 2500);
    setNow('2026-03-11 08:00');
    assert.equal(penalties.getPenalty(p.id).state, 'expired');
    assert.equal(book(d.bob, d.bobCar, d.slots[0], '10:00', '11:00', '2026-03-11').surcharge_centavos, 0);
    penalties.revokePenalty(p.id, { reason: 'Clean-up after the test.' }, admin);
  });

  test('one-time fee: charged exactly once; released again by a free cancellation', () => {
    clearBookings();
    const p = issue({ kind: 'fee_once', amount: '100' });
    assert.equal(p.state, 'pending');
    const first = book(d.bob, d.bobCar, d.slots[0], '12:00', '13:00');
    assert.equal(first.surcharge_centavos, 10000);
    assert.equal(penalties.getPenalty(p.id).state, 'charged');
    const second = book(d.bob, d.bobCar, d.slots[1], '14:00', '15:00');
    assert.equal(second.surcharge_centavos, 0, 'never charged twice');

    // Cancelled free of charge (more than 2 hours ahead): nothing is collected, so the fee waits for the next booking.
    reservations.cancelReservation(first.id, { id: d.bob.id, role: 'driver' });
    assert.equal(penalties.getPenalty(p.id).state, 'pending');
    const third = book(d.bob, d.bobCar, d.slots[2], '16:00', '17:00');
    assert.equal(third.surcharge_centavos, 10000);
    assert.throws(() => env.db.prepare(`INSERT INTO penalty_charges (penalty_id, reservation_id, kind, amount_centavos, status, created_at, updated_at) VALUES (?, ?, 'fee_once', 1, 'applied', 'x', 'x')`).run(p.id, second.id), /UNIQUE/, 'the database itself refuses a second charge');
    assert.match(failure(() => penalties.modifyPenalty(p.id, { amount: '200', reason: 'Confirmed by parking staff.', change_note: 'Raise it.' }, admin)).fields.amount, /already charged/);
    penalties.revokePenalty(p.id, { reason: 'Fee waived by the office.', removeUnpaid: true }, admin);
    assert.equal(reservations.getReservation(third.id).surcharge_centavos, 0);
  });

  test('an uncharged one-time fee can be put on an existing unpaid booking, by explicit action only', () => {
    clearBookings();
    const existing = book(d.bob, d.bobCar, d.slots[0], '12:00', '13:00');
    const p = issue({ kind: 'fee_once', amount: '40' });
    assert.equal(reservations.getReservation(existing.id).surcharge_centavos, 0, 'not added by itself');
    penalties.chargeToReservation(p.id, existing.id, admin);
    const r = reservations.getReservation(existing.id);
    assert.equal(r.surcharge_centavos, 4000);
    assert.equal(r.fee_estimated_centavos, 3000 + 4000);
    assert.ok(failure(() => penalties.chargeToReservation(p.id, existing.id, admin)).message.match(/not been charged yet/));
    penalties.revokePenalty(p.id, { reason: 'Clean-up after the test.' }, admin);
  });

  // ------------------------------------------------------------ bans

  let tempBanId;
  test('temporary ban: enforced on the backend for every vehicle of the account; existing bookings are kept', async () => {
    clearBookings();
    const kept = book(d.bob, d.bobCar, d.slots[0], '12:00', '13:00');
    assert.match(fieldsOf(() => issue({ kind: 'temp_ban', start_date: '2026-03-09', end_date: '2026-03-12' })).start_date, /past/);
    assert.match(fieldsOf(() => issue({ kind: 'temp_ban', start_date: '2026-03-12', end_date: '2026-03-11' })).end_date, /on or after/);
    const ban = issue({ kind: 'temp_ban', start_date: DAY, end_date: '2026-03-12' });
    tempBanId = ban.id;
    assert.equal(ban.state, 'active');
    assert.equal(ban.duration_text, '3 days');

    assert.equal(failure(() => book(d.bob, d.bobCar, d.slots[1], '14:00', '15:00')).code, 'BANNED');
    assert.equal(failure(() => book(d.bob, d.bobMoto, d.moto, '14:00', '15:00')).code, 'BANNED', 'switching vehicles does not help');
    assert.equal(failure(() => reservations.rescheduleReservation(kept.id, { id: d.bob.id, role: 'driver' }, { date: DAY, start: '16:00', end: '17:00' })).code, 'BANNED');
    assert.equal(reservations.getReservation(kept.id).status, 'confirmed', 'not silently cancelled');

    // Through the real form too: the page cannot get around it.
    const res = await bob.post('/driver/reserve', { slot_id: d.slots[1].id, vehicle_id: d.bobCar.id, date: DAY, start: '14:00', end: '15:00' });
    assert.equal(res.status, 302);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM reservations WHERE user_id = ?').get(d.bob.id).n, 1);
    assert.match((await bob.get('/driver/find-parking')).text, /banned from new parking reservations until/);

    // Another overlapping temporary ban is refused; a later, separate one is fine.
    assert.match(fieldsOf(() => issue({ kind: 'temp_ban', start_date: '2026-03-12', end_date: '2026-03-14' })).kind, /overlaps temporary ban/);
  });

  test('the banned plate cannot be booked from another account either (simple bypass)', () => {
    env.db.prepare('UPDATE vehicles SET is_active = 0 WHERE id = ?').run(d.bobCar.id);
    const copy = users.addVehicle(d.alice.id, { plate_number: 'BBB-3333', vehicle_type: 'car' }, null);
    const err = failure(() => book(d.alice, copy, d.slots[3], '14:00', '15:00'));
    assert.equal(err.code, 'BANNED');
    assert.match(err.message, /Vehicle BBB 3333 is banned/);
    assert.equal(book(d.alice, d.aliceCar, d.slots[3], '14:00', '15:00').status, 'confirmed', 'Alice\'s own vehicle is not affected');
    env.db.prepare('UPDATE vehicles SET is_active = 0 WHERE id = ?').run(copy.id);
    env.db.prepare('UPDATE vehicles SET is_active = 1 WHERE id = ?').run(d.bobCar.id);
  });

  test('a temporary ban expires by itself', () => {
    clearBookings();
    setNow('2026-03-13 08:00');
    assert.equal(penalties.getPenalty(tempBanId).state, 'expired');
    assert.equal(book(d.bob, d.bobCar, d.slots[0], '10:00', '11:00', '2026-03-13').status, 'confirmed');
  });

  let permBanId;
  test('permanent ban: one per account, blocks until revoked', () => {
    clearBookings();
    const ban = issue({ kind: 'perm_ban', reason: 'Repeated reckless driving in the lot.' });
    permBanId = ban.id;
    assert.match(fieldsOf(() => issue({ kind: 'perm_ban' })).kind, /already permanently banned/);
    assert.match(fieldsOf(() => issue({ kind: 'temp_ban', start_date: DAY, end_date: DAY })).kind, /already permanently banned/);
    assert.throws(() => env.db.prepare(`INSERT INTO penalties (user_id, plate_number, plate_key, kind, starts_at, reason, issued_at, updated_at) VALUES (?, 'X', 'X', 'perm_ban', 'x', 'r', 'x', 'x')`).run(d.bob.id), /UNIQUE/);
    setNow('2027-06-01 08:00');
    assert.equal(failure(() => book(d.bob, d.bobCar, d.slots[0], '10:00', '11:00', '2027-06-01')).code, 'BANNED', 'still in force a year later');
  });

  // ------------------------------------------------------------ appeals

  test('the penalised driver appeals once, with an optional photo; the administrator upholds', async () => {
    assert.equal((await alice.post(`/driver/etiquette/penalties/${permBanId}/appeal`, { explanation: 'This is not even my penalty but let me try.' })).status, 404);
    let res = await bob.post(`/driver/etiquette/penalties/${permBanId}/appeal`, { explanation: 'too short' });
    assert.equal(res.status, 422);
    res = await bob.post(`/driver/etiquette/penalties/${permBanId}/appeal`, { explanation: 'I was not driving that day; my car was at the repair shop.', evidence_data: PNG });
    assert.equal(res.status, 302);
    const appeal = penalties.appealForPenalty(permBanId);
    assert.equal(appeal.status, 'pending');
    assert.ok(appeal.has_evidence);
    res = await bob.post(`/driver/etiquette/penalties/${permBanId}/appeal`, { explanation: 'Trying a second appeal on the same penalty.' });
    assert.equal(penalties.listAppeals({}).rows.length, 1, 'one appeal per penalty');
    assert.ok(notifications.counts({ id: d.admin.id, role: 'admin' }).etiquette >= 1, 'administrators are notified');
    assert.match((await adminC.get('/admin/etiquette?tab=appeals')).text, /repair shop/);
    assert.equal((await adminC.get(`/admin/etiquette/appeals/${appeal.id}/evidence`)).status, 200);
    assert.equal((await alice.get(`/driver/etiquette/appeals/${appeal.id}/evidence`)).status, 404);

    await adminC.post(`/admin/etiquette/appeals/${appeal.id}/decide`, { decision: 'uphold', reason: 'Staff saw the driver in person.' });
    assert.equal(penalties.getAppeal(appeal.id).status, 'upheld');
    assert.equal(penalties.getPenalty(permBanId).state, 'active');
    const page = await bob.get(`/driver/etiquette/penalties/${permBanId}`);
    assert.match(page.text, /Staff saw the driver in person/);
  });

  test('an appeal can revoke the penalty, which lifts the ban at once', () => {
    const fee = issue({ kind: 'fee_once', amount: '75' });
    const appeal = penalties.submitAppeal(d.bob.id, fee.id, { explanation: 'The fine was already paid at the office in cash.' }, null);
    penalties.decideAppeal(appeal.id, { decision: 'revoke', reason: 'Receipt shown at the office.' }, admin);
    assert.equal(penalties.getAppeal(appeal.id).status, 'revoked');
    assert.equal(penalties.getPenalty(fee.id).state, 'revoked');
    assert.equal(penalties.bookingCharges(d.bob.id).length, 0);

    penalties.revokePenalty(permBanId, { reason: 'Lifted by the parking director.' }, admin);
    assert.equal(failure(() => penalties.revokePenalty(permBanId, { reason: 'Again.' }, admin)).code, 'INVALID_STATE');
    setNow('2026-03-13 08:00'); // after the temporary ban of 10–12 March
    assert.equal(book(d.bob, d.bobCar, d.slots[0], '10:00', '11:00', '2026-03-13').status, 'confirmed', 'can book again');
  });

  // ------------------------------------------------------------ records

  test('every decision is in the audit log and in the penalty history', async () => {
    const actions = new Set(env.db.prepare(`SELECT action FROM audit_logs WHERE entity_type IN ('penalty', 'penalty_appeal', 'etiquette_report')`).all().map((r) => r.action));
    for (const a of ['etiquette.submit', 'etiquette.under_review', 'etiquette.verify_vehicle', 'etiquette.resolve', 'etiquette.dismiss',
      'penalty.issue', 'penalty.modify', 'penalty.charge', 'penalty.revoke', 'appeal.submit', 'appeal.decide']) assert.ok(actions.has(a), a);
    const issued = env.db.prepare(`SELECT * FROM penalty_events WHERE penalty_id = ? AND action = 'issued'`).get(surchargeId);
    const entry = env.db.prepare('SELECT * FROM audit_logs WHERE id = ?').get(issued.audit_log_id);
    assert.equal(entry.action, 'penalty.issue');
    assert.equal(entry.user_id, d.admin.id);
    const page = await adminC.get(`/admin/etiquette/penalties/${surchargeId}`);
    assert.match(page.text, /Second offence this month/);
    assert.match(page.text, /Reduced after review/);
    assert.equal((await adminC.get('/admin/settings/audit')).status, 200);
  });

  test('admin pages render: overview tabs, vehicle lookup, vehicle history, driver detail', async () => {
    for (const url of ['/admin/etiquette', '/admin/etiquette?tab=penalties&state=in_force', '/admin/etiquette?tab=appeals', '/admin/etiquette/vehicles?q=bbb',
      `/admin/etiquette/vehicles/${d.bobCar.id}`, `/admin/drivers/${d.bob.id}`, `/admin/etiquette/penalties/${tempBanId}`]) {
      const res = await adminC.get(url);
      assert.equal(res.status, 200, url);
    }
    assert.match((await adminC.get('/admin/etiquette/vehicles?q=nope')).text, /No registered vehicle matches/);
    assert.match((await adminC.get(`/admin/drivers/${d.bob.id}`)).text, /Etiquette penalties/);
  });

  test('evidence parsing accepts each allowed format by its signature', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
    assert.equal(evidence.parse(`data:image/jpeg;base64,${jpeg.toString('base64')}`).mime, 'image/jpeg');
    assert.equal(evidence.parse(`data:image/gif;base64,${Buffer.from('GIF89a....').toString('base64')}`).mime, 'image/gif');
    assert.equal(evidence.parse(''), null);
    assert.throws(() => evidence.parse(`data:image/gif;base64,${jpeg.toString('base64')}`), AppError, 'a JPEG labelled as GIF');
  });
});
