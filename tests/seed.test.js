'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');

// The demo data is generated relative to "now"; it must be sensible whatever time the app is first started.
for (const [label, now, expectParked, expectArrival] of [
  ['before opening (03:00)', '2026-03-10 03:00', false, false],
  ['just after opening (07:10)', '2026-03-10 07:10', true, true],
  ['midday (12:10)', '2026-03-10 12:10', true, true],
  ['last open hour (21:40)', '2026-03-10 21:40', true, false],
  ['after closing (23:30)', '2026-03-10 23:30', false, false],
]) {
  test(`demo seed at ${label}: history, live parking and arrivals are consistent`, async () => {
    const env = await startApp({ fixture: 'demo', now });
    try {
      const db = env.db;
      assert.ok(db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n > 50, 'history seeded');
      const today = '2026-03-10';
      const parked = db.prepare("SELECT * FROM reservations WHERE status = 'checked_in'").all();
      assert.equal(parked.length > 0, expectParked, `parked vehicles: ${parked.length}`);
      for (const r of parked) assert.ok(r.start_at <= `${today} ${now.slice(11)}:59`, 'a parked vehicle started before now');
      const arrivals = db.prepare("SELECT * FROM reservations WHERE status = 'confirmed' AND start_at LIKE ? AND start_at > ?").all(`${today}%`, `${today} ${now.slice(11)}:59`);
      assert.equal(arrivals.length > 0, expectArrival, `arrivals later today: ${arrivals.length}`);
      // The no-show sweep must not immediately close the seeded arrival.
      const sweepSvc = require('../src/services/reservations');
      assert.equal(sweepSvc.sweepNoShows(), 0);
      // Never two active bookings on one slot at the same time.
      const clash = db.prepare(
        `SELECT COUNT(*) AS n FROM reservations a JOIN reservations b ON a.slot_id = b.slot_id AND a.id < b.id
          WHERE a.status IN ('confirmed','checked_in') AND b.status IN ('confirmed','checked_in')
            AND a.start_at < b.end_at AND b.start_at < a.end_at`).get().n;
      assert.equal(clash, 0);
    } finally {
      await env.stop();
    }
  });
}
