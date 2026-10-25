'use strict';

const express = require('express');
const util = require('util');
const settingsService = require('../services/settings');
const availability = require('../services/availability');
const parking = require('../services/parking');
const reservations = require('../services/reservations');
const payments = require('../services/payments');
const dashboard = require('../services/dashboard');
const users = require('../services/users');
const fees = require('../services/fees');
const notifications = require('../services/notifications');
const vehicleCatalog = require('../../public/js/vehicle-catalog');
const ctx = require('../db/context');
const time = require('../utils/time');
const { AppError } = require('../utils/errors');
const { clean, toInt } = require('../utils/validate');
const { formatPeso } = require('../utils/money');

const router = express.Router();

const VEHICLE_TYPE_OPTIONS = [
  { value: '', label: 'Any vehicle' },
  { value: 'car', label: 'Car' },
  { value: 'motorcycle', label: 'Motorcycle' },
];

// Sidebar badges (My Reservations, Payments) and the unread records highlighted on those pages.
router.use(notifications.middleware);

// Polled by public/js/app.js so the badges update while a page stays open.
router.get('/notifications', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(res.locals.navBadges);
});

// ---------------------------------------------------------------- dashboard

router.get('/', (req, res) => {
  const data = dashboard.driverDashboard(req.user.id);
  const vehicles = users.listVehicles(req.user.id);
  res.view('driver/dashboard', { title: 'Dashboard', nav: 'dashboard', data, vehicles, hour: Number(time.nowLocal().slice(11, 13)) });
});

// ------------------------------------------------------------- find parking

/**
 * The zone to show: the one asked for, unless none of its slots fit the chosen vehicle (e.g. a motorcycle in Main
 * Building, which has no motorcycle bays); then the first zone that has free fitting slots.
 */
function pickZone(zones, requestedId, avail) {
  const requested = zones.find((z) => z.id === requestedId);
  if (requested && (!avail || requested.compatible > 0)) return requested;
  if (avail) return zones.find((z) => z.available > 0) || zones.find((z) => z.compatible > 0) || requested || zones[0] || null;
  return requested || zones[0] || null;
}

router.get('/find-parking', async (req, res, next) => {
  try {
    const settings = settingsService.getAll();
    const vehicles = users.listVehicles(req.user.id);
    const search = availability.parseSearch(req.query, settings);
    // The vehicle drawn into the chosen slot: the one asked for, else the first that matches the vehicle-type filter.
    const askedVehicle = vehicles.find((v) => String(v.id) === String(req.query.vehicle_id || ''));
    if (req.query.vehicle_type === undefined && (askedVehicle || vehicles.length)) search.vehicleType = (askedVehicle || vehicles[0]).vehicle_type;
    const vehicle = askedVehicle || vehicles.find((v) => v.vehicle_type === search.vehicleType) || (search.vehicleType ? null : vehicles[0]) || null;

    const range = availability.validateRange(search, settings);
    const avail = range.ok
      ? availability.getAvailability({ startAt: range.startAt, endAt: range.endAt, vehicleType: search.vehicleType, userId: req.user.id })
      : null;
    const zones = avail
      ? avail.zones
      : parking.listZones({ includeInactive: false }).map((z) => ({ id: z.id, code: z.code, name: z.name, map_columns: z.map_columns, total: z.active_slot_count, available: null }));
    const zone = pickZone(zones, search.zoneId, avail);
    // Every slot of the zone stays on the map with its real state; one that does not fit the chosen vehicle type is
    // shown (unavailable, unless it is reserved or occupied) but cannot be selected.
    const slots = avail && zone ? avail.slots.filter((s) => s.zone_id === zone.id) : [];
    const emptyText = null;
    const selected = slots.find((s) => s.id === search.slotId && s.state === 'available');
    const selectedSlotId = selected ? selected.id : null;
    const counts = {
      available: slots.filter((s) => s.state === 'available').length,
      reserved: slots.filter((s) => s.state === 'reserved').length,
      occupied: slots.filter((s) => s.state === 'occupied').length,
      unavailable: slots.filter((s) => s.state === 'unavailable').length,
    };

    if (req.query.fragment === '1') {
      if (!range.ok) return res.status(422).json({ ok: false, errors: range.errors, fields: range.fields });
      if (!zone) return res.json({ ok: true, zoneId: null, zones: [], mapHtml: '<p class="text-muted">No parking zones are available.</p>', selectedSlotId: null, counts });
      const render = util.promisify(req.app.render.bind(req.app));
      const mapHtml = await render('partials/parking-map', Object.assign({}, res.locals, { zone, slots, selectedSlotId, emptyText }));
      return res.json({
        ok: true,
        zoneId: zone.id,
        zones: zones.map((z) => ({ id: z.id, available: z.available, total: z.total })),
        mapHtml,
        selectedSlotId,
        counts,
        durationMinutes: range.durationMinutes,
      });
    }

    const nowStr = time.nowLocal();
    const options = availability.timeOptions(settings);
    const config = {
      step: settings.time_step_minutes,
      open: settings.open_time,
      close: settings.close_time,
      minDuration: settings.min_duration_minutes,
      maxDuration: settings.max_duration_minutes,
      increment: settings.billing_increment_minutes,
      maxAdvanceDays: settings.max_advance_days,
      today: nowStr.slice(0, 10),
      maxDate: time.addDays(nowStr, settings.max_advance_days).slice(0, 10),
      nowMinutes: time.minutesOfDay(nowStr.slice(11, 16)),
      fragmentUrl: '/driver/find-parking',
      selectedSlotId,
      zoneId: zone ? zone.id : null,
      searchedKey: range.ok ? [search.date, search.start, search.end, search.vehicleType].join('|') : '',
      vehicleId: vehicle ? vehicle.id : null,
      vehicles: vehicles.map((v) => ({ id: v.id, plate_number: v.plate_number, vehicle_type: v.vehicle_type, make: v.make, model: v.model, color: v.color })),
    };

    return res.view('driver/find-parking', {
      title: 'Find a Parking Slot',
      nav: 'find-parking',
      breadcrumbs: [{ label: 'Dashboard', href: '/driver' }, { label: 'Find Parking' }],
      search, range, zones, zone, slots, counts, selectedSlotId, vehicles, vehicle, options, config, emptyText,
      vehicleTypeOptions: VEHICLE_TYPE_OPTIONS,
      minDate: config.today,
      maxDate: config.maxDate,
      rules: settings,
      extraScripts: ['/js/reservation-form.js', '/js/vehicle-art.js', '/js/parking-slots.js'],
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------- reserve (confirm)

function searchParamsFrom(src) {
  return {
    date: clean(src.date), start: clean(src.start), end: clean(src.end),
    vehicle_type: clean(src.vehicle_type), slot_id: clean(src.slot_id), vehicle_id: clean(src.vehicle_id),
  };
}

function backToSearch(params, slotId) {
  const q = new URLSearchParams({ date: params.date, start: params.start, end: params.end, vehicle_type: params.vehicle_type || '' });
  const slot = parking.getSlot(slotId);
  if (slot) q.set('zone_id', String(slot.zone_id));
  if (params.vehicle_id) q.set('vehicle_id', params.vehicle_id);
  q.set('slot_id', String(slotId));
  return `/driver/find-parking?${q.toString()}`;
}

function buildReservePage(req, { slotId, params, values = {}, errors = {}, formError = null }) {
  const settings = settingsService.getAll();
  const range = availability.validateRange(params, settings);
  if (!range.ok) throw new AppError(range.errors[0], { code: 'VALIDATION' });
  const slot = parking.getSlot(slotId);
  if (!slot) throw new AppError('That parking slot does not exist.', { status: 404 });
  const avail = availability.getAvailability({ startAt: range.startAt, endAt: range.endAt, userId: req.user.id });
  const live = avail.slots.find((s) => s.id === slot.id);
  const vehicles = users.listVehicles(req.user.id).filter((v) => parking.vehicleFitsSlotType(slot.type_vehicle, v.vehicle_type));
  return {
    title: 'Confirm Reservation',
    nav: 'find-parking',
    breadcrumbs: [{ label: 'Dashboard', href: '/driver' }, { label: 'Find Parking', href: backToSearch(params, slot.id) }, { label: 'Confirm' }],
    slot, range, live, vehicles,
    fee: fees.estimatedFee(slot.hourly_rate_centavos, range.durationMinutes, settings),
    policy: fees.cancellationPolicyText(settings),
    values, errors, formError,
    params,
    backHref: backToSearch(params, slot.id),
    allVehicles: users.listVehicles(req.user.id).length,
  };
}

router.get('/reserve', (req, res) => {
  const params = searchParamsFrom(req.query);
  const slotId = toInt(params.slot_id);
  try {
    const page = buildReservePage(req, { slotId, params, values: { vehicle_id: params.vehicle_id } });
    if (page.live.state !== 'available') {
      req.flash('error', `Slot ${page.slot.slot_code} is no longer available for that time (${page.live.reason.toLowerCase()}). Please pick another slot.`);
      return res.redirect(backToSearch(params, slotId));
    }
    return res.view('driver/reserve', page);
  } catch (err) {
    if (err instanceof AppError) {
      req.flash('error', err.message);
      return res.redirect('/driver/find-parking');
    }
    throw err;
  }
});

router.post('/reserve', (req, res) => {
  const body = req.body || {};
  const params = searchParamsFrom(body);
  const slotId = toInt(body.slot_id);
  try {
    const created = reservations.createReservation(
      { userId: req.user.id, vehicleId: toInt(body.vehicle_id), slotId, date: params.date, start: params.start, end: params.end },
      req.actor,
    );
    req.session.justBooked = created.id;
    return res.redirect(`/driver/reservations/${created.id}`);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    if (['CONFLICT', 'SLOT_NOT_ACTIVE', 'NOT_FOUND', 'VEHICLE_CLASH'].includes(err.code) || (err.code === 'VALIDATION' && !(err.fields && err.fields.vehicle_id))) {
      req.flash('error', err.message);
      return res.redirect(slotId ? backToSearch(params, slotId) : '/driver/find-parking');
    }
    try {
      const page = buildReservePage(req, { slotId, params, values: body, errors: err.fields || {}, formError: err.message });
      return res.status(422).view('driver/reserve', page);
    } catch (inner) {
      req.flash('error', err.message);
      return res.redirect('/driver/find-parking');
    }
  }
});

// ------------------------------------------------------------ my reservations

router.get('/reservations', (req, res) => {
  const counts = reservations.countByTab(req.user.id);
  const tab = Object.keys(reservations.DRIVER_TABS).concat(['all']).includes(req.query.tab) ? req.query.tab : 'upcoming';
  const { rows, pager } = reservations.listReservations(
    { userId: req.user.id, tab: tab === 'all' ? undefined : tab },
    { page: req.query.page, perPage: 10 },
  );
  res.view('driver/reservations', {
    title: 'My Reservations', nav: 'reservations', tab, counts, rows, pager,
    policy: fees.cancellationPolicyText(settingsService.getAll()),
  });
});

function reservationPage(req, res, reservation, extra = {}) {
  const settings = settingsService.getAll();
  const now = time.nowLocal();
  const hoursBefore = time.diffMinutes(reservation.start_at, now) / 60;
  const canCancel = reservation.status === 'confirmed' && reservation.start_at > now;
  const canReschedule = reservation.status === 'confirmed' && hoursBefore >= settings.cancel_free_hours;
  const session = ctx.get().prepare('SELECT * FROM parking_sessions WHERE reservation_id = ?').get(reservation.id);
  const { rows: payRows } = payments.listPayments({ reservationId: reservation.id }, { all: true });
  const justBooked = req.session.justBooked === reservation.id;
  if (justBooked) delete req.session.justBooked;
  return {
    title: `Reservation ${reservation.booking_ref}`,
    nav: 'reservations',
    breadcrumbs: [{ label: 'Dashboard', href: '/driver' }, { label: 'My Reservations', href: '/driver/reservations' }, { label: reservation.booking_ref }],
    r: reservation, session, payRows, rules: settings, canCancel, canReschedule, justBooked,
    cancelFee: canCancel ? reservations.cancellationFeeFor(reservation, now, settings) : 0,
    policy: fees.cancellationPolicyText(settings),
    options: availability.timeOptions(settings),
    minDate: now.slice(0, 10),
    resched: { date: reservation.start_at.slice(0, 10), start: reservation.start_at.slice(11, 16), end: reservation.end_at.slice(11, 16) },
    reschedError: null,
    extraScripts: ['/js/reservation-form.js'],
    ...extra,
  };
}

router.get('/reservations/:id', (req, res) => {
  const reservation = reservations.assertCanAccess(reservations.getReservation(toInt(req.params.id)), req.user);
  res.view('driver/reservation-detail', reservationPage(req, res, reservation));
});

router.post('/reservations/:id/cancel', (req, res) => {
  const id = toInt(req.params.id);
  try {
    const result = reservations.cancelReservation(id, req.user, { actor: req.actor });
    req.flash(
      result.fee_final_centavos > 0 ? 'warning' : 'success',
      result.fee_final_centavos > 0
        ? `Reservation ${result.booking_ref} was cancelled. A late-cancellation fee of ${formatPeso(result.fee_final_centavos)} applies.`
        : `Reservation ${result.booking_ref} was cancelled at no charge.`,
    );
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    req.flash('error', err.message);
  }
  return res.redirect(`/driver/reservations/${id}`);
});

router.post('/reservations/:id/reschedule', (req, res) => {
  const id = toInt(req.params.id);
  const body = req.body || {};
  try {
    const result = reservations.rescheduleReservation(id, req.user, { date: clean(body.date), start: clean(body.start), end: clean(body.end) }, req.actor);
    req.flash('success', `Reservation ${result.booking_ref} moved to ${time.fmtDate(result.start_at)}, ${time.fmtTime(result.start_at)} – ${time.fmtTime(result.end_at)}.`);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    req.flash('error', err.message);
  }
  return res.redirect(`/driver/reservations/${id}`);
});

// ------------------------------------------------------------------ payments

router.get('/payments', (req, res) => {
  const db = ctx.get();
  const { rows, pager } = payments.listPayments({ userId: req.user.id }, { page: req.query.page, perPage: 10 });
  const outstanding = payments.outstandingBalances({ userId: req.user.id });
  const totalPaid = db.prepare(`SELECT COALESCE(SUM(amount_centavos), 0) AS t FROM payments WHERE user_id = ? AND status = 'valid'`).get(req.user.id).t;
  const upcoming = reservations
    .listReservations({ userId: req.user.id, tab: 'upcoming' }, { all: true })
    .rows.filter((r) => r.balance_centavos > 0);
  res.view('driver/payments', {
    title: 'Payments', nav: 'payments', rows, pager, outstanding, upcoming, totalPaid,
    totalOutstanding: outstanding.reduce((a, r) => a + r.balance_centavos, 0),
    pendingEstimates: upcoming.reduce((a, r) => a + r.balance_centavos, 0),
  });
});

router.get('/payments/:id/receipt', (req, res) => {
  const payment = payments.getPayment(toInt(req.params.id));
  if (!payment || payment.user_id !== req.user.id) throw new AppError('Receipt not found.', { status: 404 });
  res.view('receipts/receipt', {
    title: `Receipt ${payment.receipt_no}`, nav: 'payments', payment, backHref: '/driver/payments',
    breadcrumbs: [{ label: 'Payments', href: '/driver/payments' }, { label: payment.receipt_no }],
  });
});

// ------------------------------------------------------------------ vehicles

function vehiclesPage(req, { values = {}, errors = {}, formError = null, editing = null } = {}) {
  return {
    title: editing ? 'Edit Vehicle' : 'My Vehicles', nav: 'vehicles',
    breadcrumbs: editing ? [{ label: 'My Vehicles', href: '/driver/vehicles' }, { label: 'Edit' }] : [],
    vehicles: users.listVehicles(req.user.id), values, errors, formError, editing,
    typeOptions: [{ value: 'car', label: 'Car' }, { value: 'motorcycle', label: 'Motorcycle' }],
    vehicleCatalog,
    extraScripts: ['/js/vehicle-catalog.js', '/js/vehicle-form.js'],
  };
}

router.get('/vehicles', (req, res) => res.view('driver/vehicles', vehiclesPage(req, { values: { vehicle_type: 'car' } })));

router.post('/vehicles', (req, res) => {
  try {
    const v = users.addVehicle(req.user.id, req.body || {}, req.actor);
    req.flash('success', `${v.plate_number} was added to your vehicles.`);
    return res.redirect(req.body.next === 'find' ? '/driver/find-parking' : '/driver/vehicles');
  } catch (err) {
    if (err instanceof AppError && err.fields) return res.status(422).view('driver/vehicles', vehiclesPage(req, { values: req.body, errors: err.fields }));
    throw err;
  }
});

router.get('/vehicles/:id/edit', (req, res) => {
  const v = users.getVehicle(toInt(req.params.id));
  if (!v || v.user_id !== req.user.id) throw new AppError('Vehicle not found.', { status: 404 });
  res.view('driver/vehicles', vehiclesPage(req, { values: v, editing: v }));
});

router.post('/vehicles/:id', (req, res) => {
  const id = toInt(req.params.id);
  try {
    users.updateVehicle(req.user.id, id, req.body || {}, req.actor);
    req.flash('success', 'Vehicle updated.');
    return res.redirect('/driver/vehicles');
  } catch (err) {
    if (err instanceof AppError && err.fields) return res.status(422).view('driver/vehicles', vehiclesPage(req, { values: req.body, errors: err.fields, editing: users.getVehicle(id) }));
    if (err instanceof AppError && err.status === 404) throw err; // someone else's vehicle: look like any missing page
    if (err instanceof AppError) {
      req.flash('error', err.message);
      return res.redirect(`/driver/vehicles/${id}/edit`);
    }
    throw err;
  }
});

router.post('/vehicles/:id/delete', (req, res) => {
  try {
    const r = users.removeVehicle(req.user.id, toInt(req.params.id), req.actor);
    req.flash('success', r.archived ? 'Vehicle removed. Its past reservation history is kept.' : 'Vehicle deleted.');
  } catch (err) {
    if (!(err instanceof AppError) || err.status === 404) throw err;
    req.flash('error', err.message);
  }
  return res.redirect('/driver/vehicles');
});

// ------------------------------------------------------------------- profile

router.get('/profile', (req, res) => {
  res.view('driver/profile', { title: 'Profile', nav: 'profile', values: req.user, errors: {}, pwErrors: {}, formError: null });
});

router.post('/profile', (req, res) => {
  try {
    users.updateOwnProfile(req.user.id, req.body || {}, req.actor);
    req.flash('success', 'Profile updated.');
    return res.redirect('/driver/profile');
  } catch (err) {
    if (err instanceof AppError && err.fields) {
      return res.status(422).view('driver/profile', { title: 'Profile', nav: 'profile', values: req.body, errors: err.fields, pwErrors: {}, formError: null });
    }
    throw err;
  }
});

router.post('/profile/password', (req, res) => {
  try {
    users.changePassword(req.user.id, req.body || {}, req.actor);
    req.flash('success', 'Password changed.');
    return res.redirect('/driver/profile');
  } catch (err) {
    if (err instanceof AppError && err.fields) {
      return res.status(422).view('driver/profile', { title: 'Profile', nav: 'profile', values: req.user, errors: {}, pwErrors: err.fields, formError: null });
    }
    throw err;
  }
});

module.exports = router;
