'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('node:child_process');
const { startApp, PASSWORD } = require('./helpers');
const users = require('../src/services/users');
const config = require('../src/config');

const DAY = '2026-03-10';
const NOW = `${DAY} 09:00`;
const WORKER = path.join(__dirname, 'fixtures', 'book-worker.js');

let env;
let drivers;

before(async () => {
  env = await startApp({ fixture: 'minimal', now: NOW });
  drivers = [];
  for (let i = 1; i <= 8; i += 1) {
    const u = users.adminCreateUser({ full_name: `Racer ${'ABCDEFGH'[i - 1]}`, email: `racer${i}@test.local`, password: PASSWORD, role: 'driver' }, null);
    const v = users.addVehicle(u.id, { plate_number: `RAC ${1000 + i}`, vehicle_type: 'car' }, null);
    drivers.push({ user: u, vehicle: v });
  }
});
after(async () => env.stop());

/** Run one booking attempt per job in separate processes, all released at the same instant. */
function race(jobs) {
  const startAt = Date.now() + 1500; // leave time for every process to boot
  return Promise.all(
    jobs.map(
      (job) =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [WORKER], {
            env: { ...process.env, DATABASE_PATH: config.databasePath, NOW, START_AT: String(startAt), JOB: JSON.stringify(job) },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (c) => { stdout += c; });
          child.stderr.on('data', (c) => { stderr += c; });
          child.on('error', reject);
          child.on('close', (code) => {
            if (code !== 0) return reject(new Error(`worker exited ${code}: ${stderr}`));
            return resolve(JSON.parse(stdout.trim().split('\n').pop()));
          });
        }),
    ),
  );
}

const jobFor = (i, slotId, start, end) => ({ userId: drivers[i].user.id, vehicleId: drivers[i].vehicle.id, slotId, date: DAY, start, end });

function overlappingPairs() {
  return env.db
    .prepare(
      `SELECT a.id AS a_id, b.id AS b_id FROM reservations a JOIN reservations b
         ON a.slot_id = b.slot_id AND a.id < b.id AND a.start_at < b.end_at AND b.start_at < a.end_at
       WHERE a.status IN ('confirmed','checked_in') AND b.status IN ('confirmed','checked_in')`,
    )
    .all();
}

test('8 processes racing for the same slot and time: exactly one booking wins', async () => {
  const slot = env.data.slots[0];
  const results = await race(drivers.map((_, i) => jobFor(i, slot.id, '10:00', '12:00')));
  const winners = results.filter((r) => r.ok);
  const losers = results.filter((r) => !r.ok);
  assert.equal(winners.length, 1, JSON.stringify(results));
  assert.equal(losers.length, 7);
  for (const l of losers) assert.equal(l.code, 'CONFLICT', l.message);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM reservations WHERE slot_id = ?').get(slot.id).n, 1);
  assert.deepEqual(overlappingPairs(), []);
});

test('8 processes spread over 5 slots: one booking per slot, never two', async () => {
  env.db.exec('DELETE FROM reservations');
  const slots = env.data.slots;
  const results = await race(drivers.map((_, i) => jobFor(i, slots[i % 5].id, '13:00', '15:00')));
  assert.equal(results.filter((r) => r.ok).length, 5, JSON.stringify(results));
  const perSlot = env.db.prepare('SELECT slot_id, COUNT(*) AS n FROM reservations GROUP BY slot_id').all();
  assert.equal(perSlot.length, 5);
  for (const row of perSlot) assert.equal(row.n, 1);
  assert.deepEqual(overlappingPairs(), []);
});

test('staggered overlapping windows on one slot: whatever wins, no two bookings overlap', async () => {
  env.db.exec('DELETE FROM reservations');
  const slot = env.data.slots[1];
  const windows = [['10:00', '12:00'], ['11:00', '13:00'], ['12:00', '14:00'], ['13:00', '15:00'], ['10:00', '11:00'], ['14:00', '15:00'], ['11:00', '12:00'], ['12:00', '13:00']];
  const results = await race(windows.map(([s, e], i) => jobFor(i, slot.id, s, e)));
  const won = results.filter((r) => r.ok).length;
  assert.ok(won >= 2 && won <= 5, `some compatible windows should succeed, got ${won}: ${JSON.stringify(results)}`);
  for (const r of results.filter((x) => !x.ok)) assert.equal(r.code, 'CONFLICT', r.message);
  assert.deepEqual(overlappingPairs(), [], 'the invariant: no overlapping active reservations');
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n, won);
});
