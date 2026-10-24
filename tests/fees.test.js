'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
require('./helpers'); // sets the test environment before application modules load
const fees = require('../src/services/fees');
const { formatPeso, parsePesoToCentavos, toPesoString } = require('../src/utils/money');
const time = require('../src/utils/time');

const S = {
  billing_increment_minutes: 60,
  overstay_grace_minutes: 10,
  overstay_multiplier_percent: 150,
  cancel_free_hours: 2,
  late_cancel_fee_percent: 50,
  no_show_fee_percent: 50,
};

test('reserved fee rounds UP to the billing increment', () => {
  assert.equal(fees.estimatedFee(3000, 60, S), 3000);
  assert.equal(fees.estimatedFee(3000, 120, S), 6000);
  assert.equal(fees.estimatedFee(3000, 90, S), 6000, '90 minutes bills as 2 hours');
  assert.equal(fees.estimatedFee(3000, 61, S), 6000);
  assert.equal(fees.estimatedFee(3000, 0, S), 0);
  // Half-hour increments bill 30-minute blocks.
  assert.equal(fees.estimatedFee(3000, 90, Object.assign({}, S, { billing_increment_minutes: 30 })), 4500);
});

test('overstay: grace period, then ALL minutes past reserved end at the overstay rate', () => {
  const end = '2026-03-10 12:00:00';
  assert.deepEqual(fees.overstay(end, '2026-03-10 11:30:00', 3000, S), { minutes: 0, feeCentavos: 0 }, 'early departure: no overstay');
  assert.deepEqual(fees.overstay(end, '2026-03-10 12:10:00', 3000, S), { minutes: 0, feeCentavos: 0 }, 'inside grace');
  // 11 minutes late → past grace → 11 min rounds up to 1h × ₱30 × 150% = ₱45
  assert.deepEqual(fees.overstay(end, '2026-03-10 12:11:00', 3000, S), { minutes: 11, feeCentavos: 4500 });
  // 75 minutes late → 2 billable hours × ₱30 × 150% = ₱90
  assert.deepEqual(fees.overstay(end, '2026-03-10 13:15:00', 3000, S), { minutes: 75, feeCentavos: 9000 });
});

test('cancellation fee: free before the window, percentage inside it, waivable', () => {
  const start = '2026-03-10 14:00:00';
  assert.equal(fees.cancellationFee(6000, start, '2026-03-10 11:00:00', S), 0, '3h before: free');
  assert.equal(fees.cancellationFee(6000, start, '2026-03-10 12:00:00', S), 0, 'exactly 2h before: free');
  assert.equal(fees.cancellationFee(6000, start, '2026-03-10 12:01:00', S), 3000, 'just inside the window: 50%');
  assert.equal(fees.cancellationFee(6000, start, '2026-03-10 12:01:00', S, { waive: true }), 0);
});

test('no-show fee is the configured percentage of the reserved fee', () => {
  assert.equal(fees.noShowFee(6000, S), 3000);
  assert.equal(fees.noShowFee(6000, Object.assign({}, S, { no_show_fee_percent: 0 })), 0);
  assert.equal(fees.noShowFee(5001, S), 2501, 'rounds to a whole centavo');
});

test('money helpers format and parse pesos safely', () => {
  assert.equal(formatPeso(3000), '₱30.00');
  assert.equal(formatPeso(4550), '₱45.50');
  assert.equal(toPesoString(4550), '45.50');
  assert.equal(parsePesoToCentavos('30'), 3000);
  assert.equal(parsePesoToCentavos('₱1,250.50'), 125050);
  assert.equal(parsePesoToCentavos('12.345'), null, 'no sub-centavo amounts');
  assert.equal(parsePesoToCentavos('abc'), null);
  assert.equal(parsePesoToCentavos('-5'), null);
});

test('time helpers: local string arithmetic and overlap-friendly boundaries', () => {
  assert.equal(time.addMinutes('2026-03-10 23:30:00', 60), '2026-03-11 00:30:00');
  assert.equal(time.diffMinutes('2026-03-10 12:00:00', '2026-03-10 10:30:00'), 90);
  assert.equal(time.floorToStep('2026-03-10 09:47:12', 60), '2026-03-10 09:00:00');
  assert.ok(time.isValidDate('2026-02-28'));
  assert.ok(!time.isValidDate('2026-02-30'));
  assert.ok(time.isValidTime('21:00'));
  assert.ok(!time.isValidTime('24:00'));
});
