'use strict';

const ctx = require('../db/context');
const { immediate } = require('../db');
const audit = require('./audit');
const evidence = require('./evidence');
const etiquette = require('./etiquette');
const time = require('../utils/time');
const { AppError } = require('../utils/errors');
const { clean, collapse, toInt, oneOf } = require('../utils/validate');
const { parsePesoToCentavos, formatPeso } = require('../utils/money');
const { paginate } = require('../utils/paginate');

/**
 * Penalties an administrator issues against a driver account, through a registered vehicle whose ownership was
 * verified from the vehicle records. Submitting a report never creates one.
 *
 *   fee_once    a one-time fee: added to the driver's next new reservation (or, by an explicit administrator action, to
 *               one of their unpaid upcoming bookings). A unique index allows one applied charge, so it is never
 *               charged twice. If that booking is later cancelled free of charge, the fee is released and waits for
 *               the next booking.
 *   surcharge   added to every new reservation the account makes until its expiry date (ends_at), or until revoked
 *               when it has none. One active surcharge per account: change its amount instead of adding another.
 *   temp_ban    no new reservations or reschedules from the start date to the end date (inclusive); it ends by itself.
 *   perm_ban    no new reservations or reschedules until an administrator revokes it. One per account.
 *
 * Bans are checked in reservations.createReservation / rescheduleReservation (the backend), for the penalised account
 * with any of its vehicles, and for the penalised plate with any account (so re-registering the vehicle elsewhere is
 * no way around it; that other account is not penalised in any other way). Existing bookings are never cancelled by a
 * new ban, and fees never change a booking that already exists, except by the explicit actions below.
 *
 * Every decision runs in one IMMEDIATE transaction, is written to the audit log and to penalty_events, and notifies the
 * driver (the audit entries feed the sidebar notifications, src/services/notifications.js).
 */

const KINDS = [
  { value: 'fee_once', label: 'One-time penalty fee' },
  { value: 'surcharge', label: 'Recurring surcharge' },
  { value: 'temp_ban', label: 'Temporary ban' },
  { value: 'perm_ban', label: 'Permanent ban' },
];
const STATES = [
  { value: 'pending', label: 'Awaiting charge' },
  { value: 'charged', label: 'Charged' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'active', label: 'Active' },
  { value: 'expired', label: 'Expired' },
  { value: 'revoked', label: 'Revoked' },
];
const APPEAL_STATUSES = [
  { value: 'pending', label: 'Awaiting decision' },
  { value: 'upheld', label: 'Upheld' },
  { value: 'revoked', label: 'Penalty revoked' },
];

const BANS = ['temp_ban', 'perm_ban'];
const FEES = ['fee_once', 'surcharge'];
const MAX_FEE = 500000; // ₱5,000
const MAX_BAN_DAYS = 365;

const label = etiquette.label;
const invalid = (fields) => new AppError('Please correct the highlighted fields.', { code: 'VALIDATION', fields });
const notFound = () => new AppError('Penalty not found.', { status: 404, code: 'NOT_FOUND' });
const dayStart = (date) => `${date} 00:00:00`;
/** The last day a [starts_at, ends_at) period covers. */
const lastDay = (endsAt) => time.addDays(endsAt, -1).slice(0, 10);

// ---------------------------------------------------------------- reading

const STATE_SQL = `
  CASE WHEN p.status = 'revoked' THEN 'revoked'
       WHEN p.kind = 'fee_once' THEN
         CASE WHEN EXISTS (SELECT 1 FROM penalty_charges c WHERE c.penalty_id = p.id AND c.status = 'applied') THEN 'charged' ELSE 'pending' END
       WHEN p.kind = 'temp_ban' AND p.starts_at > @now THEN 'scheduled'
       WHEN p.ends_at IS NOT NULL AND p.ends_at <= @now THEN 'expired'
       ELSE 'active' END`;

const PENALTY_SELECT = `
  SELECT p.*, ${STATE_SQL} AS state,
         u.full_name AS driver_name, u.email AS driver_email, ib.full_name AS issued_by_name, rb.full_name AS revoked_by_name,
         r.violation_type, r.incident_at, r.status AS report_status, z.name AS zone_name,
         a.id AS appeal_id, a.status AS appeal_status,
         (SELECT c.reservation_id FROM penalty_charges c WHERE c.penalty_id = p.id AND c.kind = 'fee_once' AND c.status = 'applied') AS charged_reservation_id,
         (SELECT res.booking_ref FROM penalty_charges c JOIN reservations res ON res.id = c.reservation_id
           WHERE c.penalty_id = p.id AND c.kind = 'fee_once' AND c.status = 'applied') AS charged_ref,
         (SELECT COUNT(*) FROM penalty_charges c WHERE c.penalty_id = p.id AND c.status = 'applied') AS charge_count,
         (SELECT COALESCE(SUM(c.amount_centavos), 0) FROM penalty_charges c WHERE c.penalty_id = p.id AND c.status = 'applied') AS charged_total
  FROM penalties p
  JOIN users u ON u.id = p.user_id
  LEFT JOIN users ib ON ib.id = p.issued_by
  LEFT JOIN users rb ON rb.id = p.revoked_by
  LEFT JOIN etiquette_reports r ON r.id = p.report_id
  LEFT JOIN parking_zones z ON z.id = r.zone_id
  LEFT JOIN penalty_appeals a ON a.penalty_id = p.id`;

function summaryOf(p) {
  switch (p.kind) {
    case 'fee_once':
      return `${formatPeso(p.amount_centavos)} one-time fee${p.charged_ref ? `, charged to booking ${p.charged_ref}` : p.status === 'active' ? ', added to the next reservation' : ''}`;
    case 'surcharge':
      return `${formatPeso(p.amount_centavos)} added to every new reservation${p.ends_at ? ` until ${time.fmtDate(lastDay(p.ends_at))}` : ' until revoked'}`;
    case 'temp_ban':
      return `No new reservations from ${time.fmtDate(p.starts_at)} to ${time.fmtDate(lastDay(p.ends_at))}`;
    default:
      return 'No new reservations until revoked';
  }
}

function decorate(p) {
  if (!p) return p;
  const days = p.kind === 'temp_ban' ? Math.round(time.diffMinutes(p.ends_at, p.starts_at) / 1440) : null;
  return Object.assign(p, {
    kind_label: label(KINDS, p.kind),
    state_label: label(STATES, p.state),
    violation_label: p.violation_type ? label(etiquette.VIOLATIONS, p.violation_type) : null,
    summary: summaryOf(p),
    is_ban: BANS.includes(p.kind),
    is_fee: FEES.includes(p.kind),
    ban_days: days,
    duration_text: p.kind === 'temp_ban' ? `${days} day${days === 1 ? '' : 's'}` : p.kind === 'perm_ban' ? 'Indefinite, until revoked' : null,
    start_date: p.starts_at.slice(0, 10),
    end_date: p.kind === 'temp_ban' && p.ends_at ? lastDay(p.ends_at) : '',
    expires_date: p.kind === 'surcharge' && p.ends_at ? lastDay(p.ends_at) : '',
    in_force: ['active', 'pending', 'scheduled'].includes(p.state),
    can_modify: p.status === 'active',
    can_revoke: p.status === 'active',
    can_appeal: p.status === 'active' && !p.appeal_id,
  });
}

const select = (where, params = {}, tail = '') =>
  ctx.get().prepare(`${PENALTY_SELECT} ${where} ${tail}`).all(Object.assign({ now: time.nowLocal() }, params)).map(decorate);

const getPenalty = (id) => select('WHERE p.id = @id', { id })[0] || null;
const penaltiesForUser = (userId) => select('WHERE p.user_id = @user', { user: userId }, 'ORDER BY p.status = \'active\' DESC, p.issued_at DESC, p.id DESC');
const penaltiesForPlate = (plate) => select('WHERE p.plate_key = @key', { key: etiquette.plateMatchKey(plate) }, 'ORDER BY p.issued_at DESC, p.id DESC');
const penaltiesForReport = (reportId) => select('WHERE p.report_id = @report', { report: reportId }, 'ORDER BY p.id DESC');

function listPenalties({ q = '', kind = '', state = '', userId = null } = {}, { page = 1, perPage = 15 } = {}) {
  const where = [];
  const params = { now: time.nowLocal() };
  if (userId) {
    where.push('p.user_id = @user');
    params.user = userId;
  }
  if (KINDS.some((k) => k.value === kind)) {
    where.push('p.kind = @kind');
    params.kind = kind;
  }
  if (state === 'in_force') where.push(`(${STATE_SQL}) IN ('active', 'pending', 'scheduled')`);
  else if (STATES.some((s) => s.value === state)) {
    where.push(`(${STATE_SQL}) = @state`);
    params.state = state;
  }
  if (q) {
    where.push(`(p.plate_key LIKE @plate OR u.full_name LIKE @q OR u.email LIKE @q OR p.reason LIKE @q)`);
    params.plate = `%${etiquette.plateMatchKey(q)}%`;
    params.q = `%${q}%`;
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const db = ctx.get();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM penalties p JOIN users u ON u.id = p.user_id ${whereSql}`).get(params).n;
  const pager = paginate(total, page, perPage);
  const rows = db
    .prepare(`${PENALTY_SELECT} ${whereSql} ORDER BY p.status = 'active' DESC, p.issued_at DESC, p.id DESC LIMIT @limit OFFSET @offset`)
    .all(Object.assign(params, { limit: pager.perPage, offset: pager.offset }))
    .map(decorate);
  return { rows, pager };
}

function countInForce() {
  return ctx.get().prepare(`SELECT COUNT(*) AS n FROM penalties p WHERE (${STATE_SQL}) IN ('active', 'pending', 'scheduled')`).get({ now: time.nowLocal() }).n;
}

function events(penaltyId) {
  return ctx.get()
    .prepare(`SELECT e.*, u.full_name AS actor_name FROM penalty_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.penalty_id = ? ORDER BY e.id DESC`)
    .all(penaltyId)
    .map((e) => Object.assign(e, { data: e.details ? JSON.parse(e.details) : {} }));
}

function charges(penaltyId) {
  return ctx.get()
    .prepare(
      `SELECT c.*, r.booking_ref, r.status AS reservation_status, r.start_at,
              COALESCE((SELECT SUM(pm.amount_centavos) FROM payments pm WHERE pm.reservation_id = r.id AND pm.status = 'valid'), 0) AS paid_centavos
       FROM penalty_charges c JOIN reservations r ON r.id = c.reservation_id WHERE c.penalty_id = ? ORDER BY c.id DESC`,
    )
    .all(penaltyId);
}

/** Penalty fees on one booking (for the fee breakdown on reservation pages). */
function chargesForReservation(reservationId) {
  return ctx.get()
    .prepare(
      `SELECT c.*, p.reason, p.kind AS penalty_kind FROM penalty_charges c JOIN penalties p ON p.id = c.penalty_id
       WHERE c.reservation_id = ? ORDER BY c.id`,
    )
    .all(reservationId)
    .map((c) => Object.assign(c, { kind_label: label(KINDS, c.kind) }));
}

/** The driver's bookings that are still upcoming (kept when a ban is issued; listed so staff can act on them). */
function upcomingReservations(userId) {
  return ctx.get()
    .prepare(
      `SELECT r.id, r.booking_ref, r.start_at, r.end_at, r.status, r.fee_estimated_centavos, r.surcharge_centavos,
              COALESCE((SELECT SUM(pm.amount_centavos) FROM payments pm WHERE pm.reservation_id = r.id AND pm.status = 'valid'), 0) AS paid_centavos
       FROM reservations r WHERE r.user_id = ? AND r.status IN ('confirmed', 'checked_in') ORDER BY r.start_at`,
    )
    .all(userId);
}

// ---------------------------------------------------------------- enforcement (used by reservations.js)

/** The ban that stops this account, or this plate, from booking right now (a permanent one first), or null. */
function activeBan(userId, plate, db = ctx.get()) {
  const row = db
    .prepare(
      `${PENALTY_SELECT} WHERE p.status = 'active' AND p.kind IN ('temp_ban', 'perm_ban')
         AND p.starts_at <= @now AND (p.ends_at IS NULL OR p.ends_at > @now)
         AND (p.user_id = @user OR p.plate_key = @key)
       ORDER BY p.kind = 'perm_ban' DESC, p.ends_at DESC LIMIT 1`,
    )
    .get({ now: time.nowLocal(), user: userId || 0, key: plate ? etiquette.plateMatchKey(plate) : '' });
  return decorate(row) || null;
}

function banMessage(ban, userId) {
  const own = ban.user_id === userId;
  const subject = own ? 'Your account' : `Vehicle ${ban.plate_number}`;
  return ban.kind === 'perm_ban'
    ? `${subject} is banned from new parking reservations until parking administration lifts the ban.${own ? ' See Etiquette Reports for the details and to appeal.' : ''}`
    : `${subject} is banned from new parking reservations until ${time.fmtDate(lastDay(ban.ends_at))} (inclusive).${own ? ' See Etiquette Reports for the details and to appeal.' : ''}`;
}

/** Throws (403, code BANNED) when the account or the plate is under an active ban. */
function assertCanBook(userId, plate, db = ctx.get()) {
  const ban = activeBan(userId, plate, db);
  if (ban) throw new AppError(banMessage(ban, userId), { code: 'BANNED', status: 403 });
}

/** The penalty fees a new booking by this account carries right now: the active surcharge and any uncharged one-time fees. */
function bookingCharges(userId, db = ctx.get()) {
  return db
    .prepare(
      `SELECT p.id AS penalty_id, p.kind, p.amount_centavos FROM penalties p
       WHERE p.user_id = @user AND p.status = 'active' AND (
         (p.kind = 'surcharge' AND p.starts_at <= @now AND (p.ends_at IS NULL OR p.ends_at > @now))
         OR (p.kind = 'fee_once' AND NOT EXISTS (SELECT 1 FROM penalty_charges c WHERE c.penalty_id = p.id AND c.status = 'applied')))
       ORDER BY p.kind = 'surcharge' DESC, p.id`,
    )
    .all({ user: userId, now: time.nowLocal() })
    .map((c) => Object.assign(c, { kind_label: label(KINDS, c.kind) }));
}

function event(db, penaltyId, action, actor, details) {
  const auditId = details && details.auditId ? details.auditId : null;
  const payload = Object.assign({}, details);
  delete payload.auditId;
  db.prepare('INSERT INTO penalty_events (penalty_id, action, actor_id, details, audit_log_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(penaltyId, action, actor && typeof actor === 'object' ? actor.id : actor || null, JSON.stringify(payload), auditId, time.nowLocal());
}

/** Audit log entry, returning its id so the penalty event can point at it. */
function logAudit(db, actor, action, entityType, entityId, details) {
  audit.log(actor, action, entityType, entityId, details);
  return db.prepare('SELECT last_insert_rowid() AS id').get().id;
}

/** Record the penalty fees a new booking carries (inside the booking's transaction). */
function applyCharges(db, reservationId, list, actor) {
  const now = time.nowLocal();
  const insert = db.prepare(
    `INSERT INTO penalty_charges (penalty_id, reservation_id, kind, amount_centavos, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'applied', ?, ?)`,
  );
  for (const c of list) {
    insert.run(c.penalty_id, reservationId, c.kind, c.amount_centavos, now, now);
    event(db, c.penalty_id, 'charged', actor, { reservation_id: reservationId, amount: c.amount_centavos });
  }
}

/** A booking cancelled at no charge collects no penalty fee: its one-time fees wait for the next booking again. */
function releaseCharges(db, reservationId, actor) {
  const now = time.nowLocal();
  const applied = db.prepare(`SELECT * FROM penalty_charges WHERE reservation_id = ? AND status = 'applied'`).all(reservationId);
  for (const c of applied) {
    db.prepare(`UPDATE penalty_charges SET status = 'released', updated_at = ? WHERE id = ?`).run(now, c.id);
    event(db, c.penalty_id, 'released', actor, { reservation_id: reservationId, amount: c.amount_centavos });
  }
  return applied.length;
}

// ---------------------------------------------------------------- issuing and changing

function parseAmount(value, fields) {
  const amount = parsePesoToCentavos(value);
  if (!amount || amount > MAX_FEE) fields.amount = `Enter an amount from ₱1.00 to ${formatPeso(MAX_FEE)}.`;
  return amount;
}

/** Start and end dates of a temporary ban → [starts_at, ends_at). `keepStart` allows an unchanged start in the past. */
function parseBanDates(input, fields, { keepStart = null } = {}) {
  const start = clean(input.start_date);
  const end = clean(input.end_date);
  const today = time.todayLocal();
  if (!time.isValidDate(start)) fields.start_date = 'Choose the first day of the ban.';
  else if (start < today && start !== keepStart) fields.start_date = 'The ban cannot start in the past.';
  if (!time.isValidDate(end)) fields.end_date = 'Choose the last day of the ban.';
  else if (end < today) fields.end_date = 'The last day cannot be in the past.';
  else if (!fields.start_date && end < start) fields.end_date = 'The last day must be on or after the first day.';
  if (fields.start_date || fields.end_date) return {};
  const startsAt = dayStart(start);
  const endsAt = dayStart(time.addDays(dayStart(end), 1).slice(0, 10));
  if (time.diffMinutes(endsAt, startsAt) / 1440 > MAX_BAN_DAYS) {
    fields.end_date = `A temporary ban lasts at most ${MAX_BAN_DAYS} days. Use a permanent ban for longer.`;
    return {};
  }
  return { startsAt, endsAt };
}

function parseExpiry(input, fields) {
  const value = clean(input.expires_on);
  if (!value) return null;
  if (!time.isValidDate(value)) fields.expires_on = 'Choose a valid date, or leave it empty to keep the surcharge until revoked.';
  else if (value < time.todayLocal()) fields.expires_on = 'The expiry date cannot be in the past.';
  else return dayStart(time.addDays(dayStart(value), 1).slice(0, 10));
  return null;
}

function parseReason(value, fields, field = 'reason') {
  const reason = collapse(value);
  if (reason.length < 5) fields[field] = 'Give the reason (at least 5 characters). The driver sees it.';
  else if (reason.length > 1000) fields[field] = 'Keep the reason under 1,000 characters.';
  return reason;
}

/** Conflicts with the account's other penalties of the same kind (shared by issue and modify). */
function overlapProblem(db, kind, userId, { startsAt, endsAt, excludeId = 0 }) {
  const now = time.nowLocal();
  if (kind === 'perm_ban' || kind === 'temp_ban') {
    const perm = db.prepare(`SELECT id FROM penalties WHERE user_id = ? AND kind = 'perm_ban' AND status = 'active' AND id <> ?`).get(userId, excludeId);
    if (perm) return `This account is already permanently banned (penalty #${perm.id}).`;
  }
  if (kind === 'temp_ban') {
    const clash = db
      .prepare(
        `SELECT id, starts_at, ends_at FROM penalties WHERE user_id = ? AND kind = 'temp_ban' AND status = 'active' AND id <> ?
           AND ends_at > ? AND starts_at < ? AND ends_at > ? LIMIT 1`,
      )
      .get(userId, excludeId, now, endsAt, startsAt);
    if (clash) return `It overlaps temporary ban #${clash.id} (${time.fmtDate(clash.starts_at)} – ${time.fmtDate(lastDay(clash.ends_at))}). Change that ban instead.`;
  }
  if (kind === 'surcharge') {
    const other = db
      .prepare(`SELECT id FROM penalties WHERE user_id = ? AND kind = 'surcharge' AND status = 'active' AND id <> ? AND (ends_at IS NULL OR ends_at > ?)`)
      .get(userId, excludeId, now);
    if (other) return `This account already has an active recurring surcharge (penalty #${other.id}). Change its amount instead of adding another.`;
  }
  return null;
}

/**
 * Issue a penalty. `reportId` (optional) must be an approved report whose vehicle was verified; otherwise `vehicleId`
 * names the registered vehicle directly (from the vehicle lookup). The account penalised is that vehicle's owner.
 */
function issuePenalty(input, admin) {
  const db = ctx.get();
  return immediate(db, () => {
    const fields = {};
    const report = input.report_id ? etiquette.getReport(toInt(input.report_id)) : null;
    if (input.report_id && !report) throw new AppError('Report not found.', { status: 404, code: 'NOT_FOUND' });
    if (report && report.status !== 'resolved') throw new AppError('Approve the report before issuing a penalty for it.', { code: 'INVALID_STATE', status: 409 });
    if (report && !report.vehicle_id) throw new AppError('Verify which registered vehicle the report is about before issuing a penalty.', { code: 'INVALID_STATE', status: 409 });
    const vehicleId = report ? report.vehicle_id : toInt(input.vehicle_id);
    const vehicle = vehicleId ? etiquette.getVehicle(vehicleId) : null;
    if (!vehicle) throw new AppError('Choose a registered vehicle to penalise.', { code: 'VALIDATION', status: 422 });
    if (vehicle.owner_role !== 'driver') throw new AppError('Only driver accounts can be penalised.', { code: 'VALIDATION', status: 422 });

    const kind = oneOf(clean(input.kind), KINDS.map((k) => k.value));
    if (!kind) fields.kind = 'Choose a penalty type.';
    const reason = parseReason(input.reason, fields);
    let amount = null;
    let startsAt = time.nowLocal();
    let endsAt = null;
    if (FEES.includes(kind)) amount = parseAmount(input.amount, fields);
    if (kind === 'surcharge') endsAt = parseExpiry(input, fields);
    if (kind === 'temp_ban') {
      const dates = parseBanDates(input, fields);
      if (dates.startsAt) {
        // A ban starting today takes effect immediately.
        startsAt = dates.startsAt < startsAt ? startsAt : dates.startsAt;
        endsAt = dates.endsAt;
      }
    }
    if (kind && !Object.keys(fields).length) {
      const problem = overlapProblem(db, kind, vehicle.user_id, { startsAt, endsAt });
      if (problem) fields.kind = problem;
      else if (report && db.prepare(`SELECT 1 FROM penalties WHERE report_id = ? AND kind = ? AND status = 'active'`).get(report.id, kind)) {
        fields.kind = `This report already has an active ${label(KINDS, kind).toLowerCase()}.`;
      }
    }
    if (Object.keys(fields).length) throw invalid(fields);

    const now = time.nowLocal();
    const id = db
      .prepare(
        `INSERT INTO penalties (user_id, vehicle_id, plate_number, plate_key, report_id, kind, amount_centavos, starts_at, ends_at, reason,
           status, issued_by, issued_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(vehicle.user_id, vehicle.id, vehicle.plate_number, etiquette.plateMatchKey(vehicle.plate_number), report ? report.id : null, kind, amount,
        startsAt, endsAt, reason, admin.id, now, now).lastInsertRowid;
    const details = {
      driver: vehicle.owner_name, plate: vehicle.plate_number, penalty: label(KINDS, kind), amount, from: kind === 'temp_ban' ? startsAt : null,
      until: endsAt ? lastDay(endsAt) : null, report: report ? report.id : null, reason,
    };
    event(db, id, 'issued', admin, Object.assign({ auditId: logAudit(db, admin, 'penalty.issue', 'penalty', id, details) }, details));
    return getPenalty(id);
  });
}

/** Change an active penalty. Only future bookings see a changed fee; bookings already made keep theirs. */
function modifyPenalty(id, input, admin) {
  const db = ctx.get();
  return immediate(db, () => {
    const p = getPenalty(id);
    if (!p) throw notFound();
    if (p.status !== 'active') throw new AppError('A revoked penalty cannot be changed.', { code: 'INVALID_STATE', status: 409 });
    const fields = {};
    const reason = parseReason(input.reason, fields);
    const note = collapse(input.change_note);
    if (note.length < 5) fields.change_note = 'Say what changed and why (at least 5 characters).';
    else if (note.length > 500) fields.change_note = 'Keep the note under 500 characters.';
    const next = { amount: p.amount_centavos, startsAt: p.starts_at, endsAt: p.ends_at };
    if (p.kind === 'fee_once') {
      next.amount = parseAmount(input.amount, fields);
      if (!fields.amount && next.amount !== p.amount_centavos && p.state === 'charged') {
        fields.amount = `This fee is already charged to booking ${p.charged_ref}. Revoke it and issue a new one to change the amount.`;
      }
    }
    if (p.kind === 'surcharge') {
      next.amount = parseAmount(input.amount, fields);
      next.endsAt = parseExpiry(input, fields);
    }
    if (p.kind === 'temp_ban') {
      const dates = parseBanDates(input, fields, { keepStart: p.start_date });
      if (dates.startsAt) {
        next.startsAt = dates.startsAt === dayStart(p.start_date) ? p.starts_at : dates.startsAt;
        next.endsAt = dates.endsAt;
      }
    }
    if (!Object.keys(fields).length) {
      const problem = overlapProblem(db, p.kind, p.user_id, { startsAt: next.startsAt, endsAt: next.endsAt, excludeId: p.id });
      if (problem) fields[p.kind === 'temp_ban' ? 'end_date' : 'amount'] = problem;
    }
    if (Object.keys(fields).length) throw invalid(fields);

    const changes = {};
    if (next.amount !== p.amount_centavos) changes.amount = [p.amount_centavos, next.amount];
    if (next.startsAt !== p.starts_at) changes.from = [p.starts_at, next.startsAt];
    if (next.endsAt !== p.ends_at) changes.until = [p.ends_at ? lastDay(p.ends_at) : 'none', next.endsAt ? lastDay(next.endsAt) : 'none'];
    if (reason !== p.reason) changes.reason = [p.reason, reason];
    if (!Object.keys(changes).length) throw new AppError('Nothing was changed.', { code: 'NO_CHANGE' });

    const now = time.nowLocal();
    db.prepare('UPDATE penalties SET amount_centavos = ?, starts_at = ?, ends_at = ?, reason = ?, updated_at = ? WHERE id = ?')
      .run(next.amount, next.startsAt, next.endsAt, reason, now, p.id);
    const details = { driver: p.driver_name, plate: p.plate_number, penalty: p.kind_label, changes, note };
    event(db, p.id, 'modified', admin, Object.assign({ auditId: logAudit(db, admin, 'penalty.modify', 'penalty', p.id, details) }, details));
    return getPenalty(p.id);
  });
}

/**
 * Take a penalty's fee off bookings that are still upcoming and unpaid (an explicit administrator choice). Paid,
 * finished or cancelled bookings are never changed.
 */
function removeFromUnpaid(db, p, admin) {
  const now = time.nowLocal();
  const removed = [];
  for (const c of charges(p.id)) {
    if (c.status !== 'applied' || c.reservation_status !== 'confirmed' || c.paid_centavos > 0) continue;
    db.prepare(
      `UPDATE reservations SET surcharge_centavos = surcharge_centavos - ?, fee_estimated_centavos = fee_estimated_centavos - ?, updated_at = ? WHERE id = ?`,
    ).run(c.amount_centavos, c.amount_centavos, now, c.reservation_id);
    db.prepare(`UPDATE penalty_charges SET status = 'removed', updated_at = ? WHERE id = ?`).run(now, c.id);
    audit.log(admin, 'reservation.penalty_fee_removed', 'reservation', c.reservation_id, { ref: c.booking_ref, amount: c.amount_centavos, penalty: p.id });
    removed.push(c.booking_ref);
  }
  return removed;
}

function revokeInside(db, p, reason, { removeUnpaid = false, appealId = null } = {}, admin) {
  const now = time.nowLocal();
  db.prepare(`UPDATE penalties SET status = 'revoked', revoked_by = ?, revoked_at = ?, revoke_reason = ?, updated_at = ? WHERE id = ?`)
    .run(admin.id, now, reason, now, p.id);
  const removed = removeUnpaid ? removeFromUnpaid(db, p, admin) : [];
  // A pending appeal has nothing left to decide.
  if (!appealId) {
    db.prepare(`UPDATE penalty_appeals SET status = 'revoked', decision_reason = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE penalty_id = ? AND status = 'pending'`)
      .run(`Penalty revoked: ${reason}`, admin.id, now, now, p.id);
  }
  const details = { driver: p.driver_name, plate: p.plate_number, penalty: p.kind_label, reason, removed_from: removed.length ? removed : null, appeal: appealId };
  event(db, p.id, 'revoked', admin, Object.assign({ auditId: logAudit(db, admin, 'penalty.revoke', 'penalty', p.id, details) }, details));
  return removed;
}

function revokePenalty(id, { reason: reasonIn, removeUnpaid = false } = {}, admin) {
  const db = ctx.get();
  return immediate(db, () => {
    const p = getPenalty(id);
    if (!p) throw notFound();
    if (p.status !== 'active') throw new AppError('This penalty is already revoked.', { code: 'INVALID_STATE', status: 409 });
    const fields = {};
    const reason = parseReason(reasonIn, fields);
    if (Object.keys(fields).length) throw new AppError(fields.reason, { code: 'VALIDATION', fields });
    const removed = revokeInside(db, p, reason, { removeUnpaid }, admin);
    return { penalty: getPenalty(id), removed };
  });
}

/** Explicit administrator action: put a one-time fee that is still waiting on one of the driver's unpaid upcoming bookings. */
function chargeToReservation(id, reservationIdIn, admin) {
  const db = ctx.get();
  return immediate(db, () => {
    const p = getPenalty(id);
    if (!p) throw notFound();
    if (p.kind !== 'fee_once' || p.state !== 'pending') throw new AppError('Only a one-time fee that has not been charged yet can be added to a booking.', { code: 'INVALID_STATE', status: 409 });
    const res = upcomingReservations(p.user_id).find((r) => r.id === toInt(reservationIdIn));
    if (!res || res.status !== 'confirmed') throw new AppError('Choose one of the driver\'s upcoming bookings.', { code: 'VALIDATION', status: 422 });
    if (res.paid_centavos > 0) throw new AppError(`Booking ${res.booking_ref} already has a payment, so its fee is not changed.`, { code: 'INVALID_STATE', status: 409 });
    if (db.prepare('SELECT 1 FROM penalty_charges WHERE penalty_id = ? AND reservation_id = ?').get(p.id, res.id)) {
      // Released from this booking earlier: apply that charge again rather than adding a second row.
      db.prepare(`UPDATE penalty_charges SET status = 'applied', amount_centavos = ?, updated_at = ? WHERE penalty_id = ? AND reservation_id = ?`)
        .run(p.amount_centavos, time.nowLocal(), p.id, res.id);
    } else {
      db.prepare(`INSERT INTO penalty_charges (penalty_id, reservation_id, kind, amount_centavos, status, created_at, updated_at) VALUES (?, ?, 'fee_once', ?, 'applied', ?, ?)`)
        .run(p.id, res.id, p.amount_centavos, time.nowLocal(), time.nowLocal());
    }
    db.prepare(`UPDATE reservations SET surcharge_centavos = surcharge_centavos + ?, fee_estimated_centavos = fee_estimated_centavos + ?, updated_at = ? WHERE id = ?`)
      .run(p.amount_centavos, p.amount_centavos, time.nowLocal(), res.id);
    audit.log(admin, 'reservation.penalty_fee_added', 'reservation', res.id, { ref: res.booking_ref, amount: p.amount_centavos, penalty: p.id });
    const details = { driver: p.driver_name, plate: p.plate_number, penalty: p.kind_label, ref: res.booking_ref, amount: p.amount_centavos };
    event(db, p.id, 'charged', admin, Object.assign({ auditId: logAudit(db, admin, 'penalty.charge', 'penalty', p.id, details), reservation_id: res.id }, details));
    return getPenalty(p.id);
  });
}

// ---------------------------------------------------------------- appeals

const APPEAL_SELECT = `
  SELECT a.*, u.full_name AS driver_name, u.email AS driver_email, d.full_name AS decided_by_name,
         p.kind, p.plate_number, p.amount_centavos, p.status AS penalty_status,
         EXISTS (SELECT 1 FROM appeal_evidence e WHERE e.appeal_id = a.id) AS has_evidence
  FROM penalty_appeals a
  JOIN users u ON u.id = a.user_id
  JOIN penalties p ON p.id = a.penalty_id
  LEFT JOIN users d ON d.id = a.decided_by`;

const decorateAppeal = (a) => a && Object.assign(a, {
  status_label: label(APPEAL_STATUSES, a.status),
  kind_label: label(KINDS, a.kind),
  has_evidence: !!a.has_evidence,
});

const getAppeal = (id) => decorateAppeal(ctx.get().prepare(`${APPEAL_SELECT} WHERE a.id = ?`).get(id));
const appealForPenalty = (penaltyId) => decorateAppeal(ctx.get().prepare(`${APPEAL_SELECT} WHERE a.penalty_id = ?`).get(penaltyId));
const getAppealEvidence = (id) => ctx.get().prepare('SELECT mime, size_bytes, data FROM appeal_evidence WHERE appeal_id = ?').get(id);

function listAppeals({ status = '' } = {}, { page = 1, perPage = 15 } = {}) {
  const ok = APPEAL_STATUSES.some((s) => s.value === status);
  const whereSql = ok ? 'WHERE a.status = ?' : '';
  const params = ok ? [status] : [];
  const db = ctx.get();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM penalty_appeals a ${whereSql}`).get(...params).n;
  const pager = paginate(total, page, perPage);
  const rows = db
    .prepare(`${APPEAL_SELECT} ${whereSql} ORDER BY a.status = 'pending' DESC, a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`)
    .all(...params, pager.perPage, pager.offset)
    .map(decorateAppeal);
  return { rows, pager };
}

const countPendingAppeals = () => ctx.get().prepare(`SELECT COUNT(*) AS n FROM penalty_appeals WHERE status = 'pending'`).get().n;

/** The penalised driver appeals, once per penalty, while it is in force. */
function submitAppeal(userId, penaltyId, input, actor) {
  const db = ctx.get();
  const fields = {};
  const explanation = collapse(input.explanation);
  if (explanation.length < 20) fields.explanation = 'Explain your appeal in at least 20 characters.';
  else if (explanation.length > 2000) fields.explanation = 'Keep the explanation under 2,000 characters.';
  let photo = null;
  try {
    photo = evidence.parse(input.evidence_data);
  } catch (err) {
    if (!err.fields) throw err;
    Object.assign(fields, err.fields);
  }
  return immediate(db, () => {
    const p = getPenalty(penaltyId);
    // Someone else's penalty looks like a missing one.
    if (!p || p.user_id !== userId) throw notFound();
    if (p.status !== 'active') throw new AppError('This penalty was revoked; there is nothing to appeal.', { code: 'INVALID_STATE', status: 409 });
    if (p.appeal_id) throw new AppError('You already appealed this penalty. Each penalty can be appealed once.', { code: 'INVALID_STATE', status: 409 });
    if (Object.keys(fields).length) throw invalid(fields);
    const now = time.nowLocal();
    const id = db
      .prepare(`INSERT INTO penalty_appeals (penalty_id, user_id, explanation, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)`)
      .run(p.id, userId, explanation, now, now).lastInsertRowid;
    if (photo) db.prepare('INSERT INTO appeal_evidence (appeal_id, mime, size_bytes, sha256, data) VALUES (?, ?, ?, ?, ?)').run(id, photo.mime, photo.size, photo.sha256, photo.data);
    const details = { penalty: p.kind_label, plate: p.plate_number, evidence: !!photo };
    event(db, p.id, 'appealed', actor || userId, Object.assign({ auditId: logAudit(db, actor || userId, 'appeal.submit', 'penalty_appeal', id, details), appeal_id: id }, details));
    return getAppeal(id);
  });
}

/** Uphold the penalty, or revoke it, with the documented reason the driver sees. */
function decideAppeal(id, { decision, reason: reasonIn, removeUnpaid = false } = {}, admin) {
  const db = ctx.get();
  return immediate(db, () => {
    const a = getAppeal(id);
    if (!a) throw new AppError('Appeal not found.', { status: 404, code: 'NOT_FOUND' });
    if (a.status !== 'pending') throw new AppError('This appeal was already decided.', { code: 'INVALID_STATE', status: 409 });
    const choice = oneOf(clean(decision), ['uphold', 'revoke']);
    if (!choice) throw new AppError('Choose to uphold or revoke the penalty.', { code: 'VALIDATION', status: 422 });
    const fields = {};
    const reason = parseReason(reasonIn, fields);
    if (Object.keys(fields).length) throw new AppError(fields.reason, { code: 'VALIDATION', fields });
    const p = getPenalty(a.penalty_id);
    const now = time.nowLocal();
    const status = choice === 'revoke' ? 'revoked' : 'upheld';
    db.prepare(`UPDATE penalty_appeals SET status = ?, decision_reason = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?`)
      .run(status, reason, admin.id, now, now, a.id);
    const details = { penalty: p.kind_label, plate: p.plate_number, decision: label(APPEAL_STATUSES, status), reason };
    event(db, p.id, choice === 'revoke' ? 'appeal_granted' : 'appeal_upheld', admin,
      Object.assign({ auditId: logAudit(db, admin, 'appeal.decide', 'penalty_appeal', a.id, details), appeal_id: a.id }, details));
    let removed = [];
    if (choice === 'revoke' && p.status === 'active') removed = revokeInside(db, p, `Appeal granted: ${reason}`, { removeUnpaid, appealId: a.id }, admin);
    return { appeal: getAppeal(a.id), removed };
  });
}

module.exports = {
  KINDS,
  STATES,
  APPEAL_STATUSES,
  MAX_FEE,
  MAX_BAN_DAYS,
  getPenalty,
  penaltiesForUser,
  penaltiesForPlate,
  penaltiesForReport,
  listPenalties,
  countInForce,
  events,
  charges,
  chargesForReservation,
  upcomingReservations,
  activeBan,
  banMessage,
  assertCanBook,
  bookingCharges,
  applyCharges,
  releaseCharges,
  issuePenalty,
  modifyPenalty,
  revokePenalty,
  chargeToReservation,
  getAppeal,
  appealForPenalty,
  getAppealEvidence,
  listAppeals,
  countPendingAppeals,
  submitAppeal,
  decideAppeal,
};
