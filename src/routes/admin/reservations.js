'use strict';

const express = require('express');
const reservations = require('../../services/reservations');
const parking = require('../../services/parking');
const payments = require('../../services/payments');
const penalties = require('../../services/penalties');
const settingsService = require('../../services/settings');
const fees = require('../../services/fees');
const ctx = require('../../db/context');
const time = require('../../utils/time');
const { AppError } = require('../../utils/errors');
const { toInt, clean, oneOf } = require('../../utils/validate');
const { formatPeso } = require('../../utils/money');

const router = express.Router();

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'checked_in', label: 'Checked in' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'no_show', label: 'No-show' },
];
const PAYMENT_OPTIONS = [
  { value: '', label: 'Any payment state' },
  { value: 'unpaid', label: 'Unpaid' },
  { value: 'paid', label: 'Paid' },
  { value: 'no_charge', label: 'No charge' },
];

function isDate(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && time.isValidDate(v);
}

router.get('/', (req, res) => {
  const filters = {
    q: clean(req.query.q),
    status: oneOf(clean(req.query.status), reservations.STATUSES, ''),
    zone: toInt(req.query.zone) || '',
    payment: oneOf(clean(req.query.payment), PAYMENT_OPTIONS.map((o) => o.value).filter(Boolean), ''),
    from: isDate(clean(req.query.from)) ? clean(req.query.from) : '',
    to: isDate(clean(req.query.to)) ? clean(req.query.to) : '',
  };
  const base = { q: filters.q, status: filters.status, zoneId: filters.zone || null, dateFrom: filters.from, dateTo: filters.to, paymentStatus: filters.payment };
  // Three panels, each paged on its own: today and past run most recent first, upcoming runs soonest first.
  const pages = { today: 'tpage', upcoming: 'upage', past: 'ppage' };
  const sorts = { today: 'start_desc', upcoming: 'start_asc', past: 'start_desc' };
  const panels = Object.keys(pages).map((period) => Object.assign(
    { period, pageParam: pages[period] },
    reservations.listReservations(Object.assign({ period, sort: sorts[period] }, base), { page: req.query[pages[period]] }),
  ));
  const baseQuery = Object.assign({}, filters);
  for (const p of panels) baseQuery[p.pageParam] = p.pager.page;
  const zones = parking.listZones();
  res.view('admin/reservations', {
    title: 'Reservations',
    nav: 'reservations',
    panels, filters, baseQuery,
    statusOptions: STATUS_OPTIONS,
    paymentOptions: PAYMENT_OPTIONS,
    zoneOptions: [{ value: '', label: 'All zones' }].concat(zones.map((z) => ({ value: z.id, label: z.name }))),
  });
});

function detailPage(req, reservation, extra = {}) {
  const settings = settingsService.getAll();
  const now = time.nowLocal();
  const session = ctx.get().prepare('SELECT ps.*, cin.full_name AS in_by, cout.full_name AS out_by FROM parking_sessions ps LEFT JOIN users cin ON cin.id = ps.checked_in_by LEFT JOIN users cout ON cout.id = ps.checked_out_by WHERE ps.reservation_id = ?').get(reservation.id);
  const { rows: payRows } = payments.listPayments({ reservationId: reservation.id }, { all: true });
  const canCancel = reservation.status === 'confirmed';
  const canNoShow = reservation.status === 'confirmed' && now >= time.addMinutes(reservation.start_at, settings.late_arrival_grace_minutes);
  const canCheckIn = reservation.status === 'confirmed' && now >= time.addMinutes(reservation.start_at, -settings.checkin_early_minutes) && now < reservation.end_at;
  const canCheckOut = reservation.status === 'checked_in';
  return Object.assign({
    title: `Reservation ${reservation.booking_ref}`,
    nav: 'reservations',
    breadcrumbs: [{ label: 'Reservations', href: '/admin/reservations' }, { label: reservation.booking_ref }],
    r: reservation, session, payRows, rules: settings,
    trail: reservations.auditTrail(reservation.id),
    penaltyCharges: penalties.chargesForReservation(reservation.id),
    canCancel, canNoShow, canCheckIn, canCheckOut,
    canPay: reservation.balance_centavos > 0,
    cancelPreview: canCancel ? reservations.cancellationFeeFor(reservation, now, settings) : 0,
    noShowPreview: reservations.noShowFeeFor(reservation, settings),
    reasonError: null,
  }, extra);
}

router.get('/:id', (req, res) => {
  const reservation = reservations.getReservation(toInt(req.params.id));
  if (!reservation) throw new AppError('Reservation not found.', { status: 404 });
  res.view('admin/reservation-detail', detailPage(req, reservation));
});

router.post('/:id/cancel', (req, res) => {
  const id = toInt(req.params.id);
  try {
    const waive = req.body.waive_fee === '1';
    const result = reservations.cancelReservation(id, req.user, { reason: req.body.reason, waiveFee: waive, actor: req.actor });
    req.flash(
      'success',
      result.fee_final_centavos > 0
        ? `${result.booking_ref} was cancelled. A cancellation fee of ${formatPeso(result.fee_final_centavos)} applies.`
        : `${result.booking_ref} was cancelled with no fee.`,
    );
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    req.flash('error', err.message);
  }
  return res.redirect(`/admin/reservations/${id}`);
});

router.post('/:id/no-show', (req, res) => {
  const id = toInt(req.params.id);
  try {
    const result = reservations.markNoShow(id, req.user);
    req.flash('warning', `${result.booking_ref} was marked as a no-show. Fee assessed: ${formatPeso(result.fee_final_centavos)}.`);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    req.flash('error', err.message);
  }
  return res.redirect(`/admin/reservations/${id}`);
});

module.exports = router;
