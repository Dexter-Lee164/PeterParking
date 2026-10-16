'use strict';
const { db } = require('../db');
const { ValidationError } = require('../utils/errors');
const { isValidTime } = require('../utils/time');
const audit = require('./audit');

/** Configurable booking rules. type: time (HH:MM) | int. */
const FIELDS = [
  { key: 'operating_start', label: 'Opening time', type: 'time', def: '06:00', help: 'Earliest start time for a reservation.' },
  { key: 'operating_end', label: 'Closing time', type: 'time', def: '22:00', help: 'Latest end time. Reservations cannot run past midnight.' },
  { key: 'booking_increment_minutes', label: 'Booking increment (minutes)', type: 'int', def: 60, min: 30, max: 60, help: '30 or 60. Start and end times snap to this step.' },
  { key: 'min_duration_minutes', label: 'Minimum reservation (minutes)', type: 'int', def: 60, min: 30, max: 480 },
  { key: 'max_duration_minutes', label: 'Maximum reservation (minutes)', type: 'int', def: 480, min: 60, max: 960 },
  { key: 'advance_booking_days', label: 'Book up to (days ahead)', type: 'int', def: 14, min: 1, max: 90 },
  { key: 'max_open_reservations', label: 'Open reservations per driver', type: 'int', def: 5, min: 1, max: 50, help: 'Confirmed or active bookings a driver can hold at once.' },
  { key: 'cancellation_cutoff_minutes', label: 'Free cancellation cutoff (minutes before start)', type: 'int', def: 60, min: 0, max: 1440, help: 'Drivers can cancel or reschedule until this long before the start. Administrators can always cancel with a reason.' },
  { key: 'early_checkin_minutes', label: 'Early check-in window (minutes)', type: 'int', def: 30, min: 0, max: 120 },
  { key: 'late_grace_minutes', label: 'Late arrival grace (minutes)', type: 'int', def: 15, min: 0, max: 240, help: 'Check-ins later than this after the start are flagged as late.' },
  { key: 'no_show_after_minutes', label: 'No-show after (minutes past start)', type: 'int', def: 30, min: 5, max: 480, help: 'Administrators can mark an unclaimed booking as a no-show after this delay.' },
  { key: 'no_show_fee_hours', label: 'No-show fee (hours billed)', type: 'int', def: 0, min: 0, max: 8 },
  { key: 'overstay_grace_minutes', label: 'Overstay grace (minutes)', type: 'int', def: 10, min: 0, max: 120, help: 'Time after the booked end before extra hours are billed.' },
  { key: 'receipt_header', label: 'Receipt header', type: 'text', def: 'University Parking Office' },
];
const BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f]));

function getAll() {
  const out = {};
  for (const f of FIELDS) out[f.key] = f.def;
  for (const r of db.prepare('SELECT key, value FROM settings').all()) {
    const f = BY_KEY[r.key];
    if (!f) continue;
    out[r.key] = f.type === 'int' ? Number.parseInt(r.value, 10) : r.value;
  }
  return out;
}
const hmToMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

function update(input, actor) {
  const errors = {}; const next = {};
  for (const f of FIELDS) {
    const raw = String(input[f.key] ?? '').trim();
    if (f.type === 'time') { if (!isValidTime(raw)) errors[f.key] = 'Use HH:MM (24-hour).'; else next[f.key] = raw; }
    else if (f.type === 'int') {
      const n = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
      if (!Number.isFinite(n) || n < f.min || n > f.max) errors[f.key] = `Enter a whole number from ${f.min} to ${f.max}.`; else next[f.key] = n;
    } else if (!raw || raw.length > 80) errors[f.key] = 'Enter 1–80 characters.'; else next[f.key] = raw;
  }
  if (!Object.keys(errors).length) {
    if (![30, 60].includes(next.booking_increment_minutes)) errors.booking_increment_minutes = 'Use 30 or 60.';
    if (hmToMin(next.operating_end) <= hmToMin(next.operating_start)) errors.operating_end = 'Closing time must be after opening time.';
    if (next.min_duration_minutes > next.max_duration_minutes) errors.min_duration_minutes = 'Minimum cannot exceed maximum.';
    if (next.min_duration_minutes % next.booking_increment_minutes) errors.min_duration_minutes = 'Must be a multiple of the booking increment.';
    if (next.max_duration_minutes % next.booking_increment_minutes) errors.max_duration_minutes = 'Must be a multiple of the booking increment.';
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
  const before = getAll();
  const up = db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?,?,strftime('%Y-%m-%dT%H:%M:%SZ','now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at");
  const changed = {};
  db.transaction(() => {
    for (const [k, v] of Object.entries(next)) { up.run(k, String(v)); if (before[k] !== v) changed[k] = { from: before[k], to: v }; }
    audit.log(actor, 'settings.update', 'settings', null, changed);
  })();
  return getAll();
}

module.exports = { FIELDS, getAll, update, hmToMin };
