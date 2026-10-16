'use strict';
const express = require('express');
const { actorOf: actor } = require('../middleware/security');
const H = require('../utils/view-helpers');
const T = require('../utils/time');
const v = require('../utils/validate');
const { AppError, ValidationError } = require('../utils/errors');
const users = require('../services/users');
const catalog = require('../services/catalog');
const reservations = require('../services/reservations');
const parking = require('../services/parking');
const payments = require('../services/payments');
const reports = require('../services/reports');
const settingsSvc = require('../services/settings');
const audit = require('../services/audit');
const { db } = require('../db');

const CHART_JS = ['/vendor/chartjs/chart.umd.js', '/js/charts.js'];
const router = express.Router();
router.use((req, res, next) => { res.locals.nav = 'admin'; next(); });
const page = (req) => Math.max(1, v.toInt(req.query.page, 1));
const msg = (e) => (e instanceof ValidationError ? Object.values(e.fields).join(' ') : e.message);
const str = (x) => (typeof x === 'string' ? x.trim() : '');
const back = (req, fallback) => { const r = req.get('referer'); try { const u = new URL(r); return u.pathname + u.search; } catch { return fallback; } };
/** Run a mutation; flash success or the error message, then redirect. */
const act = (fn, ok, to) => async (req, res) => {
  try { const r = await fn(req); req.flash('success', typeof ok === 'function' ? ok(r, req) : ok); }
  catch (e) { if (!(e instanceof AppError)) throw e; req.flash('danger', msg(e)); }
  res.redirect(typeof to === 'function' ? to(req) : to);
};

router.get('/', (req, res) => res.redirect('/admin/dashboard'));

router.get('/dashboard', (req, res) => {
  const d = reports.dashboard();
  res.page('admin/dashboard', { title: 'Dashboard', scripts: CHART_JS, ...d, overdue: reservations.overdueCount(), sessions: parking.activeSessions().length, now: T.nowIso() });
});

/* ------------------------- zones, slots and rates ------------------------- */
const slotTabs = (req) => ({ zones: catalog.listZones(), types: catalog.SLOT_TYPES, statuses: catalog.SLOT_STATUSES, typeLabel: catalog.TYPE_LABEL, rates: catalog.listRates() });

router.get('/slots', (req, res) => {
  const f = { q: str(req.query.q), zoneId: req.query.zone || '', status: str(req.query.status), type: str(req.query.type) };
  const { rows, total } = catalog.listSlots({ ...f, page: page(req) });
  res.page('admin/slots', { title: 'Parking slots', tab: 'slots', f, rows, pg: H.paginate(total, page(req), 20), query: req.query, ...slotTabs(req) });
});
router.post('/slots', (req, res) => {
  try { catalog.createSlot(req.body, actor(req)); req.flash('success', 'Slot added.'); res.redirect('/admin/slots'); }
  catch (e) { if (!(e instanceof ValidationError)) { if (e instanceof AppError) { req.flash('danger', e.message); return res.redirect('/admin/slots'); } throw e; }
    const { rows, total } = catalog.listSlots({ page: 1 });
    res.status(422).page('admin/slots', { title: 'Parking slots', tab: 'slots', f: {}, rows, pg: H.paginate(total, 1, 20), query: {}, errors: e.fields, old: req.body, openForm: 'single', ...slotTabs(req) }); }
});
router.post('/slots/bulk', (req, res) => {
  try { const n = catalog.bulkCreateSlots(req.body, actor(req)); req.flash('success', `${n} slots added.`); res.redirect('/admin/slots'); }
  catch (e) { if (!(e instanceof ValidationError)) throw e;
    const { rows, total } = catalog.listSlots({ page: 1 });
    res.status(422).page('admin/slots', { title: 'Parking slots', tab: 'slots', f: {}, rows, pg: H.paginate(total, 1, 20), query: {}, errors: e.fields, old: req.body, openForm: 'bulk', ...slotTabs(req) }); }
});
router.get('/slots/:id/edit', (req, res) => {
  const slot = catalog.getSlot(v.toInt(req.params.id));
  if (!slot) throw new AppError('Slot not found.', 404, 'NOT_FOUND');
  res.page('admin/slot-edit', { title: `Edit ${slot.code}`, crumbs: [['Parking slots', '/admin/slots'], [slot.code]], slot, old: { code: slot.code, slotType: slot.slot_type, status: slot.status, notes: slot.notes }, ...slotTabs(req) });
});
router.post('/slots/:id', (req, res) => {
  const id = v.toInt(req.params.id);
  try { catalog.updateSlot(id, req.body, actor(req)); req.flash('success', 'Slot updated.'); res.redirect('/admin/slots'); }
  catch (e) {
    if (e instanceof ValidationError) { res.status(422); return res.page('admin/slot-edit', { title: 'Edit slot', crumbs: [['Parking slots', '/admin/slots'], ['Edit']], slot: catalog.getSlot(id), errors: e.fields, old: req.body, ...slotTabs(req) }); }
    if (!(e instanceof AppError)) throw e;
    req.flash('danger', e.message); res.redirect(`/admin/slots/${id}/edit`);
  }
});
router.post('/slots/:id/delete', act((req) => catalog.deleteSlot(v.toInt(req.params.id), actor(req)), 'Slot deleted.', '/admin/slots'));

router.get('/zones', (req, res) => res.page('admin/zones', { title: 'Parking zones', tab: 'zones', ...slotTabs(req) }));
router.post('/zones', (req, res) => {
  try { catalog.createZone(req.body, actor(req)); req.flash('success', 'Zone added.'); res.redirect('/admin/zones'); }
  catch (e) { if (!(e instanceof ValidationError)) throw e; res.status(422).page('admin/zones', { title: 'Parking zones', tab: 'zones', errors: e.fields, old: req.body, ...slotTabs(req) }); }
});
router.get('/zones/:id/edit', (req, res) => {
  const zone = catalog.getZone(v.toInt(req.params.id));
  if (!zone) throw new AppError('Zone not found.', 404, 'NOT_FOUND');
  res.page('admin/zone-edit', { title: `Edit ${zone.name}`, crumbs: [['Parking zones', '/admin/zones'], [zone.name]], zone, old: { name: zone.name, description: zone.description, mapColumns: zone.map_columns, isActive: zone.is_active ? '1' : '' } });
});
router.post('/zones/:id', (req, res) => {
  const id = v.toInt(req.params.id);
  try { catalog.updateZone(id, req.body, actor(req)); req.flash('success', 'Zone updated.'); res.redirect('/admin/zones'); }
  catch (e) {
    if (e instanceof ValidationError) { res.status(422); return res.page('admin/zone-edit', { title: 'Edit zone', crumbs: [['Parking zones', '/admin/zones'], ['Edit']], zone: catalog.getZone(id), errors: e.fields, old: req.body }); }
    if (!(e instanceof AppError)) throw e;
    req.flash('danger', e.message); res.redirect(`/admin/zones/${id}/edit`);
  }
});
router.post('/zones/:id/delete', act((req) => catalog.deleteZone(v.toInt(req.params.id), actor(req)), 'Zone deleted.', '/admin/zones'));

/* ------------------------------ reservations ------------------------------ */
router.get('/reservations', (req, res) => {
  const f = { q: str(req.query.q), status: str(req.query.status), zoneId: req.query.zone || '', dateFrom: str(req.query.from), dateTo: str(req.query.to) };
  const { rows, total } = reservations.search({ ...f, page: page(req) });
  res.page('admin/reservations', { title: 'Reservations', f, rows, pg: H.paginate(total, page(req), 15), query: req.query, zones: catalog.listZones(), overdue: reservations.overdueCount() });
});
router.post('/reservations/no-show/sweep', act((req) => reservations.markAllOverdueNoShows(actor(req)), (n) => (n ? `${n} overdue reservation${n > 1 ? 's' : ''} marked as no-show.` : 'No overdue reservations to update.'), '/admin/reservations'));
router.get('/reservations/:ref', (req, res) => {
  const r = reservations.getByReference(req.params.ref, actor(req));
  const settings = settingsSvc.getAll();
  const noShowFrom = T.addMinutesIso(r.start_at, settings.no_show_after_minutes);
  res.page('admin/reservation-detail', {
    title: r.reference, crumbs: [['Reservations', '/admin/reservations'], [r.reference]], r, settings, pays: payments.list({ q: r.reference, size: 50 }).rows.filter((p) => p.reservation_id === r.id),
    canNoShow: r.status === 'confirmed' && T.nowIso() >= noShowFrom, noShowFrom, history: audit.list({ q: `"reference":"${r.reference}"`, size: 20 }).rows,
  });
});
router.post('/reservations/:ref/cancel', act((req) => reservations.cancelReservation(req.params.ref, req.body.reason, actor(req)), 'Reservation cancelled and the slot released.', (req) => `/admin/reservations/${req.params.ref}`));
router.post('/reservations/:ref/no-show', act((req) => reservations.markNoShow(req.params.ref, actor(req)), 'Marked as no-show.', (req) => `/admin/reservations/${req.params.ref}`));

/* ------------------------- check-in / check-out ------------------------- */
router.get('/operations', (req, res) => {
  const q = str(req.query.q);
  res.page('admin/operations', { title: 'Check-in / Check-out', q, results: q ? parking.lookup(q) : [], sessions: parking.activeSessions(), arrivals: parking.expectedArrivals(), settings: settingsSvc.getAll() });
});
router.post('/operations/check-in', (req, res) => {
  try {
    const r = parking.checkIn(req.body.reference, actor(req));
    req.flash(r.isLate ? 'warning' : 'success', r.isLate ? `Checked in ${r.reference}. Flagged as a late arrival (${T.fmtDuration(r.lateMinutes)} after the start).` : `Checked in ${r.reference}.`);
  } catch (e) { if (!(e instanceof AppError)) throw e; req.flash('danger', e.message); }
  res.redirect('/admin/operations');
});
router.post('/operations/check-out', (req, res) => {
  try {
    const r = parking.checkOut(v.toInt(req.body.sessionId), actor(req));
    req.flash(r.isOverstay ? 'warning' : 'success', `Checked out ${r.reference}. Final fee ${H.pesos(r.fee)}${r.isOverstay ? ` including ${r.overstayHours} overstay hour${r.overstayHours > 1 ? 's' : ''}` : ''}. Record the payment under Payments.`);
  } catch (e) { if (!(e instanceof AppError)) throw e; req.flash('danger', e.message); }
  res.redirect('/admin/operations');
});

/* ------------------------------- payments ------------------------------- */
const paymentsPage = (req, res, extra = {}) => {
  const f = { q: str(req.query.q), status: str(req.query.status), method: str(req.query.method), dateFrom: str(req.query.from), dateTo: str(req.query.to) };
  const { rows, total } = payments.list({ ...f, page: page(req) });
  const prefill = str(req.query.ref).toUpperCase();
  const target = prefill && db.prepare(`${reservations.RES_SELECT} WHERE r.reference = ?`).get(prefill);
  res.page('admin/payments', { title: 'Payments', f, rows, pg: H.paginate(total, page(req), 15), query: req.query, outstanding: payments.outstanding({ limit: 8 }), methods: payments.METHODS, methodLabel: payments.METHOD_LABEL,
    old: { reservationRef: prefill }, target: target && reservations.getById(target.id), ...extra });
};
router.get('/payments', (req, res) => paymentsPage(req, res));
router.post('/payments', (req, res) => {
  try { const p = payments.recordPayment(req.body, actor(req)); req.flash('success', `Payment recorded. Receipt ${p.receipt}.`); res.redirect(`/admin/payments/${p.id}/receipt`); }
  catch (e) { if (!(e instanceof ValidationError)) throw e; res.status(422); paymentsPage(req, res, { errors: e.fields, old: req.body }); }
});
router.post('/payments/:id/void', act((req) => payments.voidPayment(v.toInt(req.params.id), req.body.reason, actor(req)), (n) => `Payment ${n} voided.`, (req) => back(req, '/admin/payments')));
router.get('/payments/:id/receipt', (req, res) => {
  const rc = payments.getReceipt(v.toInt(req.params.id), actor(req));
  res.page('shared/receipt', { title: `Receipt ${rc.payment.receipt_number}`, crumbs: [['Payments', '/admin/payments'], ['Receipt']], ...rc, back: '/admin/payments' });
});

/* -------------------------------- drivers -------------------------------- */
router.get('/drivers', (req, res) => {
  const f = { q: str(req.query.q), role: str(req.query.role), status: str(req.query.status) };
  const { rows, total } = users.listUsers({ ...f, page: page(req) });
  res.page('admin/drivers', { title: 'Drivers', f, rows, pg: H.paginate(total, page(req), 15), query: req.query });
});
router.get('/drivers/new', (req, res) => res.page('admin/driver-new', { title: 'Add account', crumbs: [['Drivers', '/admin/drivers'], ['Add account']], driverTypes: users.DRIVER_TYPES, old: { role: 'driver', driverType: 'student' } }));
router.post('/drivers', (req, res) => {
  try { const u = users.createUser(req.body, { allowRole: true, actor: actor(req) }); req.flash('success', 'Account created.'); res.redirect(`/admin/drivers/${u.id}`); }
  catch (e) { if (!(e instanceof ValidationError)) throw e; res.status(422).page('admin/driver-new', { title: 'Add account', crumbs: [['Drivers', '/admin/drivers'], ['Add account']], driverTypes: users.DRIVER_TYPES, errors: e.fields, old: { ...req.body, password: '', confirmPassword: '' } }); }
});
router.get('/drivers/:id', (req, res) => {
  const id = v.toInt(req.params.id); const u = users.getById(id);
  if (!u) throw new AppError('Account not found.', 404, 'NOT_FOUND');
  res.page('admin/driver-detail', { title: u.name, crumbs: [['Drivers', '/admin/drivers'], [u.name]], u, vehicles: users.listVehicles(id, { includeInactive: true }), recent: reservations.search({ userId: id, size: 8 }).rows, outstanding: payments.outstanding({ userId: id }) });
});
router.post('/drivers/:id/status', act((req) => users.setActive(v.toInt(req.params.id), req.body.active === '1', actor(req)), 'Account updated.', (req) => `/admin/drivers/${req.params.id}`));
router.post('/drivers/:id/password', act((req) => users.resetPassword(v.toInt(req.params.id), req.body.password, actor(req)), 'Password reset. Share the temporary password with the driver in person.', (req) => `/admin/drivers/${req.params.id}`));

/* -------------------------------- reports -------------------------------- */
const reportQuery = (req) => ({ period: str(req.query.period) || 'daily', date: str(req.query.date) || T.todayLocal(), zoneId: req.query.zone || '' });
router.get('/reports', (req, res) => {
  const q = reportQuery(req); const rep = reports.report(q);
  res.page('admin/reports', { title: 'Reports', scripts: CHART_JS, rep, zones: catalog.listZones(), q, chart: { labels: rep.rows.map((r) => r.label), reservations: rep.rows.map((r) => r.reservations), collected: rep.rows.map((r) => r.collected / 100), utilization: rep.rows.map((r) => r.utilization) } });
});
router.get('/reports/export.csv', (req, res) => {
  const q = reportQuery(req); const rep = reports.report(q);
  const dataset = req.query.dataset === 'reservations' ? 'reservations' : 'summary';
  const csv = dataset === 'summary' ? reports.summaryCsv(rep) : reports.reservationsCsv(rep);
  audit.log(actor(req), 'report.export', 'report', null, { ...q, dataset });
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="parking-${dataset}-${rep.period}-${rep.date}.csv"`, 'Cache-Control': 'no-store' }).send(csv);
});

/* -------------------------------- settings -------------------------------- */
router.get('/settings', (req, res) => {
  const tab = ['rules', 'rates', 'audit'].includes(req.query.tab) ? req.query.tab : 'rules';
  const base = { title: 'Settings', tab, fields: settingsSvc.FIELDS, values: settingsSvc.getAll(), rates: catalog.listRates(), typeLabel: catalog.TYPE_LABEL, types: catalog.SLOT_TYPES };
  if (tab === 'audit') {
    const f = { q: str(req.query.q), action: str(req.query.action) };
    const { rows, total } = audit.list({ ...f, page: page(req), size: 20 });
    return res.page('admin/settings', { ...base, f, rows, pg: H.paginate(total, page(req), 20), query: req.query, actions: audit.actions() });
  }
  res.page('admin/settings', { ...base, old: tab === 'rules' ? base.values : Object.fromEntries(base.rates.map((r) => [r.slot_type, (r.hourly_rate_centavos / 100).toFixed(2)])) });
});
router.post('/settings', (req, res) => {
  try { settingsSvc.update(req.body, actor(req)); req.flash('success', 'Booking rules saved.'); res.redirect('/admin/settings'); }
  catch (e) { if (!(e instanceof ValidationError)) throw e; res.status(422).page('admin/settings', { title: 'Settings', tab: 'rules', fields: settingsSvc.FIELDS, values: settingsSvc.getAll(), rates: catalog.listRates(), typeLabel: catalog.TYPE_LABEL, types: catalog.SLOT_TYPES, errors: e.fields, old: req.body }); }
});
router.post('/settings/rates', (req, res) => {
  try { catalog.updateRates(req.body, actor(req)); req.flash('success', 'Hourly rates saved. New bookings use these rates; existing bookings keep theirs.'); res.redirect('/admin/settings?tab=rates'); }
  catch (e) { if (!(e instanceof ValidationError)) throw e; res.status(422).page('admin/settings', { title: 'Settings', tab: 'rates', fields: settingsSvc.FIELDS, values: settingsSvc.getAll(), rates: catalog.listRates(), typeLabel: catalog.TYPE_LABEL, types: catalog.SLOT_TYPES, errors: e.fields, old: req.body }); }
});

module.exports = router;
