'use strict';
const express = require('express');
const { actorOf: actor } = require('../middleware/security');
const T = require('../utils/time');
const v = require('../utils/validate');
const { AppError, ValidationError } = require('../utils/errors');
const users = require('../services/users');
const reservations = require('../services/reservations');
const payments = require('../services/payments');
const catalog = require('../services/catalog');
const avail = require('../services/availability');
const settingsSvc = require('../services/settings');
const { searchAvailability, timeOptions } = require('../services/search');
const { db } = require('../db');

const router = express.Router();
router.use((req, res, next) => { res.locals.nav = 'driver'; next(); });
const page = (req) => Math.max(1, v.toInt(req.query.page, 1));
const msg = (e) => (e instanceof ValidationError ? Object.values(e.fields).join(' ') : e.message);

router.get('/', (req, res) => res.redirect('/driver/dashboard'));

router.get('/dashboard', (req, res) => {
  const uid = req.session.user.id; const now = T.nowIso();
  const upcoming = db.prepare(`${reservations.RES_SELECT} WHERE r.user_id = ? AND r.status = 'confirmed' AND r.end_at > ? ORDER BY r.start_at LIMIT 1`).get(uid, now);
  const active = db.prepare(`${reservations.RES_SELECT} WHERE r.user_id = ? AND r.status = 'active' ORDER BY r.start_at LIMIT 1`).get(uid);
  const recent = db.prepare(`${reservations.RES_SELECT} WHERE r.user_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT 5`).all(uid);
  const out = payments.outstanding({ userId: uid });
  res.page('driver/dashboard', {
    title: 'Dashboard', upcoming: upcoming && reservations.getById(upcoming.id), active: active && reservations.getById(active.id), recent,
    outstanding: out, recentPayments: payments.list({ userId: uid, size: 4 }).rows, vehicleCount: users.listVehicles(uid).length,
    counts: reservations.listForUser(uid, 'upcoming', { size: 1 }).counts,
  });
});

/* --------------------------- find parking --------------------------- */
router.get('/find-parking', (req, res) => {
  const data = searchAvailability(req.query);
  res.page('driver/find-parking', { title: 'Find parking', scripts: ['/js/reservation-form.js', '/js/parking-slots.js'], crumbs: [['Dashboard', '/driver/dashboard'], ['Find parking']], ...data, vehicles: users.listVehicles(req.session.user.id), typeLabel: catalog.TYPE_LABEL });
});
router.get('/find-parking/results', (req, res) => {
  const data = searchAvailability(req.query);
  res.status(data.valid ? 200 : 422).render('partials/slot-results', { ...res.locals, ...data, typeLabel: catalog.TYPE_LABEL });
});

router.get('/reserve', (req, res, next) => {
  const slotId = v.toInt(req.query.slot);
  const form = { date: req.query.date, start: req.query.start, end: req.query.end };
  const back = `/driver/find-parking${require('../utils/view-helpers').qs({ date: form.date, start: form.start, end: form.end })}`;
  const range = avail.validateRange(form);
  if (!range.ok) { req.flash('danger', Object.values(range.errors).join(' ')); return res.redirect(back); }
  const slot = slotId && avail.listSlotAvailability({ startAt: range.startAt, endAt: range.endAt }).find((s) => s.id === slotId);
  if (!slot) { req.flash('danger', 'That slot could not be found. Search again.'); return res.redirect(back); }
  if (!slot.selectable) { req.flash('warning', `Slot ${slot.code} is ${slot.stateText.toLowerCase()} for that time. Pick another slot.`); return res.redirect(back); }
  const all = users.listVehicles(req.session.user.id);
  const vehicles = all.filter((vh) => catalog.COMPATIBLE[vh.vehicle_type].includes(slot.slot_type));
  res.page('driver/reserve', {
    title: 'Confirm reservation', crumbs: [['Dashboard', '/driver/dashboard'], ['Find parking', back], ['Confirm']],
    slot, range, form, vehicles, hasOtherVehicles: all.length > vehicles.length, back, settings: settingsSvc.getAll(), fee: slot.rate * range.hours, typeLabel: catalog.TYPE_LABEL,
  });
});

router.post('/reservations', (req, res) => {
  const { slotId, vehicleId, date, start, end } = req.body;
  const q = require('../utils/view-helpers').qs({ slot: slotId, date, start, end });
  try {
    const ref = reservations.createReservation({ userId: req.session.user.id, vehicleId: v.toInt(vehicleId), slotId: v.toInt(slotId), date, start, end }, actor(req));
    req.flash('success', 'Reservation confirmed.');
    res.redirect(`/driver/reservations/${ref}?new=1`);
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    req.flash('danger', msg(e));
    res.redirect(e.status === 409 && e.code !== 'LIMIT_REACHED' ? `/driver/find-parking${require('../utils/view-helpers').qs({ date, start, end })}` : `/driver/reserve${q}`);
  }
});

/* ----------------------------- reservations ----------------------------- */
router.get('/reservations', (req, res) => {
  const tab = ['upcoming', 'active', 'completed', 'cancelled', 'no-show'].includes(req.query.tab) ? req.query.tab : 'upcoming';
  const data = reservations.listForUser(req.session.user.id, tab, { page: page(req) });
  res.page('driver/reservations', { title: 'My reservations', crumbs: [['Dashboard', '/driver/dashboard'], ['My reservations']], tab, ...data, pageNo: page(req), settings: settingsSvc.getAll() });
});
router.get('/reservations/:ref', (req, res) => {
  const r = reservations.getByReference(req.params.ref, actor(req));
  const settings = settingsSvc.getAll();
  const cutoff = T.addMinutesIso(r.start_at, -settings.cancellation_cutoff_minutes);
  const canChange = r.status === 'confirmed' && T.nowIso() <= cutoff;
  const pays = payments.list({ q: r.reference, userId: req.session.user.id, size: 20 }).rows;
  res.page('driver/reservation-detail', {
    title: r.reference, crumbs: [['Dashboard', '/driver/dashboard'], ['My reservations', '/driver/reservations'], [r.reference]],
    r, settings, cutoff, canChange, pays, isNew: req.query.new === '1', options: timeOptions(settings), minDate: T.todayLocal(), maxDate: T.addDays(T.todayLocal(), settings.advance_booking_days), local: T.localParts(r.start_at), localEnd: T.localParts(r.end_at),
  });
});
router.post('/reservations/:ref/cancel', (req, res) => {
  try { reservations.cancelReservation(req.params.ref, req.body.reason, actor(req)); req.flash('success', 'Reservation cancelled. The slot is open for others again.'); }
  catch (e) { if (!(e instanceof AppError)) throw e; req.flash('danger', msg(e)); }
  res.redirect(`/driver/reservations/${req.params.ref}`);
});
router.post('/reservations/:ref/reschedule', (req, res) => {
  try { reservations.rescheduleReservation(req.params.ref, req.body, actor(req)); req.flash('success', 'Reservation rescheduled.'); }
  catch (e) { if (!(e instanceof AppError)) throw e; req.flash('danger', msg(e)); }
  res.redirect(`/driver/reservations/${req.params.ref}`);
});

/* ------------------------------- payments ------------------------------- */
router.get('/payments', (req, res) => {
  const uid = req.session.user.id;
  res.page('driver/payments', {
    title: 'Payments', crumbs: [['Dashboard', '/driver/dashboard'], ['Payments']], outstanding: payments.outstanding({ userId: uid }), prepay: payments.prepayable(uid),
    history: payments.list({ userId: uid, page: page(req), size: 10 }), pageNo: page(req), methodLabel: payments.METHOD_LABEL,
  });
});
router.get('/payments/:id/receipt', (req, res) => {
  const rc = payments.getReceipt(v.toInt(req.params.id), actor(req));
  res.page('shared/receipt', { title: `Receipt ${rc.payment.receipt_number}`, crumbs: [['Payments', '/driver/payments'], ['Receipt']], ...rc, back: '/driver/payments' });
});

/* ------------------------------- vehicles ------------------------------- */
router.get('/vehicles', (req, res) => res.page('driver/vehicles', { title: 'My vehicles', crumbs: [['Dashboard', '/driver/dashboard'], ['My vehicles']], vehicles: users.listVehicles(req.session.user.id) }));
router.post('/vehicles', (req, res) => {
  try { users.addVehicle(req.session.user.id, req.body, actor(req)); req.flash('success', 'Vehicle added.'); res.redirect('/driver/vehicles'); }
  catch (e) {
    if (!(e instanceof ValidationError)) throw e;
    res.status(422).page('driver/vehicles', { title: 'My vehicles', crumbs: [['Dashboard', '/driver/dashboard'], ['My vehicles']], vehicles: users.listVehicles(req.session.user.id), errors: e.fields, old: req.body });
  }
});
router.get('/vehicles/:id/edit', (req, res) => {
  const vh = users.listVehicles(req.session.user.id).find((x) => x.id === v.toInt(req.params.id));
  if (!vh) throw new AppError('Vehicle not found.', 404, 'NOT_FOUND');
  res.page('driver/vehicle-edit', { title: 'Edit vehicle', crumbs: [['My vehicles', '/driver/vehicles'], ['Edit']], vehicle: vh, old: { plateNumber: vh.plate_number, vehicleType: vh.vehicle_type, makeModel: vh.make_model, color: vh.color } });
});
router.post('/vehicles/:id', (req, res) => {
  try { users.updateVehicle(req.session.user.id, v.toInt(req.params.id), req.body, actor(req)); req.flash('success', 'Vehicle updated.'); res.redirect('/driver/vehicles'); }
  catch (e) {
    if (e instanceof ValidationError) {
      const vh = users.listVehicles(req.session.user.id).find((x) => x.id === v.toInt(req.params.id));
      return res.status(422).page('driver/vehicle-edit', { title: 'Edit vehicle', crumbs: [['My vehicles', '/driver/vehicles'], ['Edit']], vehicle: vh, errors: e.fields, old: req.body });
    }
    if (!(e instanceof AppError)) throw e;
    req.flash('danger', e.message); res.redirect('/driver/vehicles');
  }
});
router.post('/vehicles/:id/delete', (req, res) => {
  try { const r = users.removeVehicle(req.session.user.id, v.toInt(req.params.id), actor(req)); req.flash('success', r === 'deleted' ? 'Vehicle removed.' : 'Vehicle removed from your list. Past bookings keep their record.'); }
  catch (e) { if (!(e instanceof AppError)) throw e; req.flash('danger', e.message); }
  res.redirect('/driver/vehicles');
});

/* ------------------------------- profile ------------------------------- */
const profileView = (req, res, extra = {}) => {
  const u = users.getById(req.session.user.id);
  res.page('driver/profile', { title: 'Profile', crumbs: [['Dashboard', '/driver/dashboard'], ['Profile']], profile: u, old: { name: u.name, phone: u.phone, universityId: u.university_id }, ...extra });
};
router.get('/profile', (req, res) => profileView(req, res));
router.post('/profile', (req, res) => {
  try { const u = users.updateProfile(req.session.user.id, req.body, actor(req)); req.session.user.name = u.name; req.flash('success', 'Profile saved.'); res.redirect('/driver/profile'); }
  catch (e) { if (!(e instanceof ValidationError)) throw e; res.status(422); profileView(req, res, { errors: e.fields, old: req.body }); }
});
router.post('/profile/password', async (req, res) => {
  try { await users.changePassword(req.session.user.id, req.body.currentPassword, req.body.newPassword, req.body.confirmPassword, actor(req)); req.flash('success', 'Password changed.'); res.redirect('/driver/profile'); }
  catch (e) { if (!(e instanceof ValidationError)) throw e; res.status(422); profileView(req, res, { pwErrors: e.fields }); }
});

module.exports = router;
