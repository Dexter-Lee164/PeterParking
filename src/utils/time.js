'use strict';

/**
 * Campus-local time helpers.
 *
 * All reservation and session times are stored as local campus time in the format
 * 'YYYY-MM-DD HH:MM:SS' (the Philippines has no daylight saving, so local time is
 * unambiguous). The "current time" always comes from clock.now() so tests can
 * freeze or move it.
 */

const config = require('../config');

let clockFn = () => new Date();

const clock = {
  now: () => clockFn(),
  set(fn) {
    clockFn = typeof fn === 'function' ? fn : () => new Date(fn);
  },
  reset() {
    clockFn = () => new Date();
  },
};

const pad = (n) => String(n).padStart(2, '0');

const formatterCache = new Map();
function partsFormatter(timeZone) {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(
      timeZone,
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }),
    );
  }
  return formatterCache.get(timeZone);
}

/** 'YYYY-MM-DD HH:MM:SS' in campus time for a JS Date. */
function toLocalString(date = clock.now(), timeZone = config.timezone) {
  const parts = {};
  for (const p of partsFormatter(timeZone).formatToParts(date)) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

const nowLocal = () => toLocalString(clock.now());
const todayLocal = () => nowLocal().slice(0, 10);

/** Parse a local string into a UTC-based epoch ms (only differences are meaningful). */
function toMs(str) {
  const s = String(str).trim().replace(' ', 'T');
  const full = s.length === 10 ? `${s}T00:00:00` : s.length === 16 ? `${s}:00` : s;
  return Date.parse(`${full}Z`);
}

function fromMs(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

const addMinutes = (str, minutes) => fromMs(toMs(str) + minutes * 60000);
const addDays = (str, days) => fromMs(toMs(str) + days * 86400000);
const diffMinutes = (later, earlier) => Math.round((toMs(later) - toMs(earlier)) / 60000);

const isValidDate = (str) => /^\d{4}-\d{2}-\d{2}$/.test(str || '') && fromMs(toMs(str)).slice(0, 10) === str;
const isValidTime = (str) => /^([01]\d|2[0-3]):[0-5]\d$/.test(str || '');
const minutesOfDay = (hhmm) => parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(3, 5), 10);

/** Combine a 'YYYY-MM-DD' date and 'HH:MM' time into a stored string. */
const combine = (date, time) => `${date} ${time}:00`;

/** Round a local string down to a step (in minutes) within its day. */
function floorToStep(str, stepMinutes) {
  const date = str.slice(0, 10);
  const mins = minutesOfDay(str.slice(11, 16));
  const floored = Math.floor(mins / stepMinutes) * stepMinutes;
  return `${date} ${pad(Math.floor(floored / 60))}:${pad(floored % 60)}:00`;
}

// ---- display helpers -------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function fmtDate(str) {
  if (!str) return '—';
  const d = new Date(toMs(str));
  return `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
function fmtDateShort(str) {
  if (!str) return '—';
  const d = new Date(toMs(str));
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
function fmtTime(str) {
  if (!str) return '—';
  const h = parseInt(str.slice(11, 13), 10);
  const m = str.slice(14, 16);
  const suffix = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 === 0 ? 12 : h % 12}:${m} ${suffix}`;
}
const fmtDateTime = (str) => (str ? `${fmtDateShort(str)}, ${str.slice(0, 4)} · ${fmtTime(str)}` : '—');
const fmtHHMM = (hhmm) => fmtTime(`2000-01-01 ${hhmm}:00`);

function fmtDuration(minutes) {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return '—';
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h && r) return `${h}h ${r}m`;
  if (h) return `${h}h`;
  return `${r}m`;
}

module.exports = {
  clock,
  nowLocal,
  todayLocal,
  toLocalString,
  toMs,
  fromMs,
  addMinutes,
  addDays,
  diffMinutes,
  isValidDate,
  isValidTime,
  minutesOfDay,
  combine,
  floorToStep,
  fmtDate,
  fmtDateShort,
  fmtTime,
  fmtDateTime,
  fmtHHMM,
  fmtDuration,
};
