'use strict';
const { db } = require('../db');
const audit = require('./audit');
const settingsSvc = require('./settings');
const billing = require('./billing');
const { RES_SELECT } = require('./reservations');
const T = require('../utils/time');
const { pesos, parsePesos } = require('../utils/money');
const { ValidationError, conflict, notFound } = require('../utils/errors');
const v = require('../utils/validate');

const METHODS = ['cash', 'gcash', 'bank_transfer', 'other'];
const METHOD_LABEL = { cash: 'Cash', gcash: 'GCash (recorded manually)', bank_transfer: 'Bank transfer (recorded manually)', other: 'Other' };

/** Record a payment the administrator received in person. No money moves through the system. */
function recordPayment(input, actor) {
  const errors = {};
  const ref = v.clean(input.reservationRef).toUpperCase();
  const amount = parsePesos(input.amount);
  const method = v.clean(input.method), reference = v.clean(input.reference).slice(0, 60), notes = v.clean(input.notes).slice(0, 200);
  if (!ref) errors.reservationRef = 'Enter the booking reference.';
  if (amount === null || amount <= 0) errors.amount = 'Enter an amount in pesos, such as 40.00.';
  if (!v.oneOf(method, METHODS)) errors.method = 'Choose how it was paid.';
  else if (method !== 'cash' && !reference) errors.reference = 'Enter the receipt or transaction reference.';
  v.assertNoErrors(errors);

  return db.transaction(() => {
    const row = db.prepare(`${RES_SELECT} WHERE r.reference = ?`).get(ref);
    if (!row) throw new ValidationError({ reservationRef: 'No reservation has this reference.' });
    const b = billing.balance(row);
    if (b.assessed === 0) throw new ValidationError({ reservationRef: 'There is no fee to pay on this reservation.' });
    if (amount > b.balance) throw new ValidationError({ amount: `This is more than the remaining balance of ${pesos(b.balance)}.` });
    const now = T.nowIso();
    const next = db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM payments').get().n;
    const receipt = `OR-${T.localParts(now).date.replaceAll('-', '')}-${String(next).padStart(5, '0')}`;
    const info = db.prepare(`INSERT INTO payments (receipt_number, reservation_id, amount_centavos, method, reference, notes, recorded_by, recorded_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(receipt, row.id, amount, method, reference || null, notes || null, actor.id, now);
    audit.log(actor, 'payment.record', 'payment', info.lastInsertRowid, { receipt, reservation: row.reference, amount, method });
    return { id: info.lastInsertRowid, receipt };
  }).immediate();
}

function voidPayment(paymentId, reason, actor) {
  const text = v.cleanMultiline(reason).slice(0, 300);
  if (text.length < 3) throw new ValidationError({ reason: 'Enter a reason (at least 3 characters).' });
  return db.transaction(() => {
    const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
    if (!p) throw notFound('Payment');
    if (p.status === 'voided') throw conflict('This payment is already voided.', 'BAD_STATE');
    const now = T.nowIso();
    db.prepare("UPDATE payments SET status = 'voided', voided_by = ?, voided_at = ?, void_reason = ? WHERE id = ?").run(actor.id, now, text, p.id);
    audit.log(actor, 'payment.void', 'payment', p.id, { receipt: p.receipt_number, amount: p.amount_centavos, reason: text });
    return p.receipt_number;
  }).immediate();
}

const PAY_SELECT = `SELECT p.*, r.reference AS reservation_reference, r.user_id, u.name AS driver_name, rb.name AS recorded_by_name, vb.name AS voided_by_name
  FROM payments p JOIN reservations r ON r.id = p.reservation_id JOIN users u ON u.id = r.user_id
  LEFT JOIN users rb ON rb.id = p.recorded_by LEFT JOIN users vb ON vb.id = p.voided_by`;

function list({ q = '', status = '', method = '', dateFrom = '', dateTo = '', userId = '', page = 1, size = 15 } = {}) {
  const where = []; const p = [];
  if (q) { where.push('(p.receipt_number LIKE ? OR r.reference LIKE ? OR u.name LIKE ? OR p.reference LIKE ?)'); p.push(...Array(4).fill(`%${q}%`)); }
  if (v.oneOf(status, ['valid', 'voided'])) { where.push('p.status = ?'); p.push(status); }
  if (v.oneOf(method, METHODS)) { where.push('p.method = ?'); p.push(method); }
  if (userId) { where.push('r.user_id = ?'); p.push(userId); }
  if (T.isValidDate(dateFrom)) { where.push('p.recorded_at >= ?'); p.push(T.dayBoundsUtc(dateFrom).start); }
  if (T.isValidDate(dateTo)) { where.push('p.recorded_at < ?'); p.push(T.dayBoundsUtc(dateTo).end); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM payments p JOIN reservations r ON r.id = p.reservation_id JOIN users u ON u.id = r.user_id ${w}`).get(...p).c;
  const rows = db.prepare(`${PAY_SELECT} ${w} ORDER BY p.id DESC LIMIT ? OFFSET ?`).all(...p, size, (page - 1) * size);
  return { rows, total };
}

function getReceipt(paymentId, actor) {
  const p = db.prepare(`${PAY_SELECT} WHERE p.id = ?`).get(paymentId);
  if (!p || (actor.role !== 'admin' && p.user_id !== actor.id)) throw notFound('Receipt');
  const reservation = db.prepare(`${RES_SELECT} WHERE r.id = ?`).get(p.reservation_id);
  return { payment: p, reservation, bal: billing.balance(reservation), header: settingsSvc.getAll().receipt_header };
}

/** Reservations with a finalized fee that is not fully paid. */
function outstanding({ userId = null, limit = 50 } = {}) {
  const rows = db.prepare(`SELECT * FROM (${RES_SELECT}) q WHERE q.final_fee_centavos IS NOT NULL AND q.final_fee_centavos > q.paid_centavos
      ${userId ? 'AND q.user_id = ?' : ''} ORDER BY q.finalized_at DESC LIMIT ?`).all(...(userId ? [userId, limit] : [limit])).map((r) => ({ ...r, bal: billing.balance(r) }));
  const totals = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(q.final_fee_centavos - q.paid_centavos), 0) AS amount FROM (${RES_SELECT}) q
      WHERE q.final_fee_centavos IS NOT NULL AND q.final_fee_centavos > q.paid_centavos ${userId ? 'AND q.user_id = ?' : ''}`).get(...(userId ? [userId] : []));
  return { rows, count: totals.n, amount: totals.amount };
}

/** Open (not yet finalized) reservations a driver may prepay. */
const prepayable = (userId) => db.prepare(`SELECT * FROM (${RES_SELECT}) q WHERE q.user_id = ? AND q.status IN ('confirmed','active') AND q.estimated_fee_centavos > q.paid_centavos ORDER BY q.start_at`)
  .all(userId).map((r) => ({ ...r, bal: billing.balance(r) }));

module.exports = { METHODS, METHOD_LABEL, recordPayment, voidPayment, list, getReceipt, outstanding, prepayable };
