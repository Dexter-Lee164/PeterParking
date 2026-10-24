'use strict';

const ctx = require('../db/context');
const { immediate } = require('../db');
const settingsService = require('./settings');
const reservations = require('./reservations');
const fees = require('./fees');
const audit = require('./audit');
const time = require('../utils/time');
const { AppError } = require('../utils/errors');
const { clean, normalizePlate } = require('../utils/validate');

/**
 * Administrator confirms a vehicle's arrival. Occupancy changes only here, only after
 * the reservation, timing and slot checks all pass.
 */
function checkIn(reservationId, admin, { notes = '' } = {}) {
  const db = ctx.get();
  return immediate(db, () => {
    const res = reservations.getReservation(reservationId);
    if (!res) throw new AppError('Reservation not found.', { status: 404, code: 'NOT_FOUND' });
    const settings = settingsService.getAll();
    const now = time.nowLocal();

    if (res.status === 'checked_in') throw new AppError(`${res.booking_ref} is already checked in.`, { code: 'DUPLICATE_CHECKIN', status: 409 });
    if (res.status !== 'confirmed') {
      throw new AppError(`${res.booking_ref} is ${res.status.replace('_', ' ')} and cannot be checked in.`, { code: 'INVALID_STATE', status: 409 });
    }
    if (res.slot_status !== 'active') throw new AppError('This slot is not in service. Reassign the driver before checking in.', { code: 'SLOT_NOT_ACTIVE', status: 409 });

    const earliest = time.addMinutes(res.start_at, -settings.checkin_early_minutes);
    if (now < earliest) {
      throw new AppError(`Too early to check in. Check-in opens at ${time.fmtTime(earliest)} (${settings.checkin_early_minutes} minutes before the start time).`, { code: 'TOO_EARLY', status: 409 });
    }
    if (now >= res.end_at) {
      throw new AppError('This reservation window has already ended. Mark it as a no-show instead.', { code: 'EXPIRED', status: 409 });
    }
    const occupant = db
      .prepare(
        `SELECT v.plate_number, r.booking_ref FROM parking_sessions ps
         JOIN reservations r ON r.id = ps.reservation_id JOIN vehicles v ON v.id = ps.vehicle_id
         WHERE ps.slot_id = ? AND ps.check_out_at IS NULL`,
      )
      .get(res.slot_id);
    if (occupant) {
      throw new AppError(`Slot ${res.slot_code} is still occupied by ${occupant.plate_number} (${occupant.booking_ref}). Check that vehicle out first.`, { code: 'SLOT_OCCUPIED', status: 409 });
    }

    const lateRaw = time.diffMinutes(now, res.start_at);
    const late = lateRaw > settings.late_arrival_grace_minutes ? lateRaw : 0;
    db.prepare(
      `INSERT INTO parking_sessions (reservation_id, slot_id, vehicle_id, check_in_at, checked_in_by, late_arrival_minutes, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(res.id, res.slot_id, res.vehicle_id, now, admin.id, late, clean(notes) || null);
    db.prepare(`UPDATE reservations SET status = 'checked_in', updated_at = ? WHERE id = ?`).run(now, res.id);
    audit.log(admin, 'session.check_in', 'reservation', res.id, { ref: res.booking_ref, slot: res.slot_code, plate: res.plate_number, late_minutes: late });
    return { reservation: reservations.getReservation(res.id), lateMinutes: late };
  });
}

/** Administrator records departure, assesses overstay and finalizes the fee. */
function checkOut(reservationId, admin) {
  const db = ctx.get();
  return immediate(db, () => {
    const res = reservations.getReservation(reservationId);
    if (!res) throw new AppError('Reservation not found.', { status: 404, code: 'NOT_FOUND' });
    const session = db.prepare('SELECT * FROM parking_sessions WHERE reservation_id = ?').get(res.id);
    if (!session || res.status !== 'checked_in') {
      throw new AppError(
        res.status === 'completed' ? `${res.booking_ref} has already been checked out.` : `${res.booking_ref} has not been checked in, so it cannot be checked out.`,
        { code: 'INVALID_STATE', status: 409 },
      );
    }
    if (session.check_out_at) throw new AppError(`${res.booking_ref} has already been checked out.`, { code: 'DUPLICATE_CHECKOUT', status: 409 });

    const settings = settingsService.getAll();
    const now = time.nowLocal();
    const over = fees.overstay(res.end_at, now, res.hourly_rate_centavos, settings);
    const finalFee = res.fee_estimated_centavos + over.feeCentavos;

    db.prepare(
      `UPDATE parking_sessions SET check_out_at = ?, checked_out_by = ?, overstay_minutes = ?, overstay_fee_centavos = ? WHERE id = ?`,
    ).run(now, admin.id, over.minutes, over.feeCentavos, session.id);
    db.prepare(`UPDATE reservations SET status = 'completed', fee_final_centavos = ?, updated_at = ? WHERE id = ?`).run(finalFee, now, res.id);
    audit.log(admin, 'session.check_out', 'reservation', res.id, {
      ref: res.booking_ref, overstay_minutes: over.minutes, overstay_fee: over.feeCentavos, final_fee: finalFee,
    });
    const after = reservations.getReservation(res.id);
    return {
      reservation: after,
      session: db.prepare('SELECT * FROM parking_sessions WHERE id = ?').get(session.id),
      durationMinutes: time.diffMinutes(now, session.check_in_at),
      overstayMinutes: over.minutes,
      overstayFee: over.feeCentavos,
      finalFee,
    };
  });
}

/** Everything currently parked, with elapsed time and overstay flags. */
function activeSessions() {
  const now = time.nowLocal();
  const settings = settingsService.getAll();
  const rows = ctx
    .get()
    .prepare(
      `${reservations.RES_SELECT.replace('SELECT r.*,', 'SELECT ps.id AS session_id, ps.check_in_at, ps.late_arrival_minutes, r.*,')}
       JOIN parking_sessions ps ON ps.reservation_id = r.id
       WHERE ps.check_out_at IS NULL ORDER BY ps.check_in_at`,
    )
    .all()
    .map(reservations.decorate);
  return rows.map((r) => {
    const elapsed = time.diffMinutes(now, r.check_in_at);
    const overBy = time.diffMinutes(now, r.end_at);
    return {
      ...r,
      elapsed_minutes: elapsed,
      overstaying: overBy > settings.overstay_grace_minutes,
      overstay_minutes_so_far: Math.max(0, overBy),
      minutes_remaining: Math.max(0, -overBy),
    };
  });
}

/** Confirmed bookings starting around now (for the arrivals list). */
function expectedArrivals() {
  const now = time.nowLocal();
  const settings = settingsService.getAll();
  const todayEnd = `${now.slice(0, 10)} 23:59:59`;
  const rows = ctx
    .get()
    .prepare(`${reservations.RES_SELECT} WHERE r.status = 'confirmed' AND r.end_at > ? AND r.start_at <= ? ORDER BY r.start_at`)
    .all(now, todayEnd)
    .map(reservations.decorate);
  return rows.map((r) => {
    const opens = time.addMinutes(r.start_at, -settings.checkin_early_minutes);
    const lateBy = time.diffMinutes(now, r.start_at);
    return {
      ...r,
      can_check_in: now >= opens,
      is_late: lateBy > settings.late_arrival_grace_minutes,
      late_minutes: Math.max(0, lateBy),
      can_mark_no_show: now >= time.addMinutes(r.start_at, settings.late_arrival_grace_minutes),
    };
  });
}

/** Look up reservations by booking reference or plate number for the operations screen. */
function search(query) {
  const q = clean(query);
  if (!q) return [];
  const plate = normalizePlate(q).replace(/\s/g, '');
  const rows = ctx
    .get()
    .prepare(
      `${reservations.RES_SELECT}
       WHERE r.status IN ('confirmed', 'checked_in')
         AND (r.booking_ref = ? COLLATE NOCASE OR replace(v.plate_number, ' ', '') LIKE ?)
       ORDER BY r.start_at LIMIT 20`,
    )
    .all(q, `%${plate}%`)
    .map(reservations.decorate);
  const settings = settingsService.getAll();
  const now = time.nowLocal();
  return rows.map((r) => ({
    ...r,
    can_check_in: r.status === 'confirmed' && now >= time.addMinutes(r.start_at, -settings.checkin_early_minutes) && now < r.end_at,
    can_check_out: r.status === 'checked_in',
    is_late: r.status === 'confirmed' && time.diffMinutes(now, r.start_at) > settings.late_arrival_grace_minutes,
  }));
}

module.exports = { checkIn, checkOut, activeSessions, expectedArrivals, search };
