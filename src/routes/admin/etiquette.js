'use strict';

const express = require('express');
const etiquette = require('../../services/etiquette');
const penalties = require('../../services/penalties');
const evidence = require('../../services/evidence');
const users = require('../../services/users');
const time = require('../../utils/time');
const { AppError } = require('../../utils/errors');
const { toInt, clean, oneOf } = require('../../utils/validate');

/**
 * Etiquette Reports for administrators: review what drivers reported, verify which registered vehicle a plate is,
 * approve or dismiss with a documented reason, issue, modify or revoke penalties, and decide appeals. Every decision
 * asks for confirmation in the page and is written to the audit log by the services
 * (src/services/etiquette.js, src/services/penalties.js). The whole area is behind requireRole('admin').
 */
const router = express.Router();

const TABS = ['reports', 'penalties', 'appeals'];
const any = (label) => [{ value: '', label }];

function penaltyOptions() {
  return {
    penaltyOptions: any('Choose a penalty…').concat(penalties.KINDS),
    maxFee: penalties.MAX_FEE,
    maxBanDays: penalties.MAX_BAN_DAYS,
    today: time.todayLocal(),
  };
}

// ------------------------------------------------------------------ overview (three tabs)

router.get('/', (req, res) => {
  const tab = oneOf(clean(req.query.tab), TABS, 'reports');
  const q = clean(req.query.q);
  const page = { page: req.query.page, perPage: 15 };
  const data = { title: 'Etiquette Reports', nav: 'etiquette', tab, q };
  data.counts = etiquette.countByStatus();
  data.inForce = penalties.countInForce();
  data.pendingAppeals = penalties.countPendingAppeals();
  if (tab === 'reports') {
    const filters = {
      q,
      status: oneOf(clean(req.query.status), ['open'].concat(etiquette.STATUSES.map((s) => s.value)), ''),
      violation: oneOf(clean(req.query.violation), etiquette.VIOLATIONS.map((v) => v.value), ''),
      zoneId: toInt(req.query.zone_id),
      dateFrom: clean(req.query.from),
      dateTo: clean(req.query.to),
    };
    Object.assign(data, etiquette.listReports(filters, page), {
      filters,
      baseQuery: { tab, q, status: filters.status, violation: filters.violation, zone_id: filters.zoneId || '', from: filters.dateFrom, to: filters.dateTo },
      statusOptions: any('Any status').concat([{ value: 'open', label: 'Open (new or under review)' }], etiquette.STATUSES),
      violationOptions: any('Any violation').concat(etiquette.VIOLATIONS),
      zoneOptions: any('Any zone').concat(etiquette.activeZones().map((z) => ({ value: z.id, label: z.name }))),
    });
  } else if (tab === 'penalties') {
    const filters = {
      q,
      kind: oneOf(clean(req.query.kind), penalties.KINDS.map((k) => k.value), ''),
      state: oneOf(clean(req.query.state), ['in_force'].concat(penalties.STATES.map((s) => s.value)), ''),
    };
    Object.assign(data, penalties.listPenalties(filters, page), {
      filters,
      baseQuery: { tab, q, kind: filters.kind, state: filters.state },
      kindOptions: any('Any type').concat(penalties.KINDS),
      stateOptions: any('Any state').concat([{ value: 'in_force', label: 'In force (active, scheduled or awaiting charge)' }], penalties.STATES),
    });
  } else {
    const filters = { status: oneOf(clean(req.query.status), penalties.APPEAL_STATUSES.map((s) => s.value), '') };
    Object.assign(data, penalties.listAppeals(filters, page), {
      filters,
      baseQuery: { tab, status: filters.status },
      statusOptions: any('Any status').concat(penalties.APPEAL_STATUSES),
    });
  }
  res.view('admin/etiquette', data);
});

// ------------------------------------------------------------------ vehicle lookup

router.get('/vehicles', (req, res) => {
  const q = clean(req.query.q);
  res.view('admin/etiquette-vehicles', {
    title: 'Vehicle lookup', nav: 'etiquette', q,
    rows: q ? etiquette.searchVehicles(q) : [],
    key: etiquette.plateMatchKey(q),
    breadcrumbs: [{ label: 'Etiquette Reports', href: '/admin/etiquette' }, { label: 'Vehicle lookup' }],
  });
});

function vehicleOr404(id) {
  const vehicle = etiquette.getVehicle(toInt(id));
  if (!vehicle) throw new AppError('Vehicle not found.', { status: 404 });
  return vehicle;
}

function vehiclePage(vehicle, extra = {}) {
  return Object.assign({
    title: `Vehicle ${vehicle.plate_number}`, nav: 'etiquette', vehicle,
    owner: users.getUser(vehicle.user_id),
    accountPenalties: penalties.penaltiesForUser(vehicle.user_id),
    platePenalties: penalties.penaltiesForPlate(vehicle.plate_number).filter((p) => p.user_id !== vehicle.user_id),
    plateReports: etiquette.listReports({ plateKey: etiquette.plateMatchKey(vehicle.plate_number) }, { perPage: 50 }).rows,
    penaltyValues: {}, penaltyErrors: {}, formError: null,
    breadcrumbs: [{ label: 'Etiquette Reports', href: '/admin/etiquette' }, { label: 'Vehicle lookup', href: `/admin/etiquette/vehicles?q=${encodeURIComponent(vehicle.plate_number)}` }, { label: vehicle.plate_number }],
    extraScripts: ['/js/penalty-form.js'],
  }, penaltyOptions(), extra);
}

router.get('/vehicles/:id', (req, res) => res.view('admin/etiquette-vehicle', vehiclePage(vehicleOr404(req.params.id))));

router.post('/vehicles/:id/penalties', (req, res) => {
  const vehicle = vehicleOr404(req.params.id);
  try {
    const p = penalties.issuePenalty({ ...req.body, report_id: null, vehicle_id: vehicle.id }, req.user);
    req.flash('success', `${p.kind_label} issued to ${p.driver_name} (${p.plate_number}). The driver was notified.`);
    return res.redirect(`/admin/etiquette/penalties/${p.id}`);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    return res.status(err.fields ? 422 : err.status).view('admin/etiquette-vehicle', vehiclePage(vehicle, { penaltyValues: req.body, penaltyErrors: err.fields || {}, formError: err.message }));
  }
});

// ------------------------------------------------------------------ reports

function reportOr404(id) {
  const report = etiquette.getReport(toInt(id));
  if (!report) throw new AppError('Report not found.', { status: 404 });
  return report;
}

function reportPage(report, extra = {}) {
  return Object.assign({
    title: `Report #${report.id}`, nav: 'etiquette', report,
    matches: etiquette.vehiclesForPlate(report.plate_number),
    duplicates: etiquette.possibleDuplicates(report),
    linked: penalties.penaltiesForReport(report.id),
    ownerPenalties: report.owner_id ? penalties.penaltiesForUser(report.owner_id) : [],
    ownerReports: report.owner_id ? etiquette.listReports({ ownerId: report.owner_id }, { perPage: 50 }).rows.filter((r) => r.id !== report.id) : [],
    penaltyValues: {}, penaltyErrors: {}, formError: null,
    breadcrumbs: [{ label: 'Etiquette Reports', href: '/admin/etiquette' }, { label: `Report #${report.id}` }],
    extraScripts: ['/js/penalty-form.js'],
  }, penaltyOptions(), extra);
}

router.get('/reports/:id', (req, res) => res.view('admin/etiquette-report', reportPage(reportOr404(req.params.id))));

router.get('/reports/:id/evidence', (req, res) => {
  const report = reportOr404(req.params.id);
  const file = etiquette.getEvidence(report.id);
  if (!file) throw new AppError('No photo was attached to this report.', { status: 404 });
  evidence.send(res, file, `report-${report.id}`);
});

/** POST actions on a report that only need a flash message and a redirect back. */
function reportAction(path, run, done) {
  router.post(`/reports/:id/${path}`, (req, res) => {
    const report = reportOr404(req.params.id);
    try {
      const updated = run(report, req);
      req.flash('success', done(updated));
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      req.flash('error', err.fields ? Object.values(err.fields)[0] : err.message);
    }
    return res.redirect(`/admin/etiquette/reports/${report.id}`);
  });
}

reportAction('review', (r, req) => etiquette.markUnderReview(r.id, req.user), (r) => `Report #${r.id} is now under review.`);
reportAction('approve', (r, req) => etiquette.approveReport(r.id, req.body.reason, req.user), (r) => `Report #${r.id} was approved. No penalty is applied until you issue one.`);
reportAction('dismiss', (r, req) => etiquette.dismissReport(r.id, req.body.reason, req.user), (r) => `Report #${r.id} was dismissed.`);
reportAction('verify', (r, req) => etiquette.verifyVehicle(r.id, req.body.vehicle_id, req.user), (r) => `Report #${r.id} is now linked to ${r.vehicle_plate}, registered to ${r.owner_name}.`);

router.post('/reports/:id/penalties', (req, res) => {
  const report = reportOr404(req.params.id);
  try {
    const p = penalties.issuePenalty({ ...req.body, report_id: report.id }, req.user);
    req.flash('success', `${p.kind_label} issued to ${p.driver_name} (${p.plate_number}). The driver was notified.`);
    return res.redirect(`/admin/etiquette/penalties/${p.id}`);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    return res.status(err.fields ? 422 : err.status).view('admin/etiquette-report', reportPage(report, { penaltyValues: req.body, penaltyErrors: err.fields || {}, formError: err.message }));
  }
});

// ------------------------------------------------------------------ penalties

function penaltyOr404(id) {
  const penalty = penalties.getPenalty(toInt(id));
  if (!penalty) throw new AppError('Penalty not found.', { status: 404 });
  return penalty;
}

function penaltyPage(penalty, extra = {}) {
  const upcoming = penalties.upcomingReservations(penalty.user_id);
  return Object.assign({
    title: `Penalty #${penalty.id}`, nav: 'etiquette', penalty,
    report: penalty.report_id ? etiquette.getReport(penalty.report_id) : null,
    appeal: penalties.appealForPenalty(penalty.id),
    events: penalties.events(penalty.id),
    charges: penalties.charges(penalty.id),
    upcoming,
    chargeable: upcoming.filter((r) => r.status === 'confirmed' && r.paid_centavos === 0),
    values: {
      amount: penalty.amount_centavos ? (penalty.amount_centavos / 100).toFixed(2) : '',
      start_date: penalty.start_date, end_date: penalty.end_date, expires_on: penalty.expires_date, reason: penalty.reason,
    },
    errors: {}, formError: null,
    breadcrumbs: [{ label: 'Etiquette Reports', href: '/admin/etiquette?tab=penalties' }, { label: `Penalty #${penalty.id}` }],
  }, penaltyOptions(), extra);
}

router.get('/penalties/:id', (req, res) => res.view('admin/etiquette-penalty', penaltyPage(penaltyOr404(req.params.id))));

router.post('/penalties/:id', (req, res) => {
  const penalty = penaltyOr404(req.params.id);
  try {
    penalties.modifyPenalty(penalty.id, req.body || {}, req.user);
    req.flash('success', `Penalty #${penalty.id} was updated. The driver was notified.`);
    return res.redirect(`/admin/etiquette/penalties/${penalty.id}`);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    if (!err.fields) {
      req.flash('error', err.message);
      return res.redirect(`/admin/etiquette/penalties/${penalty.id}`);
    }
    return res.status(422).view('admin/etiquette-penalty', penaltyPage(penalty, { values: req.body, errors: err.fields, formError: err.message }));
  }
});

router.post('/penalties/:id/revoke', (req, res) => {
  const penalty = penaltyOr404(req.params.id);
  try {
    const { removed } = penalties.revokePenalty(penalty.id, { reason: req.body.reason, removeUnpaid: req.body.remove_unpaid === '1' }, req.user);
    req.flash('success', `Penalty #${penalty.id} was revoked.${removed.length ? ` Its fee was removed from ${removed.join(', ')}.` : ''} The driver was notified.`);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    req.flash('error', err.message);
  }
  return res.redirect(`/admin/etiquette/penalties/${penalty.id}`);
});

router.post('/penalties/:id/charge', (req, res) => {
  const penalty = penaltyOr404(req.params.id);
  try {
    const p = penalties.chargeToReservation(penalty.id, req.body.reservation_id, req.user);
    req.flash('success', `The one-time fee was added to booking ${p.charged_ref}.`);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    req.flash('error', err.message);
  }
  return res.redirect(`/admin/etiquette/penalties/${penalty.id}`);
});

// ------------------------------------------------------------------ appeals

function appealOr404(id) {
  const appeal = penalties.getAppeal(toInt(id));
  if (!appeal) throw new AppError('Appeal not found.', { status: 404 });
  return appeal;
}

router.get('/appeals/:id', (req, res) => res.redirect(`/admin/etiquette/penalties/${appealOr404(req.params.id).penalty_id}#appeal`));

router.get('/appeals/:id/evidence', (req, res) => {
  const appeal = appealOr404(req.params.id);
  const file = penalties.getAppealEvidence(appeal.id);
  if (!file) throw new AppError('No photo was attached to this appeal.', { status: 404 });
  evidence.send(res, file, `appeal-${appeal.id}`);
});

router.post('/appeals/:id/decide', (req, res) => {
  const appeal = appealOr404(req.params.id);
  try {
    const { appeal: decided, removed } = penalties.decideAppeal(appeal.id, {
      decision: req.body.decision, reason: req.body.reason, removeUnpaid: req.body.remove_unpaid === '1',
    }, req.user);
    req.flash('success', decided.status === 'revoked'
      ? `Appeal granted: penalty #${appeal.penalty_id} was revoked.${removed.length ? ` Its fee was removed from ${removed.join(', ')}.` : ''}`
      : `Appeal decided: penalty #${appeal.penalty_id} is upheld.`);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    req.flash('error', err.message);
  }
  return res.redirect(`/admin/etiquette/penalties/${appeal.penalty_id}#appeal`);
});

module.exports = router;
