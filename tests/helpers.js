'use strict';
// Test harness: temp SQLite file, seeded data, ephemeral HTTP server and a tiny cookie-aware client (no extra dependencies).
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parking-test-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.BCRYPT_ROUNDS = '4';
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-123456';
process.env.LOGIN_RATE_LIMIT_MAX = process.env.LOGIN_RATE_LIMIT_MAX || '1000';

const config = require('../src/config/env');
const { db } = require('../src/db');
const { seed } = require('../src/db/seed');
const { createApp } = require('../src/app');
const clock = require('../src/utils/clock');
const T = require('../src/utils/time');

async function start() {
  seed(db);
  // The seed may leave one vehicle parked "now" (depends on the time of day). Close it so tests start from a known state.
  const now = T.nowIso();
  db.prepare("UPDATE parking_sessions SET status = 'completed', checked_out_at = ?, final_fee_centavos = rate_centavos * 2 WHERE status = 'active'").run(now);
  db.prepare("UPDATE reservations SET status = 'completed', final_fee_centavos = estimated_fee_centavos, finalized_at = ? WHERE status = 'active'").run(now);
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, close: () => new Promise((r) => server.close(r)) };
}

class Client {
  constructor(base) { this.base = base; this.cookies = new Map(); this.page = '/login'; }
  _cookie() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
  _store(res) {
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(';'); const i = pair.indexOf('=');
      const k = pair.slice(0, i), v = pair.slice(i + 1);
      if (/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c)) this.cookies.delete(k); else this.cookies.set(k, v);
    }
  }
  async req(method, url, { form, headers = {} } = {}) {
    const res = await fetch(this.base + url, {
      method, redirect: 'manual', headers: { cookie: this._cookie(), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    this._store(res);
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, location: res.headers.get('location') };
  }
  get(url, o) { return this.req('GET', url, o); }
  async csrf(from) { const r = await this.get(from || this.page); const m = /name="_csrf" value="([a-f0-9]+)"/.exec(r.text); return m && m[1]; }
  async post(url, form = {}, { csrfFrom } = {}) { const token = await this.csrf(csrfFrom); return this.req('POST', url, { form: { _csrf: token, ...form } }); }
  async login(email, password) {
    const r = await this.post('/login', { email, password });
    if (r.status === 302) this.page = r.location.startsWith('/admin') ? '/admin/settings' : '/driver/profile';
    return r;
  }
}

/** First free slot code/id for a future window, to keep tests independent of seed layout. */
function futureWindow(daysAhead = 5, startH = 9, endH = 11) {
  const date = T.addDays(T.todayLocal(), daysAhead);
  const p = (n) => String(n).padStart(2, '0');
  return { date, start: `${p(startH)}:00`, end: `${p(endH)}:00` };
}
const slotId = (code) => db.prepare('SELECT id FROM parking_slots WHERE code = ?').get(code).id;
const userId = (email) => db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
const vehicleOf = (email) => db.prepare('SELECT v.id FROM vehicles v JOIN users u ON u.id = v.user_id WHERE u.email = ?').get(email).id;

module.exports = { config, db, start, Client, clock, T, futureWindow, slotId, userId, vehicleOf, dir, seedPasswords: { admin: config.seed.adminPassword, driver: config.seed.driverPassword, adminEmail: config.seed.adminEmail } };
