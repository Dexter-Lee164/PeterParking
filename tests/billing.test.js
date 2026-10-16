'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';
const { computeFinalFee, balance, assessed } = require('../src/services/billing');
const { parsePesos, pesos } = require('../src/utils/money');
const T = require('../src/utils/time');

const at = (h, m = 0) => T.localToIso('2030-01-15', `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);

test('fee is the hourly rate x started hours of the reservation', () => {
  const f = computeFinalFee({ rateCentavos: 2000, startAt: at(9), endAt: at(11), outAt: at(11), overstayGraceMinutes: 10 });
  assert.equal(f.fee, 4000); assert.equal(f.isOverstay, false);
  const half = computeFinalFee({ rateCentavos: 2000, startAt: at(9), endAt: at(10, 30), outAt: at(10, 30), overstayGraceMinutes: 10 });
  assert.equal(half.reservedHours, 2); assert.equal(half.fee, 4000, 'a started hour is billed in full');
});
test('leaving early or arriving late does not reduce the fee', () => {
  const f = computeFinalFee({ rateCentavos: 2000, startAt: at(9), endAt: at(11), outAt: at(9, 30), overstayGraceMinutes: 10 });
  assert.equal(f.fee, 4000);
});
test('overstay inside the grace period is free; beyond it every started hour is billed', () => {
  const grace = computeFinalFee({ rateCentavos: 2000, startAt: at(9), endAt: at(11), outAt: at(11, 10), overstayGraceMinutes: 10 });
  assert.equal(grace.isOverstay, false); assert.equal(grace.fee, 4000);
  const over = computeFinalFee({ rateCentavos: 2000, startAt: at(9), endAt: at(11), outAt: at(11, 11), overstayGraceMinutes: 10 });
  assert.equal(over.isOverstay, true); assert.equal(over.overstayHours, 1); assert.equal(over.fee, 6000);
  const long = computeFinalFee({ rateCentavos: 2000, startAt: at(9), endAt: at(11), outAt: at(13, 1), overstayGraceMinutes: 10 });
  assert.equal(long.overstayHours, 3); assert.equal(long.fee, 2000 * 5);
});
test('balance statuses reconcile assessed fees with valid payments', () => {
  const base = { status: 'completed', estimated_fee_centavos: 4000, final_fee_centavos: 4000 };
  assert.equal(balance({ ...base, paid_centavos: 0 }).status, 'unpaid');
  assert.equal(balance({ ...base, paid_centavos: 1500 }).status, 'partial');
  assert.equal(balance({ ...base, paid_centavos: 1500 }).balance, 2500);
  assert.equal(balance({ ...base, paid_centavos: 4000 }).status, 'paid');
  assert.equal(balance({ ...base, paid_centavos: 4500 }).status, 'overpaid');
  assert.equal(balance({ status: 'cancelled', estimated_fee_centavos: 4000, final_fee_centavos: 0, paid_centavos: 0 }).status, 'none');
  assert.equal(assessed({ status: 'confirmed', estimated_fee_centavos: 3000, final_fee_centavos: null }), 3000, 'open bookings use the estimate');
});
test('money is stored as integer centavos and parsed strictly', () => {
  assert.equal(parsePesos('20'), 2000); assert.equal(parsePesos('₱1,250.50'), 125050); assert.equal(parsePesos('0.1'), 10);
  assert.equal(parsePesos('-5'), null); assert.equal(parsePesos('1.234'), null); assert.equal(parsePesos('abc'), null);
  assert.match(pesos(125050), /1,250\.50/);
});
test('campus time conversion uses a fixed UTC+8 offset', () => {
  assert.equal(T.localToIso('2030-01-15', '09:00'), '2030-01-15T01:00:00Z');
  assert.equal(T.localParts('2030-01-15T16:30:00Z').date, '2030-01-16');
  assert.equal(T.fmtTime('2030-01-15T05:00:00Z'), '1:00 PM');
});
