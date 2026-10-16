'use strict';
const T = require('../utils/time');

/**
 * Billing policy (all values configurable in Settings):
 *  - Fee = hourly rate x started hours of the reserved period.
 *  - If the vehicle leaves later than (booked end + overstay grace), every started hour beyond the booked end is billed too.
 *  - Arriving late or leaving early does not reduce the fee.
 *  - Cancelled bookings assess 0; no-shows assess no_show_fee_hours x rate (default 0).
 */
function computeFinalFee({ rateCentavos, startAt, endAt, outAt, overstayGraceMinutes }) {
  const reservedHours = T.billedHours(startAt, endAt);
  const overMin = Math.max(0, T.minutesBetween(endAt, outAt));
  const isOverstay = overMin > overstayGraceMinutes;
  const overstayHours = isOverstay ? Math.ceil(overMin / 60) : 0;
  return { reservedHours, overstayHours, overstayMinutes: isOverstay ? overMin : 0, isOverstay, fee: rateCentavos * (reservedHours + overstayHours) };
}

/** Fee assessed against a reservation row (which carries paid_centavos from a payments aggregate). */
function assessed(row) {
  if (row.final_fee_centavos != null) return row.final_fee_centavos;
  return row.status === 'confirmed' || row.status === 'active' ? row.estimated_fee_centavos : 0;
}
function balance(row) {
  const a = assessed(row);
  const paid = row.paid_centavos || 0;
  let status = 'none';
  if (a > 0 || paid > 0) status = paid === 0 ? 'unpaid' : paid < a ? 'partial' : paid === a ? 'paid' : 'overpaid';
  return { assessed: a, paid, balance: a - paid, status, finalized: row.final_fee_centavos != null };
}
module.exports = { computeFinalFee, assessed, balance };
