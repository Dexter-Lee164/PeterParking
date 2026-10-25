'use strict';

/** Role-aware sidebar navigation. `key` matches the `nav` value a page passes to res.view. */
const ADMIN_NAV = [
  { key: 'dashboard', label: 'Dashboard', href: '/admin', icon: 'bi-speedometer2' },
  { key: 'slots', label: 'Parking Slots', href: '/admin/slots', icon: 'bi-grid-3x3-gap' },
  { key: 'reservations', label: 'Reservations', href: '/admin/reservations', icon: 'bi-calendar2-week' },
  { key: 'operations', label: 'Check-in / Check-out', href: '/admin/operations', icon: 'bi-arrow-left-right' },
  { key: 'payments', label: 'Payments', href: '/admin/payments', icon: 'bi-cash-stack' },
  { key: 'drivers', label: 'Drivers', href: '/admin/drivers', icon: 'bi-people' },
  { key: 'settings', label: 'Settings', href: '/admin/settings', icon: 'bi-gear' },
];

const DRIVER_NAV = [
  { key: 'dashboard', label: 'Dashboard', href: '/driver', icon: 'bi-speedometer2' },
  { key: 'find-parking', label: 'Find Parking', href: '/driver/find-parking', icon: 'bi-geo-alt' },
  { key: 'reservations', label: 'My Reservations', href: '/driver/reservations', icon: 'bi-calendar2-check' },
  { key: 'payments', label: 'Payments', href: '/driver/payments', icon: 'bi-wallet2' },
  { key: 'vehicles', label: 'My Vehicles', href: '/driver/vehicles', icon: 'bi-car-front' },
  { key: 'profile', label: 'Profile', href: '/driver/profile', icon: 'bi-person-circle' },
];

const navFor = (role) => (role === 'admin' ? ADMIN_NAV : DRIVER_NAV);
const homeFor = (role) => (role === 'admin' ? '/admin' : '/driver');

module.exports = { ADMIN_NAV, DRIVER_NAV, navFor, homeFor };
