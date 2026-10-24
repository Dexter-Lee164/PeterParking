'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('node:child_process');
const { startApp, Client } = require('./helpers');
const { DEMO_CREDENTIALS } = require('../src/db/seed');
const config = require('../src/config');

const ROOT = path.resolve(__dirname, '..');

test('reservations and sign-in sessions survive an application restart (in-process)', async () => {
  let env = await startApp({ fixture: 'minimal', now: '2026-03-10 09:00' });
  const alice = env.client();
  await alice.login('alice@test.local');
  const post = await alice.post('/driver/reserve', {
    slot_id: env.data.slots[0].id, vehicle_id: env.data.aliceCar.id, date: '2026-03-10', start: '10:00', end: '12:00', vehicle_type: 'car',
  });
  assert.equal(post.status, 302);
  const detailUrl = post.location;
  const before = env.db.prepare('SELECT booking_ref, status, fee_estimated_centavos FROM reservations').all();
  assert.equal(before.length, 1);
  await env.stop();

  env = await startApp({ fixture: 'none', now: '2026-03-10 09:05', reuseDatabase: true });
  try {
    alice.baseUrl = env.baseUrl; // same browser, new server process state
    const page = await alice.get(detailUrl);
    assert.equal(page.status, 200, 'the session cookie still works after the restart');
    assert.match(page.text, new RegExp(before[0].booking_ref));
    assert.deepEqual(env.db.prepare('SELECT booking_ref, status, fee_estimated_centavos FROM reservations').all(), before);
    // The slot is still protected from double booking after the restart.
    const bob = env.client();
    await bob.login('bob@test.local');
    const again = await bob.post('/driver/reserve', {
      slot_id: 1, vehicle_id: 3, // Test Zone / T1 and Bob's car in the minimal fixture, date: '2026-03-10', start: '11:00', end: '12:00', vehicle_type: 'car',
    });
    assert.equal(again.status, 302);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n, 1);
  } finally {
    await env.stop();
  }
});

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function runServer({ port, dbPath }) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
      HOST: '127.0.0.1',
      DATABASE_PATH: dbPath,
      SESSION_SECRET: 'integration-test-secret-0123456789',
      SEED_DEMO_DATA: 'true',
      BCRYPT_ROUNDS: '4',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 20000);
    const poll = setInterval(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (res.ok) {
          clearInterval(poll);
          clearTimeout(timer);
          resolve();
        }
      } catch { /* not up yet */ }
    }, 150);
    child.on('exit', (code) => {
      clearInterval(poll);
      clearTimeout(timer);
      reject(new Error(`server exited early (${code}):\n${output}`));
    });
  });
  const stop = () =>
    new Promise((resolve) => {
      child.removeAllListeners('exit');
      child.on('exit', () => resolve(output));
      child.kill('SIGTERM');
    });
  return { ready, stop, output: () => output };
}

test('the real server boots, seeds demo data on first run, and keeps data + sessions across a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parking-server-'));
  const dbPath = path.join(dir, 'parking.sqlite');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  let server = runServer({ port, dbPath });
  await server.ready;
  const admin = new Client(base);
  const login = await admin.login(DEMO_CREDENTIALS.admin.email, DEMO_CREDENTIALS.admin.password);
  assert.equal(login.status, 302);
  const dash = await admin.get('/admin');
  assert.equal(dash.status, 200);
  assert.match(dash.text, /Operations overview/);
  const list1 = await admin.get('/admin/reservations');
  // The list is split into today / upcoming / past panels, each with its own total.
  const totalOf = (html) => [...html.matchAll(/of (\d+) reservations/g)].reduce((n, m) => n + Number(m[1]), 0);
  const total1 = totalOf(list1.text);
  assert.ok(total1 > 50, 'demo history was seeded');

  // Make a change that must survive: a note and a rate on a slot (the layout itself is fixed).
  const made = await admin.post('/admin/slots/1', { status: 'active', notes: 'Persistence check', hourly_rate_override: '42' });
  assert.equal(made.status, 302);
  const out1 = await server.stop();
  assert.match(out1, /demo data loaded/);

  server = runServer({ port, dbPath });
  await server.ready;
  try {
    const dash2 = await admin.get('/admin/slots/1/edit');
    assert.equal(dash2.status, 200, 'session cookie still valid after restart');
    assert.match(dash2.text, /Persistence check/);
    assert.match(dash2.text, /₱42.00/);
    const list2 = await admin.get('/admin/reservations');
    assert.equal(totalOf(list2.text), total1, 'no data lost or re-seeded');
    assert.doesNotMatch(server.output(), /demo data loaded/, 'seed runs on first start only');
  } finally {
    await server.stop();
  }

  const files = fs.readdirSync(dir).sort();
  assert.ok(files.includes('parking.sqlite'));
  assert.ok(files.every((f) => f.startsWith('parking.sqlite')), `only SQLite files exist: ${files.join(', ')}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('SQLite is the only database: no other database driver is a dependency', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const deps = Object.keys(Object.assign({}, pkg.dependencies, pkg.devDependencies));
  const banned = /^(mysql2?|pg|pg-promise|mongodb|mongoose|redis|ioredis|sequelize|typeorm|prisma|@prisma\/client|knex|firebase|firebase-admin|@supabase\/.*|cassandra-driver|oracledb|tedious)$/;
  assert.deepEqual(deps.filter((d) => banned.test(d)), []);
  assert.ok(deps.includes('better-sqlite3'));
  assert.match(config.databasePath, /\.sqlite$/);
});

test('campus time: the clock converts UTC instants to Asia/Manila (UTC+8, no daylight saving)', () => {
  const time = require('../src/utils/time');
  time.clock.set(() => new Date('2026-03-10T16:30:00Z'));
  assert.equal(time.nowLocal(), '2026-03-11 00:30:00', 'crosses midnight in campus time');
  assert.equal(time.todayLocal(), '2026-03-11');
  time.clock.set(() => new Date('2026-07-01T00:00:00Z'));
  assert.equal(time.nowLocal(), '2026-07-01 08:00:00', 'same offset in summer');
  time.clock.reset();
});
