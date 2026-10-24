'use strict';

const express = require('express');
const payments = require('../../services/payments');
const reservations = require('../../services/reservations');
const time = require('../../utils/time');
const { AppError } = require('../../utils/errors');
const { toInt, clean, oneOf } = require('../../utils/validate');
const { formatPeso } = require('../../utils/money');

const router = express.Router();

function isDate(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && time.isValidDate(v);
}

router.get('/', (req, res) => {
  // Only paid bookings with a valid receipt are listed; voided receipts stay on their booking's record.
  const filters = {
    q: clean(req.query.q),
    method: oneOf(clean(req.query.method), payments.ALL_METHODS, ''),
    from: isDate(clean(req.query.from)) ? clean(req.query.from) : '',
    to: isDate(clean(req.query.to)) ? clean(req.query.to) : '',
  };
  const { rows, pager } = payments.listPayments(
    { q: filters.q, status: 'valid', method: filters.method, dateFrom: filters.from, dateTo: filters.to },
    { page: req.query.page, perPage: 15 },
  );
  const today = time.todayLocal();
  const todayTotal = payments.listPayments({ status: 'valid', dateFrom: today, dateTo: today }, { all: true }).rows.reduce((a, p) => a + p.amount_centavos, 0);
  res.view('admin/payments', {
    title: 'Payments',
    nav: 'payments',
    rows, pager, filters, baseQuery: filters,
    // Older non-cash records can still be found; the filter only offers methods that actually appear.
    methodOptions: [{ value: '', label: 'Any method' }].concat(payments.methodsInUse().map((m) => ({ value: m, label: payments.methodLabel(m) }))),
    todayTotal,
  });
});

function formPage(req, { values = {}, errors = {}, formError = null, selected = null } = {}) {
  const q = clean(req.query.q);
  const reservation = selected || (toInt(values.reservation_id) ? reservations.getReservation(toInt(values.reservation_id)) : null);
  return {
    title: 'Record Payment',
    nav: 'payments',
    breadcrumbs: [{ label: 'Payments', href: '/admin/payments' }, { label: 'Record payment' }],
    q,
    candidates: reservation ? [] : payments.payableReservations(q),
    reservation,
    values: Object.assign({}, values, reservation && !values.amount ? { amount: (Math.max(0, reservation.balance_centavos) / 100).toFixed(2) } : {}),
    errors,
    formError,
  };
}

router.get('/new', (req, res) => {
  const id = toInt(req.query.reservation_id);
  const reservation = id ? reservations.getReservation(id) : null;
  res.view('admin/payment-form', formPage(req, { values: reservation ? { reservation_id: reservation.id } : {}, selected: reservation }));
});

router.post('/', (req, res) => {
  try {
    const p = payments.recordPayment(req.body || {}, req.user);
    req.flash('success', `Payment of ${formatPeso(p.amount_centavos)} recorded (receipt ${p.receipt_no}).`);
    return res.redirect(`/admin/payments/${p.id}/receipt`);
  } catch (err) {
    if (err instanceof AppError && err.fields) {
      return res.status(422).view('admin/payment-form', formPage(req, { values: req.body, errors: err.fields, formError: err.message }));
    }
    throw err;
  }
});

router.get('/:id/receipt', (req, res) => {
  const payment = payments.getPayment(toInt(req.params.id));
  if (!payment) throw new AppError('Receipt not found.', { status: 404 });
  res.view('receipts/receipt', {
    title: `Receipt ${payment.receipt_no}`,
    nav: 'payments',
    payment,
    backHref: '/admin/payments',
    voidable: payment.status === 'valid',
    breadcrumbs: [{ label: 'Payments', href: '/admin/payments' }, { label: payment.receipt_no }],
  });
});

router.post('/:id/void', (req, res) => {
  const id = toInt(req.params.id);
  try {
    const p = payments.voidPayment(id, req.user, req.body.reason);
    req.flash('warning', `Receipt ${p.receipt_no} was voided. The booking balance has been restored.`);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    req.flash('error', err.message);
  }
  return res.redirect(`/admin/payments/${id}/receipt`);
});

module.exports = router;
