'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { DEMO_CREDENTIALS } = require('../src/db/seed');

let env;
before(async () => {
  env = await startApp({ fixture: 'demo' });
});
after(async () => env.stop());

const ok = (res, label) => {
  assert.equal(res.status, 200, `${label} → ${res.status}\n${res.text.slice(0, 600)}`);
  assert.match(res.type, /text\/html/, `${label} should be HTML`);
  assert.doesNotMatch(res.text, /<pre>[\s\S]*?(Error|at .*node_modules)/, `${label} rendered an error page`);
};

test('public pages render with the dark UI shell', async () => {
  const c = env.client();
  for (const url of ['/login', '/register']) {
    const res = await c.get(url);
    ok(res, url);
    assert.match(res.text, /data-bs-theme="dark"/);
    assert.match(res.text, /University Parking/);
  }
  const health = await c.get('/healthz');
  assert.equal(health.status, 200);
});

test('static assets are served locally (no CDN)', async () => {
  const c = env.client();
  const assets = [
    ['/css/theme.css', /text\/css/], ['/css/components.css', /text\/css/], ['/css/auth.css', /text\/css/], ['/css/parking-slots.css', /text\/css/],
    ['/js/app.js', /javascript/], ['/js/auth.js', /javascript/], ['/js/parking-slots.js', /javascript/], ['/js/reservation-form.js', /javascript/], ['/js/charts.js', /javascript/],
    ['/vendor/bootstrap/css/bootstrap.min.css', /text\/css/], ['/vendor/bootstrap/js/bootstrap.bundle.min.js', /javascript/],
    ['/vendor/bootstrap-icons/bootstrap-icons.min.css', /text\/css/], ['/vendor/chartjs/chart.umd.min.js', /javascript/],
  ];
  for (const [url, type] of assets) {
    const res = await c.get(url);
    assert.equal(res.status, 200, url);
    assert.match(res.type, type, url);
  }
  const page = await c.get('/login');
  assert.doesNotMatch(page.text, /https?:\/\/(cdn|unpkg|fonts)\./i, 'pages must not reference CDNs');
});

test('driver can open every driver page', async () => {
  const c = env.client();
  const login = await c.login(DEMO_CREDENTIALS.driver.email, DEMO_CREDENTIALS.driver.password);
  assert.equal(login.status, 302);
  const pages = [
    '/driver', '/driver/find-parking', '/driver/reservations', '/driver/reservations?tab=all', '/driver/reservations?tab=completed',
    '/driver/reservations?tab=cancelled', '/driver/payments', '/driver/vehicles', '/driver/profile',
  ];
  for (const url of pages) ok(await c.get(url), url);

  // Detail pages for the driver's own bookings and a payment receipt.
  const own = env.db.prepare(`SELECT r.id FROM reservations r JOIN users u ON u.id = r.user_id WHERE u.email = ? ORDER BY r.id`).all(DEMO_CREDENTIALS.driver.email);
  assert.ok(own.length > 3, 'demo driver should have booking history');
  for (const r of own.slice(0, 6)) ok(await c.get(`/driver/reservations/${r.id}`), `reservation ${r.id}`);
  const pay = env.db.prepare(`SELECT p.id FROM payments p JOIN users u ON u.id = p.user_id WHERE u.email = ? LIMIT 1`).get(DEMO_CREDENTIALS.driver.email);
  if (pay) ok(await c.get(`/driver/payments/${pay.id}/receipt`), 'driver receipt');
});

test('admin can open every admin page', async () => {
  const c = env.client();
  const login = await c.login(DEMO_CREDENTIALS.admin.email, DEMO_CREDENTIALS.admin.password);
  assert.equal(login.status, 302);
  const pages = [
    '/admin', '/admin/slots', '/admin/slots?zone=1', '/admin/slots?zone=5', '/admin/slots/1/edit',
    '/admin/reservations', '/admin/reservations?status=completed&q=ABC', '/admin/reservations?payment=unpaid',
    '/admin/operations', '/admin/operations?q=ABC%201234',
    '/admin/payments', '/admin/payments/new', '/admin/payments?status=valid&method=cash',
    '/admin/drivers', '/admin/drivers/new', '/admin/drivers?role=all',
    '/admin/settings/rules', '/admin/settings/rates', '/admin/settings/rates?edit=1', '/admin/settings/types', '/admin/settings/types?edit=regular', '/admin/settings/audit',
  ];
  for (const url of pages) ok(await c.get(url), url);

  const r = env.db.prepare('SELECT id FROM reservations ORDER BY id DESC LIMIT 1').get();
  ok(await c.get(`/admin/reservations/${r.id}`), 'admin reservation detail');
  const p = env.db.prepare('SELECT id FROM payments ORDER BY id LIMIT 1').get();
  ok(await c.get(`/admin/payments/${p.id}/receipt`), 'admin receipt');
  const d = env.db.prepare(`SELECT id FROM users WHERE role = 'driver' LIMIT 1`).get();
  ok(await c.get(`/admin/drivers/${d.id}`), 'admin driver detail');
  const withBalance = env.db.prepare(`SELECT id FROM reservations WHERE fee_final_centavos > 0 LIMIT 1`).get();
  if (withBalance) ok(await c.get(`/admin/payments/new?reservation_id=${withBalance.id}`), 'payment form for booking');
});

test('admin dashboard embeds real chart data and no inline scripts', async () => {
  const c = env.client();
  await c.login(DEMO_CREDENTIALS.admin.email, DEMO_CREDENTIALS.admin.password);
  const res = await c.get('/admin');
  ok(res, 'dashboard');
  const m = /<script type="application\/json" id="chart-data">([\s\S]*?)<\/script>/.exec(res.text);
  assert.ok(m, 'chart-data JSON present');
  const data = JSON.parse(m[1]);
  assert.equal(data.reservationsOverTime.labels.length, 14);
  assert.ok(data.reservationsOverTime.values.some((n) => n > 0), 'reservation counts come from seeded bookings');
  assert.doesNotMatch(res.text.replace(/<script type="application\/json"[\s\S]*?<\/script>/, ''), /<script(?![^>]*\bsrc=)[^>]*>/, 'no inline executable scripts');
});

test('unknown routes return a styled 404', async () => {
  const c = env.client();
  await c.login(DEMO_CREDENTIALS.driver.email, DEMO_CREDENTIALS.driver.password);
  const res = await c.get('/driver/does-not-exist');
  assert.equal(res.status, 404);
  assert.match(res.text, /not found/i);
});


test('My Vehicles lists 10 vehicles per page', async () => {
  const c = env.client();
  await c.login(DEMO_CREDENTIALS.driver.email, DEMO_CREDENTIALS.driver.password);
  const userId = env.db.prepare('SELECT id FROM users WHERE email = ?').get(DEMO_CREDENTIALS.driver.email).id;
  const add = env.db.prepare(`INSERT INTO vehicles (user_id, plate_number, vehicle_type) VALUES (?, ?, 'car')`);
  for (let i = 0; i < 12; i++) add.run(userId, `PGT ${String(i).padStart(4, '0')}`);
  const total = env.db.prepare('SELECT COUNT(*) AS n FROM vehicles WHERE user_id = ? AND is_active = 1').get(userId).n;
  const rows = (html) => (html.match(/<td data-label="Plate">/g) || []).length;

  const first = await c.get('/driver/vehicles');
  ok(first, 'vehicles page 1');
  assert.equal(rows(first.text), 10);
  assert.match(first.text, new RegExp(`Showing 1–10 of ${total} vehicles`));
  assert.match(first.text, /href="\?page=2"/);

  const second = await c.get('/driver/vehicles?page=2');
  ok(second, 'vehicles page 2');
  assert.equal(rows(second.text), Math.min(total - 10, 10));
  assert.match(second.text, /\/edit\?page=2"/, 'Edit keeps the list on the same page');
});
