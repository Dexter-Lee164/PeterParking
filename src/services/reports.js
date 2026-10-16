'use strict';
const { db } = require('../db');
const settingsSvc = require('./settings');
const avail = require('./availability');
const payments = require('./payments');
const audit = require('./audit');
const T = require('../utils/time');
const v = require('../utils/validate');

const tzMod = `${T.TZ >= 0 ? '+' : ''}${T.TZ} minutes`;
const dayRange = (endDate, n) => Array.from({ length: n }, (_, i) => T.addDays(endDate, i - n + 1));

/** Everything on the administrator dashboard comes from these queries. */
function dashboard() {
  const now = T.nowIso();
  const slots = avail.listSlotAvailability({ startAt: now, endAt: T.addMinutesIso(now, 1) });
  const count = (s) => slots.filter((x) => x.state === s).length;
  const today = T.todayLocal(); const b = T.dayBoundsUtc(today);
  const todayRes = db.prepare("SELECT COUNT(*) c FROM reservations WHERE start_at >= ? AND start_at < ? AND status <> 'cancelled'").get(b.start, b.end).c;
  const out = payments.outstanding({ limit: 1 });

  const from14 = T.dayBoundsUtc(T.addDays(today, -13)).start, from30 = T.dayBoundsUtc(T.addDays(today, -29)).start;
  const perDay = Object.fromEntries(db.prepare("SELECT date(start_at, ?) d, COUNT(*) c FROM reservations WHERE start_at >= ? AND start_at < ? AND status <> 'cancelled' GROUP BY d").all(tzMod, from14, b.end).map((r) => [r.d, r.c]));
  const cashDay = Object.fromEntries(db.prepare("SELECT date(recorded_at, ?) d, SUM(amount_centavos) s FROM payments WHERE status = 'valid' AND recorded_at >= ? AND recorded_at < ? GROUP BY d").all(tzMod, from14, b.end).map((r) => [r.d, r.s]));
  const days = dayRange(today, 14);
  const hourRows = db.prepare("SELECT CAST(strftime('%H', start_at, ?) AS INTEGER) h, COUNT(*) c FROM reservations WHERE start_at >= ? AND status <> 'cancelled' GROUP BY h").all(tzMod, from30);
  const settings = settingsSvc.getAll();
  const h0 = parseInt(settings.operating_start, 10), h1 = Math.ceil(settingsSvc.hmToMin(settings.operating_end) / 60);
  const hours = Array.from({ length: Math.max(1, h1 - h0) }, (_, i) => h0 + i);
  const byZone = db.prepare(`SELECT z.name, COUNT(*) c FROM reservations r JOIN parking_slots s ON s.id = r.slot_id JOIN parking_zones z ON z.id = s.zone_id
    WHERE r.start_at >= ? AND r.status <> 'cancelled' GROUP BY z.id ORDER BY c DESC`).all(from30);
  const st = Object.fromEntries(db.prepare('SELECT status, COUNT(*) c FROM reservations WHERE start_at >= ? GROUP BY status').all(from30).map((r) => [r.status, r.c]));
  const total30 = Object.values(st).reduce((a, b2) => a + b2, 0);
  const pct = (n) => (total30 ? Math.round((n / total30) * 1000) / 10 : 0);

  return {
    kpis: { totalSlots: slots.filter((s) => s.slot_status === 'active').length, availableNow: count('available'), reservedNow: count('reserved'), occupiedNow: count('occupied'),
      unavailableNow: count('unavailable'), todayReservations: todayRes, outstandingAmount: out.amount, outstandingCount: out.count },
    charts: {
      reservations: { labels: days.map((d) => T.fmtDateShort(d).slice(0, -6)), values: days.map((d) => perDay[d] || 0) },
      peakHours: { labels: hours.map((h) => T.fmtTime12FromHm(`${String(h).padStart(2, '0')}:00`)), values: hours.map((h) => hourRows.find((r) => r.h === h)?.c || 0) },
      zones: { labels: byZone.map((z) => z.name), values: byZone.map((z) => z.c) },
      outcomes: { labels: ['Completed', 'Upcoming or active', 'Cancelled', 'No-show'], values: [st.completed || 0, (st.confirmed || 0) + (st.active || 0), st.cancelled || 0, st.no_show || 0],
        cancelRate: pct(st.cancelled || 0), noShowRate: pct(st.no_show || 0), total: total30 },
      collections: { labels: days.map((d) => T.fmtDateShort(d).slice(0, -6)), values: days.map((d) => (cashDay[d] || 0) / 100) },
    },
    recent: audit.list({ size: 8 }).rows,
  };
}

/* --------------------------- period reports --------------------------- */
function periodRange(period, date) {
  if (period === 'weekly') { const s = T.weekStart(date); return { from: s, to: T.addDays(s, 7), days: 7 }; }
  if (period === 'monthly') { const s = T.monthStart(date); const to = T.nextMonthStart(s); return { from: s, to, days: Math.round((Date.parse(to) - Date.parse(s)) / 864e5) }; }
  return { from: date, to: T.addDays(date, 1), days: 1 };
}

function report({ period = 'daily', date = T.todayLocal(), zoneId = '' } = {}) {
  if (!['daily', 'weekly', 'monthly'].includes(period)) period = 'daily';
  if (!T.isValidDate(date)) date = T.todayLocal();
  const zid = v.toInt(zoneId);
  const range = periodRange(period, date);
  const startUtc = T.dayBoundsUtc(range.from).start, endUtc = T.dayBoundsUtc(T.addDays(range.to, -1)).end;
  const settings = settingsSvc.getAll();
  const opMinutes = settingsSvc.hmToMin(settings.operating_end) - settingsSvc.hmToMin(settings.operating_start);

  const zoneSql = zid ? 'AND z.id = ?' : ''; const zp = zid ? [zid] : [];
  const res = db.prepare(`SELECT r.id, r.reference, r.start_at, r.end_at, r.status, r.estimated_fee_centavos, r.final_fee_centavos, z.id AS zone_id, z.name AS zone_name, s.code AS slot_code,
      u.name AS driver_name, v.plate_number,
      (SELECT COUNT(*) FROM parking_sessions ps WHERE ps.reservation_id = r.id) AS has_session,
      COALESCE((SELECT SUM(p.amount_centavos) FROM payments p WHERE p.reservation_id = r.id AND p.status = 'valid'), 0) AS paid
    FROM reservations r JOIN parking_slots s ON s.id = r.slot_id JOIN parking_zones z ON z.id = s.zone_id JOIN users u ON u.id = r.user_id JOIN vehicles v ON v.id = r.vehicle_id
    WHERE r.start_at >= ? AND r.start_at < ? ${zoneSql} ORDER BY r.start_at`).all(startUtc, endUtc, ...zp);
  const pays = db.prepare(`SELECT p.amount_centavos AS amount, p.recorded_at, z.id AS zone_id FROM payments p JOIN reservations r ON r.id = p.reservation_id
      JOIN parking_slots s ON s.id = r.slot_id JOIN parking_zones z ON z.id = s.zone_id WHERE p.status = 'valid' AND p.recorded_at >= ? AND p.recorded_at < ? ${zoneSql}`).all(startUtc, endUtc, ...zp);
  const zones = db.prepare(`SELECT z.id, z.name, (SELECT COUNT(*) FROM parking_slots s WHERE s.zone_id = z.id AND s.status = 'active') AS slots FROM parking_zones z WHERE z.is_active = 1 ${zid ? 'AND z.id = ?' : ''} ORDER BY z.name COLLATE NOCASE`).all(...zp);
  const totalSlots = zones.reduce((a, z) => a + z.slots, 0);

  const byZone = period === 'daily';
  const buckets = byZone ? zones.map((z) => ({ key: z.id, label: z.name, capacity: z.slots * opMinutes })) : dayRange(T.addDays(range.to, -1), range.days).map((d) => ({ key: d, label: `${T.fmtDateShort(d)}`, capacity: totalSlots * opMinutes }));
  const rows = buckets.map((b) => ({ ...b, reservations: 0, completed: 0, cancelled: 0, noShows: 0, sessions: 0, bookedMinutes: 0, assessed: 0, collected: 0, outstanding: 0 }));
  const index = new Map(rows.map((r) => [r.key, r]));
  for (const r of res) {
    const row = index.get(byZone ? r.zone_id : T.localParts(r.start_at).date); if (!row) continue;
    row.reservations++;
    if (r.status === 'completed') row.completed++;
    if (r.status === 'cancelled') row.cancelled++;
    if (r.status === 'no_show') row.noShows++;
    if (r.has_session) row.sessions++;
    if (r.status !== 'cancelled') row.bookedMinutes += T.minutesBetween(r.start_at, r.end_at);
    if (r.final_fee_centavos != null) { row.assessed += r.final_fee_centavos; row.outstanding += Math.max(0, r.final_fee_centavos - r.paid); }
  }
  for (const p of pays) { const row = index.get(byZone ? p.zone_id : T.localParts(p.recorded_at).date); if (row) row.collected += p.amount; }
  for (const r of rows) r.utilization = r.capacity ? Math.min(100, Math.round((r.bookedMinutes / r.capacity) * 1000) / 10) : 0;

  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  const cap = rows.reduce((a, r) => a + r.capacity, 0);
  const totals = { reservations: sum('reservations'), completed: sum('completed'), cancelled: sum('cancelled'), noShows: sum('noShows'), sessions: sum('sessions'),
    assessed: sum('assessed'), collected: sum('collected'), outstanding: sum('outstanding'), utilization: cap ? Math.min(100, Math.round((sum('bookedMinutes') / cap) * 1000) / 10) : 0 };
  const rangeLabel = period === 'daily' ? T.fmtDateShort(range.from) : `${T.fmtDateShort(range.from)} – ${T.fmtDateShort(T.addDays(range.to, -1))}`;
  return { period, date, zoneId: zid || '', range, rangeLabel, groupLabel: byZone ? 'Zone' : 'Day', rows, totals, reservations: res };
}

/* ------------------------------- CSV ------------------------------- */
const cell = (x) => {
  let s = x == null ? '' : String(x);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (header, rows) => `\uFEFF${[header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
const peso = (c) => (c / 100).toFixed(2);

function summaryCsv(rep) {
  const rows = rep.rows.map((r) => [r.label, r.reservations, r.completed, r.cancelled, r.noShows, r.sessions, r.utilization, peso(r.assessed), peso(r.collected), peso(r.outstanding)]);
  const t = rep.totals;
  rows.push(['Total', t.reservations, t.completed, t.cancelled, t.noShows, t.sessions, t.utilization, peso(t.assessed), peso(t.collected), peso(t.outstanding)]);
  return toCsv([rep.groupLabel, 'Reservations', 'Completed', 'Cancelled', 'No-shows', 'Sessions', 'Utilization %', 'Assessed fees (PHP)', 'Collections recorded (PHP)', 'Outstanding (PHP)'], rows);
}
function reservationsCsv(rep) {
  return toCsv(['Reference', 'Date', 'Start', 'End', 'Zone', 'Slot', 'Driver', 'Plate', 'Status', 'Estimated fee (PHP)', 'Final fee (PHP)', 'Paid (PHP)'],
    rep.reservations.map((r) => [r.reference, T.localParts(r.start_at).date, T.localParts(r.start_at).time, T.localParts(r.end_at).time, r.zone_name, r.slot_code, r.driver_name, r.plate_number,
      r.status, peso(r.estimated_fee_centavos), r.final_fee_centavos == null ? '' : peso(r.final_fee_centavos), peso(r.paid)]));
}

module.exports = { dashboard, report, summaryCsv, reservationsCsv, toCsv };
