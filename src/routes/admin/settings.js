'use strict';

const express = require('express');
const settingsService = require('../../services/settings');
const parking = require('../../services/parking');
const audit = require('../../services/audit');
const auditFormat = require('../../utils/auditFormat');
const time = require('../../utils/time');
const { paginate, PER_PAGE } = require('../../utils/paginate');
const { AppError } = require('../../utils/errors');
const { toInt, clean } = require('../../utils/validate');

const router = express.Router();

const TABS = [
  { key: 'rules', label: 'Booking rules', icon: 'bi-sliders' },
  { key: 'rates', label: 'Parking rates', icon: 'bi-tag' },
  { key: 'types', label: 'Slot types', icon: 'bi-grid-3x3-gap' },
  { key: 'audit', label: 'Audit log', icon: 'bi-journal-text' },
];

function base(tab, extra = {}) {
  return Object.assign({
    title: 'Settings', nav: 'settings', tab, tabs: TABS,
    breadcrumbs: [{ label: 'Settings', href: '/admin/settings' }, { label: TABS.find((t) => t.key === tab).label }],
  }, extra);
}

router.get('/', (req, res) => res.redirect('/admin/settings/rules'));

// ------------------------------------------------------------------ rules

router.get('/rules', (req, res) => {
  res.view('admin/settings-rules', base('rules', { definitions: settingsService.DEFINITIONS, values: settingsService.getAll(), errors: {} }));
});

router.post('/rules', (req, res) => {
  const result = settingsService.update(req.body || {});
  if (result.errors) {
    return res.status(422).view('admin/settings-rules', base('rules', {
      definitions: settingsService.DEFINITIONS, values: Object.assign(settingsService.getAll(), req.body), errors: result.errors,
      formError: 'Settings were not saved. Please correct the highlighted fields.',
    }));
  }
  audit.log(req.actor, 'settings.update', 'settings', null, result.values);
  req.flash('success', 'Booking rules saved. They apply to new reservations immediately; existing bookings keep the rate they were made with.');
  return res.redirect('/admin/settings/rules');
});

// ------------------------------------------------------------------ rates

function ratesPage(extra = {}) {
  return base('rates', Object.assign({
    rates: parking.listRates(),
    zones: parking.listZones(),
    slotTypes: parking.listSlotTypes(),
    editing: null,
    values: { is_active: '1' },
    errors: {},
    formError: null,
  }, extra));
}

router.get('/rates', (req, res) => {
  const id = toInt(req.query.edit);
  const editing = id ? parking.listRates().find((r) => r.id === id) || null : null;
  res.view('admin/settings-rates', ratesPage(editing ? {
    editing,
    values: { name: editing.name, zone_id: editing.zone_id === null ? '' : editing.zone_id, slot_type: editing.slot_type || '', hourly_rate: (editing.hourly_rate_centavos / 100).toString(), is_active: String(editing.is_active) },
  } : {}));
});

router.post('/rates', (req, res) => {
  try {
    parking.createRate(req.body || {}, req.actor);
    req.flash('success', 'Rate added.');
    return res.redirect('/admin/settings/rates');
  } catch (err) {
    if (err instanceof AppError && err.fields) return res.status(422).view('admin/settings-rates', ratesPage({ values: req.body, errors: err.fields, formError: err.message }));
    throw err;
  }
});

router.post('/rates/:id', (req, res) => {
  const id = toInt(req.params.id);
  try {
    parking.updateRate(id, req.body || {}, req.actor);
    req.flash('success', 'Rate updated. Existing reservations keep the rate they were booked at.');
    return res.redirect('/admin/settings/rates');
  } catch (err) {
    if (err instanceof AppError && err.fields) {
      const editing = parking.listRates().find((r) => r.id === id) || null;
      return res.status(422).view('admin/settings-rates', ratesPage({ editing, values: req.body, errors: err.fields, formError: err.message }));
    }
    throw err;
  }
});

router.post('/rates/:id/delete', (req, res) => {
  try {
    parking.deleteRate(toInt(req.params.id), req.actor);
    req.flash('success', 'Rate deleted.');
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    req.flash('error', err.message);
  }
  return res.redirect('/admin/settings/rates');
});

// ------------------------------------------------------------------ slot types

function typesPage(extra = {}) {
  return base('types', Object.assign({
    slotTypes: parking.listSlotTypes(),
    icons: parking.ICONS,
    vehicleOptions: [
      { value: 'any', label: 'Any vehicle' },
      { value: 'car', label: 'Cars, vans and SUVs' },
      { value: 'motorcycle', label: 'Motorcycles only' },
    ],
    editing: null,
    values: { vehicle_type: 'car', icon: 'bi-car-front', is_active: '1', sort_order: 0 },
    errors: {},
    formError: null,
  }, extra));
}

router.get('/types', (req, res) => {
  const code = clean(req.query.edit);
  const editing = code ? parking.listSlotTypes().find((t) => t.code === code) || null : null;
  res.view('admin/settings-types', typesPage(editing ? { editing, values: Object.assign({}, editing, { is_active: String(editing.is_active) }) } : {}));
});

router.post('/types', (req, res) => {
  try {
    parking.createSlotType(req.body || {}, req.actor);
    req.flash('success', 'Slot type added.');
    return res.redirect('/admin/settings/types');
  } catch (err) {
    if (err instanceof AppError && err.fields) return res.status(422).view('admin/settings-types', typesPage({ values: req.body, errors: err.fields, formError: err.message }));
    throw err;
  }
});

router.post('/types/:code', (req, res) => {
  const code = clean(req.params.code);
  try {
    parking.updateSlotType(code, req.body || {}, req.actor);
    req.flash('success', 'Slot type updated.');
    return res.redirect('/admin/settings/types');
  } catch (err) {
    if (err instanceof AppError && err.fields) {
      const editing = parking.listSlotTypes().find((t) => t.code === code) || null;
      return res.status(422).view('admin/settings-types', typesPage({ editing, values: req.body, errors: err.fields, formError: err.message }));
    }
    throw err;
  }
});

router.post('/types/:code/delete', (req, res) => {
  try {
    parking.deleteSlotType(clean(req.params.code), req.actor);
    req.flash('success', 'Slot type deleted.');
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    req.flash('error', err.message);
  }
  return res.redirect('/admin/settings/types');
});

// ------------------------------------------------------------------ audit log

router.get('/audit', (req, res) => {
  const filters = {
    action: clean(req.query.action),
    user: clean(req.query.user),
    from: /^\d{4}-\d{2}-\d{2}$/.test(clean(req.query.from)) ? clean(req.query.from) : '',
    to: /^\d{4}-\d{2}-\d{2}$/.test(clean(req.query.to)) ? clean(req.query.to) : '',
  };
  const perPage = PER_PAGE;
  const first = audit.list({ action: filters.action, userQuery: filters.user, from: filters.from, to: filters.to, limit: 1, offset: 0 });
  const pager = paginate(first.total, req.query.page, perPage);
  const { rows } = audit.list({ action: filters.action, userQuery: filters.user, from: filters.from, to: filters.to, limit: perPage, offset: pager.offset });
  rows.forEach((row) => { row.view = auditFormat.describe(row); });
  res.view('admin/settings-audit', base('audit', {
    rows, pager, filters, baseQuery: filters, now: time.nowLocal(),
    actionOptions: [{ value: '', label: 'All actions' }].concat(
      ['reservation.create', 'reservation.cancel', 'reservation.reschedule', 'reservation.no_show', 'session.check_in', 'session.check_out',
        'payment.record', 'payment.void', 'slot.', 'zone.', 'rate.', 'user.', 'settings.update', 'auth.']
        .map((a) => ({ value: a, label: a.endsWith('.') ? `${auditFormat.actionTitle(a.slice(0, -1))} (all)` : auditFormat.actionTitle(a) })),
    ),
  }));
});

module.exports = router;
