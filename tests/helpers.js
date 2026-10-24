'use strict';

/**
 * Shared test harness. Each test file runs in its own process (node --test), so the
 * environment below is set before any application module is loaded.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';
process.env.BCRYPT_ROUNDS = '4';
process.env.SEED_DEMO_DATA = 'false';
// No network from tests, whatever the developer's .env says (dotenv never overrides values set here).
process.env.EMAIL_DNS_CHECK = 'false';
process.env.MAIL_MODE = 'console';
// The test client talks plain http to 127.0.0.1: a Secure cookie (or trusting a proxy that is not there) breaks sessions.
process.env.COOKIE_SECURE = 'false';
process.env.TRUST_PROXY = 'false';
if (!process.env.DATABASE_PATH) {
  process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'parking-test-')), 'test.sqlite');
}

const { openDatabase } = require('../src/db');
const ctx = require('../src/db/context');
const time = require('../src/utils/time');
const users = require('../src/services/users');
const parking = require('../src/services/parking');
const seed = require('../src/db/seed');
const config = require('../src/config');
const { createApp } = require('../src/app');
const { getMailer } = require('../src/services/mail');

const PASSWORD = 'Passw0rd!';

/** Freeze "now" to a campus-local time like '2026-03-10 09:00:00' (Asia/Manila, UTC+8, no DST). */
function setNow(local) {
  const iso = `${local.replace(' ', 'T')}${local.length === 16 ? ':00' : ''}+08:00`;
  time.clock.set(() => new Date(iso));
}
const resetClock = () => time.clock.reset();

const extractCsrf = (html) => {
  const m = /name="csrf-token" content="([a-f0-9]+)"/.exec(html) || /name="_csrf" value="([a-f0-9]+)"/.exec(html);
  return m ? m[1] : null;
};

/** Minimal cookie-aware HTTP client with automatic CSRF handling. */
class Client {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookies = new Map();
    this.csrf = null;
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async request(method, url, { form, json, headers = {}, csrf = true, follow = false } = {}) {
    const h = Object.assign({ Accept: 'text/html,application/json' }, headers);
    if (this.cookies.size) h.Cookie = this.cookieHeader();
    let body;
    if (form) {
      const data = Object.assign({}, form);
      if (csrf && this.csrf && data._csrf === undefined) data._csrf = this.csrf;
      body = new URLSearchParams(Object.entries(data).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])).toString();
      h['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (json) {
      body = JSON.stringify(json);
      h['Content-Type'] = 'application/json';
      if (csrf && this.csrf) h['X-CSRF-Token'] = this.csrf;
    }
    const res = await fetch(this.baseUrl + url, { method, headers: h, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '' || /expires=Thu, 01 Jan 1970/i.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await res.text();
    const type = res.headers.get('content-type') || '';
    if (type.includes('text/html')) {
      const token = extractCsrf(text);
      if (token) this.csrf = token;
    }
    const out = { status: res.status, headers: res.headers, text, location: res.headers.get('location'), type };
    if (follow && res.status >= 300 && res.status < 400 && out.location) return this.get(out.location, { follow: true });
    return out;
  }

  get(url, opts) {
    return this.request('GET', url, opts);
  }

  post(url, form = {}, opts = {}) {
    return this.request('POST', url, Object.assign({ form }, opts));
  }

  async login(email, password = PASSWORD) {
    await this.get('/login');
    const res = await this.post('/login', { email, password });
    // Signing in rotates the session (and its CSRF token); pick up the new token from the landing page.
    if (res.status === 302 && res.location) await this.get(res.location);
    return res;
  }
}

/**
 * Start the app on an ephemeral port with a fresh database.
 * fixture: 'minimal' (1 admin, 2 drivers with vehicles, 1 zone with 6 slots) | 'demo' | 'none'
 */
async function startApp({ fixture = 'minimal', now = null, loginRateLimit, authLimits, reuseDatabase = false } = {}) {
  if (now) setNow(now);
  if (!reuseDatabase) {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.databasePath + suffix, { force: true });
  }
  const db = openDatabase(config.databasePath);
  ctx.set(db);
  let data = {};
  if (fixture === 'demo') seed.seedDemoData(db);
  if (fixture === 'minimal') data = seedMinimal();

  const app = createApp({ loginRateLimit, authLimits, sessionSecret: process.env.SESSION_SECRET });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    db, app, server, baseUrl, data,
    client: () => new Client(baseUrl),
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      app.locals.sessionStore.close();
      db.close();
      ctx.clear();
      resetClock();
    },
  };
}

/** Small deterministic data set for rule-focused tests. */
function seedMinimal() {
  const actor = null;
  const admin = users.adminCreateUser({ full_name: 'Ada Admin', email: 'admin@test.local', password: PASSWORD, role: 'admin' }, actor);
  const alice = users.adminCreateUser({ full_name: 'Alice Driver', email: 'alice@test.local', password: PASSWORD, role: 'driver', university_id: 'U-001' }, actor);
  const bob = users.adminCreateUser({ full_name: 'Bob Driver', email: 'bob@test.local', password: PASSWORD, role: 'driver', university_id: 'U-002' }, actor);
  const aliceCar = users.addVehicle(alice.id, { plate_number: 'AAA 1111', vehicle_type: 'car', make: 'Toyota', model: 'Vios' }, actor);
  const aliceCar2 = users.addVehicle(alice.id, { plate_number: 'AAA 2222', vehicle_type: 'car' }, actor);
  const bobCar = users.addVehicle(bob.id, { plate_number: 'BBB 3333', vehicle_type: 'car' }, actor);
  const bobMoto = users.addVehicle(bob.id, { plate_number: 'BBB 4444', vehicle_type: 'motorcycle' }, actor);
  const zone = parking.createZone({ code: 'TZ', name: 'Test Zone', map_columns: 3 }, actor);
  const slots = [];
  for (let i = 1; i <= 5; i += 1) slots.push(parking.createSlot({ zone_id: zone.id, slot_code: `T${i}`, slot_type: 'regular', sort_order: i }, actor));
  const moto = parking.createSlot({ zone_id: zone.id, slot_code: 'M1', slot_type: 'motorcycle', sort_order: 6 }, actor);
  return { admin, alice, bob, aliceCar, aliceCar2, bobCar, bobMoto, zone, slots, moto };
}

/** The 6-digit code in the newest verification e-mail to `email` (console mode keeps an outbox in tests). */
function lastCode(email) {
  const to = String(email).trim().toLowerCase();
  const msg = [...getMailer().outbox].reverse().find((m) => m.to === to && /verification code/i.test(m.subject));
  const m = msg && /^\s{4}(\d{6})$/m.exec(msg.text);
  return m ? m[1] : null;
}

/** Full e-mail sign-up: POST /register, then the code from the outbox. Returns both responses. */
async function signUp(client, form) {
  await client.get('/register');
  const res = await client.post('/register', form);
  if (res.status !== 303) return { res, verify: null, code: null };
  await client.get('/register/verify');
  const code = lastCode(form.email);
  const verify = await client.post('/register/verify', { code });
  return { res, verify, code };
}

/** Rate for 'regular' slots in the migration seed is ₱30/hr (default ₱20). */
module.exports = { PASSWORD, Client, startApp, setNow, resetClock, seedMinimal, extractCsrf, lastCode, signUp };
