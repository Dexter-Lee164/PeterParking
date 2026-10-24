'use strict';

const express = require('express');
const etiquette = require('../../services/etiquette');
const { AppError } = require('../../utils/errors');
const { toInt, clean, oneOf, plateKey } = require('../../utils/validate');

/**
 * Parking Etiquette Reports for administrators: review what drivers reported, judge severity, set the status, and
 * penalise a plate (permanent additional fee, temporary or permanent ban) or lift a penalty. Every decision asks for
 * confirmation in the page and is written to the audit log (src/services/etiquette.js).
 */
const router = express.Router();

const STATUS_FILTER = [{ value: '', label: 'Any status' }].concat(etiquette.STATUSES);

router.get('/', (req, res) => {
  const status = oneOf(clean(req.query.status), etiquette.STATUSES.map((s) => s.value), '');
  const q = clean(req.query.q);
  const { rows, pager } = etiquette.listReports({ status, q }, { page: req.query.page, perPage: 15 });
  res.view('admin/reports', {
    title: 'Etiquette Reports', nav: 'reports', rows, pager,
    counts: etiquette.countByStatus(),
    filters: { status, q }, baseQuery: { status, q },
    statusOptions: STATUS_FILTER,
  });
});

/** Penalty, review and lift forms on the report page and the plate page share these lists. */
function decisionLists() {
  return {
    statusOptions: etiquette.STATUSES,
    severityOptions: [{ value: '', label: 'Not assessed' }].concat(etiquette.SEVERITIES),
    penaltyOptions: [{ value: '', label: 'Choose a penalty…' }].concat(etiquette.PENALTY_KINDS),
  };
}

function reportPage(report, extra = {}) {
  return Object.assign({
    title: `Report #${report.id}`, nav: 'reports', report, history: etiquette.plateHistory(report.plate_number),
    values: { status: report.status, severity: report.severity || '', admin_notes: report.admin_notes || '' },
    penaltyValues: {}, errors: {}, penaltyErrors: {}, formError: null,
    breadcrumbs: [{ label: 'Etiquette Reports', href: '/admin/reports' }, { label: `Report #${report.id}` }],
    extraScripts: ['/js/penalty-form.js'],
  }, decisionLists(), extra);
}

function plateParam(req) {
  const plate = etiquette.displayPlate(decodeURIComponent(req.params.plate || ''));
  if (!/^[A-Z0-9][A-Z0-9 -]{2,11}$/.test(plate)) throw new AppError('Plate not found.', { status: 404 });
  return plate;
}

function platePage(plate, extra = {}) {
  return Object.assign({
    title: `Plate ${plate}`, nav: 'reports', plate, history: etiquette.plateHistory(plate),
    penaltyValues: {}, penaltyErrors: {}, formError: null,
    breadcrumbs: [{ label: 'Etiquette Reports', href: '/admin/reports' }, { label: plate }],
    extraScripts: ['/js/penalty-form.js'],
  }, decisionLists(), extra);
}

const getReportOr404 = (id) => {
  const report = etiquette.getReport(toInt(id));
  if (!report) throw new AppError('Report not found.', { status: 404 });
  return report;
};

// ------------------------------------------------------------------ plates

router.get('/plate/:plate', (req, res) => res.view('admin/report-plate', platePage(plateParam(req))));

router.post('/plate/:plate/penalties', (req, res) => {
  const plate = plateParam(req);
  try {
    const p = etiquette.applyPenalty({ ...req.body, plate }, req.user);
    req.flash('success', `${p.kind_label} applied to ${p.plate_number}.`);
    return res.redirect(`/admin/reports/plate/${encodeURIComponent(plateKey(plate))}`);
  } catch (err) {
    if (!(err instanceof AppError) || !err.fields) throw err;
    return res.status(422).view('admin/report-plate', platePage(plate, { penaltyValues: req.body, penaltyErrors: err.fields, formError: err.message }));
  }
});

router.post('/penalties/:id/lift', (req, res) => {
  const penalty = etiquette.getPenalty(toInt(req.params.id));
  if (!penalty) throw new AppError('Penalty not found.', { status: 404 });
  // Back to the page the form was on: its report, or the plate.
  const back = penalty.report_id && toInt(req.body.report_id) === penalty.report_id
    ? `/admin/reports/${penalty.report_id}`
    : `/admin/reports/plate/${encodeURIComponent(penalty.plate_key)}`;
  try {
    etiquette.liftPenalty(penalty.id, req.body.reason, req.user); // the reason comes from the confirmation dialog
    req.flash('success', `${penalty.kind_label} on ${penalty.plate_number} was lifted.`);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    req.flash('error', err.fields ? err.fields.lift_reason : err.message);
  }
  return res.redirect(back);
});

// ----------------------------------------------------------------- reports

router.get('/:id', (req, res) => res.view('admin/report-detail', reportPage(getReportOr404(req.params.id))));

router.post('/:id/review', (req, res) => {
  const report = getReportOr404(req.params.id);
  try {
    const updated = etiquette.reviewReport(report.id, req.body || {}, req.user);
    req.flash('success', `Report #${updated.id} is now ${updated.status_label.toLowerCase()}.`);
    return res.redirect(`/admin/reports/${updated.id}`);
  } catch (err) {
    if (!(err instanceof AppError) || !err.fields) throw err;
    return res.status(422).view('admin/report-detail', reportPage(report, { values: req.body, errors: err.fields, formError: err.message }));
  }
});

router.post('/:id/penalties', (req, res) => {
  const report = getReportOr404(req.params.id);
  try {
    const p = etiquette.applyPenalty({ ...req.body, plate: report.plate_number, reportId: report.id }, req.user);
    req.flash('success', `${p.kind_label} applied to ${p.plate_number}.`);
    return res.redirect(`/admin/reports/${report.id}`);
  } catch (err) {
    if (!(err instanceof AppError) || !err.fields) throw err;
    return res.status(422).view('admin/report-detail', reportPage(report, { penaltyValues: req.body, penaltyErrors: err.fields, formError: err.message }));
  }
});

router.get('/:id/evidence', (req, res) => {
  const report = getReportOr404(req.params.id);
  const file = etiquette.getEvidence(report.id);
  if (!file) throw new AppError('No image was attached to this report.', { status: 404 });
  res.set({ 'Content-Type': file.mime, 'Cache-Control': 'private, max-age=300', 'Content-Disposition': 'inline' });
  res.send(file.data);
});

module.exports = router;
