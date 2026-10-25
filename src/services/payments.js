'use strict';

const ctx = require('../db/context');
const { immediate } = require('../db');
const reservations = require('./reservations');
const audit = require('./audit');
const time = require('../utils/time');
const { AppError } = require('../utils/errors');
const { clean } = require('../utils/validate');
const { parsePesoToCentavos, formatPeso } = require('../utils/money');
const { paginate } = require('../utils/paginate');

/** Cash is the only way to pay. The other methods exist only on older records, which are kept as they were. */
const METHODS = ['cash'];
const LEGACY_METHODS = ['gcash', 'bank_transfer', 'other'];
const ALL_METHODS = METHODS.concat(LEGACY_METHODS);
const METHOD_LABELS = { cash: 'Cash', gcash: 'GCash (legacy record)', bank_transfer: 'Bank transfer (legacy record)', other: 'Other (legacy record)' };
const methodLabel = (method) => METHOD_LABELS[method] || String(method || '');

/**
 * Payments are manual records made by an administrator. They never change a
 * reservation's or a slot's status. Balance = assessed (or estimated) fee − valid payments.
 */
const PAYMENT_SELECT = `
  SELECT p.*, r.booking_ref, r.fee_estimated_centavos, r.fee_final_centavos, r.status AS reservation_status,
         u.full_name AS driver_name, u.email AS driver_email,
         rb.full_name AS recorded_by_name, vb.full_name AS voided_by_name,
         s.slot_code, z.name AS zone_name, v.plate_number
  FROM payments p
  JOIN reservations r ON r.id = p.reservation_id
  JOIN users u ON u.id = p.user_id
  JOIN users rb ON rb.id = p.recorded_by
  LEFT JOIN users vb ON vb.id = p.voided_by
  JOIN parking_slots s ON s.id = r.slot_id
  JOIN parking_zones z ON z.id = s.zone_id
  JOIN vehicles v ON v.id = r.vehicle_id`;

function nextReceiptNo(db, paidAt) {
  const day = paidAt.slice(0, 10).replace(/-/g, '');
  const prefix = `RCT-${day}-`;
  const last = db
    .prepare(`SELECT receipt_no FROM payments WHERE receipt_no LIKE ? ORDER BY receipt_no DESC LIMIT 1`)
    .get(`${prefix}%`);
  const n = last ? parseInt(last.receipt_no.slice(prefix.length), 10) + 1 : 1;
  return `${prefix}${String(n).padStart(4, '0')}`;
}

function recordPayment(input, admin) {
  const db = ctx.get();
  return immediate(db, () => {
    const fields = {};
    const res = reservations.getReservation(parseInt(input.reservation_id, 10));
    if (!res) throw new AppError('Choose a reservation to record the payment against.', { code: 'VALIDATION', fields: { reservation_id: 'Reservation not found.' } });

    const amount = parsePesoToCentavos(input.amount);
    // A form that sends no method means cash; anything else is refused, never silently turned into cash.
    const method = clean(input.method) || 'cash';
    const reference = clean(input.reference);
    const notes = clean(input.notes);

    if (amount === null || amount <= 0) fields.amount = 'Enter an amount greater than zero (e.g. 60 or 60.50).';
    if (!METHODS.includes(method)) fields.method = 'Only cash payments are accepted.';
    if (reference.length > 80) fields.reference = 'Keep the reference under 80 characters.';
    if (notes.length > 300) fields.notes = 'Keep notes under 300 characters.';
    if (res.status === 'cancelled' && res.due_centavos === 0) fields.reservation_id = 'This cancelled booking has no charge to pay.';
    // A payment settles the whole remaining balance: partial payments are not accepted.
    if (!fields.amount && amount !== res.balance_centavos) {
      if (res.balance_centavos <= 0) fields.amount = 'This reservation is already fully paid.';
      else if (amount > res.balance_centavos) fields.amount = `Amount exceeds the remaining balance of ${formatPeso(res.balance_centavos)}.`;
      else fields.amount = `Collect the full remaining balance of ${formatPeso(res.balance_centavos)}. Partial payments are not accepted.`;
    }
    if (Object.keys(fields).length) throw new AppError('Please correct the highlighted fields.', { code: 'VALIDATION', fields });

    const paidAt = time.nowLocal();
    const receiptNo = nextReceiptNo(db, paidAt);
    const info = db
      .prepare(
        `INSERT INTO payments (receipt_no, reservation_id, user_id, amount_centavos, method, reference, notes, status, paid_at, recorded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'valid', ?, ?)`,
      )
      .run(receiptNo, res.id, res.user_id, amount, method, reference || null, notes || null, paidAt, admin.id);
    audit.log(admin, 'payment.record', 'payment', info.lastInsertRowid, {
      receipt: receiptNo, ref: res.booking_ref, amount, method, reference,
    });
    return getPayment(info.lastInsertRowid);
  });
}

function voidPayment(id, admin, reason) {
  const db = ctx.get();
  return immediate(db, () => {
    const p = getPayment(id);
    if (!p) throw new AppError('Payment not found.', { status: 404, code: 'NOT_FOUND' });
    if (p.status === 'voided') throw new AppError('This payment has already been voided.', { code: 'INVALID_STATE', status: 409 });
    const why = clean(reason);
    if (why.length < 3) throw new AppError('Enter the reason for voiding this payment.', { code: 'VALIDATION', fields: { reason: 'A reason is required.' } });
    const now = time.nowLocal();
    db.prepare(`UPDATE payments SET status = 'voided', voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ?`).run(now, admin.id, why, id);
    audit.log(admin, 'payment.void', 'payment', id, { receipt: p.receipt_no, ref: p.booking_ref, amount: p.amount_centavos, reason: why });
    return getPayment(id);
  });
}

function getPayment(id) {
  return ctx.get().prepare(`${PAYMENT_SELECT} WHERE p.id = ?`).get(id);
}

function listPayments({ q = '', status = '', method = '', dateFrom = '', dateTo = '', userId = null, reservationId = null } = {}, { page = 1, perPage = 15, all = false } = {}) {
  const where = [];
  const params = [];
  if (userId) {
    where.push('p.user_id = ?');
    params.push(userId);
  }
  if (reservationId) {
    where.push('p.reservation_id = ?');
    params.push(reservationId);
  }
  if (status === 'valid' || status === 'voided') {
    where.push('p.status = ?');
    params.push(status);
  }
  if (ALL_METHODS.includes(method)) {
    where.push('p.method = ?');
    params.push(method);
  }
  if (dateFrom) {
    where.push('p.paid_at >= ?');
    params.push(`${dateFrom} 00:00:00`);
  }
  if (dateTo) {
    where.push('p.paid_at <= ?');
    params.push(`${dateTo} 23:59:59`);
  }
  if (q) {
    where.push('(p.receipt_no LIKE ? OR p.reference LIKE ? OR r.booking_ref LIKE ? COLLATE NOCASE OR u.full_name LIKE ? OR replace(v.plate_number, \' \', \'\') LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q.replace(/\s/g, '').toUpperCase()}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const db = ctx.get();
  if (all) return { rows: db.prepare(`${PAYMENT_SELECT} ${whereSql} ORDER BY p.id DESC`).all(...params) };
  const total = db
    .prepare(
      `SELECT COUNT(*) AS n FROM payments p JOIN reservations r ON r.id = p.reservation_id
       JOIN users u ON u.id = p.user_id JOIN vehicles v ON v.id = r.vehicle_id ${whereSql}`,
    )
    .get(...params).n;
  const pager = paginate(total, page, perPage);
  const rows = db.prepare(`${PAYMENT_SELECT} ${whereSql} ORDER BY p.id DESC LIMIT ? OFFSET ?`).all(...params, perPage, pager.offset);
  return { rows, pager };
}

/** Reservations that still owe money after being finalized (and prepaid-but-unfinalized ones are excluded). */
function outstandingBalances({ userId = null, limit = null } = {}) {
  const rows = ctx
    .get()
    .prepare(
      `${reservations.RES_SELECT}
       WHERE r.fee_final_centavos IS NOT NULL ${userId ? 'AND r.user_id = @user' : ''}
       ORDER BY r.start_at DESC`,
    )
    .all(userId ? { user: userId } : {})
    .map(reservations.decorate)
    .filter((r) => r.balance_centavos > 0);
  return limit ? rows.slice(0, limit) : rows;
}

/** Methods present on recorded payments, for the history filter (cash first). */
function methodsInUse() {
  const used = new Set(ctx.get().prepare('SELECT DISTINCT method FROM payments').all().map((r) => r.method));
  return ALL_METHODS.filter((m) => m === 'cash' || used.has(m));
}

const totalOutstanding = (opts) => outstandingBalances(opts).reduce((sum, r) => sum + r.balance_centavos, 0);

/** Reservations an administrator can still record a payment against (balance > 0). */
function payableReservations(query = '') {
  const q = clean(query);
  const { rows } = reservations.listReservations({ q: q || undefined }, { all: true });
  return rows.filter((r) => r.balance_centavos > 0).slice(0, 50);
}

module.exports = {
  METHODS,
  LEGACY_METHODS,
  ALL_METHODS,
  METHOD_LABELS,
  methodLabel,
  methodsInUse,
  recordPayment,
  voidPayment,
  getPayment,
  listPayments,
  outstandingBalances,
  totalOutstanding,
  payableReservations,
};
