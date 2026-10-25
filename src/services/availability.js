'use strict';

const ctx = require('../db/context');
const settingsService = require('./settings');
const parking = require('./parking');
const fees = require('./fees');
const time = require('../utils/time');
const { clean, toInt, oneOf } = require('../utils/validate');

/**
 * Validate a requested reservation window against the booking rules.
 * Returns { ok, errors: [messages], fields: {name: msg}, startAt, endAt, durationMinutes }.
 */
function validateRange({ date, start, end }, settings = settingsService.getAll(), { allowPast = false } = {}) {
  const fields = {};
  const d = clean(date);
  const s = clean(start);
  const e = clean(end);
  const step = settings.time_step_minutes;
  const nowStr = time.nowLocal();

  if (!time.isValidDate(d)) fields.date = 'Choose a valid date.';
  if (!time.isValidTime(s)) fields.start = 'Choose a valid start time.';
  if (!time.isValidTime(e)) fields.end = 'Choose a valid end time.';

  let startAt = null;
  let endAt = null;
  let durationMinutes = null;

  if (!fields.date && !fields.start && !fields.end) {
    const sm = time.minutesOfDay(s);
    const em = time.minutesOfDay(e);
    startAt = time.combine(d, s);
    endAt = time.combine(d, e);
    durationMinutes = em - sm;

    if (em <= sm) fields.end = 'End time must be after the start time.';
    else {
      if (sm % step !== 0 || em % step !== 0) {
        fields.start = `Times must fall on a ${step === 60 ? 'whole hour' : `${step}-minute mark`}.`;
      }
      if (sm < time.minutesOfDay(settings.open_time)) fields.start = `The facility opens at ${time.fmtHHMM(settings.open_time)}.`;
      if (em > time.minutesOfDay(settings.close_time)) fields.end = `The facility closes at ${time.fmtHHMM(settings.close_time)}.`;
      if (!fields.start && !fields.end) {
        if (durationMinutes < settings.min_duration_minutes) {
          fields.end = `Minimum booking is ${time.fmtDuration(settings.min_duration_minutes)}.`;
        } else if (durationMinutes > settings.max_duration_minutes) {
          fields.end = `Maximum booking is ${time.fmtDuration(settings.max_duration_minutes)}.`;
        }
      }
    }
    if (!allowPast && !fields.date && !fields.start && !fields.end) {
      if (startAt < time.floorToStep(nowStr, step)) fields.start = 'That start time has already passed.';
      else if (d > time.addDays(nowStr, settings.max_advance_days).slice(0, 10)) {
        fields.date = `Bookings can be made up to ${settings.max_advance_days} days in advance.`;
      }
    }
  }

  const errors = Object.values(fields);
  return { ok: errors.length === 0, errors, fields, startAt, endAt, durationMinutes };
}

/**
 * Real, SQLite-backed availability for every active zone over [startAt, endAt).
 * A slot is:
 *   unavailable — out of service (status 'maintenance') / inactive, or free but does not fit the chosen vehicle type
 *   occupied    — a vehicle is physically parked (checked in) and the window overlaps its stay
 *   reserved    — another active booking overlaps the window
 *   available   — otherwise
 * Occupied and reserved win over "does not fit", so filtering by vehicle type never hides what is happening in a bay.
 * Adjacent bookings (one ends exactly when the next begins) never conflict.
 */
function getAvailability({ startAt, endAt, vehicleType = '', userId = null, excludeReservationId = 0 }) {
  const db = ctx.get();
  const settings = settingsService.getAll();
  const now = time.nowLocal();
  const duration = time.diffMinutes(endAt, startAt);

  const zones = parking.listZones({ includeInactive: false });
  const slots = db
    .prepare(`${parking.SLOT_SELECT} WHERE z.is_active = 1 AND s.retired_at IS NULL ORDER BY z.sort_order, z.name, s.sort_order, s.slot_code`)
    .all();

  // A checked-in vehicle blocks the slot at least until "now" (covers overstays).
  const conflicts = db
    .prepare(
      `SELECT slot_id, status, user_id FROM reservations
       WHERE status IN ('confirmed', 'checked_in')
         AND id <> @exclude
         AND start_at < @end
         AND (CASE WHEN status = 'checked_in' AND end_at < @now THEN @now ELSE end_at END) > @start`,
    )
    .all({ exclude: excludeReservationId, end: endAt, start: startAt, now });

  const bySlot = new Map();
  for (const c of conflicts) {
    const cur = bySlot.get(c.slot_id) || { occupied: false, mine: false };
    if (c.status === 'checked_in') cur.occupied = true;
    if (userId && c.user_id === userId) cur.mine = true;
    bySlot.set(c.slot_id, cur);
  }

  const result = slots.map((s) => {
    let state = 'available';
    let reason = 'Free for your selected time';
    const compatible = !vehicleType || parking.vehicleFitsSlotType(s.type_vehicle, vehicleType);
    if (s.status !== 'active') {
      state = 'unavailable';
      reason = s.status === 'maintenance' ? 'Out of service' : 'Inactive';
    } else if (bySlot.has(s.id)) {
      const c = bySlot.get(s.id);
      state = c.occupied ? 'occupied' : 'reserved';
      reason = c.occupied ? 'Vehicle currently parked' : c.mine ? 'You already booked this time' : 'Reserved for part of your selected time';
    } else if (!compatible) {
      state = 'unavailable';
      reason = s.type_vehicle === 'motorcycle' ? `Motorcycles only: not for a ${vehicleType}` : `Cars only: not for a ${vehicleType}`;
    }
    return {
      id: s.id,
      zone_id: s.zone_id,
      zone_name: s.zone_name,
      code: s.slot_code,
      slot_type: s.slot_type,
      type_vehicle: s.type_vehicle,
      type_label: s.type_label,
      type_icon: s.type_icon,
      operational_status: s.status,
      hourly_rate_centavos: s.hourly_rate_centavos,
      est_fee_centavos: fees.estimatedFee(s.hourly_rate_centavos, duration, settings),
      state,
      reason,
      compatible, // fits the requested vehicle type (always true when no type was given)
    };
  });

  const zoneSummaries = zones.map((z) => {
    const zs = result.filter((s) => s.zone_id === z.id);
    return {
      id: z.id,
      code: z.code,
      name: z.name,
      description: z.description,
      map_columns: z.map_columns,
      total: zs.length,
      compatible: zs.filter((s) => s.compatible).length,
      available: zs.filter((s) => s.state === 'available').length,
    };
  });

  return { zones: zoneSummaries, slots: result, durationMinutes: duration, settings };
}

/** A sensible default search window: the next booking step today, else opening time tomorrow. */
function defaultWindow(settings) {
  const step = settings.time_step_minutes;
  const nowStr = time.nowLocal();
  const today = nowStr.slice(0, 10);
  const open = time.minutesOfDay(settings.open_time);
  const close = time.minutesOfDay(settings.close_time);
  const next = time.addMinutes(time.floorToStep(nowStr, step), step);
  let date = next.slice(0, 10);
  let startMin = date === today ? time.minutesOfDay(next.slice(11, 16)) : open;
  if (startMin < open) startMin = open;
  if (startMin + settings.min_duration_minutes > close) {
    date = time.addDays(`${today} 00:00:00`, 1).slice(0, 10);
    startMin = open;
  }
  const endMin = Math.min(startMin + Math.max(settings.min_duration_minutes, 120), close);
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return { date, start: hhmm(startMin), end: hhmm(endMin) };
}

/** Parse the find-parking query string into a normalised request object. */
function parseSearch(query, settings = settingsService.getAll()) {
  const def = defaultWindow(settings);
  const date = time.isValidDate(clean(query.date)) ? clean(query.date) : def.date;
  const start = time.isValidTime(clean(query.start)) ? clean(query.start) : def.start;
  const end = time.isValidTime(clean(query.end)) ? clean(query.end) : def.end;
  return {
    date,
    start,
    end,
    zoneId: toInt(query.zone_id),
    vehicleType: oneOf(clean(query.vehicle_type), parking.VEHICLE_TYPES, ''),
    slotId: toInt(query.slot_id),
  };
}

/** <option> lists for start / end selects according to the booking time step. */
function timeOptions(settings = settingsService.getAll()) {
  const step = settings.time_step_minutes;
  const open = time.minutesOfDay(settings.open_time);
  const close = time.minutesOfDay(settings.close_time);
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const mk = (m) => ({ value: hhmm(m), label: time.fmtHHMM(hhmm(m)) });
  const start = [];
  const end = [];
  for (let m = open; m < close; m += step) start.push(mk(m));
  for (let m = open + step; m <= close; m += step) end.push(mk(m));
  return { start, end };
}

module.exports = { validateRange, getAvailability, parseSearch, defaultWindow, timeOptions };
