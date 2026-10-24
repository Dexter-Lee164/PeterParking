'use strict';

const express = require('express');
const users = require('../../services/users');
const reservations = require('../../services/reservations');
const payments = require('../../services/payments');
const etiquette = require('../../services/etiquette');
const ctx = require('../../db/context');
const { AppError } = require('../../utils/errors');
const { toInt, clean, oneOf } = require('../../utils/validate');

const router = express.Router();

const ROLE_OPTIONS = [
  { value: 'driver', label: 'Drivers' },
  { value: 'admin', label: 'Administrators' },
  { value: 'all', label: 'Everyone' },
];
const STATUS_OPTIONS = [
  { value: '', label: 'Any status' },
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
];

router.get('/', (req, res) => {
  const filters = {
    q: clean(req.query.q),
    role: oneOf(clean(req.query.role), ['driver', 'admin', 'all'], 'driver'),
    status: oneOf(clean(req.query.status), ['active', 'inactive'], ''),
  };
  const { rows, pager } = users.listUsers(
    { q: filters.q, role: filters.role === 'all' ? '' : filters.role, status: filters.status },
    { page: req.query.page, perPage: 15 },
  );
  res.view('admin/drivers', {
    title: 'Drivers', nav: 'drivers', rows, pager, filters, baseQuery: filters,
    roleOptions: ROLE_OPTIONS, statusOptions: STATUS_OPTIONS,
  });
});

const ROLE_FORM_OPTIONS = [{ value: 'driver', label: 'Driver' }, { value: 'admin', label: 'Administrator' }];

router.get('/new', (req, res) => {
  res.view('admin/driver-form', {
    title: 'Add User', nav: 'drivers', person: null, values: { role: 'driver', is_active: '1' }, errors: {}, formError: null,
    roleOptions: ROLE_FORM_OPTIONS,
    breadcrumbs: [{ label: 'Drivers', href: '/admin/drivers' }, { label: 'Add user' }],
  });
});

router.post('/', (req, res) => {
  try {
    const u = users.adminCreateUser(req.body || {}, req.actor);
    req.flash('success', `${u.full_name} was added as ${u.role === 'admin' ? 'an administrator' : 'a driver'}.`);
    return res.redirect(`/admin/drivers/${u.id}`);
  } catch (err) {
    if (err instanceof AppError && err.fields) {
      return res.status(422).view('admin/driver-form', {
        title: 'Add User', nav: 'drivers', person: null, values: req.body, errors: err.fields, formError: err.message, roleOptions: ROLE_FORM_OPTIONS,
        breadcrumbs: [{ label: 'Drivers', href: '/admin/drivers' }, { label: 'Add user' }],
      });
    }
    throw err;
  }
});

function detailPage(person, extra = {}) {
  const db = ctx.get();
  const history = reservations.listReservations({ userId: person.id }, { page: 1, perPage: 8 });
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS bookings,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
              SUM(CASE WHEN status = 'no_show' THEN 1 ELSE 0 END) AS no_shows
       FROM reservations WHERE user_id = ?`,
    )
    .get(person.id);
  return Object.assign({
    title: person.full_name,
    nav: 'drivers',
    breadcrumbs: [{ label: 'Drivers', href: '/admin/drivers' }, { label: person.full_name }],
    person,
    vehicles: users.listVehicles(person.id, { includeInactive: true }),
    history: history.rows,
    totals,
    outstanding: payments.totalOutstanding({ userId: person.id }),
    // Etiquette violations on the driver's plates: reports not dismissed, and penalties in force right now.
    violationReports: etiquette.reportsForDriver(person.id),
    activePenalties: etiquette.penaltiesForDriver(person.id).filter((p) => p.state === 'active'),
    roleOptions: ROLE_FORM_OPTIONS,
    values: Object.assign({}, person, { is_active: String(person.is_active) }),
    errors: {},
    formError: null,
  }, extra);
}

router.get('/:id', (req, res) => {
  const person = users.getUser(toInt(req.params.id));
  if (!person) throw new AppError('User not found.', { status: 404 });
  res.view('admin/driver-detail', detailPage(person));
});

router.post('/:id', (req, res) => {
  const id = toInt(req.params.id);
  try {
    const u = users.adminUpdateUser(id, req.body || {}, req.actor);
    req.flash('success', `${u.full_name} was updated.`);
    return res.redirect(`/admin/drivers/${id}`);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    const person = users.getUser(id);
    if (!person) throw err;
    return res.status(err.fields ? 422 : 409).view('admin/driver-detail', detailPage(person, { values: req.body, errors: err.fields || {}, formError: err.message }));
  }
});

router.post('/:id/status', (req, res) => {
  const id = toInt(req.params.id);
  const active = req.body.active === '1';
  try {
    users.setUserActive(id, active, req.actor);
    req.flash('success', active ? 'Account reactivated.' : 'Account deactivated. The user can no longer sign in.');
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    req.flash('error', err.message);
  }
  return res.redirect(`/admin/drivers/${id}`);
});

module.exports = router;
