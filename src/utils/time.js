'use strict';
const config = require('../config/env');
const clock = require('./clock');

const TZ = config.tzOffsetMinutes;
const pad = (n) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const toIso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const nowIso = () => toIso(clock.now());
const addMinutesIso = (iso, m) => toIso(new Date(new Date(iso).getTime() + m * 60000));
const minutesBetween = (a, b) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
const billedHours = (startIso, endIso) => Math.max(0, Math.ceil(minutesBetween(startIso, endIso) / 60));

function isValidDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}
const isValidTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));

function localToIso(dateStr, timeStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  return toIso(new Date(Date.UTC(y, mo - 1, d, h, mi) - TZ * 60000));
}
function localParts(iso) {
  const d = new Date(new Date(iso).getTime() + TZ * 60000);
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    hour: d.getUTCHours(), minute: d.getUTCMinutes(), dow: d.getUTCDay(),
    y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(),
  };
}
const todayLocal = () => localParts(nowIso()).date;
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}
function weekStart(dateStr) { // Monday
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(dateStr, -((dow + 6) % 7));
}
const monthStart = (dateStr) => `${dateStr.slice(0, 7)}-01`;
function nextMonthStart(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
}
const dayBoundsUtc = (dateStr) => ({ start: localToIso(dateStr, '00:00'), end: localToIso(addDays(dateStr, 1), '00:00') });

function fmtDate(iso) { if (!iso) return '—'; const p = localParts(iso); return `${DAYS[p.dow]}, ${MONTHS[p.m]} ${p.d}, ${p.y}`; }
function fmtDateShort(dateStr) { const [y, m, d] = dateStr.split('-').map(Number); return `${MONTHS[m - 1]} ${d}, ${y}`; }
function fmtTime(iso) {
  if (!iso) return '—';
  const p = localParts(iso);
  return `${p.hour % 12 || 12}:${pad(p.minute)} ${p.hour < 12 ? 'AM' : 'PM'}`;
}
const fmtDateTime = (iso) => (iso ? `${fmtDate(iso)}, ${fmtTime(iso)}` : '—');
const fmtRange = (s, e) => `${fmtDate(s)} · ${fmtTime(s)} – ${fmtTime(e)}`;
function fmtDuration(min) {
  if (min == null) return '—';
  const h = Math.floor(min / 60), m = min % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}
function fmtTime12FromHm(hm) { const [h, m] = hm.split(':').map(Number); return `${h % 12 || 12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`; }

module.exports = {
  TZ, toIso, nowIso, addMinutesIso, minutesBetween, billedHours, isValidDate, isValidTime, localToIso, localParts,
  todayLocal, addDays, weekStart, monthStart, nextMonthStart, dayBoundsUtc, fmtDate, fmtDateShort, fmtTime, fmtDateTime,
  fmtRange, fmtDuration, fmtTime12FromHm,
};
