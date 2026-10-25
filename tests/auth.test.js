'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, PASSWORD, signUp } = require('./helpers');
const reservations = require('../src/services/reservations');
const users = require('../src/services/users');

describe('authentication, roles and ownership', () => {
  let env;
  let aliceBooking;
  before(async () => {
    env = await startApp({ fixture: 'minimal', now: '2026-03-10 09:00' });
    const { alice, aliceCar, slots } = env.data;
    aliceBooking = reservations.createReservation(
      { userId: alice.id, vehicleId: aliceCar.id, slotId: slots[0].id, date: '2026-03-10', start: '12:00', end: '14:00' },
      { id: alice.id },
    );
  });
  after(async () => env.stop());

  test('admin and driver land in their own areas after sign-in', async () => {
    const admin = env.client();
    const a = await admin.login('admin@test.local');
    assert.equal(a.status, 302);
    assert.equal(a.location, '/admin');
    const driver = env.client();
    const d = await driver.login('alice@test.local');
    assert.equal(d.status, 302);
    assert.equal(d.location, '/driver');
  });

  test('wrong password and unknown email give the same generic error', async () => {
    const c = env.client();
    await c.get('/login');
    const bad = await c.post('/login', { email: 'alice@test.local', password: 'nope-nope-1' });
    const unknown = await c.post('/login', { email: 'ghost@test.local', password: 'nope-nope-1' });
    assert.equal(bad.status, 401);
    assert.equal(unknown.status, 401);
    assert.match(bad.text, /Invalid email or password/);
    assert.match(unknown.text, /Invalid email or password/);
  });

  test('deactivated accounts cannot sign in, and an active session ends immediately', async () => {
    const victim = users.adminCreateUser({ full_name: 'Temp Driver', email: 'temp@test.local', password: PASSWORD, role: 'driver' }, null);
    const c = env.client();
    assert.equal((await c.login('temp@test.local')).status, 302);
    assert.equal((await c.get('/driver')).status, 200);
    users.setUserActive(victim.id, false, { id: env.data.admin.id });
    const after = await c.get('/driver');
    assert.equal(after.status, 302, 'session no longer valid once the account is deactivated');
    assert.equal(after.location, '/login');
    const retry = env.client();
    await retry.get('/login');
    const res = await retry.post('/login', { email: 'temp@test.local', password: PASSWORD });
    assert.equal(res.status, 401);
    assert.match(res.text, /deactivated/i);
  });

  test('anonymous visitors are redirected to the login page', async () => {
    const c = env.client();
    for (const url of ['/driver', '/driver/find-parking', '/admin', '/admin/payments']) {
      const res = await c.get(url);
      assert.equal(res.status, 302, url);
      assert.equal(res.location, '/login', url);
    }
  });

  test('return-to after login stays inside the user\'s own area', async () => {
    const c = env.client();
    await c.get('/admin/payments');
    await c.get('/login');
    const res = await c.post('/login', { email: 'admin@test.local', password: PASSWORD });
    assert.equal(res.location, '/admin/payments');
  });

  test('role separation: drivers cannot reach admin pages and vice versa', async () => {
    const driver = env.client();
    await driver.login('alice@test.local');
    for (const url of ['/admin', '/admin/slots', '/admin/payments', '/admin/settings/rules', '/admin/drivers']) {
      const res = await driver.get(url);
      assert.equal(res.status, 302, url);
      assert.equal(res.location, '/driver', url);
    }
    const post = await driver.post('/admin/slots', { zone_id: env.data.zone.id, slot_code: 'HACK', slot_type: 'regular' });
    assert.equal(post.status, 302);
    assert.equal(post.location, '/driver');
    assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM parking_slots WHERE slot_code = 'HACK'`).get().n, 0);

    const admin = env.client();
    await admin.login('admin@test.local');
    const res = await admin.get('/driver/find-parking');
    assert.equal(res.status, 302);
    assert.equal(res.location, '/admin');
  });

  test('a driver cannot view or change another driver\'s reservation', async () => {
    const bob = env.client();
    await bob.login('bob@test.local');
    const view = await bob.get(`/driver/reservations/${aliceBooking.id}`);
    assert.equal(view.status, 404);
    const cancel = await bob.post(`/driver/reservations/${aliceBooking.id}/cancel`);
    assert.equal(cancel.status, 302);
    assert.equal(env.db.prepare('SELECT status FROM reservations WHERE id = ?').get(aliceBooking.id).status, 'confirmed');
    const resched = await bob.post(`/driver/reservations/${aliceBooking.id}/reschedule`, { date: '2026-03-10', start: '15:00', end: '16:00' });
    assert.equal(resched.status, 302);
    assert.equal(env.db.prepare('SELECT start_at FROM reservations WHERE id = ?').get(aliceBooking.id).start_at, '2026-03-10 12:00:00');

    const alice = env.client();
    await alice.login('alice@test.local');
    assert.equal((await alice.get(`/driver/reservations/${aliceBooking.id}`)).status, 200);
  });

  test('a driver cannot use another driver\'s vehicle when booking', async () => {
    const alice = env.client();
    await alice.login('alice@test.local');
    const res = await alice.post('/driver/reserve', {
      slot_id: env.data.slots[2].id, vehicle_id: env.data.bobCar.id, date: '2026-03-10', start: '15:00', end: '16:00', vehicle_type: '',
    });
    assert.equal(res.status, 422);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM reservations WHERE vehicle_id = ?').get(env.data.bobCar.id).n, 0);
  });

  test('state-changing requests without a valid CSRF token are rejected', async () => {
    const c = env.client();
    await c.login('alice@test.local');
    const noToken = await c.post(`/driver/reservations/${aliceBooking.id}/cancel`, { _csrf: '' });
    assert.equal(noToken.status, 403);
    const wrong = await c.post(`/driver/reservations/${aliceBooking.id}/cancel`, { _csrf: 'a'.repeat(64) });
    assert.equal(wrong.status, 403);
    assert.equal(env.db.prepare('SELECT status FROM reservations WHERE id = ?').get(aliceBooking.id).status, 'confirmed');
    const login = env.client();
    const fresh = await login.post('/login', { email: 'alice@test.local', password: PASSWORD }, { csrf: false });
    assert.equal(fresh.status, 403, 'even login needs a token');
  });

  test('passwords are stored as bcrypt hashes, never plain text', () => {
    const row = env.db.prepare(`SELECT password_hash FROM users WHERE email = 'alice@test.local'`).get();
    assert.match(row.password_hash, /^\$2[aby]\$/);
    assert.ok(!row.password_hash.includes(PASSWORD));
  });

  test('session cookie is HttpOnly + SameSite and security headers are present', async () => {
    const res = await fetch(`${env.baseUrl}/login`);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('up.sid='));
    assert.ok(cookie, 'a session cookie is issued');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });

  test('public registration always creates a driver, even if a role is smuggled in', async () => {
    const c = env.client();
    const { res, verify } = await signUp(c, {
      full_name: 'New Person', email: 'new@test.local', university_id: 'U-NEW', phone: '0917 000 0000',
      password: PASSWORD, confirm_password: PASSWORD, role: 'admin',
    });
    assert.equal(res.status, 303);
    assert.equal(verify.location, '/driver/vehicles');
    assert.equal(env.db.prepare(`SELECT role FROM users WHERE email = 'new@test.local'`).get().role, 'driver');
    // The new session can reach driver pages but not admin pages.
    assert.equal((await c.get('/driver')).status, 200);
    assert.equal((await c.get('/admin')).status, 302);
  });

  test('registration validates input and rejects duplicate email', async () => {
    const c = env.client();
    await c.get('/register');
    const dup = await c.post('/register', { full_name: 'Dup', email: 'alice@test.local', password: PASSWORD, confirm_password: PASSWORD });
    assert.equal(dup.status, 422);
    assert.match(dup.text, /already registered/);
    const weak = await c.post('/register', { full_name: 'Weak Pw', email: 'weak@test.local', password: 'short', confirm_password: 'short' });
    assert.equal(weak.status, 422);
    const mismatch = await c.post('/register', { full_name: 'Mis Match', email: 'mm@test.local', password: PASSWORD, confirm_password: PASSWORD + 'x' });
    assert.equal(mismatch.status, 422);
    assert.match(mismatch.text, /do not match/);
  });

  test('logout ends the session', async () => {
    const c = env.client();
    await c.login('alice@test.local');
    assert.equal((await c.get('/driver')).status, 200);
    const out = await c.post('/logout');
    assert.equal(out.status, 302);
    assert.equal(out.location, '/login');
    const after = await c.get('/driver');
    assert.equal(after.status, 302);
  });
});

describe('login rate limiting', () => {
  let env;
  before(async () => {
    env = await startApp({ fixture: 'minimal', loginRateLimit: { windowMs: 60000, max: 3 } });
  });
  after(async () => env.stop());

  test('repeated failed sign-ins are throttled with HTTP 429', async () => {
    const c = env.client();
    await c.get('/login');
    const statuses = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await c.post('/login', { email: 'alice@test.local', password: 'wrong-pass-1' });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
    // Even the correct password is refused while throttled.
    const blocked = await c.post('/login', { email: 'alice@test.local', password: PASSWORD });
    assert.equal(blocked.status, 429);
  });
});
