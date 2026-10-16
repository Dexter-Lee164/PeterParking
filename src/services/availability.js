'use strict';
const { db } = require('../db');
const settingsSvc = require('./settings');
const { COMPATIBLE } = require('./catalog');
const T = require('../utils/time');

const hm = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

/** Validate a requested date + start/end (local campus time) against the booking rules. */
function validateRange({ date, start, end }, settings = settingsSvc.getAll()) {
  const errors = {};
  if (!T.isValidDate(date)) errors.date = 'Choose a valid date.';
  if (!T.isValidTime(start)) errors.start = 'Choose a start time.';
  if (!T.isValidTime(end)) errors.end = 'Choose an end time.';
  if (Object.keys(errors).length) return { ok: false, errors };

  const s = hm(start), e = hm(end), open = hm(settings.operating_start), close = hm(settings.operating_end);
  const inc = settings.booking_increment_minutes;
  if (e <= s) errors.end = 'End time must be after the start time.';
  if (s < open) errors.start = `Parking opens at ${T.fmtTime12FromHm(settings.operating_start)}.`;
  if (e > close) errors.end = `Parking closes at ${T.fmtTime12FromHm(settings.operating_end)}.`;
  if (!errors.start && s % inc) errors.start = `Start on the hour${inc === 30 ? ' or half hour' : ''}.`;
  if (!errors.end && e % inc) errors.end = `End on the hour${inc === 30 ? ' or half hour' : ''}.`;
  const minutes = e - s;
  if (!errors.end && minutes < settings.min_duration_minutes) errors.end = `Reserve at least ${T.fmtDuration(settings.min_duration_minutes)}.`;
  if (!errors.end && minutes > settings.max_duration_minutes) errors.end = `Reserve at most ${T.fmtDuration(settings.max_duration_minutes)}.`;

  const startAt = T.localToIso(date, start), endAt = T.localToIso(date, end);
  if (!errors.start && startAt < T.nowIso()) errors.start = 'This start time has already passed.';
  if (!errors.date && date > T.addDays(T.todayLocal(), settings.advance_booking_days)) errors.date = `Bookings open up to ${settings.advance_booking_days} days ahead.`;
  return { ok: !Object.keys(errors).length, errors, startAt, endAt, minutes, hours: Math.ceil(minutes / 60) };
}

const STATE_TEXT = { available: 'Available', reserved: 'Reserved', occupied: 'Occupied', unavailable: 'Unavailable' };

/**
 * Slot states for a requested window, computed from live reservation and session rows:
 * unavailable (maintenance) > occupied (vehicle checked in) > reserved (overlapping booking) > available.
 */
function listSlotAvailability({ startAt, endAt, vehicleType = null }) {
  const types = vehicleType && COMPATIBLE[vehicleType] ? COMPATIBLE[vehicleType] : null;
  const rows = db.prepare(`
    SELECT s.id, s.code, s.slot_type, s.status AS slot_status, s.notes, z.id AS zone_id, z.name AS zone_name, z.map_columns, r.hourly_rate_centavos,
      (SELECT COUNT(*) FROM reservations x WHERE x.slot_id = s.id AND x.status IN ('confirmed','active')
          AND x.start_at < @end AND x.end_at > @start) AS overlaps,
      (SELECT COUNT(*) FROM parking_sessions ps JOIN reservations rv ON rv.id = ps.reservation_id
        WHERE ps.slot_id = s.id AND ps.status = 'active' AND @start < max(rv.end_at, @now) AND @end > ps.checked_in_at) AS occupied
    FROM parking_slots s JOIN parking_zones z ON z.id = s.zone_id LEFT JOIN parking_rates r ON r.slot_type = s.slot_type
    WHERE z.is_active = 1 AND s.status <> 'inactive'
    ORDER BY z.name COLLATE NOCASE, length(s.code), s.code`).all({ start: startAt, end: endAt, now: T.nowIso() });
  return rows.filter((r) => !types || types.includes(r.slot_type)).map((r) => {
    const state = r.slot_status !== 'active' ? 'unavailable' : r.occupied ? 'occupied' : r.overlaps ? 'reserved' : 'available';
    return { ...r, rate: r.hourly_rate_centavos || 0, state, stateText: STATE_TEXT[state], selectable: state === 'available' };
  });
}

/** Group slots by zone and add availability counts for the zone tabs. */
function groupByZone(slots) {
  const zones = new Map();
  for (const s of slots) {
    if (!zones.has(s.zone_id)) zones.set(s.zone_id, { id: s.zone_id, name: s.zone_name, columns: s.map_columns, total: 0, available: 0, slots: [] });
    const z = zones.get(s.zone_id);
    z.total++; if (s.selectable) z.available++; z.slots.push(s);
  }
  return [...zones.values()];
}

/** Final server-side check used by the booking transaction. */
function conflictsFor({ slotId, startAt, endAt, excludeReservationId = 0 }) {
  return db.prepare(`SELECT id, reference FROM reservations WHERE slot_id = ? AND id <> ? AND status IN ('confirmed','active') AND start_at < ? AND end_at > ?`)
    .all(slotId, excludeReservationId, endAt, startAt);
}

module.exports = { validateRange, listSlotAvailability, groupByZone, conflictsFor, STATE_TEXT };
