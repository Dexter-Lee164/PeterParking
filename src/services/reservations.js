'use strict';

const crypto = require('crypto');
const ctx = require('../db/context');
const { immediate } = require('../db');
const settingsService = require('./settings');
const availability = require('./availability');
const parking = require('./parking');
const fees = require('./fees');
const audit = require('./audit');
const etiquette = require('./etiquette');
const time = require('../utils/time');
const { AppError } = require('../utils/errors');
const { clean, normalizePlate } = require('../utils/validate');
const { paginate } = require('../utils/paginate');

const ACTIVE = ['confirmed', 'checked_in'];
const STATUSES = ['confirmed', 'checked_in', 'completed', 'cancelled', 'no_show'];

/** Driver-facing tab → reservation status. */
const DRIVER_TABS = {
  upcoming: 'confirmed',
  active: 'checked_in',
  completed: 'completed',
  cancelled: 'cancelled',
  no_show: 'no_show',
};

const RES_SELECT = `
  SELECT r.*,
         s.slot_code, s.zone_id, s.slot_type, s.status AS slot_status,
         z.name AS zone_name, z.code AS zone_code,
         t.label AS type_label,
         u.full_name AS driver_name, u.email AS driver_email, u.phone AS driver_phone, u.university_id AS driver_university_id,
         v.plate_number, v.vehicle_type, v.make, v.model, v.color,
         COALESCE((SELECT SUM(p.amount_centavos) FROM payments p WHERE p.reservation_id = r.id AND p.status = 'valid'), 0) AS paid_centavos
  FROM reservations r
  JOIN parking_slots s ON s.id = r.slot_id
  JOIN parking_zones z ON z.id = s.zone_id
  JOIN slot_types t ON t.code = s.slot_type
  JOIN users u ON u.id = r.user_id
  JOIN vehicles v ON v.id = r.vehicle_id`;

/** Adds derived money fields: due, balance, payment status (anything short of the full fee is unpaid). */
function decorate(row) {
  if (!row) return row;
  const isFinal = row.fee_final_centavos !== null && row.fee_final_centavos !== undefined;
  const due = isFinal ? row.fee_final_centavos : row.fee_estimated_centavos;
  const balance = due - row.paid_centavos;
  let paymentStatus = 'unpaid';
  if (due === 0 && row.paid_centavos === 0) paymentStatus = 'no_charge';
  else if (row.paid_centavos > due) paymentStatus = 'overpaid';
  else if (row.paid_centavos >= due) paymentStatus = 'paid';
  return { ...row, fee_is_final: isFinal, due_centavos: due, balance_centavos: balance, payment_status: paymentStatus };
}

function getReservation(id) {
  return decorate(ctx.get().prepare(`${RES_SELECT} WHERE r.id = ?`).get(id));
}

function getByRef(ref) {
  return decorate(ctx.get().prepare(`${RES_SELECT} WHERE r.booking_ref = ? COLLATE NOCASE`).get(clean(ref)));
}

/** Throws unless the actor owns the reservation or is an administrator. */
function assertCanAccess(reservation, user) {
  if (!reservation) throw new AppError('Reservation not found.', { status: 404, code: 'NOT_FOUND' });
  if (user.role !== 'admin' && reservation.user_id !== user.id) {
    // Same response as "not found" so ids of other drivers' bookings are not revealed.
    throw new AppError('Reservation not found.', { status: 404, code: 'NOT_FOUND' });
  }
  return reservation;
}

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateRef(db) {
  const stamp = time.nowLocal().slice(2, 10).replace(/-/g, '');
  for (let i = 0; i < 20; i += 1) {
    let suffix = '';
    for (let k = 0; k < 5; k += 1) suffix += REF_ALPHABET[crypto.randomInt(REF_ALPHABET.length)];
    const ref = `UP-${stamp}-${suffix}`;
    if (!db.prepare('SELECT 1 FROM reservations WHERE booking_ref = ?').get(ref)) return ref;
  }
  throw new AppError('Could not generate a booking reference. Please try again.', { status: 500 });
}

function translateDbError(err) {
  const msg = String((err && err.message) || '');
  if (msg.includes('RESERVATION_OVERLAP')) {
    return new AppError('That slot was just booked for an overlapping time. Please choose another slot or time.', { code: 'CONFLICT', status: 409 });
  }
  if (msg.includes('SLOT_NOT_ACTIVE')) {
    return new AppError('That slot is not in service and cannot be reserved.', { code: 'SLOT_NOT_ACTIVE', status: 409 });
  }
  return err;
}

/** A plate under an active ban (src/services/etiquette.js) cannot be used to book or reschedule. */
function assertNotBanned(plate) {
  const ban = etiquette.activeBan(plate);
  if (ban) throw new AppError(etiquette.banMessage(plate, ban), { code: 'VEHICLE_BANNED', status: 403 });
}

/**
 * Late-cancellation and no-show fees are a percentage of the reserved fee without the plate's additional fee; when
 * such a fee applies at all, the additional fee is charged in full on top. A free cancellation costs nothing.
 */
function cancellationFeeFor(res, now, settings, opts) {
  const fee = fees.cancellationFee(res.fee_estimated_centavos - res.surcharge_centavos, res.start_at, now, settings, opts);
  return fee > 0 ? fee + res.surcharge_centavos : 0;
}
function noShowFeeFor(res, settings) {
  return fees.noShowFee(res.fee_estimated_centavos - res.surcharge_centavos, settings) + res.surcharge_centavos;
}

/** Is [startAt, endAt) free for the slot? Honors overstay (checked-in stays block until now). */
function slotHasConflict(db, slotId, startAt, endAt, excludeId = 0) {
  const now = time.nowLocal();
  return !!db
    .prepare(
      `SELECT 1 FROM reservations
       WHERE slot_id = @slot AND id <> @exclude AND status IN ('confirmed', 'checked_in')
         AND start_at < @end
         AND (CASE WHEN status = 'checked_in' AND end_at < @now THEN @now ELSE end_at END) > @start
       LIMIT 1`,
    )
    .get({ slot: slotId, exclude: excludeId, end: endAt, start: startAt, now });
}

/**
 * Create a reservation. The conflict check and the insert run inside one
 * IMMEDIATE transaction, so concurrent requests are serialized by SQLite's write
 * lock and can never both succeed for overlapping times. The database trigger
 * is a second, independent line of defence.
 */
function createReservation({ userId, vehicleId, slotId, date, start, end }, actor) {
  const db = ctx.get();
  try {
    return immediate(db, () => {
      const settings = settingsService.getAll();
      const range = availability.validateRange({ date, start, end }, settings);
      if (!range.ok) throw new AppError(range.errors[0], { code: 'VALIDATION', fields: range.fields });

      const user = db.prepare('SELECT id, is_active, role FROM users WHERE id = ?').get(userId);
      if (!user || !user.is_active) throw new AppError('Your account is not active.', { status: 403, code: 'FORBIDDEN' });

      const vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ? AND user_id = ? AND is_active = 1').get(vehicleId, userId);
      if (!vehicle) throw new AppError('Choose one of your registered vehicles.', { code: 'VALIDATION', fields: { vehicle_id: 'Choose one of your vehicles.' } });

      const slot = parking.getSlot(slotId);
      if (!slot || !slot.zone_active) throw new AppError('That parking slot does not exist.', { status: 404, code: 'NOT_FOUND' });
      if (slot.status !== 'active') {
        throw new AppError('That slot is not available for booking (out of service or inactive).', { code: 'SLOT_NOT_ACTIVE', status: 409 });
      }
      if (!parking.vehicleFitsSlotType(slot.type_vehicle, vehicle.vehicle_type)) {
        throw new AppError(`A ${vehicle.vehicle_type} cannot use a ${slot.type_label} slot.`, { code: 'VEHICLE_MISMATCH', fields: { vehicle_id: 'This vehicle does not fit the selected slot type.' } });
      }
      assertNotBanned(vehicle.plate_number);

      const activeCount = db
        .prepare(`SELECT COUNT(*) AS n FROM reservations WHERE user_id = ? AND status IN ('confirmed','checked_in')`)
        .get(userId).n;
      if (activeCount >= settings.max_active_reservations) {
        throw new AppError(`You already have ${activeCount} active reservations (limit ${settings.max_active_reservations}). Cancel or complete one first.`, { code: 'LIMIT' });
      }

      const vehicleClash = db
        .prepare(
          `SELECT booking_ref FROM reservations
           WHERE vehicle_id = ? AND status IN ('confirmed','checked_in') AND start_at < ? AND end_at > ? LIMIT 1`,
        )
        .get(vehicleId, range.endAt, range.startAt);
      if (vehicleClash) {
        throw new AppError(`This vehicle already has a reservation (${vehicleClash.booking_ref}) overlapping that time.`, { code: 'VEHICLE_CLASH', status: 409 });
      }

      if (slotHasConflict(db, slotId, range.startAt, range.endAt)) {
        throw new AppError('That slot is no longer available for the selected time. Please choose another slot.', { code: 'CONFLICT', status: 409 });
      }

      const rate = slot.hourly_rate_centavos;
      // An administrator's additional fee on this plate is part of the booking's fee from the start.
      const surcharge = etiquette.activeSurcharge(vehicle.plate_number);
      const fee = fees.estimatedFee(rate, range.durationMinutes, settings) + surcharge;
      const ref = generateRef(db);
      const info = db
        .prepare(
          `INSERT INTO reservations (booking_ref, user_id, vehicle_id, slot_id, start_at, end_at, duration_minutes,
             hourly_rate_centavos, fee_estimated_centavos, surcharge_centavos, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?)`,
        )
        .run(ref, userId, vehicleId, slotId, range.startAt, range.endAt, range.durationMinutes, rate, fee, surcharge, time.nowLocal(), time.nowLocal());
      audit.log(actor || userId, 'reservation.create', 'reservation', info.lastInsertRowid, {
        ref, slot: slot.slot_code, zone: slot.zone_name, start: range.startAt, end: range.endAt, fee, ...(surcharge ? { surcharge } : {}),
      });
      return getReservation(info.lastInsertRowid);
    });
  } catch (err) {
    throw translateDbError(err);
  }
}

/** Driver cancels their own booking; an administrator may cancel any with a reason. */
function cancelReservation(id, user, { reason = '', waiveFee = null, actor = null } = {}) {
  const db = ctx.get();
  try {
    return immediate(db, () => {
      const res = assertCanAccess(getReservation(id), user);
      const settings = settingsService.getAll();
      const now = time.nowLocal();
      const isAdmin = user.role === 'admin';
      const cleanReason = clean(reason);

      if (res.status !== 'confirmed') {
        const msg = res.status === 'checked_in'
          ? 'This vehicle is already parked. Check it out instead of cancelling.'
          : `This reservation is already ${res.status.replace('_', ' ')} and cannot be cancelled.`;
        throw new AppError(msg, { code: 'INVALID_STATE', status: 409 });
      }
      if (isAdmin && cleanReason.length < 3) {
        throw new AppError('Enter a reason for the cancellation.', { code: 'VALIDATION', fields: { reason: 'A reason is required.' } });
      }
      if (!isAdmin && res.start_at <= now) {
        throw new AppError('This reservation has already started. Please contact parking staff to cancel it.', { code: 'TOO_LATE', status: 409 });
      }

      const waive = isAdmin ? (waiveFee === null ? true : !!waiveFee) : false;
      const fee = cancellationFeeFor(res, now, settings, { waive });
      db.prepare(
        `UPDATE reservations SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancel_reason = ?,
           fee_final_centavos = ?, updated_at = ? WHERE id = ?`,
      ).run(now, user.id, cleanReason || (isAdmin ? null : 'Cancelled by driver'), fee, now, id);
      audit.log(actor || user, 'reservation.cancel', 'reservation', id, {
        ref: res.booking_ref, by: isAdmin ? 'admin' : 'driver', reason: cleanReason, fee, waived: waive,
      });
      return getReservation(id);
    });
  } catch (err) {
    throw translateDbError(err);
  }
}

/** Move a not-yet-started booking to a new time on the same slot (owner only). */
function rescheduleReservation(id, user, { date, start, end }, actor = null) {
  const db = ctx.get();
  try {
    return immediate(db, () => {
      const res = assertCanAccess(getReservation(id), user);
      if (res.user_id !== user.id) throw new AppError('Only the booking owner can reschedule.', { status: 403, code: 'FORBIDDEN' });
      const settings = settingsService.getAll();
      const now = time.nowLocal();

      if (res.status !== 'confirmed') throw new AppError('Only upcoming reservations can be rescheduled.', { code: 'INVALID_STATE', status: 409 });
      const hoursBefore = time.diffMinutes(res.start_at, now) / 60;
      if (hoursBefore < settings.cancel_free_hours) {
        throw new AppError(
          `Reservations can be rescheduled until ${settings.cancel_free_hours} hour(s) before they start.`,
          { code: 'TOO_LATE', status: 409 },
        );
      }
      const range = availability.validateRange({ date, start, end }, settings);
      if (!range.ok) throw new AppError(range.errors[0], { code: 'VALIDATION', fields: range.fields });
      if (range.startAt === res.start_at && range.endAt === res.end_at) {
        throw new AppError('That is the same time as your current booking.', { code: 'NO_CHANGE' });
      }
      if (slotHasConflict(db, res.slot_id, range.startAt, range.endAt, id)) {
        throw new AppError('This slot is not free at the new time. Choose a different time, or cancel and book another slot.', { code: 'CONFLICT', status: 409 });
      }
      const vehicleClash = db
        .prepare(
          `SELECT booking_ref FROM reservations
           WHERE vehicle_id = ? AND id <> ? AND status IN ('confirmed','checked_in') AND start_at < ? AND end_at > ? LIMIT 1`,
        )
        .get(res.vehicle_id, id, range.endAt, range.startAt);
      if (vehicleClash) throw new AppError(`This vehicle already has reservation ${vehicleClash.booking_ref} at that time.`, { code: 'VEHICLE_CLASH', status: 409 });

      assertNotBanned(res.plate_number);
      // The booking keeps the additional fee it was made with.
      const fee = fees.estimatedFee(res.hourly_rate_centavos, range.durationMinutes, settings) + res.surcharge_centavos;
      db.prepare(
        `UPDATE reservations SET start_at = ?, end_at = ?, duration_minutes = ?, fee_estimated_centavos = ?, updated_at = ? WHERE id = ?`,
      ).run(range.startAt, range.endAt, range.durationMinutes, fee, now, id);
      audit.log(actor || user, 'reservation.reschedule', 'reservation', id, {
        ref: res.booking_ref, from: [res.start_at, res.end_at], to: [range.startAt, range.endAt], fee,
      });
      return getReservation(id);
    });
  } catch (err) {
    throw translateDbError(err);
  }
}

/** Administrator marks a late booking as a no-show (after the arrival grace period). */
function markNoShow(id, admin) {
  const db = ctx.get();
  return immediate(db, () => {
    const res = getReservation(id);
    if (!res) throw new AppError('Reservation not found.', { status: 404, code: 'NOT_FOUND' });
    const settings = settingsService.getAll();
    const now = time.nowLocal();
    if (res.status !== 'confirmed') throw new AppError('Only upcoming reservations can be marked as no-show.', { code: 'INVALID_STATE', status: 409 });
    const graceEnds = time.addMinutes(res.start_at, settings.late_arrival_grace_minutes);
    if (now < graceEnds) {
      throw new AppError(`A booking can be marked as a no-show only after the ${settings.late_arrival_grace_minutes}-minute arrival grace period (from ${time.fmtTime(graceEnds)}).`, { code: 'TOO_EARLY', status: 409 });
    }
    applyNoShow(db, res, settings, now, admin);
    return getReservation(id);
  });
}

function applyNoShow(db, res, settings, now, actor) {
  const fee = noShowFeeFor(res, settings);
  db.prepare(
    `UPDATE reservations SET status = 'no_show', no_show_at = ?, fee_final_centavos = ?, updated_at = ? WHERE id = ?`,
  ).run(now, fee, now, res.id);
  audit.log(actor || null, 'reservation.no_show', 'reservation', res.id, { ref: res.booking_ref, fee, automatic: !actor });
}

/** Booking windows that ended without arrival are closed as no-shows (runs every minute). */
function sweepNoShows() {
  const db = ctx.get();
  return immediate(db, () => {
    const now = time.nowLocal();
    const settings = settingsService.getAll();
    const stale = db.prepare(`${RES_SELECT} WHERE r.status = 'confirmed' AND r.end_at <= ?`).all(now);
    for (const row of stale) applyNoShow(db, decorate(row), settings, now, null);
    return stale.length;
  });
}

// ----------------------------------------------------------------- queries

function buildFilters({ userId, q, status, zoneId, dateFrom, dateTo, tab, period, paymentStatus }) {
  const where = [];
  const params = [];
  // period: today / upcoming / past by the campus calendar day of the start (APP_TIMEZONE).
  if (period === 'today' || period === 'upcoming' || period === 'past') {
    where.push(`substr(r.start_at, 1, 10) ${{ today: '=', upcoming: '>', past: '<' }[period]} ?`);
    params.push(time.todayLocal());
  }
  if (userId) {
    where.push('r.user_id = ?');
    params.push(userId);
  }
  if (tab && DRIVER_TABS[tab]) {
    where.push('r.status = ?');
    params.push(DRIVER_TABS[tab]);
  }
  if (status && STATUSES.includes(status)) {
    where.push('r.status = ?');
    params.push(status);
  }
  if (zoneId) {
    where.push('s.zone_id = ?');
    params.push(zoneId);
  }
  if (dateFrom) {
    where.push('r.start_at >= ?');
    params.push(`${dateFrom} 00:00:00`);
  }
  if (dateTo) {
    where.push('r.start_at <= ?');
    params.push(`${dateTo} 23:59:59`);
  }
  if (q) {
    const plate = normalizePlate(q).replace(/\s/g, '');
    where.push(
      `(r.booking_ref LIKE ? COLLATE NOCASE OR u.full_name LIKE ? OR u.email LIKE ? OR replace(v.plate_number, ' ', '') LIKE ? OR s.slot_code LIKE ?)`,
    );
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${plate}%`, `%${q}%`);
  }
  return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params, paymentStatus };
}

/**
 * `sort: 'priority'` (the administrator's list): today's bookings first, then future ones, then past ones, using the
 * campus calendar day (APP_TIMEZONE). Today and future run soonest first; past runs most recent first.
 * `sort: 'start_asc'` / `'start_desc'`: by start time, soonest / most recent first.
 * Otherwise: upcoming / active tabs soonest first, everything else most recent first.
 */
function orderClause(filters) {
  if (filters.sort === 'priority') {
    const today = time.todayLocal();
    const tier = 'CASE WHEN substr(r.start_at, 1, 10) = ? THEN 0 WHEN substr(r.start_at, 1, 10) > ? THEN 1 ELSE 2 END';
    return {
      sql: `${tier}, CASE WHEN substr(r.start_at, 1, 10) >= ? THEN r.start_at END ASC, r.start_at DESC`,
      params: [today, today, today],
    };
  }
  if (filters.sort === 'start_asc') return { sql: 'r.start_at ASC', params: [] };
  if (filters.sort === 'start_desc') return { sql: 'r.start_at DESC', params: [] };
  return { sql: filters.tab === 'upcoming' || filters.tab === 'active' ? 'r.start_at ASC' : 'r.start_at DESC', params: [] };
}

function listReservations(filters = {}, { page = 1, perPage = 15, all = false } = {}) {
  const db = ctx.get();
  const { where, params, paymentStatus } = buildFilters(filters);
  const { sql: order, params: orderParams } = orderClause(filters);

  if (all || paymentStatus) {
    let rows = db.prepare(`${RES_SELECT} ${where} ORDER BY ${order}, r.id DESC`).all(...params, ...orderParams).map(decorate);
    if (paymentStatus) rows = rows.filter((r) => r.payment_status === paymentStatus);
    if (all) return { rows, pager: paginate(rows.length, 1, Math.max(rows.length, 1)) };
    const pager = paginate(rows.length, page, perPage);
    return { rows: rows.slice(pager.offset, pager.offset + perPage), pager };
  }

  const total = db
    .prepare(
      `SELECT COUNT(*) AS n FROM reservations r
       JOIN parking_slots s ON s.id = r.slot_id JOIN users u ON u.id = r.user_id JOIN vehicles v ON v.id = r.vehicle_id ${where}`,
    )
    .get(...params).n;
  const pager = paginate(total, page, perPage);
  const rows = db
    .prepare(`${RES_SELECT} ${where} ORDER BY ${order}, r.id DESC LIMIT ? OFFSET ?`)
    .all(...params, ...orderParams, perPage, pager.offset)
    .map(decorate);
  return { rows, pager };
}

function countByTab(userId) {
  const rows = ctx.get().prepare('SELECT status, COUNT(*) AS n FROM reservations WHERE user_id = ? GROUP BY status').all(userId);
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  const counts = {};
  let all = 0;
  for (const [tab, status] of Object.entries(DRIVER_TABS)) {
    counts[tab] = byStatus[status] || 0;
    all += counts[tab];
  }
  counts.all = all;
  return counts;
}

function auditTrail(reservationId) {
  return ctx
    .get()
    .prepare(
      `SELECT a.*, u.full_name AS user_name FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.entity_type = 'reservation' AND a.entity_id = ? ORDER BY a.id DESC`,
    )
    .all(reservationId);
}

module.exports = {
  ACTIVE,
  STATUSES,
  DRIVER_TABS,
  RES_SELECT,
  decorate,
  getReservation,
  getByRef,
  assertCanAccess,
  slotHasConflict,
  cancellationFeeFor,
  noShowFeeFor,
  createReservation,
  cancelReservation,
  rescheduleReservation,
  markNoShow,
  sweepNoShows,
  listReservations,
  countByTab,
  auditTrail,
};
