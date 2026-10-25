'use strict';

const ctx = require('../db/context');
const { immediate } = require('../db');
const audit = require('./audit');
const evidence = require('./evidence');
const time = require('../utils/time');
const { AppError } = require('../utils/errors');
const { clean, collapse, toInt, normalizePlate, oneOf } = require('../utils/validate');
const { paginate } = require('../utils/paginate');

/**
 * Parking etiquette reports.
 *
 * A signed-in driver reports a vehicle by the plate number they saw: category, when, where, what happened and an
 * optional photo. A report never punishes anyone by itself and never assumes the plate belongs to a registered driver:
 * an administrator looks the plate up, verifies which registered vehicle (and so which account) it is, and only then
 * can a penalty follow (src/services/penalties.js).
 *
 *   pending        new, nobody has looked at it yet ("Under review" to the reporter)
 *   under_review   an administrator has taken it up
 *   resolved       approved: the violation is confirmed, with the administrator's documented reason
 *   dismissed      no violation, or not enough to act on, with the reason
 *
 * The reporter's identity is shown to administrators only, never to the reported driver.
 */

const VIOLATIONS = [
  { value: 'improper_parking', label: 'Parked over the lines or across two slots' },
  { value: 'blocking', label: 'Blocking another vehicle, a lane or an exit' },
  { value: 'wrong_slot', label: 'Parked in a slot reserved by someone else' },
  { value: 'accessible_misuse', label: 'Misused an accessible slot' },
  { value: 'overstay', label: 'Stayed well past the reserved time' },
  { value: 'reckless', label: 'Reckless or unsafe driving in the lot' },
  { value: 'other', label: 'Other' },
];
const STATUSES = [
  { value: 'pending', label: 'New' },
  { value: 'under_review', label: 'Under review' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'dismissed', label: 'Dismissed' },
];
/** What the reporter sees: a new report is already "under review" from their side. */
const DRIVER_STATUS = { pending: 'under_review', under_review: 'under_review', resolved: 'resolved', dismissed: 'dismissed' };

const label = (list, value) => (list.find((o) => o.value === value) || {}).label || value;
const PLATE = /^[A-Z0-9][A-Z0-9 -]{2,11}$/;
const REPORT_WINDOW_DAYS = 30;
const DAILY_LIMIT = 10;
const DUPLICATE_MINUTES = 60;

/** "abc-1234" / "ABC 1234" → "ABC1234": plates are compared without spaces or hyphens. */
const plateMatchKey = (v) => normalizePlate(v).replace(/[^A-Z0-9]/g, '');
/** The same key computed in SQL for a stored plate column. */
const keySql = (col) => `upper(replace(replace(${col}, ' ', ''), '-', ''))`;

const invalid = (fields) => new AppError('Please correct the highlighted fields.', { code: 'VALIDATION', fields });

// ---------------------------------------------------------------- reading

const REPORT_SELECT = `
  SELECT r.*, u.full_name AS reporter_name, u.email AS reporter_email, rv.full_name AS reviewer_name,
         z.name AS zone_name, z.code AS zone_code,
         ow.full_name AS owner_name, ow.email AS owner_email, vh.plate_number AS vehicle_plate, vh.is_active AS vehicle_active,
         vh.vehicle_type, vh.make, vh.model, vh.color, vf.full_name AS verified_by_name,
         EXISTS (SELECT 1 FROM etiquette_evidence e WHERE e.report_id = r.id) AS has_evidence,
         (SELECT COUNT(*) FROM etiquette_reports o WHERE o.plate_key = r.plate_key) AS plate_report_count,
         (SELECT COUNT(*) FROM penalties p WHERE p.report_id = r.id) AS penalty_count,
         (SELECT COUNT(*) FROM penalties p WHERE p.report_id = r.id AND p.status = 'active') AS active_penalty_count
  FROM etiquette_reports r
  JOIN users u ON u.id = r.reporter_id
  LEFT JOIN users rv ON rv.id = r.reviewed_by
  LEFT JOIN parking_zones z ON z.id = r.zone_id
  LEFT JOIN users ow ON ow.id = r.owner_id
  LEFT JOIN vehicles vh ON vh.id = r.vehicle_id
  LEFT JOIN users vf ON vf.id = r.verified_by`;

function decorate(r) {
  if (!r) return r;
  const open = r.status === 'pending' || r.status === 'under_review';
  return Object.assign(r, {
    violation_label: label(VIOLATIONS, r.violation_type),
    status_label: label(STATUSES, r.status),
    driver_status: DRIVER_STATUS[r.status] || r.status,
    has_evidence: !!r.has_evidence,
    is_open: open,
    can_mark_review: r.status === 'pending',
    can_decide: open,
    // The verified vehicle can change until a penalty was issued for this report.
    can_verify: r.status !== 'dismissed' && !r.penalty_count,
    can_penalise: r.status === 'resolved' && !!r.vehicle_id,
  });
}

const getReport = (id) => decorate(ctx.get().prepare(`${REPORT_SELECT} WHERE r.id = ?`).get(id));
const getEvidence = (reportId) => ctx.get().prepare('SELECT mime, size_bytes, data FROM etiquette_evidence WHERE report_id = ?').get(reportId);
const activeZones = () => ctx.get().prepare('SELECT id, code, name FROM parking_zones WHERE is_active = 1 ORDER BY sort_order, name').all();

function listReports({ reporterId = null, status = '', violation = '', zoneId = null, q = '', dateFrom = '', dateTo = '', ownerId = null, plateKey = '' } = {}, { page = 1, perPage = 15 } = {}) {
  const where = [];
  const params = [];
  const add = (sql, ...values) => {
    where.push(sql);
    params.push(...values);
  };
  if (reporterId) add('r.reporter_id = ?', reporterId);
  if (ownerId) add('r.owner_id = ?', ownerId);
  if (plateKey) add('r.plate_key = ?', plateKey);
  if (status === 'open') add(`r.status IN ('pending', 'under_review')`);
  else if (STATUSES.some((s) => s.value === status)) add('r.status = ?', status);
  if (VIOLATIONS.some((v) => v.value === violation)) add('r.violation_type = ?', violation);
  if (zoneId) add('r.zone_id = ?', zoneId);
  if (time.isValidDate(dateFrom)) add('r.incident_at >= ?', `${dateFrom} 00:00:00`);
  if (time.isValidDate(dateTo)) add('r.incident_at <= ?', `${dateTo} 23:59:59`);
  if (q) {
    add(
      '(r.plate_key LIKE ? OR r.description LIKE ? OR u.full_name LIKE ? OR u.email LIKE ? OR CAST(r.id AS TEXT) = ?)',
      `%${plateMatchKey(q)}%`, `%${q}%`, `%${q}%`, `%${q}%`, q.replace(/^#/, ''),
    );
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const db = ctx.get();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM etiquette_reports r JOIN users u ON u.id = r.reporter_id ${whereSql}`).get(...params).n;
  const pager = paginate(total, page, perPage);
  // Open reports first (new before under review), newest first within each status.
  const rows = db
    .prepare(
      `${REPORT_SELECT} ${whereSql}
       ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'under_review' THEN 1 ELSE 2 END, r.created_at DESC, r.id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, pager.perPage, pager.offset)
    .map(decorate);
  return { rows, pager };
}

function countByStatus({ reporterId = null } = {}) {
  const rows = reporterId
    ? ctx.get().prepare('SELECT status, COUNT(*) AS n FROM etiquette_reports WHERE reporter_id = ? GROUP BY status').all(reporterId)
    : ctx.get().prepare('SELECT status, COUNT(*) AS n FROM etiquette_reports GROUP BY status').all();
  const out = { pending: 0, under_review: 0, resolved: 0, dismissed: 0, all: 0 };
  for (const r of rows) {
    out[r.status] = r.n;
    out.all += r.n;
  }
  return out;
}

/** Other reports about the same plate within three hours of this incident: possibly the same incident. */
function possibleDuplicates(report) {
  return ctx.get()
    .prepare(
      `${REPORT_SELECT} WHERE r.plate_key = @key AND r.id <> @id
         AND r.incident_at BETWEEN @from AND @to ORDER BY r.incident_at`,
    )
    .all({ key: report.plate_key, id: report.id, from: time.addMinutes(report.incident_at, -180), to: time.addMinutes(report.incident_at, 180) })
    .map(decorate);
}

// ---------------------------------------------------------------- vehicles

const VEHICLE_SELECT = `
  SELECT v.*, u.full_name AS owner_name, u.email AS owner_email, u.university_id AS owner_university_id, u.role AS owner_role,
         u.is_active AS owner_active,
         (SELECT COUNT(*) FROM penalties p WHERE p.user_id = v.user_id AND p.status = 'active') AS owner_active_penalties,
         (SELECT COUNT(*) FROM etiquette_reports r WHERE r.plate_key = ${keySql('v.plate_number')}) AS plate_report_count
  FROM vehicles v JOIN users u ON u.id = v.user_id`;

/** Registered vehicles (current and removed) whose normalized plate contains the search, best matches first. */
function searchVehicles(query, { limit = 50 } = {}) {
  const key = plateMatchKey(query);
  if (key.length < 2) return [];
  return ctx.get()
    .prepare(
      `${VEHICLE_SELECT} WHERE ${keySql('v.plate_number')} LIKE @like
       ORDER BY ${keySql('v.plate_number')} = @key DESC, v.is_active DESC, v.plate_number LIMIT @limit`,
    )
    .all({ like: `%${key}%`, key, limit });
}

/** Every vehicle record (current or removed) with exactly this normalized plate. */
const vehiclesForPlate = (plate) =>
  ctx.get().prepare(`${VEHICLE_SELECT} WHERE ${keySql('v.plate_number')} = ? ORDER BY v.is_active DESC, v.created_at DESC`).all(plateMatchKey(plate));

const getVehicle = (id) => ctx.get().prepare(`${VEHICLE_SELECT} WHERE v.id = ?`).get(id);

// ---------------------------------------------------------------- submitting

function submitReport(reporterId, input, actor) {
  const db = ctx.get();
  const fields = {};
  const plate = normalizePlate(input.plate_number);
  const key = plateMatchKey(plate);
  const violation = oneOf(clean(input.violation_type), VIOLATIONS.map((v) => v.value));
  const zoneId = toInt(input.zone_id);
  const description = collapse(input.description);
  const date = clean(input.incident_date);
  const hhmm = clean(input.incident_time);
  const now = time.nowLocal();

  if (!PLATE.test(plate) || key.length < 2) fields.plate_number = 'Enter the plate number you saw (3–12 letters or numbers, e.g. ABC 1234).';
  else if (db.prepare(`SELECT 1 FROM vehicles WHERE user_id = ? AND is_active = 1 AND ${keySql('plate_number')} = ?`).get(reporterId, key)) {
    fields.plate_number = 'That plate is one of your own vehicles.';
  }
  if (!violation) fields.violation_type = 'Choose the type of violation.';
  if (!zoneId || !activeZones().some((z) => z.id === zoneId)) fields.zone_id = 'Choose the parking zone where it happened.';
  if (description.length < 10) fields.description = 'Describe what happened in at least 10 characters.';
  else if (description.length > 1000) fields.description = 'Keep the description under 1,000 characters.';
  let incidentAt = null;
  if (!time.isValidDate(date)) fields.incident_date = 'Choose the date of the incident.';
  if (!time.isValidTime(hhmm)) fields.incident_time = 'Choose the time of the incident.';
  if (!fields.incident_date && !fields.incident_time) {
    incidentAt = `${date} ${hhmm}:00`;
    if (incidentAt > time.addMinutes(now, 5)) fields.incident_time = 'The incident cannot be in the future.';
    else if (incidentAt < time.addDays(now, -REPORT_WINDOW_DAYS)) fields.incident_date = `Incidents can be reported up to ${REPORT_WINDOW_DAYS} days later.`;
  }
  let photo = null;
  try {
    photo = evidence.parse(input.evidence_data);
  } catch (err) {
    if (!err.fields) throw err;
    Object.assign(fields, err.fields);
  }
  if (Object.keys(fields).length) throw invalid(fields);

  return immediate(db, () => {
    // Inside the write lock, so two quick submissions of the same form cannot both get through.
    const recent = db.prepare(`SELECT COUNT(*) AS n FROM etiquette_reports WHERE reporter_id = ? AND created_at > ?`).get(reporterId, time.addDays(now, -1)).n;
    if (recent >= DAILY_LIMIT) {
      throw new AppError(`You can send up to ${DAILY_LIMIT} reports a day. Please try again tomorrow.`, { code: 'LIMIT', status: 429 });
    }
    // The same incident sent twice: same reporter and plate, and either within an hour or the same violation that day.
    const dup = db
      .prepare(
        `SELECT id, incident_at FROM etiquette_reports
         WHERE reporter_id = @reporter AND plate_key = @key AND status <> 'dismissed'
           AND ((incident_at BETWEEN @from AND @to) OR (violation_type = @violation AND substr(incident_at, 1, 10) = @day))
         ORDER BY id DESC LIMIT 1`,
      )
      .get({ reporter: reporterId, key, from: time.addMinutes(incidentAt, -DUPLICATE_MINUTES), to: time.addMinutes(incidentAt, DUPLICATE_MINUTES), violation, day: date });
    if (dup) {
      throw invalid({ plate_number: `You already reported this vehicle for an incident at ${time.fmtDateTime(dup.incident_at)} (report #${dup.id}). Follow that report instead of sending it again.` });
    }
    if (photo) {
      const samePhoto = db
        .prepare(`SELECT e.report_id FROM etiquette_evidence e JOIN etiquette_reports r ON r.id = e.report_id WHERE e.sha256 = ? AND r.reporter_id = ? LIMIT 1`)
        .get(photo.sha256, reporterId);
      if (samePhoto) throw invalid({ evidence: `You already sent this photo with report #${samePhoto.report_id}.` });
    }

    const id = db
      .prepare(
        `INSERT INTO etiquette_reports (reporter_id, plate_number, plate_key, violation_type, zone_id, description, incident_at, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(reporterId, plate, key, violation, zoneId, description, incidentAt, now, now).lastInsertRowid;
    if (photo) {
      db.prepare('INSERT INTO etiquette_evidence (report_id, mime, size_bytes, sha256, data) VALUES (?, ?, ?, ?, ?)').run(id, photo.mime, photo.size, photo.sha256, photo.data);
    }
    audit.log(actor || reporterId, 'etiquette.submit', 'etiquette_report', id, {
      plate, violation: label(VIOLATIONS, violation), incident: incidentAt, zone: (activeZones().find((z) => z.id === zoneId) || {}).name, evidence: !!photo,
    });
    return getReport(id);
  });
}

// ---------------------------------------------------------------- administrator decisions

function loadForChange(db, id) {
  const report = getReport(id);
  if (!report) throw new AppError('Report not found.', { status: 404, code: 'NOT_FOUND' });
  return report;
}

function documentedReason(value, field, what) {
  const reason = collapse(value);
  if (reason.length < 5) throw invalid({ [field]: `Give the reason ${what} (at least 5 characters).` });
  if (reason.length > 1000) throw invalid({ [field]: 'Keep the reason under 1,000 characters.' });
  return reason;
}

function setStatus(db, report, status, reason, admin, action) {
  const now = time.nowLocal();
  db.prepare(
    `UPDATE etiquette_reports SET status = ?, admin_notes = COALESCE(?, admin_notes), reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?`,
  ).run(status, reason, admin.id, now, now, report.id);
  audit.log(admin, action, 'etiquette_report', report.id, {
    plate: report.plate_number, status: [label(STATUSES, report.status), label(STATUSES, status)], reason: reason || null,
  });
  return getReport(report.id);
}

function markUnderReview(id, admin) {
  const db = ctx.get();
  return immediate(db, () => {
    const report = loadForChange(db, id);
    if (report.status !== 'pending') throw new AppError(`This report is already ${report.status_label.toLowerCase()}.`, { code: 'INVALID_STATE', status: 409 });
    return setStatus(db, report, 'under_review', null, admin, 'etiquette.under_review');
  });
}

/** Approve: the violation is confirmed. A penalty is a separate, explicit decision afterwards. */
function approveReport(id, reasonIn, admin) {
  const db = ctx.get();
  return immediate(db, () => {
    const report = loadForChange(db, id);
    if (!report.can_decide) throw new AppError(`This report is already ${report.status_label.toLowerCase()}.`, { code: 'INVALID_STATE', status: 409 });
    return setStatus(db, report, 'resolved', documentedReason(reasonIn, 'reason', 'for approving the report'), admin, 'etiquette.resolve');
  });
}

function dismissReport(id, reasonIn, admin) {
  const db = ctx.get();
  return immediate(db, () => {
    const report = loadForChange(db, id);
    if (!report.can_decide) throw new AppError(`This report is already ${report.status_label.toLowerCase()}.`, { code: 'INVALID_STATE', status: 409 });
    if (report.active_penalty_count) throw new AppError('A penalty was issued for this report. Revoke it before dismissing the report.', { code: 'INVALID_STATE', status: 409 });
    return setStatus(db, report, 'dismissed', documentedReason(reasonIn, 'reason', 'for dismissing the report'), admin, 'etiquette.dismiss');
  });
}

/**
 * The administrator confirms which registered vehicle the reported plate is, from the existing vehicle records. The
 * plate must match exactly (spaces and hyphens ignored); nothing is assumed from a near match.
 */
function verifyVehicle(id, vehicleIdIn, admin) {
  const db = ctx.get();
  return immediate(db, () => {
    const report = loadForChange(db, id);
    if (!report.can_verify) {
      throw new AppError(report.penalty_count ? 'A penalty was issued for this report, so its vehicle can no longer change.' : 'This report was dismissed.', { code: 'INVALID_STATE', status: 409 });
    }
    const vehicle = getVehicle(toInt(vehicleIdIn));
    if (!vehicle) throw new AppError('Choose one of the registered vehicles listed.', { code: 'VALIDATION', status: 422 });
    if (plateMatchKey(vehicle.plate_number) !== report.plate_key) {
      throw new AppError(`Vehicle ${vehicle.plate_number} does not have the reported plate ${report.plate_number}.`, { code: 'VALIDATION', status: 422 });
    }
    if (vehicle.user_id === report.reporter_id) throw new AppError('That vehicle belongs to the driver who sent the report.', { code: 'VALIDATION', status: 422 });
    const now = time.nowLocal();
    db.prepare(`UPDATE etiquette_reports SET vehicle_id = ?, owner_id = ?, verified_by = ?, verified_at = ?, updated_at = ? WHERE id = ?`)
      .run(vehicle.id, vehicle.user_id, admin.id, now, now, report.id);
    audit.log(admin, 'etiquette.verify_vehicle', 'etiquette_report', report.id, { plate: vehicle.plate_number, owner: vehicle.owner_name });
    return getReport(report.id);
  });
}

module.exports = {
  VIOLATIONS,
  STATUSES,
  DRIVER_STATUS,
  REPORT_WINDOW_DAYS,
  PLATE,
  label,
  plateMatchKey,
  keySql,
  activeZones,
  getReport,
  getEvidence,
  listReports,
  countByStatus,
  possibleDuplicates,
  searchVehicles,
  vehiclesForPlate,
  getVehicle,
  submitReport,
  markUnderReview,
  approveReport,
  dismissReport,
  verifyVehicle,
};
