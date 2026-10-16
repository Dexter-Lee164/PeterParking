'use strict';
const crypto = require('crypto');
const { db } = require('../db');
const audit = require('./audit');
const settingsSvc = require('./settings');
const catalog = require('./catalog');
const avail = require('./availability');
const billing = require('./billing');
const T = require('../utils/time');
const { AppError, ValidationError, conflict, notFound, forbidden } = require('../utils/errors');
const v = require('../utils/validate');

const REF_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newReference = () => {
  let s = ''; for (let i = 0; i < 5; i++) s += REF_CHARS[crypto.randomInt(REF_CHARS.length)];
  return `UP-${T.localParts(T.nowIso()).date.replaceAll('-', '')}-${s}`;
};

const RES_SELECT = `SELECT r.*, s.code AS slot_code, s.slot_type, z.id AS zone_id, z.name AS zone_name,
    v.plate_number, v.vehicle_type, v.make_model, u.name AS driver_name, u.email AS driver_email,
    ps.id AS session_id, ps.status AS session_status, ps.checked_in_at, ps.checked_out_at, ps.is_late, ps.late_minutes, ps.is_overstay, ps.overstay_minutes,
    COALESCE((SELECT SUM(p.amount_centavos) FROM payments p WHERE p.reservation_id = r.id AND p.status = 'valid'), 0) AS paid_centavos
  FROM reservations r JOIN parking_slots s ON s.id = r.slot_id JOIN parking_zones z ON z.id = s.zone_id
  JOIN vehicles v ON v.id = r.vehicle_id JOIN users u ON u.id = r.user_id LEFT JOIN parking_sessions ps ON ps.reservation_id = r.id`;

const decorate = (row) => (row ? { ...row, bal: billing.balance(row) } : row);

function mapDbError(e) {
  const m = String(e && e.message);
  if (m.includes('RESERVATION_CONFLICT')) return conflict('That slot was just booked for an overlapping time. Search again and pick another slot.', 'RESERVATION_CONFLICT');
  if (m.includes('SLOT_NOT_BOOKABLE')) return conflict('That slot is not open for booking.', 'SLOT_NOT_BOOKABLE');
  return e;
}

function createReservation({ userId, vehicleId, slotId, date, start, end }, actor) {
  const settings = settingsSvc.getAll();
  const range = avail.validateRange({ date, start, end }, settings);
  if (!range.ok) throw new ValidationError(range.errors, 'The selected time cannot be booked.');

  const tx = db.transaction(() => {
    const user = db.prepare('SELECT id, is_active FROM users WHERE id = ?').get(userId);
    if (!user || !user.is_active) throw forbidden('This account is not active.');
    const vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ? AND user_id = ? AND is_active = 1').get(vehicleId, userId);
    if (!vehicle) throw new ValidationError({ vehicleId: 'Choose one of your registered vehicles.' });
    const slot = catalog.getSlot(slotId);
    if (!slot) throw notFound('Parking slot');
    if (slot.status !== 'active' || !slot.zone_active) throw conflict('This slot is not open for booking.', 'SLOT_NOT_BOOKABLE');
    if (!catalog.COMPATIBLE[vehicle.vehicle_type].includes(slot.slot_type)) {
      throw new ValidationError({ slotId: `A ${vehicle.vehicle_type} cannot use a ${slot.slot_type} slot.` });
    }
    const open = db.prepare("SELECT COUNT(*) c FROM reservations WHERE user_id = ? AND status IN ('confirmed','active')").get(userId).c;
    if (open >= settings.max_open_reservations) throw conflict(`You already hold ${open} open reservations (the limit is ${settings.max_open_reservations}).`, 'LIMIT_REACHED');
    if (db.prepare("SELECT 1 FROM reservations WHERE vehicle_id = ? AND status IN ('confirmed','active') AND start_at < ? AND end_at > ?").get(vehicleId, range.endAt, range.startAt)) {
      throw conflict('This vehicle already has a reservation that overlaps this time.', 'VEHICLE_CONFLICT');
    }
    if (avail.conflictsFor({ slotId, startAt: range.startAt, endAt: range.endAt }).length) {
      throw conflict('That slot is already reserved for an overlapping time. Search again and pick another slot.', 'RESERVATION_CONFLICT');
    }
    const rate = slot.hourly_rate_centavos || 0;
    let reference = newReference();
    while (db.prepare('SELECT 1 FROM reservations WHERE reference = ?').get(reference)) reference = newReference();
    const now = T.nowIso();
    const info = db.prepare(`INSERT INTO reservations (reference, user_id, vehicle_id, slot_id, start_at, end_at, status, hourly_rate_centavos, estimated_fee_centavos, created_at, updated_at)
      VALUES (?,?,?,?,?,?, 'confirmed', ?,?,?,?)`).run(reference, userId, vehicleId, slotId, range.startAt, range.endAt, rate, rate * range.hours, now, now);
    audit.log(actor, 'reservation.create', 'reservation', info.lastInsertRowid, { reference, slotId, start: range.startAt, end: range.endAt });
    return reference;
  });
  try { return tx.immediate(); } catch (e) { throw mapDbError(e); }
}

function getByReference(ref, actor) {
  const row = db.prepare(`${RES_SELECT} WHERE r.reference = ?`).get(String(ref || '').toUpperCase());
  if (!row || (actor.role !== 'admin' && row.user_id !== actor.id)) throw notFound('Reservation');
  return decorate(row);
}
const getById = (id) => decorate(db.prepare(`${RES_SELECT} WHERE r.id = ?`).get(id));

const TAB_STATUS = { upcoming: 'confirmed', active: 'active', completed: 'completed', cancelled: 'cancelled', 'no-show': 'no_show' };
function listForUser(userId, tab = 'upcoming', { page = 1, size = 10 } = {}) {
  const status = TAB_STATUS[tab] || 'confirmed';
  const order = status === 'confirmed' || status === 'active' ? 'ASC' : 'DESC';
  const total = db.prepare('SELECT COUNT(*) c FROM reservations WHERE user_id = ? AND status = ?').get(userId, status).c;
  const rows = db.prepare(`${RES_SELECT} WHERE r.user_id = ? AND r.status = ? ORDER BY r.start_at ${order} LIMIT ? OFFSET ?`).all(userId, status, size, (page - 1) * size).map(decorate);
  const counts = {};
  for (const r of db.prepare('SELECT status, COUNT(*) c FROM reservations WHERE user_id = ? GROUP BY status').all(userId)) counts[r.status] = r.c;
  return { rows, total, counts: { upcoming: counts.confirmed || 0, active: counts.active || 0, completed: counts.completed || 0, cancelled: counts.cancelled || 0, 'no-show': counts.no_show || 0 } };
}

function search({ q = '', status = '', zoneId = '', dateFrom = '', dateTo = '', userId = '', page = 1, size = 15 } = {}) {
  const where = []; const p = [];
  if (q) {
    where.push('(r.reference LIKE ? OR u.name LIKE ? OR u.email LIKE ? OR v.plate_number LIKE ?)');
    const like = `%${q.replace(/\s+/g, '')}%`; p.push(like, `%${q}%`, `%${q}%`, like);
  }
  if (v.oneOf(status, ['confirmed', 'active', 'completed', 'cancelled', 'no_show'])) { where.push('r.status = ?'); p.push(status); }
  if (zoneId) { where.push('z.id = ?'); p.push(zoneId); }
  if (userId) { where.push('r.user_id = ?'); p.push(userId); }
  if (T.isValidDate(dateFrom)) { where.push('r.start_at >= ?'); p.push(T.dayBoundsUtc(dateFrom).start); }
  if (T.isValidDate(dateTo)) { where.push('r.start_at < ?'); p.push(T.dayBoundsUtc(dateTo).end); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = RES_SELECT.slice(RES_SELECT.indexOf(' FROM reservations r'));
  const total = db.prepare(`SELECT COUNT(*) c ${from} ${w}`).get(...p).c;
  const rows = db.prepare(`${RES_SELECT} ${w} ORDER BY r.start_at DESC, r.id DESC LIMIT ? OFFSET ?`).all(...p, size, (page - 1) * size).map(decorate);
  return { rows, total };
}

function assertActorMayChange(row, actor, settings, verb) {
  if (actor.role !== 'admin') {
    if (row.user_id !== actor.id) throw notFound('Reservation');
    const cutoff = T.addMinutesIso(row.start_at, -settings.cancellation_cutoff_minutes);
    if (T.nowIso() > cutoff) throw conflict(`You can ${verb} until ${T.fmtDateTime(cutoff)} (${T.fmtDuration(settings.cancellation_cutoff_minutes)} before the start). Please contact the parking office.`, 'PAST_CUTOFF');
  }
}

function cancelReservation(reference, reason, actor) {
  const settings = settingsSvc.getAll();
  const text = v.cleanMultiline(reason).slice(0, 300);
  if (actor.role === 'admin' && text.length < 3) throw new ValidationError({ reason: 'Enter a reason (at least 3 characters).' });
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM reservations WHERE reference = ?').get(String(reference || '').toUpperCase());
    if (!row || (actor.role !== 'admin' && row.user_id !== actor.id)) throw notFound('Reservation');
    if (row.status !== 'confirmed') throw conflict(row.status === 'active' ? 'A vehicle is checked in. Check it out instead of cancelling.' : `This reservation is already ${row.status.replace('_', '-')}.`, 'BAD_STATE');
    assertActorMayChange(row, actor, settings, 'cancel');
    const now = T.nowIso();
    db.prepare(`UPDATE reservations SET status = 'cancelled', cancel_reason = ?, cancelled_by = ?, cancelled_at = ?, final_fee_centavos = 0, finalized_at = ?, updated_at = ? WHERE id = ?`)
      .run(text || null, actor.id, now, now, now, row.id);
    audit.log(actor, 'reservation.cancel', 'reservation', row.id, { reference: row.reference, reason: text || null });
    return row.reference;
  }).immediate();
}

function rescheduleReservation(reference, { date, start, end }, actor) {
  const settings = settingsSvc.getAll();
  const range = avail.validateRange({ date, start, end }, settings);
  if (!range.ok) throw new ValidationError(range.errors, 'The new time cannot be booked.');
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT * FROM reservations WHERE reference = ?').get(String(reference || '').toUpperCase());
    if (!row || (actor.role !== 'admin' && row.user_id !== actor.id)) throw notFound('Reservation');
    if (row.status !== 'confirmed') throw conflict('Only upcoming reservations can be rescheduled.', 'BAD_STATE');
    assertActorMayChange(row, actor, settings, 'reschedule');
    const slot = catalog.getSlot(row.slot_id);
    if (slot.status !== 'active' || !slot.zone_active) throw conflict('This slot is out of service. Cancel the reservation and book another slot.', 'SLOT_NOT_BOOKABLE');
    if (avail.conflictsFor({ slotId: row.slot_id, startAt: range.startAt, endAt: range.endAt, excludeReservationId: row.id }).length) {
      throw conflict('This slot is already reserved for part of that time. Try another time or cancel and book a different slot.', 'RESERVATION_CONFLICT');
    }
    if (db.prepare("SELECT 1 FROM reservations WHERE vehicle_id = ? AND id <> ? AND status IN ('confirmed','active') AND start_at < ? AND end_at > ?").get(row.vehicle_id, row.id, range.endAt, range.startAt)) {
      throw conflict('This vehicle already has a reservation that overlaps the new time.', 'VEHICLE_CONFLICT');
    }
    const rate = slot.hourly_rate_centavos ?? row.hourly_rate_centavos;
    db.prepare('UPDATE reservations SET start_at = ?, end_at = ?, hourly_rate_centavos = ?, estimated_fee_centavos = ?, rescheduled_count = rescheduled_count + 1, updated_at = ? WHERE id = ?')
      .run(range.startAt, range.endAt, rate, rate * range.hours, T.nowIso(), row.id);
    audit.log(actor, 'reservation.reschedule', 'reservation', row.id, { from: [row.start_at, row.end_at], to: [range.startAt, range.endAt] });
    return row.reference;
  });
  try { return tx.immediate(); } catch (e) { throw mapDbError(e); }
}

function markNoShow(reference, actor) {
  const settings = settingsSvc.getAll();
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM reservations WHERE reference = ?').get(String(reference || '').toUpperCase());
    if (!row) throw notFound('Reservation');
    if (row.status !== 'confirmed') throw conflict('Only unclaimed upcoming reservations can be marked as no-show.', 'BAD_STATE');
    const earliest = T.addMinutesIso(row.start_at, settings.no_show_after_minutes);
    if (T.nowIso() < earliest) throw conflict(`A no-show can be recorded after ${T.fmtTime(earliest)} (${settings.no_show_after_minutes} minutes past the start).`, 'TOO_EARLY');
    const fee = row.hourly_rate_centavos * settings.no_show_fee_hours;
    const now = T.nowIso();
    db.prepare("UPDATE reservations SET status = 'no_show', final_fee_centavos = ?, finalized_at = ?, updated_at = ? WHERE id = ?").run(fee, now, now, row.id);
    audit.log(actor, 'reservation.no_show', 'reservation', row.id, { reference: row.reference, fee });
    return row.reference;
  }).immediate();
}

/** Marks every unclaimed booking past the no-show delay. Returns how many were updated. */
function markAllOverdueNoShows(actor) {
  const settings = settingsSvc.getAll();
  const cutoff = T.addMinutesIso(T.nowIso(), -settings.no_show_after_minutes);
  const refs = db.prepare("SELECT reference FROM reservations WHERE status = 'confirmed' AND start_at <= ?").all(cutoff).map((r) => r.reference);
  let n = 0; for (const ref of refs) { try { markNoShow(ref, actor); n++; } catch { /* skip */ } }
  return n;
}
const overdueCount = () => db.prepare("SELECT COUNT(*) c FROM reservations WHERE status = 'confirmed' AND start_at <= ?").get(T.addMinutesIso(T.nowIso(), -settingsSvc.getAll().no_show_after_minutes)).c;

module.exports = { RES_SELECT, createReservation, getByReference, getById, listForUser, search, cancelReservation, rescheduleReservation, markNoShow, markAllOverdueNoShows, overdueCount, newReference };
