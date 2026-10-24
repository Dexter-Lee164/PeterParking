'use strict';

/**
 * Pure fee calculations — the single, documented hourly-billing policy.
 *
 *  1. Reserved fee   = billable units × rate. Duration is rounded UP to the billing
 *                      increment (default 60 min), so 90 minutes bills as 2 hours.
 *  2. Overstay       = if the vehicle leaves later than reserved end + grace, ALL minutes
 *                      beyond the reserved end are billed (rounded up to the increment) at
 *                      rate × overstay multiplier (default 150%).
 *  3. Early departure is not refunded: the reserved fee is final unless there is overstay.
 *  4. Cancellation   = free when cancelled at least `cancel_free_hours` before start;
 *                      otherwise `late_cancel_fee_percent` of the reserved fee.
 *  5. No-show        = `no_show_fee_percent` of the reserved fee.
 *
 * Fees become "final" (assessed) only on check-out, cancellation or no-show; until
 * then the estimated reserved fee is shown.
 */

const { diffMinutes } = require('../utils/time');

function billableUnits(minutes, incrementMinutes) {
  if (minutes <= 0) return 0;
  return Math.ceil(minutes / incrementMinutes);
}

/** Fee in centavos for `minutes` at an hourly `rateCentavos`. */
function feeFor(rateCentavos, minutes, incrementMinutes) {
  const units = billableUnits(minutes, incrementMinutes);
  return Math.round((units * incrementMinutes * rateCentavos) / 60);
}

function estimatedFee(rateCentavos, durationMinutes, settings) {
  return feeFor(rateCentavos, durationMinutes, settings.billing_increment_minutes);
}

/** Overstay assessment for a departure at `outAt` against a reserved end. */
function overstay(reservedEndAt, outAt, rateCentavos, settings) {
  const raw = diffMinutes(outAt, reservedEndAt);
  if (raw <= settings.overstay_grace_minutes) return { minutes: 0, feeCentavos: 0 };
  const base = feeFor(rateCentavos, raw, settings.billing_increment_minutes);
  return { minutes: raw, feeCentavos: Math.round((base * settings.overstay_multiplier_percent) / 100) };
}

/** Assessed fee when a cancellation happens at `nowAt`. */
function cancellationFee(estimatedCentavos, startAt, nowAt, settings, { waive = false } = {}) {
  if (waive) return 0;
  const hoursBefore = diffMinutes(startAt, nowAt) / 60;
  if (hoursBefore >= settings.cancel_free_hours) return 0;
  return Math.round((estimatedCentavos * settings.late_cancel_fee_percent) / 100);
}

function noShowFee(estimatedCentavos, settings) {
  return Math.round((estimatedCentavos * settings.no_show_fee_percent) / 100);
}

/** Describe the cancellation policy in plain language for the UI. */
function cancellationPolicyText(settings) {
  return (
    `Cancel at least ${settings.cancel_free_hours} hour${settings.cancel_free_hours === 1 ? '' : 's'} before the start time for no charge. ` +
    `Later cancellations are charged ${settings.late_cancel_fee_percent}% of the reserved fee, ` +
    `and no-shows are charged ${settings.no_show_fee_percent}%. Cancelled bookings stay in your history.`
  );
}

module.exports = { billableUnits, feeFor, estimatedFee, overstay, cancellationFee, noShowFee, cancellationPolicyText };
