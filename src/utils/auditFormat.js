'use strict';

const time = require('./time');
const { formatPeso } = require('./money');
const { badge } = require('./badges');

/**
 * Turns an audit_logs row into something people can read: a title ("Reservation Created") and a list of labelled
 * values, with times, money, yes/no flags, lists and nested objects formatted. Nothing is dropped: keys without a known
 * label are title-cased, and details that are not valid JSON are shown as plain text.
 */

const ACTION_TITLES = {
  'reservation.create': 'Reservation Created',
  'reservation.cancel': 'Reservation Cancelled',
  'reservation.reschedule': 'Reservation Rescheduled',
  'reservation.no_show': 'Reservation Marked as No-Show',
  'session.check_in': 'Vehicle Checked In',
  'session.check_out': 'Vehicle Checked Out',
  'payment.record': 'Payment Recorded',
  'payment.void': 'Payment Voided',
  'auth.login': 'Signed In',
  'auth.logout': 'Signed Out',
  'auth.login_failed': 'Failed Sign-In',
  'auth.reset_requested': 'Password Reset Requested',
  'auth.reset_completed': 'Password Reset Completed',
  'user.register': 'Account Registered',
  'user.create': 'User Created',
  'user.update': 'User Updated',
  'user.update_profile': 'Profile Updated',
  'user.change_password': 'Password Changed',
  'user.reset_password': 'Password Reset by Administrator',
  'user.activate': 'User Activated',
  'user.deactivate': 'User Deactivated',
  'vehicle.add': 'Vehicle Added',
  'vehicle.update': 'Vehicle Updated',
  'vehicle.remove': 'Vehicle Removed',
  'slot.create': 'Slot Created',
  'slot.update': 'Slot Updated',
  'slot.status': 'Slot Status Changed',
  'slot.delete': 'Slot Deleted',
  'zone.create': 'Zone Created',
  'zone.update': 'Zone Updated',
  'zone.delete': 'Zone Deleted',
  'rate.create': 'Rate Created',
  'rate.update': 'Rate Updated',
  'rate.delete': 'Rate Deleted',
  'slot_type.create': 'Slot Type Created',
  'slot_type.update': 'Slot Type Updated',
  'slot_type.delete': 'Slot Type Deleted',
  'settings.update': 'Booking Rules Updated',
  'etiquette.submit': 'Etiquette Report Submitted',
  'etiquette.under_review': 'Etiquette Report Under Review',
  'etiquette.resolve': 'Etiquette Report Approved',
  'etiquette.dismiss': 'Etiquette Report Dismissed',
  'etiquette.verify_vehicle': 'Reported Vehicle Verified',
  'penalty.issue': 'Penalty Issued',
  'penalty.modify': 'Penalty Modified',
  'penalty.charge': 'Penalty Fee Charged to Booking',
  'penalty.revoke': 'Penalty Revoked',
  'appeal.submit': 'Penalty Appeal Submitted',
  'appeal.decide': 'Penalty Appeal Decided',
  'reservation.penalty_fee_added': 'Penalty Fee Added to Booking',
  'reservation.penalty_fee_removed': 'Penalty Fee Removed from Booking',
};

const LABELS = {
  ref: 'Booking Reference',
  slot: 'Slot',
  zone: 'Zone',
  start: 'Start Time',
  end: 'End Time',
  from: 'Previous Time',
  to: 'New Time',
  fee: 'Fee',
  final_fee: 'Final Fee',
  overstay_fee: 'Overstay Fee',
  overstay_minutes: 'Overstay',
  late_minutes: 'Late Arrival',
  amount: 'Amount',
  method: 'Payment Method',
  reference: 'Receipt / Reference No.',
  receipt: 'Receipt No.',
  reason: 'Reason',
  by: 'Done By',
  waived: 'Fee Waived',
  automatic: 'Automatic',
  archived: 'Archived (history kept)',
  plate: 'Plate Number',
  plate_number: 'Plate Number',
  vehicle_type: 'Vehicle Type',
  make: 'Manufacturer',
  model: 'Model',
  color: 'Color',
  email: 'Email',
  role: 'Role',
  is_active: 'Account Status',
  status: 'Status',
  previous_status: 'Previous Status',
  new_status: 'New Status',
  slot_code: 'Slot Code',
  slot_type: 'Slot Type',
  zone_id: 'Zone ID',
  hourly_rate_centavos: 'Hourly Rate',
  hourly_rate_override_centavos: 'Hourly Rate Override',
  base_fee: 'Base Parking Fee',
  penalty_fee: 'Penalty Fee',
  violation: 'Violation',
  incident: 'Incident Time',
  evidence: 'Photo Attached',
  penalty: 'Penalty',
  driver: 'Driver',
  owner: 'Vehicle Owner',
  until: 'Until (inclusive)',
  report: 'Report No.',
  removed_from: 'Fee Removed From',
  decision: 'Decision',
  note: 'Change Note',
  changes: 'Changes',
};

const MONEY_KEYS = new Set(['fee', 'final_fee', 'overstay_fee', 'amount', 'base_fee', 'penalty_fee']);
const MINUTE_KEYS = new Set(['overstay_minutes', 'late_minutes']);
const DATETIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/;

const titleCase = (s) => String(s).replace(/[._]+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase());
const labelFor = (key) => LABELS[key] || titleCase(key.replace(/_centavos$/, '')).replace(/\bId\b/, 'ID');

function actionTitle(action) {
  if (ACTION_TITLES[action]) return ACTION_TITLES[action];
  const [entity, verb] = String(action || '').split('.');
  return verb ? `${titleCase(entity)} ${titleCase(verb)}` : titleCase(entity || 'Action');
}

function fmtWhen(str) {
  const s = String(str).replace('T', ' ');
  return `${time.fmtDate(s)}, ${time.fmtTime(s.length === 16 ? `${s}:00` : s)}`;
}

/** A plain value as text. Returns null for "nothing to show" (empty string / null). */
function formatValue(key, value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (key === 'is_active' && (value === 0 || value === 1)) return value ? 'Active' : 'Inactive';
  if (typeof value === 'number') {
    if (MONEY_KEYS.has(key) || /_centavos$/.test(key)) return formatPeso(value);
    if (MINUTE_KEYS.has(key)) return value ? time.fmtDuration(value) : 'None';
    return String(value);
  }
  if (typeof value === 'string') {
    if (DATETIME.test(value)) return fmtWhen(value);
    if (key === 'method') return { cash: 'Cash', gcash: 'GCash', bank_transfer: 'Bank transfer', other: 'Other' }[value] || value;
    // Slot status 'maintenance' is shown as "Out of Service".
    if ((key === 'status' || key === 'previous_status' || key === 'new_status') && value === 'maintenance') return badge('slot', value).label;
    if (key === 'by' || key === 'role' || key === 'vehicle_type' || key === 'status' || key === 'previous_status' || key === 'new_status') return titleCase(value);
    return value;
  }
  return null;
}

/** A [start, end] pair shown as one time range. */
function rangeText(arr) {
  if (arr.length === 2 && arr.every((v) => typeof v === 'string' && DATETIME.test(v))) {
    const [a, b] = arr.map((v) => v.replace('T', ' '));
    return a.slice(0, 10) === b.slice(0, 10) ? `${time.fmtDate(a)}, ${time.fmtTime(a)} – ${time.fmtTime(b)}` : `${fmtWhen(a)} – ${fmtWhen(b)}`;
  }
  return null;
}

/** [{ label, value }] or [{ label, items: [...] }] for nested objects. */
function itemsOf(obj, depth = 0) {
  const out = [];
  for (const [key, value] of Object.entries(obj)) {
    const label = labelFor(key);
    if (Array.isArray(value)) {
      const range = rangeText(value);
      if (range) out.push({ label, value: range });
      else if (value.some((v) => v && typeof v === 'object')) {
        out.push({ label, items: value.map((v, i) => (v && typeof v === 'object' ? { label: `#${i + 1}`, items: itemsOf(v, depth + 1) } : { label: `#${i + 1}`, value: formatValue(key, v) ?? '—' })) });
      } else if (value.length) out.push({ label, value: value.map((v) => formatValue(key, v) ?? '—').join(', ') });
    } else if (value && typeof value === 'object') {
      if (depth >= 3) out.push({ label, value: JSON.stringify(value) });
      else {
        const nested = itemsOf(value, depth + 1);
        if (nested.length) out.push({ label, items: nested });
      }
    } else {
      const text = formatValue(key, value);
      if (text !== null) out.push({ label, value: text });
    }
  }
  return out;
}

/**
 * { title, items } for one audit row. The subject (e.g. "Reservation ID: 65") and the booking's driver, when known,
 * lead the list.
 */
function describe(row) {
  const items = [];
  if (row.entity_type && row.entity_id) items.push({ label: `${titleCase(row.entity_type)} ID`, value: String(row.entity_id) });
  if (row.subject_driver) items.push({ label: 'Driver', value: row.subject_driver });
  const raw = row.details;
  if (raw !== null && raw !== undefined && String(raw).trim() !== '') {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      parsed = undefined;
    }
    // slot.status logs { from, to } as statuses, not times.
    if (row.action === 'slot.status' && parsed && typeof parsed === 'object' && !Array.isArray(parsed) && ('from' in parsed || 'to' in parsed)) {
      const { from, to, ...rest } = parsed;
      parsed = { previous_status: from, new_status: to, ...rest };
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) items.push(...itemsOf(parsed));
    else if (Array.isArray(parsed)) items.push({ label: 'Details', items: itemsOf(Object.fromEntries(parsed.map((v, i) => [`#${i + 1}`, v]))) });
    else if (parsed !== undefined && parsed !== null) items.push({ label: 'Details', value: String(parsed) });
    else items.push({ label: 'Details', value: String(raw) });
  }
  return { title: actionTitle(row.action), items };
}

module.exports = { describe, actionTitle };
