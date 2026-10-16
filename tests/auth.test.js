'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, Client, seedPasswords: pw, db } = require('./helpers');

let app;
test.before(async () => { app = await start(); });
test.after(async () => { await app.close(); });

test('anonymous visitors are redirected to the sign-in page', async () => {
  const c = new Client(app.base);
  for (const url of ['/driver/dashboard', '/admin/dashboard', '/driver/find-parking']) {
    const r = await c.get(url); assert.equal(r.status, 302); assert.equal(r.location, '/login');
  }
  assert.equal((await c.get('/api/availability')).status, 302);
});

test('valid credentials sign a driver in and an administrator in, each to their own home', async () => {
  const d = new Client(app.base); const a = new Client(app.base);
  const rd = await d.login('maria@university.test', pw.driver); assert.equal(rd.location, '/driver/dashboard');
  const ra = await a.login(pw.adminEmail, pw.admin); assert.equal(ra.location, '/admin/dashboard');
  assert.equal((await d.get('/driver/dashboard')).status, 200);
});

test('wrong password and unknown email give the same generic message', async () => {
  const c = new Client(app.base);
  const a = await c.post('/login', { email: 'maria@university.test', password: 'wrong-password1' });
  const b = await c.post('/login', { email: 'nobody@university.test', password: 'wrong-password1' });
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.match(a.text, /Email or password is incorrect/); assert.match(b.text, /Email or password is incorrect/);
  assert.ok(db.prepare("SELECT COUNT(*) c FROM audit_logs WHERE action = 'auth.login_failed'").get().c >= 2);
});

test('role-based authorization: drivers cannot open administrator pages and vice versa', async () => {
  const d = new Client(app.base); await d.login('maria@university.test', pw.driver);
  for (const url of ['/admin/dashboard', '/admin/payments', '/admin/settings', '/admin/reports/export.csv']) assert.equal((await d.get(url)).status, 403, url);
  const a = new Client(app.base); await a.login(pw.adminEmail, pw.admin);
  assert.equal((await a.get('/driver/dashboard')).status, 403);
});

test('state-changing requests without a valid CSRF token are rejected', async () => {
  const d = new Client(app.base); await d.login('maria@university.test', pw.driver);
  const r = await d.req('POST', '/driver/vehicles', { form: { plateNumber: 'XYZ9999', vehicleType: 'car' } });
  assert.equal(r.status, 403);
  const r2 = await d.req('POST', '/driver/vehicles', { form: { _csrf: 'deadbeef', plateNumber: 'XYZ9999', vehicleType: 'car' } });
  assert.equal(r2.status, 403);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM vehicles WHERE plate_number = 'XYZ9999'").get().c, 0);
});

test('logout ends the session', async () => {
  const d = new Client(app.base); await d.login('ana@university.test', pw.driver);
  assert.equal((await d.get('/driver/dashboard')).status, 200);
  const r = await d.post('/logout'); assert.equal(r.status, 302);
  assert.equal((await d.get('/driver/dashboard')).status, 302);
});

test('deactivated accounts cannot sign in', async () => {
  db.prepare("UPDATE users SET is_active = 0 WHERE email = 'juan@university.test'").run();
  const c = new Client(app.base);
  const r = await c.post('/login', { email: 'juan@university.test', password: pw.driver });
  assert.equal(r.status, 401); assert.match(r.text, /inactive/);
  db.prepare("UPDATE users SET is_active = 1 WHERE email = 'juan@university.test'").run();
});

test('registration validates input, hashes the password and signs the new driver in', async () => {
  const c = new Client(app.base);
  const bad = await c.post('/register', { name: 'A', email: 'nope', password: 'short', confirmPassword: 'x' });
  assert.equal(bad.status, 422); assert.match(bad.text, /valid email/);
  const ok = await c.post('/register', { name: 'New Driver', email: 'new@university.test', driverType: 'student', password: 'Parking123', confirmPassword: 'Parking123' });
  assert.equal(ok.status, 302);
  const row = db.prepare("SELECT password_hash, role FROM users WHERE email = 'new@university.test'").get();
  assert.equal(row.role, 'driver'); assert.match(row.password_hash, /^\$2[aby]\$/); assert.ok(!row.password_hash.includes('Parking123'));
  const dup = await new Client(app.base).post('/register', { name: 'Dup', email: 'NEW@university.test', driverType: 'student', password: 'Parking123', confirmPassword: 'Parking123' });
  assert.equal(dup.status, 422); assert.match(dup.text, /already exists/);
});

test('post-login redirects ignore external or cross-role destinations', async () => {
  const c = new Client(app.base);
  const gate = await c.get('/admin/dashboard'); assert.equal(gate.location, '/login');
  const r = await c.login('maria@university.test', pw.driver);
  assert.equal(r.location, '/driver/dashboard', 'a driver is never sent to an admin page');
});

test('security headers are present and responses do not leak the framework', async () => {
  const r = await fetch(app.base + '/login');
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(r.headers.get('x-powered-by'), null);
  assert.ok(r.headers.get('x-content-type-options'));
  const set = (await fetch(app.base + '/login')).headers.getSetCookie?.() || [];
  assert.ok(set.length === 0 || set.every((c) => /HttpOnly/i.test(c)), 'session cookies are HttpOnly');
});
