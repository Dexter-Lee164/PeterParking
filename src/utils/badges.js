'use strict';

/**
 * Status → { label, tone, icon } for the shared status-badge partial.
 * Every badge carries an icon and text, so state never depends on colour alone.
 */
const MAP = {
  reservation: {
    confirmed: { label: 'Confirmed', tone: 'blue', icon: 'bi-calendar-check' },
    checked_in: { label: 'Checked in', tone: 'teal', icon: 'bi-box-arrow-in-right' },
    completed: { label: 'Completed', tone: 'green', icon: 'bi-check2-circle' },
    cancelled: { label: 'Cancelled', tone: 'gray', icon: 'bi-x-circle' },
    no_show: { label: 'No-show', tone: 'red', icon: 'bi-person-x' },
  },
  slot: {
    active: { label: 'Active', tone: 'green', icon: 'bi-check-circle' },
    maintenance: { label: 'Out of Service', tone: 'amber', icon: 'bi-tools' },
    inactive: { label: 'Inactive', tone: 'gray', icon: 'bi-slash-circle' },
  },
  availability: {
    available: { label: 'Available', tone: 'green', icon: 'bi-check-circle-fill' },
    reserved: { label: 'Reserved', tone: 'blue', icon: 'bi-bookmark-fill' },
    occupied: { label: 'Occupied', tone: 'red', icon: 'bi-car-front-fill' },
    unavailable: { label: 'Unavailable', tone: 'gray', icon: 'bi-slash-circle-fill' },
  },
  payment: {
    valid: { label: 'Valid', tone: 'green', icon: 'bi-check-circle' },
    voided: { label: 'Voided', tone: 'gray', icon: 'bi-slash-circle' },
  },
  balance: {
    paid: { label: 'Paid', tone: 'green', icon: 'bi-cash-coin' },
    unpaid: { label: 'Unpaid', tone: 'amber', icon: 'bi-exclamation-circle' },
    overpaid: { label: 'Credit', tone: 'blue', icon: 'bi-arrow-return-left' },
    no_charge: { label: 'No charge', tone: 'gray', icon: 'bi-dash-circle' },
  },
  session: {
    parked: { label: 'Parked', tone: 'teal', icon: 'bi-p-circle' },
    closed: { label: 'Closed', tone: 'gray', icon: 'bi-check2' },
    overstay: { label: 'Overstay', tone: 'red', icon: 'bi-alarm' },
    late: { label: 'Late', tone: 'amber', icon: 'bi-clock-history' },
  },
  user: {
    active: { label: 'Active', tone: 'green', icon: 'bi-check-circle' },
    inactive: { label: 'Inactive', tone: 'gray', icon: 'bi-slash-circle' },
    admin: { label: 'Administrator', tone: 'blue', icon: 'bi-shield-check' },
    driver: { label: 'Driver', tone: 'gray', icon: 'bi-person' },
  },
};

function badge(kind, status) {
  const entry = MAP[kind] && MAP[kind][status];
  if (entry) return entry;
  return { label: String(status || '—').replace(/_/g, ' '), tone: 'gray', icon: 'bi-circle' };
}

module.exports = { badge, MAP };
