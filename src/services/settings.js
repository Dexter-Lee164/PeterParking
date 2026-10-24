'use strict';

const ctx = require('../db/context');

/**
 * Configurable booking / billing policy. Stored in the `settings` table so an
 * administrator can change it from the Settings page; defaults live here.
 */
const DEFINITIONS = [
  { key: 'time_step_minutes', label: 'Booking time step (minutes)', type: 'select', options: [30, 60], def: 60,
    help: 'Reservations start and end on multiples of this step. 60 = strictly hourly bookings.' },
  { key: 'open_time', label: 'Facility opens', type: 'time', def: '06:00', help: 'Earliest reservation start time.' },
  { key: 'close_time', label: 'Facility closes', type: 'time', def: '22:00', help: 'Latest reservation end time. Bookings never cross midnight.' },
  { key: 'min_duration_minutes', label: 'Minimum booking (minutes)', type: 'int', min: 30, max: 1440, def: 60 },
  { key: 'max_duration_minutes', label: 'Maximum booking (minutes)', type: 'int', min: 30, max: 1440, def: 480 },
  { key: 'max_advance_days', label: 'Maximum days booked in advance', type: 'int', min: 0, max: 365, def: 14 },
  { key: 'max_active_reservations', label: 'Max active reservations per driver', type: 'int', min: 1, max: 50, def: 5,
    help: 'Counts upcoming and in-progress reservations.' },
  { key: 'billing_increment_minutes', label: 'Billing increment (minutes)', type: 'select', options: [30, 60], def: 60,
    help: 'Fees are charged per increment, rounding up. 60 = whole hours.' },
  { key: 'checkin_early_minutes', label: 'Early check-in allowed (minutes)', type: 'int', min: 0, max: 240, def: 15 },
  { key: 'late_arrival_grace_minutes', label: 'Late-arrival grace (minutes)', type: 'int', min: 0, max: 240, def: 15,
    help: 'Arrivals later than start + grace are flagged as late; no-shows can be marked after this point.' },
  { key: 'overstay_grace_minutes', label: 'Overstay grace (minutes)', type: 'int', min: 0, max: 240, def: 10,
    help: 'Departures after reserved end + grace are flagged and charged overstay time.' },
  { key: 'overstay_multiplier_percent', label: 'Overstay rate (% of hourly rate)', type: 'int', min: 100, max: 1000, def: 150 },
  { key: 'cancel_free_hours', label: 'Free cancellation window (hours before start)', type: 'int', min: 0, max: 168, def: 2 },
  { key: 'late_cancel_fee_percent', label: 'Late cancellation fee (% of estimated fee)', type: 'int', min: 0, max: 100, def: 50 },
  { key: 'no_show_fee_percent', label: 'No-show fee (% of estimated fee)', type: 'int', min: 0, max: 100, def: 50 },
];

const BY_KEY = Object.fromEntries(DEFINITIONS.map((d) => [d.key, d]));

function coerce(def, raw) {
  if (def.type === 'int' || def.type === 'select') return parseInt(raw, 10);
  return String(raw);
}

function getAll() {
  const rows = ctx.get().prepare('SELECT key, value FROM settings').all();
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const out = {};
  for (const def of DEFINITIONS) {
    out[def.key] = stored[def.key] !== undefined ? coerce(def, stored[def.key]) : def.def;
  }
  return out;
}

/** Validate and persist a submitted settings object. Returns { errors, values }. */
function update(input) {
  const errors = {};
  const values = {};
  for (const def of DEFINITIONS) {
    const raw = input[def.key];
    if (raw === undefined || raw === '') {
      errors[def.key] = 'Required.';
      continue;
    }
    if (def.type === 'time') {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(raw))) errors[def.key] = 'Use HH:MM (24-hour).';
      else values[def.key] = String(raw);
    } else {
      const n = Number(raw);
      if (!Number.isInteger(n)) errors[def.key] = 'Enter a whole number.';
      else if (def.type === 'select' && !def.options.includes(n)) errors[def.key] = 'Choose a valid option.';
      else if (def.type === 'int' && (n < def.min || n > def.max)) errors[def.key] = `Must be between ${def.min} and ${def.max}.`;
      else values[def.key] = n;
    }
  }
  if (!errors.open_time && !errors.close_time && values.open_time >= values.close_time) {
    errors.close_time = 'Closing time must be after opening time.';
  }
  if (!errors.min_duration_minutes && !errors.max_duration_minutes && values.min_duration_minutes > values.max_duration_minutes) {
    errors.max_duration_minutes = 'Maximum must be at least the minimum.';
  }
  if (!errors.time_step_minutes) {
    const step = values.time_step_minutes;
    for (const k of ['min_duration_minutes', 'max_duration_minutes']) {
      if (!errors[k] && values[k] % step !== 0) errors[k] = `Must be a multiple of the ${step}-minute time step.`;
    }
    for (const k of ['open_time', 'close_time']) {
      if (!errors[k]) {
        const mins = parseInt(values[k].slice(0, 2), 10) * 60 + parseInt(values[k].slice(3, 5), 10);
        if (mins % step !== 0) errors[k] = `Must fall on the ${step}-minute time step.`;
      }
    }
  }
  if (Object.keys(errors).length) return { errors, values };

  const db = ctx.get();
  const upsert = db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now', 'localtime'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  db.transaction(() => {
    for (const [k, v] of Object.entries(values)) upsert.run(k, String(v));
  })();
  return { errors: null, values };
}

module.exports = { DEFINITIONS, BY_KEY, getAll, update };
