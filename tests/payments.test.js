'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, Client, T, futureWindow, slotId, userId, vehicleOf, db, clock, seedPasswords: pw } = require('./helpers');
const svc = require('../src/services/reservations');
const parking = require('../src/services/parking');
const payments = require('../src/services/payments');
const { AppError, ValidationError } = require('../src/utils/errors');

const driver = (email) => ({ id: userId(email), role: 'driver', ip: 'test' });
const admin = () => ({ id: userId(pw.adminEmail), role: 'admin', ip: 'test' });
const book = (email, code, w) => svc.createReservation({ userId: userId(email), vehicleId: vehicleOf(email), slotId: slotId(code), ...w }, driver(email));
const setNow = (date, hm) => clock.setOffset(new Date(T.localToIso(date, hm)).getTime() - Date.now());
const fieldError = (fn, field) => assert.throws(fn, (e) => { assert.ok(e instanceof ValidationError, String(e)); assert.ok(e.fields[field], JSON.stringify(e.fields)); return true; });
const finish = (ref, w) => { setNow(w.date, w.start); parking.checkIn(ref, admin()); setNow(w.date, w.end); const sid = db.prepare("SELECT ps.id FROM parking_sessions ps JOIN reservations r ON r.id = ps.reservation_id WHERE r.reference = ?").get(ref).id; parking.checkOut(sid, admin()); clock.reset(); };
const bal = (ref) => svc.getByReference(ref, admin()).bal;

let app;
test.before(async () => { app = await start(); db.prepare("INSERT INTO settings (key, value) VALUES ('max_open_reservations', '50')").run(); });
test.after(async () => { clock.reset(); await app.close(); });

test('partial, full and rejected payments reconcile with the finalized fee', () => {
  const w = futureWindow(4, 9, 11); const ref = book('maria@university.test', 'EN-10', w);
  assert.equal(bal(ref).status, 'unpaid'); assert.equal(bal(ref).assessed, 4000, 'open bookings are assessed at the estimate');
  finish(ref, w);
  assert.deepEqual([bal(ref).assessed, bal(ref).finalized, bal(ref).status], [4000, true, 'unpaid']);
  payments.recordPayment({ reservationRef: ref, amount: '15', method: 'cash' }, admin());
  assert.deepEqual([bal(ref).paid, bal(ref).balance, bal(ref).status], [1500, 2500, 'partial']);
  fieldError(() => payments.recordPayment({ reservationRef: ref, amount: '30', method: 'cash' }, admin()), 'amount');           // more than the remaining balance
  fieldError(() => payments.recordPayment({ reservationRef: ref, amount: '25', method: 'gcash' }, admin()), 'reference');      // non-cash needs a reference
  fieldError(() => payments.recordPayment({ reservationRef: ref, amount: '-5', method: 'cash' }, admin()), 'amount');
  fieldError(() => payments.recordPayment({ reservationRef: ref, amount: '25', method: 'card' }, admin()), 'method');
  fieldError(() => payments.recordPayment({ reservationRef: 'UP-NOPE', amount: '25', method: 'cash' }, admin()), 'reservationRef');
  payments.recordPayment({ reservationRef: ref, amount: '25.00', method: 'gcash', reference: 'GC-778899' }, admin());
  assert.deepEqual([bal(ref).balance, bal(ref).status], [0, 'paid']);
  fieldError(() => payments.recordPayment({ reservationRef: ref, amount: '1', method: 'cash' }, admin()), 'amount');
  const row = db.prepare('SELECT status, final_fee_centavos FROM reservations WHERE reference = ?').get(ref);
  assert.equal(row.status, 'completed', 'payments never change reservation status');
});

test('voiding a payment requires a reason, restores the balance and keeps the record', () => {
  const w = futureWindow(4, 12, 14); const ref = book('maria@university.test', 'MB-09', w); finish(ref, w);
  const p = payments.recordPayment({ reservationRef: ref, amount: '40', method: 'cash' }, admin());
  assert.equal(bal(ref).status, 'paid');
  assert.throws(() => payments.voidPayment(p.id, '', admin()), (e) => e instanceof ValidationError);
  payments.voidPayment(p.id, 'Entered the wrong booking', admin());
  assert.deepEqual([bal(ref).paid, bal(ref).balance, bal(ref).status], [0, 4000, 'unpaid']);
  const stored = db.prepare('SELECT status, void_reason, voided_by FROM payments WHERE id = ?').get(p.id);
  assert.deepEqual({ ...stored }, { status: 'voided', void_reason: 'Entered the wrong booking', voided_by: admin().id });
  assert.throws(() => payments.voidPayment(p.id, 'again', admin()), (e) => e instanceof AppError && e.code === 'BAD_STATE');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM audit_logs WHERE action = 'payment.void' AND entity_id = ?").get(String(p.id)).c, 1);
});

test('payments do not change occupancy; open bookings can be prepaid up to the estimate; cancelled ones owe nothing', () => {
  const w = futureWindow(5, 9, 11); const ref = book('juan@university.test', 'MB-10', w);
  payments.recordPayment({ reservationRef: ref, amount: '40', method: 'cash' }, admin());
  assert.equal(db.prepare('SELECT status FROM reservations WHERE reference = ?').get(ref).status, 'confirmed');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM parking_sessions WHERE reservation_id = (SELECT id FROM reservations WHERE reference = ?)").get(ref).c, 0);
  svc.cancelReservation(ref, 'Cancelled by driver', driver('juan@university.test'));
  assert.equal(bal(ref).status, 'overpaid', 'cancelled after prepaying leaves a credit to return');
  fieldError(() => payments.recordPayment({ reservationRef: ref, amount: '1', method: 'cash' }, admin()), 'reservationRef');
});

test('outstanding balances only count finalized fees minus valid payments', () => {
  const before = payments.outstanding();
  const w = futureWindow(6, 9, 10); const ref = book('maria@university.test', 'AD-02', w); finish(ref, w);
  payments.recordPayment({ reservationRef: ref, amount: '5', method: 'cash' }, admin());
  const after = payments.outstanding();
  assert.equal(after.amount - before.amount, 1500, 'a 20 peso fee with 5 pesos paid leaves 15 pesos outstanding');
  const direct = db.prepare(`SELECT COALESCE(SUM(final_fee_centavos - paid), 0) s FROM (SELECT r.final_fee_centavos,
    COALESCE((SELECT SUM(amount_centavos) FROM payments p WHERE p.reservation_id = r.id AND p.status = 'valid'), 0) paid FROM reservations r
    WHERE r.final_fee_centavos IS NOT NULL) WHERE final_fee_centavos > paid`).get().s;
  assert.equal(after.amount, direct);
});

test('receipts: owner and administrator can open them, other drivers cannot, voided receipts are stamped', async () => {
  const w = futureWindow(7, 9, 11); const ref = book('maria@university.test', 'AD-03', w); finish(ref, w);
  const a = new Client(app.base); await a.login(pw.adminEmail, pw.admin);
  const rec = await a.post('/admin/payments', { reservationRef: ref, amount: '40', method: 'gcash', reference: 'GC-12345' });
  assert.equal(rec.status, 302); assert.match(rec.location, /^\/admin\/payments\/\d+\/receipt$/);
  const id = rec.location.split('/')[3];
  const adminView = await a.get(rec.location); assert.match(adminView.text, /OR-\d{8}-\d{5}/); assert.match(adminView.text, /₱40\.00/); assert.match(adminView.text, /GC-12345/); assert.match(adminView.text, /No online payment was processed/);
  const owner = new Client(app.base); await owner.login('maria@university.test', pw.driver);
  assert.equal((await owner.get(`/driver/payments/${id}/receipt`)).status, 200);
  const other = new Client(app.base); await other.login('juan@university.test', pw.driver);
  assert.equal((await other.get(`/driver/payments/${id}/receipt`)).status, 404);
  await a.post(`/admin/payments/${id}/void`, { reason: 'Test void' });
  assert.match((await a.get(rec.location)).text, /VOIDED/);
  assert.match((await owner.get('/driver/payments')).text, /Payments are made <strong>in person<\/strong>/);
  const hist = await a.get('/admin/payments?status=voided'); assert.match(hist.text, /Test void/);
});

test('the payment form validates on the server and keeps what the administrator typed', async () => {
  const a = new Client(app.base); await a.login(pw.adminEmail, pw.admin);
  const r = await a.post('/admin/payments', { reservationRef: 'UP-NOPE', amount: 'abc', method: 'cash' });
  assert.equal(r.status, 422); assert.match(r.text, /No reservation has this reference|Enter an amount/);
  assert.match(r.text, /value="UP-NOPE"/);
});
