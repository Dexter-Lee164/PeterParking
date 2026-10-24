'use strict';

/**
 * Separate OS process used by concurrency.test.js. Each worker opens its OWN SQLite
 * connection to the shared database file and tries to book a slot, starting at a
 * common wall-clock instant so the attempts genuinely race each other.
 *
 * Env: DATABASE_PATH, NOW (campus-local), START_AT (epoch ms), JOB (JSON booking request)
 */
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';

const { openDatabase } = require('../../src/db');
const ctx = require('../../src/db/context');
const time = require('../../src/utils/time');
const reservations = require('../../src/services/reservations');
const { AppError } = require('../../src/utils/errors');

const job = JSON.parse(process.env.JOB);
const iso = `${process.env.NOW.replace(' ', 'T')}:00+08:00`;
time.clock.set(() => new Date(iso));

const db = openDatabase(process.env.DATABASE_PATH);
ctx.set(db);

// Busy-wait for the shared start instant.
const startAt = Number(process.env.START_AT);
while (Date.now() < startAt) { /* spin */ }

let out;
try {
  const r = reservations.createReservation(job, { id: job.userId });
  out = { ok: true, id: r.id, ref: r.booking_ref };
} catch (err) {
  out = { ok: false, code: err instanceof AppError ? err.code : 'ERROR', message: err.message };
}
process.stdout.write(`${JSON.stringify(out)}\n`);
db.close();
