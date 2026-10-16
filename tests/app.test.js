'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { start, Client, T, futureWindow, slotId, userId, vehicleOf, db, config, seedPasswords: pw } = require('./helpers');
const svc = require('../src/services/reservations');
const reports = require('../src/services/reports');
const users = require('../src/services/users');
const availability = require('../src/services/availability');

let app;
test.before(async () => { app = await start(); });
test.after(async () => { if (app) await app.close(); });

test('every major page renders (EJS) for the right role and exposes no template errors', async () => {
  const a = new Client(app.base); await a.login(pw.adminEmail, pw.admin);
  const d = new Client(app.base); await d.login('maria@university.test', pw.driver);
  const w = futureWindow(3);
  const driverPages = ['/driver/dashboard', '/driver/find-parking', `/driver/find-parking?date=${w.date}&start=${w.start}&end=${w.end}`, '/driver/reservations', '/driver/reservations?tab=cancelled', '/driver/payments', '/driver/vehicles', '/driver/profile', `/driver/reserve?slot=${slotId('MB-01')}&date=${w.date}&start=${w.start}&end=${w.end}`];
  const adminPages = ['/admin/dashboard', '/admin/slots', '/admin/zones', '/admin/reservations', '/admin/reservations?status=completed&q=UP', '/admin/operations', '/admin/payments', '/admin/drivers', '/admin/drivers/new', '/admin/reports', '/admin/reports?period=weekly', '/admin/reports?period=monthly', '/admin/settings', '/admin/settings?tab=rates', '/admin/settings?tab=audit'];
  for (const [c, pages] of [[d, driverPages], [a, adminPages]]) for (const p of pages) {
    const r = await c.get(p); assert.equal(r.status, 200, p);
    assert.doesNotMatch(r.text, /ReferenceError|TypeError|<pre>/, p); assert.match(r.text, /<h1 class="page-title">/, p);
  }
  assert.equal((await a.get('/nope')).status, 404);
  const err = await a.get('/admin/reservations/UP-00000000-ZZZZZ'); assert.equal(err.status, 404); assert.doesNotMatch(err.text, /at .*\.js:\d+/, 'no stack traces');
});

test('static assets (dark theme CSS, component CSS, slot CSS, scripts, Bootstrap, Chart.js) are served', async () => {
  const a = new Client(app.base); await a.login(pw.adminEmail, pw.admin);
  const html = (await a.get('/admin/dashboard')).text;
  for (const m of html.matchAll(/(?:href|src)="(\/(?:css|js|vendor)\/[^"]+)"/g)) { const r = await fetch(app.base + m[1]); assert.equal(r.status, 200, m[1]); }
  const css = await (await fetch(app.base + '/css/theme.css')).text();
  for (const token of ['#0B1220', '#2563EB', '#16A34A', '#EF4444', '#F59E0B']) assert.ok(css.toUpperCase().includes(token.toUpperCase()), `theme defines ${token}`);
});

test('dashboard KPIs, charts and tables come from database queries', () => {
  const dash = reports.dashboard();
  const k = dash.kpis;
  const slots = db.prepare("SELECT COUNT(*) c FROM parking_slots s JOIN parking_zones z ON z.id = s.zone_id WHERE s.status = 'active' AND z.is_active = 1").get().c;
  assert.equal(k.totalSlots, slots);
  assert.equal(k.availableNow + k.reservedNow + k.occupiedNow + k.unavailableNow, availability.listSlotAvailability({ startAt: T.nowIso(), endAt: T.addMinutesIso(T.nowIso(), 1) }).length);
  assert.equal(k.occupiedNow, db.prepare("SELECT COUNT(DISTINCT slot_id) c FROM parking_sessions WHERE status = 'active'").get().c);
  const todayB = T.dayBoundsUtc(T.todayLocal());
  assert.equal(k.todayReservations, db.prepare("SELECT COUNT(*) c FROM reservations WHERE start_at >= ? AND start_at < ? AND status <> 'cancelled'").get(todayB.start, todayB.end).c);
  assert.equal(dash.charts.reservations.values.length, 14); assert.equal(dash.charts.collections.labels.length, 14);
  assert.ok(dash.charts.reservations.values.some((n) => n > 0), 'seeded history shows up in the chart');
  const total30 = dash.charts.outcomes.values.reduce((x, y) => x + y, 0); assert.equal(total30, dash.charts.outcomes.total);
  assert.ok(dash.recent.length > 0);
});

test('period reports reconcile with the underlying rows; CSV exports are filtered and safe', async () => {
  const day = T.addDays(T.todayLocal(), -1);
  const rep = reports.report({ period: 'daily', date: day });
  const b = T.dayBoundsUtc(day);
  assert.equal(rep.totals.reservations, db.prepare('SELECT COUNT(*) c FROM reservations WHERE start_at >= ? AND start_at < ?').get(b.start, b.end).c);
  const weekly = reports.report({ period: 'weekly', date: day });
  assert.equal(weekly.rows.length, 7); assert.equal(reports.report({ period: 'monthly', date: day }).rows.length >= 28, true);
  assert.equal(weekly.totals.assessed, weekly.rows.reduce((x, r) => x + r.assessed, 0));
  const zone = db.prepare("SELECT id FROM parking_zones WHERE name = 'Engineering'").get().id;
  const filtered = reports.report({ period: 'weekly', date: day, zoneId: String(zone) });
  assert.ok(filtered.totals.reservations <= weekly.totals.reservations);
  assert.ok(filtered.reservations.every((r) => r.zone_name === 'Engineering'));

  users.createUser({ name: '=HYPERLINK("http://evil.test")', email: 'csv@university.test', driverType: 'student', password: 'Parking123' });
  users.addVehicle(userId('csv@university.test'), { plateNumber: 'CSV1234', vehicleType: 'car' }, { id: 1 });
  const w = futureWindow(2, 9, 10);
  svc.createReservation({ userId: userId('csv@university.test'), vehicleId: vehicleOf('csv@university.test'), slotId: slotId('SC-03'), ...w }, { id: userId('csv@university.test'), role: 'driver' });
  const a = new Client(app.base); await a.login(pw.adminEmail, pw.admin);
  const res = await fetch(app.base + `/admin/reports/export.csv?period=daily&date=${w.date}&dataset=reservations`, { headers: { cookie: a._cookie() } });
  assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /text\/csv/); assert.match(res.headers.get('content-disposition'), /attachment; filename="parking-reservations-daily-/);
  const csv = await res.text();
  assert.ok(csv.includes('Reference,Date,Start,End,Zone,Slot,Driver,Plate,Status'));
  assert.ok(csv.includes("'=HYPERLINK"), 'spreadsheet formulas are neutralised');
  const summary = await (await fetch(app.base + `/admin/reports/export.csv?period=weekly&date=${day}`, { headers: { cookie: a._cookie() } })).text();
  assert.match(summary, /Reservations,Completed,Cancelled,No-shows,Sessions,Utilization %,Assessed fees \(PHP\),Collections recorded \(PHP\),Outstanding \(PHP\)/);
  const d = new Client(app.base); await d.login('maria@university.test', pw.driver);
  assert.equal((await d.get('/admin/reports/export.csv')).status, 403);
});

test('data persists after the application restarts (SQLite file, migrations are idempotent)', async () => {
  const before = { users: db.prepare('SELECT COUNT(*) c FROM users').get().c, reservations: db.prepare('SELECT COUNT(*) c FROM reservations').get().c, payments: db.prepare('SELECT COUNT(*) c FROM payments').get().c };
  await app.close(); app = null;
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  const script = `const {db}=require(${JSON.stringify(path.join(__dirname, '..', 'src', 'db'))}); const q=(t)=>db.prepare('SELECT COUNT(*) c FROM '+t).get().c;
    console.log(JSON.stringify({users:q('users'),reservations:q('reservations'),payments:q('payments'),migrations:q('schema_migrations'),fk:db.pragma('foreign_keys',{simple:true}),mode:db.pragma('journal_mode',{simple:true})}));`;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { env: { ...process.env, DB_PATH: config.dbPath }, encoding: 'utf8' }));
  assert.equal(out.users, before.users); assert.equal(out.reservations, before.reservations); assert.equal(out.payments, before.payments);
  assert.equal(out.migrations, 1, 'the migration is recorded once and not re-applied'); assert.equal(out.fk, 1, 'foreign keys are enforced on every connection'); assert.equal(out.mode, 'wal');
});
