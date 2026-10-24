'use strict';

const ctx = require('../db/context');
const audit = require('./audit');
const time = require('../utils/time');
const { AppError } = require('../utils/errors');
const { clean, collapse, toInt, normalizePlate, plateKey, oneOf } = require('../utils/validate');
const { parsePesoToCentavos, formatPeso } = require('../utils/money');
const { paginate } = require('../utils/paginate');

/**
 * Parking etiquette reports and the penalties that follow them.
 *
 * A driver reports another vehicle by plate number. An administrator reviews the report (status, severity, notes) and
 * may penalise the plate:
 *   surcharge   a permanent additional fee added to every new reservation made with that plate (stored on the booking
 *               as reservations.surcharge_centavos and included in its estimated fee)
 *   temp_ban    the plate cannot be used for new reservations or reschedules until ends_at
 *   perm_ban    the plate cannot be used for new reservations or reschedules at all
 * Penalties belong to the plate (spaces ignored), not to a vehicle row, so removing and re-adding the vehicle does not
 * escape them. They can be lifted (with a reason), never deleted. Every decision is in the audit log.
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
  { value: 'pending', label: 'Pending' },
  { value: 'under_review', label: 'Under review' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'dismissed', label: 'Dismissed' },
];
const SEVERITIES = [
  { value: 'minor', label: 'Minor' },
  { value: 'moderate', label: 'Moderate' },
  { value: 'major', label: 'Major' },
  { value: 'severe', label: 'Severe' },
];
const PENALTY_KINDS = [
  { value: 'surcharge', label: 'Additional fee on every reservation' },
  { value: 'temp_ban', label: 'Temporary ban' },
  { value: 'perm_ban', label: 'Permanent ban' },
];

const label = (list, value) => (list.find((o) => o.value === value) || {}).label || value;
const PLATE = /^[A-Z0-9][A-Z0-9 -]{2,11}$/;
const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
const MAX_SURCHARGE = 500000; // ₱5,000
const REPORT_WINDOW_DAYS = 30;

// ---------------------------------------------------------------- evidence

const SIGNATURES = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};

/** A data: URL from the report form → { mime, data } (null when none was attached); throws when it is not a usable image. */
function parseEvidence(dataUrl) {
  const raw = String(dataUrl || '').trim();
  if (!raw) return null;
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(raw);
  const problem = (msg) => new AppError('Please correct the highlighted fields.', { code: 'VALIDATION', fields: { evidence: msg } });
  if (!m) throw problem('Attach a JPEG, PNG, WebP or GIF image.');
  const data = Buffer.from(m[2], 'base64');
  if (!data.length) throw problem('The image is empty.');
  if (data.length > MAX_EVIDENCE_BYTES) throw problem('The image must be 2 MB or smaller.');
  if (!SIGNATURES[m[1]](data)) throw problem('That file is not a valid image.');
  return { mime: m[1], data };
}

const getEvidence = (reportId) => ctx.get().prepare('SELECT mime, size_bytes, data FROM etiquette_evidence WHERE report_id = ?').get(reportId);

// ---------------------------------------------------------------- reports

const REPORT_SELECT = `
  SELECT r.*, u.full_name AS reporter_name, u.email AS reporter_email, rv.full_name AS reviewer_name,
         EXISTS (SELECT 1 FROM etiquette_evidence e WHERE e.report_id = r.id) AS has_evidence,
         (SELECT COUNT(*) FROM etiquette_reports o WHERE o.plate_key = r.plate_key) AS plate_report_count,
         (SELECT COUNT(*) FROM plate_penalties p WHERE p.plate_key = r.plate_key AND p.status = 'active') AS plate_active_penalties
  FROM etiquette_reports r
  JOIN users u ON u.id = r.reporter_id
  LEFT JOIN users rv ON rv.id = r.reviewed_by`;

const decorate = (r) => r && Object.assign(r, {
  violation_label: label(VIOLATIONS, r.violation_type),
  status_label: label(STATUSES, r.status),
  severity_label: r.severity ? label(SEVERITIES, r.severity) : null,
  has_evidence: !!r.has_evidence,
});

const getReport = (id) => decorate(ctx.get().prepare(`${REPORT_SELECT} WHERE r.id = ?`).get(id));

function submitReport(reporterId, input, actor) {
  const db = ctx.get();
  const fields = {};
  const plate = normalizePlate(input.plate_number);
  const violation = oneOf(clean(input.violation_type), VIOLATIONS.map((v) => v.value));
  const description = collapse(input.description);
  const date = clean(input.incident_date);
  const hhmm = clean(input.incident_time);
  const now = time.nowLocal();

  if (!PLATE.test(plate)) fields.plate_number = 'Enter the plate number you saw (3–12 letters/numbers, e.g. ABC 1234).';
  else if (db.prepare(`SELECT 1 FROM vehicles WHERE user_id = ? AND is_active = 1 AND replace(plate_number, ' ', '') = ?`).get(reporterId, plateKey(plate))) {
    fields.plate_number = 'That plate is one of your own vehicles.';
  }
  if (!violation) fields.violation_type = 'Choose the type of violation.';
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
  let evidence = null;
  try {
    evidence = parseEvidence(input.evidence_data);
  } catch (err) {
    Object.assign(fields, err.fields);
  }
  if (Object.keys(fields).length) throw new AppError('Please correct the highlighted fields.', { code: 'VALIDATION', fields });

  return db.transaction(() => {
    const id = db
      .prepare(
        `INSERT INTO etiquette_reports (reporter_id, plate_number, plate_key, violation_type, description, incident_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(reporterId, plate, plateKey(plate), violation, description, incidentAt, now, now).lastInsertRowid;
    if (evidence) db.prepare('INSERT INTO etiquette_evidence (report_id, mime, size_bytes, data) VALUES (?, ?, ?, ?)').run(id, evidence.mime, evidence.data.length, evidence.data);
    audit.log(actor || reporterId, 'etiquette.submit', 'etiquette_report', id, { plate, violation: label(VIOLATIONS, violation), incident: incidentAt, evidence: !!evidence });
    return getReport(id);
  })();
}

function listReports({ reporterId = null, status = '', q = '', plate = '' } = {}, { page = 1, perPage = 15 } = {}) {
  const where = [];
  const params = [];
  if (reporterId) {
    where.push('r.reporter_id = ?');
    params.push(reporterId);
  }
  if (status) {
    where.push('r.status = ?');
    params.push(status);
  }
  if (plate) {
    where.push('r.plate_key = ?');
    params.push(plateKey(plate));
  }
  if (q) {
    where.push(`(r.plate_key LIKE ? OR r.description LIKE ? OR u.full_name LIKE ?)`);
    params.push(`%${plateKey(q)}%`, `%${q}%`, `%${q}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const db = ctx.get();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM etiquette_reports r JOIN users u ON u.id = r.reporter_id ${whereSql}`).get(...params).n;
  const pager = paginate(total, page, perPage);
  // Open reports first (pending, then under review), newest first within each status.
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

const countByStatus = () =>
  Object.fromEntries(ctx.get().prepare('SELECT status, COUNT(*) AS n FROM etiquette_reports GROUP BY status').all().map((r) => [r.status, r.n]));

function reviewReport(id, input, admin) {
  const db = ctx.get();
  const report = getReport(id);
  if (!report) throw new AppError('Report not found.', { status: 404, code: 'NOT_FOUND' });
  const fields = {};
  const status = oneOf(clean(input.status), STATUSES.map((s) => s.value));
  const severityIn = clean(input.severity);
  const severity = severityIn ? oneOf(severityIn, SEVERITIES.map((s) => s.value)) : null;
  const notes = collapse(input.admin_notes);
  if (!status) fields.status = 'Choose a status.';
  if (severityIn && !severity) fields.severity = 'Choose a severity.';
  if (notes.length > 1000) fields.admin_notes = 'Keep notes under 1,000 characters.';
  if (status === 'dismissed' && !notes) fields.admin_notes = 'Say why the report is dismissed.';
  if (Object.keys(fields).length) throw new AppError('Please correct the highlighted fields.', { code: 'VALIDATION', fields });
  const now = time.nowLocal();
  db.prepare(
    `UPDATE etiquette_reports SET status = ?, severity = ?, admin_notes = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?`,
  ).run(status, severity, notes || null, admin.id, now, now, id);
  audit.log(admin, 'etiquette.review', 'etiquette_report', id, {
    plate: report.plate_number,
    status: report.status === status ? label(STATUSES, status) : [label(STATUSES, report.status), label(STATUSES, status)],
    severity: severity ? label(SEVERITIES, severity) : null,
    notes: notes || null,
  });
  return getReport(id);
}

// ---------------------------------------------------------------- penalties

const PENALTY_SELECT = `
  SELECT p.*, cu.full_name AS created_by_name, lu.full_name AS lifted_by_name
  FROM plate_penalties p
  LEFT JOIN users cu ON cu.id = p.created_by
  LEFT JOIN users lu ON lu.id = p.lifted_by`;

/** Active right now: not lifted, started, and (for a temporary ban) not yet over. */
const ACTIVE_SQL = `p.status = 'active' AND p.starts_at <= @now AND (p.ends_at IS NULL OR p.ends_at > @now)`;

function decoratePenalty(p, now = time.nowLocal()) {
  if (!p) return p;
  const expired = p.status === 'active' && p.ends_at && p.ends_at <= now;
  return Object.assign(p, {
    kind_label: label(PENALTY_KINDS, p.kind),
    state: p.status === 'lifted' ? 'lifted' : expired ? 'expired' : 'active',
    summary: p.kind === 'surcharge' ? `${formatPeso(p.amount_centavos)} added to every reservation`
      : p.kind === 'temp_ban' ? `No reservations until ${time.fmtDateTime(p.ends_at)}`
      : 'No reservations, permanently',
  });
}

const getPenalty = (id) => decoratePenalty(ctx.get().prepare(`${PENALTY_SELECT} WHERE p.id = ?`).get(id));

function penaltiesForPlate(plate) {
  const now = time.nowLocal();
  return ctx.get().prepare(`${PENALTY_SELECT} WHERE p.plate_key = ? ORDER BY p.created_at DESC, p.id DESC`).all(plateKey(plate)).map((p) => decoratePenalty(p, now));
}

/** The ban that stops this plate from booking right now (a permanent one first), or null. */
function activeBan(plate) {
  const row = ctx.get()
    .prepare(`${PENALTY_SELECT} WHERE p.plate_key = @key AND p.kind IN ('temp_ban', 'perm_ban') AND ${ACTIVE_SQL} ORDER BY p.kind = 'perm_ban' DESC, p.ends_at DESC LIMIT 1`)
    .get({ key: plateKey(plate), now: time.nowLocal() });
  return decoratePenalty(row) || null;
}

/** Total additional fee (centavos) that every new reservation with this plate carries. */
function activeSurcharge(plate) {
  return ctx.get()
    .prepare(`SELECT COALESCE(SUM(p.amount_centavos), 0) AS t FROM plate_penalties p WHERE p.plate_key = @key AND p.kind = 'surcharge' AND ${ACTIVE_SQL}`)
    .get({ key: plateKey(plate), now: time.nowLocal() }).t;
}

/** The message shown when a banned plate tries to book. */
function banMessage(plate, ban) {
  return ban.kind === 'perm_ban'
    ? `Vehicle ${plate} is permanently banned from parking reservations for violating parking rules. Contact parking administration if you think this is a mistake.`
    : `Vehicle ${plate} is banned from parking reservations until ${time.fmtDateTime(ban.ends_at)} for violating parking rules.`;
}

function applyPenalty({ plate: plateIn, reportId = null, kind: kindIn, amount, days, reason: reasonIn }, admin) {
  const db = ctx.get();
  const fields = {};
  const plate = normalizePlate(plateIn);
  const kind = oneOf(clean(kindIn), PENALTY_KINDS.map((k) => k.value));
  const reason = collapse(reasonIn);
  const report = reportId ? getReport(toInt(reportId)) : null;
  if (reportId && !report) throw new AppError('Report not found.', { status: 404, code: 'NOT_FOUND' });
  if (report && report.plate_key !== plateKey(plate)) throw new AppError('That report is about a different plate.', { code: 'VALIDATION' });
  if (!PLATE.test(plate)) fields.plate_number = 'Enter a valid plate number.';
  if (!kind) fields.kind = 'Choose a penalty.';
  if (reason.length < 5) fields.reason = 'Give the reason for this penalty (at least 5 characters).';
  else if (reason.length > 500) fields.reason = 'Keep the reason under 500 characters.';
  let amountCentavos = null;
  let dayCount = null;
  if (kind === 'surcharge') {
    amountCentavos = parsePesoToCentavos(amount);
    if (!amountCentavos || amountCentavos > MAX_SURCHARGE) fields.amount = `Enter an amount from ₱1 to ${formatPeso(MAX_SURCHARGE)}.`;
  }
  if (kind === 'temp_ban') {
    dayCount = toInt(days);
    if (!dayCount || dayCount < 1 || dayCount > 365) fields.days = 'Enter a number of days from 1 to 365.';
  }
  if (!fields.plate_number && (kind === 'temp_ban' || kind === 'perm_ban')) {
    const ban = activeBan(plate);
    if (ban && ban.kind === 'perm_ban') fields.kind = `${plate} is already permanently banned.`;
  }
  if (Object.keys(fields).length) throw new AppError('Please correct the highlighted fields.', { code: 'VALIDATION', fields });

  const now = time.nowLocal();
  const endsAt = kind === 'temp_ban' ? time.addDays(now, dayCount) : null;
  const id = db
    .prepare(
      `INSERT INTO plate_penalties (plate_number, plate_key, report_id, kind, amount_centavos, starts_at, ends_at, reason, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(plate, plateKey(plate), report ? report.id : null, kind, amountCentavos, now, endsAt, reason, admin.id, now).lastInsertRowid;
  audit.log(admin, 'penalty.apply', 'plate_penalty', id, {
    plate, penalty: label(PENALTY_KINDS, kind), amount: amountCentavos, until: endsAt, report: report ? report.id : null, reason,
  });
  return getPenalty(id);
}

function liftPenalty(id, reasonIn, admin) {
  const penalty = getPenalty(id);
  if (!penalty) throw new AppError('Penalty not found.', { status: 404, code: 'NOT_FOUND' });
  if (penalty.state !== 'active') throw new AppError('This penalty is no longer active.', { code: 'INVALID_STATE', status: 409 });
  const reason = collapse(reasonIn);
  if (reason.length < 5) throw new AppError('Please correct the highlighted fields.', { code: 'VALIDATION', fields: { lift_reason: 'Say why the penalty is lifted (at least 5 characters).' } });
  const now = time.nowLocal();
  ctx.get().prepare(`UPDATE plate_penalties SET status = 'lifted', lifted_by = ?, lifted_at = ?, lift_reason = ? WHERE id = ?`).run(admin.id, now, reason, id);
  audit.log(admin, 'penalty.lift', 'plate_penalty', id, { plate: penalty.plate_number, penalty: penalty.kind_label, reason });
  return getPenalty(id);
}

/** Penalties (any state) on the plates of a driver's registered vehicles, newest first. */
function penaltiesForDriver(userId) {
  const now = time.nowLocal();
  return ctx.get()
    .prepare(
      `${PENALTY_SELECT} WHERE p.plate_key IN (SELECT replace(plate_number, ' ', '') FROM vehicles WHERE user_id = ? AND is_active = 1)
       ORDER BY p.created_at DESC, p.id DESC`,
    )
    .all(userId)
    .map((p) => decoratePenalty(p, now));
}

/** A plate as it is usually written (its registered or reported spelling, e.g. "BBB 3333" for "bbb3333"). */
function displayPlate(plate) {
  const key = plateKey(plate);
  const known = ctx.get().prepare(
    `SELECT plate_number FROM vehicles WHERE replace(plate_number, ' ', '') = @key
     UNION ALL SELECT plate_number FROM etiquette_reports WHERE plate_key = @key
     UNION ALL SELECT plate_number FROM plate_penalties WHERE plate_key = @key LIMIT 1`,
  ).get({ key });
  return known ? known.plate_number : normalizePlate(plate);
}

/** Everything known about a plate: who has it registered, its reports and its penalties. */
function plateHistory(plate) {
  const key = plateKey(plate);
  const db = ctx.get();
  return {
    plate: displayPlate(plate),
    key,
    vehicles: db
      .prepare(
        `SELECT v.*, u.full_name AS owner_name, u.email AS owner_email FROM vehicles v JOIN users u ON u.id = v.user_id
         WHERE replace(v.plate_number, ' ', '') = ? ORDER BY v.is_active DESC, v.created_at DESC`,
      )
      .all(key),
    reports: db.prepare(`${REPORT_SELECT} WHERE r.plate_key = ? ORDER BY r.created_at DESC, r.id DESC`).all(key).map(decorate),
    penalties: penaltiesForPlate(plate),
    ban: activeBan(plate),
    surcharge: activeSurcharge(plate),
  };
}

module.exports = {
  VIOLATIONS,
  STATUSES,
  SEVERITIES,
  PENALTY_KINDS,
  MAX_EVIDENCE_BYTES,
  parseEvidence,
  getEvidence,
  getReport,
  submitReport,
  listReports,
  countByStatus,
  reviewReport,
  getPenalty,
  penaltiesForPlate,
  penaltiesForDriver,
  activeBan,
  activeSurcharge,
  banMessage,
  applyPenalty,
  liftPenalty,
  displayPlate,
  plateHistory,
};
