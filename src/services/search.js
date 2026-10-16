'use strict';
const settingsSvc = require('./settings');
const avail = require('./availability');
const T = require('../utils/time');
const v = require('../utils/validate');

const hm = settingsSvc.hmToMin;
const pad = (n) => String(n).padStart(2, '0');
const fromMin = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

function timeOptions(settings) {
  const inc = settings.booking_increment_minutes, open = hm(settings.operating_start), close = hm(settings.operating_end);
  const all = []; for (let m = open; m <= close; m += inc) all.push({ value: fromMin(m), label: T.fmtTime12FromHm(fromMin(m)) });
  return { start: all.slice(0, -1), end: all.slice(1) };
}

/** Sensible first search: the next bookable increment today, or opening time tomorrow. */
function defaultForm(settings) {
  const inc = settings.booking_increment_minutes, open = hm(settings.operating_start), close = hm(settings.operating_end);
  const now = T.localParts(T.nowIso());
  let date = T.todayLocal(); let start = Math.ceil((now.hour * 60 + now.minute + 1) / inc) * inc;
  if (start < open) start = open;
  if (start + settings.min_duration_minutes > close) { date = T.addDays(date, 1); start = open; }
  const dur = Math.min(Math.max(120, settings.min_duration_minutes), settings.max_duration_minutes);
  return { date, start: fromMin(start), end: fromMin(Math.min(start + dur, close)) };
}

function searchAvailability(query = {}) {
  const settings = settingsSvc.getAll();
  const def = defaultForm(settings);
  const form = {
    date: T.isValidDate(query.date) ? query.date : def.date,
    start: T.isValidTime(query.start) ? query.start : def.start,
    end: T.isValidTime(query.end) ? query.end : def.end,
    zone: v.toInt(query.zone, ''), vehicleType: v.oneOf(query.vehicleType, ['car', 'motorcycle']) ? query.vehicleType : '',
  };
  const range = avail.validateRange(form, settings);
  const out = { form, settings, options: timeOptions(settings), range, errors: range.errors, valid: range.ok, zones: [], activeZone: null, minDate: T.todayLocal(), maxDate: T.addDays(T.todayLocal(), settings.advance_booking_days) };
  if (!range.ok) return out;
  const slots = avail.listSlotAvailability({ startAt: range.startAt, endAt: range.endAt, vehicleType: form.vehicleType || null });
  out.zones = avail.groupByZone(slots);
  out.activeZone = out.zones.find((z) => z.id === form.zone) || out.zones.find((z) => z.available > 0) || out.zones[0] || null;
  out.counts = { available: slots.filter((s) => s.selectable).length, total: slots.length };
  return out;
}
module.exports = { searchAvailability, timeOptions, defaultForm };
