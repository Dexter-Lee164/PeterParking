'use strict';
const { db } = require('../db');
const audit = require('./audit');
const settingsSvc = require('./settings');
const billing = require('./billing');
const { RES_SELECT } = require('./reservations');
const T = require('../utils/time');
const { conflict, notFound } = require('../utils/errors');
const v = require('../utils/validate');

function checkInEligibility(row, settings, now = T.nowIso()) {
  if (row.status === 'active') return { ok: false, reason: 'Already checked in.' };
  if (row.status !== 'confirmed') return { ok: false, reason: `Reservation is ${row.status.replace('_', '-')}.` };
  const opens = T.addMinutesIso(row.start_at, -settings.early_checkin_minutes);
  if (now < opens) return { ok: false, reason: `Too early. Check-in opens at ${T.fmtTime(opens)}.` };
  if (now >= row.end_at) return { ok: false, reason: 'This reservation has ended.' };
  const late = Math.max(0, T.minutesBetween(row.start_at, now));
  return { ok: true, isLate: late > settings.late_grace_minutes, lateMinutes: late > settings.late_grace_minutes ? late : 0 };
}

/** Find open reservations by booking reference or plate number. */
function lookup(term) {
  const q = v.clean(term);
  if (!q) return [];
  const settings = settingsSvc.getAll();
  return db.prepare(`${RES_SELECT} WHERE (r.reference = ? OR v.plate_number = ?) AND r.status IN ('confirmed','active') ORDER BY r.start_at ASC LIMIT 10`)
    .all(q.toUpperCase(), v.normalizePlate(q)).map((r) => ({ ...r, bal: billing.balance(r), eligibility: checkInEligibility(r, settings) }));
}

function checkIn(reference, actor) {
  const settings = settingsSvc.getAll();
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT r.*, s.status AS slot_status, s.code AS slot_code FROM reservations r JOIN parking_slots s ON s.id = r.slot_id WHERE r.reference = ?').get(String(reference || '').toUpperCase());
    if (!row) throw notFound('Reservation');
    if (row.status === 'active') throw conflict('This vehicle is already checked in.', 'ALREADY_CHECKED_IN');
    const el = checkInEligibility(row, settings);
    if (!el.ok) throw conflict(el.reason, 'CHECKIN_NOT_ALLOWED');
    if (row.slot_status !== 'active') throw conflict(`Slot ${row.slot_code} is out of service.`, 'SLOT_NOT_BOOKABLE');
    const blocker = db.prepare("SELECT r.reference FROM parking_sessions ps JOIN reservations r ON r.id = ps.reservation_id WHERE ps.slot_id = ? AND ps.status = 'active'").get(row.slot_id);
    if (blocker) throw conflict(`Slot ${row.slot_code} still has a vehicle checked in (${blocker.reference}). Check that vehicle out first.`, 'SLOT_OCCUPIED');
    const now = T.nowIso();
    const info = db.prepare(`INSERT INTO parking_sessions (reservation_id, slot_id, vehicle_id, status, checked_in_at, checked_in_by, is_late, late_minutes, rate_centavos)
      VALUES (?,?,?, 'active', ?,?,?,?,?)`).run(row.id, row.slot_id, row.vehicle_id, now, actor.id, el.isLate ? 1 : 0, el.lateMinutes, row.hourly_rate_centavos);
    db.prepare("UPDATE reservations SET status = 'active', updated_at = ? WHERE id = ?").run(now, row.id);
    audit.log(actor, 'session.check_in', 'reservation', row.id, { reference: row.reference, late: el.isLate, lateMinutes: el.lateMinutes });
    return { sessionId: info.lastInsertRowid, isLate: el.isLate, lateMinutes: el.lateMinutes, reference: row.reference };
  });
  try { return tx.immediate(); } catch (e) {
    if (String(e.message).includes('UNIQUE constraint failed')) throw conflict('This vehicle or slot already has an active session.', 'ALREADY_CHECKED_IN');
    throw e;
  }
}

function checkOut(sessionId, actor) {
  const settings = settingsSvc.getAll();
  return db.transaction(() => {
    const s = db.prepare('SELECT ps.*, r.start_at, r.end_at, r.reference FROM parking_sessions ps JOIN reservations r ON r.id = ps.reservation_id WHERE ps.id = ?').get(sessionId);
    if (!s) throw notFound('Parking session');
    if (s.status !== 'active') throw conflict('This session has already been checked out.', 'INVALID_CHECKOUT');
    const now = T.nowIso();
    const f = billing.computeFinalFee({ rateCentavos: s.rate_centavos, startAt: s.start_at, endAt: s.end_at, outAt: now, overstayGraceMinutes: settings.overstay_grace_minutes });
    db.prepare("UPDATE parking_sessions SET status = 'completed', checked_out_at = ?, checked_out_by = ?, is_overstay = ?, overstay_minutes = ?, final_fee_centavos = ? WHERE id = ?")
      .run(now, actor.id, f.isOverstay ? 1 : 0, f.overstayMinutes, f.fee, s.id);
    db.prepare("UPDATE reservations SET status = 'completed', final_fee_centavos = ?, finalized_at = ?, updated_at = ? WHERE id = ?").run(f.fee, now, now, s.reservation_id);
    audit.log(actor, 'session.check_out', 'reservation', s.reservation_id, { reference: s.reference, fee: f.fee, overstayMinutes: f.overstayMinutes });
    return { reference: s.reference, ...f };
  }).immediate();
}

function activeSessions() {
  const settings = settingsSvc.getAll(); const now = T.nowIso();
  return db.prepare(`SELECT ps.*, r.reference, r.start_at, r.end_at, r.estimated_fee_centavos, s.code AS slot_code, z.name AS zone_name, v.plate_number, v.vehicle_type, u.name AS driver_name
    FROM parking_sessions ps JOIN reservations r ON r.id = ps.reservation_id JOIN parking_slots s ON s.id = ps.slot_id
    JOIN parking_zones z ON z.id = s.zone_id JOIN vehicles v ON v.id = ps.vehicle_id JOIN users u ON u.id = r.user_id
    WHERE ps.status = 'active' ORDER BY ps.checked_in_at`).all().map((r) => {
    const f = billing.computeFinalFee({ rateCentavos: r.rate_centavos, startAt: r.start_at, endAt: r.end_at, outAt: now, overstayGraceMinutes: settings.overstay_grace_minutes });
    return { ...r, elapsedMinutes: T.minutesBetween(r.checked_in_at, now), overstaying: f.isOverstay, overstayMinutesNow: f.overstayMinutes, projectedFee: f.fee };
  });
}

/** Unclaimed bookings starting today (or already running late) for the arrivals board. */
function expectedArrivals() {
  const settings = settingsSvc.getAll(); const now = T.nowIso();
  const { end } = T.dayBoundsUtc(T.todayLocal());
  return db.prepare(`${RES_SELECT} WHERE r.status = 'confirmed' AND r.end_at > ? AND r.start_at < ? ORDER BY r.start_at LIMIT 30`).all(now, end)
    .map((r) => ({ ...r, eligibility: checkInEligibility(r, settings, now) }));
}

module.exports = { checkInEligibility, lookup, checkIn, checkOut, activeSessions, expectedArrivals };
