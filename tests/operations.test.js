'use strict';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, setNow } = require('./helpers');
const reservations = require('../src/services/reservations');
const availability = require('../src/services/availability');
const sessions = require('../src/services/sessions');
const payments = require('../src/services/payments');
const dashboard = require('../src/services/dashboard');
const parking = require('../src/services/parking');
const { AppError } = require('../src/utils/errors');

const DAY = '2026-03-10';

describe('check-in, check-out, overstay and no-show', () => {
  let env;
  let d;
  before(async () => {
    env = await startApp({ fixture: 'minimal', now: `${DAY} 09:00` });
    d = env.data;
  });
  after(async () => env.stop());
  beforeEach(() => {
    setNow(`${DAY} 09:00`);
    env.db.exec('DELETE FROM payments; DELETE FROM parking_sessions; DELETE FROM reservations; DELETE FROM settings;');
    env.db.exec(`UPDATE parking_slots SET status = 'active', hourly_rate_override_centavos = NULL;`);
  });

  const admin = () => ({ id: d.admin.id, role: 'admin' });
  const book = (who, slot, start, end, vehicle) =>
    reservations.createReservation(
      { userId: who.id, vehicleId: (vehicle || (who === d.alice ? d.aliceCar : d.bobCar)).id, slotId: slot.id, date: DAY, start, end },
      { id: who.id },
    );
  const fails = (fn, code, pattern) =>
    assert.throws(fn, (err) => {
      assert.ok(err instanceof AppError, `expected AppError, got ${err && err.stack}`);
      if (code) assert.equal(err.code, code, err.message);
      if (pattern) assert.match(err.message, pattern);
      return true;
    });

  test('check-in opens 15 minutes before the start and flags late arrivals', () => {
    const r = book(d.alice, d.slots[0], '10:00', '12:00');
    fails(() => sessions.checkIn(r.id, admin()), 'TOO_EARLY', /opens at 9:45 AM/);
    setNow(`${DAY} 09:45`);
    const ok = sessions.checkIn(r.id, admin(), { notes: 'Gate pass shown' });
    assert.equal(ok.reservation.status, 'checked_in');
    assert.equal(ok.lateMinutes, 0);
    const s = env.db.prepare('SELECT * FROM parking_sessions WHERE reservation_id = ?').get(r.id);
    assert.equal(s.check_in_at, `${DAY} 09:45:00`);
    assert.equal(s.checked_in_by, d.admin.id);
    assert.equal(s.notes, 'Gate pass shown');

    const late = book(d.bob, d.slots[1], '10:00', '12:00');
    setNow(`${DAY} 10:20`);
    const lateIn = sessions.checkIn(late.id, admin());
    assert.equal(lateIn.lateMinutes, 20, 'arrived 20 minutes after start (grace is 15)');
    const within = book(d.alice, d.slots[2], '11:00', '12:00', d.aliceCar2);
    setNow(`${DAY} 11:10`);
    assert.equal(sessions.checkIn(within.id, admin()).lateMinutes, 0, 'inside the grace period is not late');
  });

  test('reserved is not occupied: occupancy changes only on check-in', () => {
    const r = book(d.alice, d.slots[0], '10:00', '12:00');
    setNow(`${DAY} 10:05`);
    const range = { startAt: `${DAY} 10:00:00`, endAt: `${DAY} 12:00:00` };
    const stateOf = () => availability.getAvailability(range).slots.find((s) => s.id === d.slots[0].id).state;
    assert.equal(stateOf(), 'reserved');
    let snap = dashboard.slotSnapshot();
    assert.equal(snap.reserved, 1);
    assert.equal(snap.occupied, 0);
    sessions.checkIn(r.id, admin());
    assert.equal(stateOf(), 'occupied');
    snap = dashboard.slotSnapshot();
    assert.equal(snap.occupied, 1);
    assert.equal(snap.reserved, 0);
    sessions.checkOut(r.id, admin());
    assert.equal(dashboard.slotSnapshot().occupied, 0);
  });

  test('out-of-service slots (status maintenance) are counted on their own, apart from inactive', () => {
    const slot = d.slots[d.slots.length - 1];
    const before = dashboard.slotSnapshot();
    parking.setSlotStatus(slot.id, 'maintenance', admin());
    const snap = dashboard.slotSnapshot();
    assert.equal(snap.maintenance, before.maintenance + 1);
    assert.equal(snap.inactive, before.inactive);
    assert.equal(dashboard.adminDashboard().kpis.maintenance, snap.maintenance);
    parking.setSlotStatus(slot.id, 'active', admin());
    assert.equal(dashboard.slotSnapshot().maintenance, before.maintenance);
  });

  test('invalid check-ins: duplicate, cancelled, expired, occupied slot', () => {
    const r = book(d.alice, d.slots[0], '10:00', '12:00');
    const nextOnSameSlot = book(d.bob, d.slots[0], '12:00', '14:00');
    const cancelled = book(d.bob, d.slots[1], '14:00', '15:00');
    const expired = book(d.bob, d.slots[3], '16:00', '17:00', d.bobCar);
    reservations.cancelReservation(cancelled.id, d.bob, { actor: { id: d.bob.id } });

    setNow(`${DAY} 10:00`);
    sessions.checkIn(r.id, admin());
    fails(() => sessions.checkIn(r.id, admin()), 'DUPLICATE_CHECKIN');

    setNow(`${DAY} 11:50`);
    fails(() => sessions.checkIn(nextOnSameSlot.id, admin()), 'SLOT_OCCUPIED', /still occupied by AAA 1111/);

    setNow(`${DAY} 14:00`);
    fails(() => sessions.checkIn(cancelled.id, admin()), 'INVALID_STATE', /cancelled/);

    setNow(`${DAY} 17:05`);
    fails(() => sessions.checkIn(expired.id, admin()), 'EXPIRED');
  });

  test('checking out on time finalizes the reserved fee; leaving early is not refunded', () => {
    const r = book(d.alice, d.slots[0], '10:00', '12:00');
    setNow(`${DAY} 10:00`);
    sessions.checkIn(r.id, admin());
    setNow(`${DAY} 11:00`); // left an hour early
    const out = sessions.checkOut(r.id, admin());
    assert.equal(out.reservation.status, 'completed');
    assert.equal(out.overstayMinutes, 0);
    assert.equal(out.finalFee, 6000, 'full ₱60, no refund for early departure');
    assert.equal(out.durationMinutes, 60);
    assert.equal(out.reservation.fee_is_final, true);
    fails(() => sessions.checkOut(r.id, admin()), 'INVALID_STATE', /already been checked out/);
    const never = book(d.bob, d.slots[1], '13:00', '14:00');
    fails(() => sessions.checkOut(never.id, admin()), 'INVALID_STATE', /not been checked in/);
  });

  test('overstay beyond the grace period adds a surcharge; inside the grace period it does not', () => {
    const inGrace = book(d.alice, d.slots[0], '10:00', '12:00');
    setNow(`${DAY} 10:00`);
    sessions.checkIn(inGrace.id, admin());
    setNow(`${DAY} 12:08`);
    const a = sessions.checkOut(inGrace.id, admin());
    assert.equal(a.overstayMinutes, 0);
    assert.equal(a.finalFee, 6000);

    setNow(`${DAY} 09:00`);
    const over = book(d.bob, d.slots[1], '10:00', '12:00');
    setNow(`${DAY} 10:00`);
    sessions.checkIn(over.id, admin());
    setNow(`${DAY} 12:30`);
    const b = sessions.checkOut(over.id, admin());
    assert.equal(b.overstayMinutes, 30);
    assert.equal(b.overstayFee, 4500, '30 minutes → 1 billable hour × ₱30 × 150%');
    assert.equal(b.finalFee, 10500);
    const sess = env.db.prepare('SELECT * FROM parking_sessions WHERE reservation_id = ?').get(over.id);
    assert.equal(sess.overstay_minutes, 30);
    assert.equal(sess.overstay_fee_centavos, 4500);
  });

  test('an overstaying vehicle keeps blocking the slot until it leaves', () => {
    const r = book(d.alice, d.slots[0], '10:00', '12:00');
    setNow(`${DAY} 10:00`);
    sessions.checkIn(r.id, admin());
    setNow(`${DAY} 12:30`);
    const live = sessions.activeSessions();
    assert.equal(live.length, 1);
    assert.equal(live[0].overstaying, true);
    assert.equal(live[0].overstay_minutes_so_far, 30);
    fails(() => book(d.bob, d.slots[0], '12:00', '13:00'), 'CONFLICT');
    const view = availability.getAvailability({ startAt: `${DAY} 12:00:00`, endAt: `${DAY} 14:00:00` });
    assert.equal(view.slots.find((s) => s.id === d.slots[0].id).state, 'occupied');
    sessions.checkOut(r.id, admin());
    assert.doesNotThrow(() => book(d.bob, d.slots[0], '12:00', '13:00'));
  });

  test('no-show: only after the arrival grace period, fee assessed, and swept automatically after the window', () => {
    const r = book(d.alice, d.slots[0], '10:00', '12:00');
    setNow(`${DAY} 10:10`);
    fails(() => reservations.markNoShow(r.id, admin()), 'TOO_EARLY', /15-minute arrival grace/);
    setNow(`${DAY} 10:20`);
    const ns = reservations.markNoShow(r.id, admin());
    assert.equal(ns.status, 'no_show');
    assert.equal(ns.fee_final_centavos, 3000, '50% of ₱60');
    fails(() => sessions.checkIn(r.id, admin()), 'INVALID_STATE');
    // The slot is free again for the remaining time.
    assert.doesNotThrow(() => book(d.bob, d.slots[0], '11:00', '12:00'));

    const auto = book(d.alice, d.slots[1], '13:00', '14:00');
    setNow(`${DAY} 14:01`);
    const swept = reservations.sweepNoShows();
    assert.equal(swept, 2, 'both unvisited bookings whose windows have ended are closed');
    const row = reservations.getReservation(auto.id);
    assert.equal(row.status, 'no_show');
    assert.equal(row.fee_final_centavos, 1500);
    assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'reservation.no_show' AND user_id IS NULL`).get().n, 2, 'system actions are logged without a user');
  });

  test('a slot cannot enter maintenance while a vehicle is parked or bookings are pending', () => {
    const r = book(d.alice, d.slots[0], '10:00', '12:00');
    fails(() => parking.setSlotStatus(d.slots[0].id, 'maintenance', admin()), 'SLOT_HAS_RESERVATIONS', /T1 has 1 upcoming/);
    setNow(`${DAY} 10:00`);
    sessions.checkIn(r.id, admin());
    fails(() => parking.setSlotStatus(d.slots[0].id, 'maintenance', admin()), 'SLOT_OCCUPIED');
    sessions.checkOut(r.id, admin());
    assert.equal(parking.setSlotStatus(d.slots[0].id, 'maintenance', admin()).status, 'maintenance');
    fails(() => parking.deleteSlot(d.slots[0].id, admin()), 'SLOT_HAS_HISTORY');
  });

  test('operations search finds bookings by reference or plate', () => {
    const r = book(d.alice, d.slots[0], '10:00', '12:00');
    setNow(`${DAY} 10:00`);
    assert.equal(sessions.search(r.booking_ref)[0].id, r.id);
    assert.equal(sessions.search('aaa1111')[0].id, r.id, 'plate lookup ignores case and spaces');
    assert.equal(sessions.search('AAA 11')[0].id, r.id);
    assert.equal(sessions.search('nothing-here').length, 0);
    assert.equal(sessions.search('')?.length, 0);
    assert.equal(sessions.search(r.booking_ref)[0].can_check_in, true);
  });
});

describe('manual payments', () => {
  let env;
  let d;
  let r;
  before(async () => {
    env = await startApp({ fixture: 'minimal', now: `${DAY} 09:00` });
    d = env.data;
  });
  after(async () => env.stop());
  beforeEach(() => {
    setNow(`${DAY} 09:00`);
    env.db.exec('DELETE FROM payments; DELETE FROM parking_sessions; DELETE FROM reservations; DELETE FROM settings;');
    r = reservations.createReservation(
      { userId: d.alice.id, vehicleId: d.aliceCar.id, slotId: d.slots[0].id, date: DAY, start: '10:00', end: '12:00' },
      { id: d.alice.id },
    );
  });
  const admin = () => ({ id: d.admin.id, role: 'admin' });
  const complete = () => {
    setNow(`${DAY} 10:00`);
    sessions.checkIn(r.id, admin());
    setNow(`${DAY} 12:00`);
    sessions.checkOut(r.id, admin());
  };
  const pay = (input) => payments.recordPayment(Object.assign({ reservation_id: r.id, method: 'cash' }, input), admin());
  const invalid = (input, field) =>
    assert.throws(() => pay(input), (e) => e instanceof AppError && e.code === 'VALIDATION' && !!e.fields && !!e.fields[field]);

  test('a partial payment is refused; the full balance settles the booking without changing it or the slot', () => {
    complete();
    assert.equal(reservations.getReservation(r.id).balance_centavos, 6000);
    assert.throws(() => pay({ amount: '25' }), (e) => e instanceof AppError && /Partial payments are not accepted/.test(e.fields.amount));
    let res = reservations.getReservation(r.id);
    assert.equal(res.paid_centavos, 0);
    assert.equal(res.payment_status, 'unpaid');
    const p = pay({ amount: '60.00', reference: 'OR-778899' });
    assert.match(p.receipt_no, /^RCT-20260310-0001$/);
    assert.equal(p.amount_centavos, 6000);
    assert.equal(p.status, 'valid');
    res = reservations.getReservation(r.id);
    assert.equal(res.balance_centavos, 0);
    assert.equal(res.payment_status, 'paid');
    assert.equal(res.status, 'completed', 'payments never change reservation status');
    assert.equal(env.db.prepare(`SELECT status FROM parking_slots WHERE id = ?`).get(d.slots[0].id).status, 'active');
    assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'payment.record'`).get().n, 1);
  });

  test('payment input is validated', () => {
    complete();
    invalid({ amount: '0' }, 'amount');
    invalid({ amount: '-5' }, 'amount');
    invalid({ amount: 'abc' }, 'amount');
    invalid({ amount: '10.555' }, 'amount');
    invalid({ amount: '60.01' }, 'amount'); // more than the ₱60 balance
    invalid({ amount: '10', method: 'bitcoin' }, 'method');
    // Cash only: the former manual methods are refused, with or without a reference.
    invalid({ amount: '10', method: 'gcash', reference: 'GC-778899' }, 'method');
    invalid({ amount: '10', method: 'bank_transfer', reference: 'BT-123456' }, 'method');
    invalid({ amount: '10', method: 'other' }, 'method');
    invalid({ amount: '10', method: 'CASH ' }, 'method');
    assert.throws(() => payments.recordPayment({ reservation_id: 999999, amount: '10', method: 'cash' }, admin()), AppError);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM payments').get().n, 0, 'nothing was recorded by the invalid attempts');
  });

  test('overpayment is refused and a settled booking cannot be paid again', () => {
    complete();
    pay({ amount: '60' });
    invalid({ amount: '1' }, 'amount');
  });

  test('voiding restores the balance, needs a reason, and keeps the record', () => {
    complete();
    const p = pay({ amount: '60' });
    assert.equal(reservations.getReservation(r.id).payment_status, 'paid');
    assert.throws(() => payments.voidPayment(p.id, admin(), ''), (e) => e instanceof AppError && e.code === 'VALIDATION');
    const voided = payments.voidPayment(p.id, admin(), 'Entered on the wrong booking');
    assert.equal(voided.status, 'voided');
    assert.equal(voided.void_reason, 'Entered on the wrong booking');
    assert.equal(voided.voided_by, d.admin.id);
    const res = reservations.getReservation(r.id);
    assert.equal(res.paid_centavos, 0);
    assert.equal(res.balance_centavos, 6000);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM payments').get().n, 1, 'voided payments are never deleted');
    assert.throws(() => payments.voidPayment(p.id, admin(), 'again'), (e) => e instanceof AppError && e.code === 'INVALID_STATE');
    // The freed balance can be paid again under a new receipt number.
    assert.match(pay({ amount: '60' }).receipt_no, /0002$/);
  });

  test('a prepayment is allowed up to the estimate for an upcoming booking', () => {
    assert.equal(r.status, 'confirmed');
    const p = pay({ amount: '60' });
    assert.equal(p.amount_centavos, 6000);
    assert.equal(reservations.getReservation(r.id).payment_status, 'paid');
    assert.equal(reservations.getReservation(r.id).status, 'confirmed', 'paying does not check the driver in');
    invalid({ amount: '5' }, 'amount');
  });

  test('a free cancellation has nothing to pay; a late-cancel fee can be collected', () => {
    const far = reservations.createReservation(
      { userId: d.alice.id, vehicleId: d.aliceCar.id, slotId: d.slots[2].id, date: DAY, start: '15:00', end: '16:00' },
      { id: d.alice.id },
    );
    reservations.cancelReservation(far.id, d.alice, { actor: { id: d.alice.id } });
    assert.equal(reservations.getReservation(far.id).due_centavos, 0);
    assert.throws(
      () => payments.recordPayment({ reservation_id: far.id, amount: '10', method: 'cash' }, admin()),
      (e) => e instanceof AppError && e.code === 'VALIDATION' && !!e.fields.reservation_id,
    );

    // r starts in one hour, which is inside the 2-hour free-cancellation window → 50% fee.
    const cancelled = reservations.cancelReservation(r.id, d.alice, { actor: { id: d.alice.id } });
    assert.equal(cancelled.fee_final_centavos, 3000);
    const fee = pay({ amount: '30' });
    assert.equal(fee.amount_centavos, 3000);
    assert.equal(reservations.getReservation(r.id).payment_status, 'paid');
  });

  test('outstanding balances only include finalized bookings and sum correctly', () => {
    assert.equal(payments.totalOutstanding(), 0, 'an unfinished booking owes nothing yet');
    complete();
    assert.equal(payments.totalOutstanding(), 6000);
    assert.equal(payments.totalOutstanding({ userId: d.alice.id }), 6000);
    assert.equal(payments.totalOutstanding({ userId: d.bob.id }), 0);
    assert.equal(payments.outstandingBalances()[0].balance_centavos, 6000);
    pay({ amount: '60' });
    assert.equal(payments.totalOutstanding(), 0);
  });
});

describe('admin and driver workflows over HTTP', () => {
  let env;
  let d;
  let adminC;
  let aliceC;
  let bobC;
  let res;
  before(async () => {
    env = await startApp({ fixture: 'minimal', now: `${DAY} 09:00` });
    d = env.data;
    res = reservations.createReservation(
      { userId: d.alice.id, vehicleId: d.aliceCar.id, slotId: d.slots[0].id, date: DAY, start: '10:00', end: '12:00' },
      { id: d.alice.id },
    );
    adminC = env.client();
    aliceC = env.client();
    bobC = env.client();
    await adminC.login('admin@test.local');
    await aliceC.login('alice@test.local');
    await bobC.login('bob@test.local');
  });
  after(async () => env.stop());

  const follow = async (c, response) => (response.location ? c.get(response.location) : response);

  test('admin checks a driver in and out from the operations screen', async () => {
    setNow(`${DAY} 09:00`);
    let page = await adminC.get(`/admin/operations?q=${res.booking_ref}`);
    assert.equal(page.status, 200);
    assert.match(page.text, new RegExp(res.booking_ref));
    assert.match(page.text, /opens 15 minutes before|Check in/);

    let post = await adminC.post(`/admin/operations/${res.id}/check-in`, { q: res.booking_ref });
    page = await follow(adminC, post);
    assert.match(page.text, /Check-in opens at 9:45 AM/, 'too-early check-in is refused with a clear message');
    assert.equal(env.db.prepare('SELECT status FROM reservations WHERE id = ?').get(res.id).status, 'confirmed');

    setNow(`${DAY} 10:00`);
    post = await adminC.post(`/admin/operations/${res.id}/check-in`, { q: res.booking_ref });
    page = await follow(adminC, post);
    assert.match(page.text, /AAA 1111 checked in to slot T1/);
    assert.equal(env.db.prepare('SELECT status FROM reservations WHERE id = ?').get(res.id).status, 'checked_in');
    assert.match(page.text, /Currently parked/);

    setNow(`${DAY} 12:30`);
    post = await adminC.post(`/admin/operations/${res.id}/check-out`, {});
    assert.equal(post.location, `/admin/payments/new?reservation_id=${res.id}`, 'a fee owed goes straight to payment');
    page = await follow(adminC, post);
    assert.match(page.text, /Overstayed by 30m/);
    assert.match(page.text, /Final fee: ₱105\.00/);
  });

  test('admin records a payment; the driver sees the receipt, another driver cannot', async () => {
    const form = await adminC.get(`/admin/payments/new?reservation_id=${res.id}`);
    assert.equal(form.status, 200);
    assert.match(form.text, /Remaining balance/);
    assert.match(form.text, /105\.00/);

    const invalid = await adminC.post('/admin/payments', { reservation_id: res.id, amount: '500', method: 'cash' });
    assert.equal(invalid.status, 422);
    assert.match(invalid.text, /exceeds the remaining balance/);

    // Only cash can be posted, even by hand-crafting the form.
    const gcash = await adminC.post('/admin/payments', { reservation_id: res.id, amount: '100', method: 'gcash', reference: 'GC-12345' });
    assert.equal(gcash.status, 422);
    assert.match(gcash.text, /Only cash payments are accepted/);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM payments').get().n, 0);
    assert.doesNotMatch(form.text, /GCash|Bank transfer/, 'the form offers no other method');

    const short = await adminC.post('/admin/payments', { reservation_id: res.id, amount: '100', method: 'cash' });
    assert.equal(short.status, 422);
    assert.match(short.text, /Collect the full remaining balance of ₱105\.00/);

    const ok = await adminC.post('/admin/payments', { reservation_id: res.id, amount: '105', method: 'cash', reference: 'OR-12345' });
    assert.equal(ok.status, 302);
    assert.match(ok.location, /^\/admin\/payments\/\d+\/receipt$/);
    const receipt = await adminC.get(ok.location);
    assert.match(receipt.text, /RCT-20260310-0001/);
    assert.match(receipt.text, /₱105\.00/);
    assert.match(receipt.text, /Void payment/, 'admins can void from the receipt');

    const payId = ok.location.split('/')[3];
    const mine = await aliceC.get(`/driver/payments/${payId}/receipt`);
    assert.equal(mine.status, 200);
    assert.doesNotMatch(mine.text, /Void payment/, 'drivers never get the void action');
    assert.equal((await bobC.get(`/driver/payments/${payId}/receipt`)).status, 404);

    const driverPayments = await aliceC.get('/driver/payments');
    assert.match(driverPayments.text, /RCT-20260310-0001/);
    // Drivers cannot post payments or void them.
    const sneaky = await aliceC.post('/admin/payments', { reservation_id: res.id, amount: '5', method: 'cash' });
    assert.equal(sneaky.status, 302);
    assert.equal(sneaky.location, '/driver');
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM payments').get().n, 1);
  });

  test('voiding from the receipt restores the balance and is shown as voided', async () => {
    const pay = env.db.prepare('SELECT id FROM payments LIMIT 1').get();
    const noReason = await adminC.post(`/admin/payments/${pay.id}/void`, { reason: '' });
    const err = await follow(adminC, noReason);
    assert.match(err.text, /reason/i);
    assert.equal(env.db.prepare('SELECT status FROM payments WHERE id = ?').get(pay.id).status, 'valid');

    const ok = await adminC.post(`/admin/payments/${pay.id}/void`, { reason: 'Wrong amount entered' });
    const page = await follow(adminC, ok);
    assert.match(page.text, /VOIDED/);
    assert.equal(reservations.getReservation(res.id).balance_centavos, 10500);
    const list = await adminC.get('/admin/payments');
    assert.doesNotMatch(list.text, /RCT-20260310-0001/, 'the payments list shows paid bookings only');
  });

  test('admin cancels a driver booking with a required reason; a no-show can be marked', async () => {
    setNow(`${DAY} 13:00`);
    const upcoming = reservations.createReservation(
      { userId: d.bob.id, vehicleId: d.bobCar.id, slotId: d.slots[1].id, date: DAY, start: '16:00', end: '18:00' },
      { id: d.bob.id },
    );
    const missing = await adminC.post(`/admin/reservations/${upcoming.id}/cancel`, { reason: '' });
    assert.match((await follow(adminC, missing)).text, /reason/i);
    assert.equal(env.db.prepare('SELECT status FROM reservations WHERE id = ?').get(upcoming.id).status, 'confirmed');
    const ok = await adminC.post(`/admin/reservations/${upcoming.id}/cancel`, { reason: 'Event closure', waive_fee: '1' });
    const page = await follow(adminC, ok);
    assert.match(page.text, /Event closure/);
    assert.equal(env.db.prepare('SELECT status FROM reservations WHERE id = ?').get(upcoming.id).status, 'cancelled');
    assert.match((await bobC.get('/driver/reservations?tab=cancelled')).text, new RegExp(upcoming.booking_ref));

    const nsBooking = reservations.createReservation(
      { userId: d.bob.id, vehicleId: d.bobCar.id, slotId: d.slots[2].id, date: DAY, start: '14:00', end: '16:00' },
      { id: d.bob.id },
    );
    setNow(`${DAY} 14:30`);
    const ns = await adminC.post(`/admin/reservations/${nsBooking.id}/no-show`);
    assert.match((await follow(adminC, ns)).text, /marked as a no-show/);
    assert.equal(env.db.prepare('SELECT status FROM reservations WHERE id = ?').get(nsBooking.id).status, 'no_show');
  });
});
