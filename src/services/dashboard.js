'use strict';

const ctx = require('../db/context');
const settingsService = require('./settings');
const reservations = require('./reservations');
const payments = require('./payments');
const time = require('../utils/time');

function lastNDays(n) {
  const today = time.todayLocal();
  const days = [];
  for (let i = n - 1; i >= 0; i -= 1) days.push(time.addDays(`${today} 00:00:00`, -i).slice(0, 10));
  return days;
}

/** Live occupancy numbers. Reserved ≠ occupied: occupied means a vehicle is checked in. */
function slotSnapshot() {
  const db = ctx.get();
  const now = time.nowLocal();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM parking_slots s JOIN parking_zones z ON z.id = s.zone_id WHERE s.status = 'active' AND z.is_active = 1`).get().n;
  const occupied = db
    .prepare(
      `SELECT COUNT(DISTINCT ps.slot_id) AS n FROM parking_sessions ps JOIN parking_slots s ON s.id = ps.slot_id
       WHERE ps.check_out_at IS NULL`,
    )
    .get().n;
  const reserved = db
    .prepare(
      `SELECT COUNT(DISTINCT r.slot_id) AS n FROM reservations r JOIN parking_slots s ON s.id = r.slot_id
       WHERE r.status = 'confirmed' AND r.start_at <= ? AND r.end_at > ? AND s.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM parking_sessions ps WHERE ps.slot_id = r.slot_id AND ps.check_out_at IS NULL)`,
    )
    .get(now, now).n;
  const unavailable = db
    .prepare(`SELECT COUNT(*) AS n FROM parking_slots s JOIN parking_zones z ON z.id = s.zone_id WHERE s.retired_at IS NULL AND (s.status <> 'active' OR z.is_active = 0)`)
    .get().n;
  // Out of service (status 'maintenance', in an active zone): shown on its own; the rest of `unavailable` is inactive.
  const maintenance = db
    .prepare(`SELECT COUNT(*) AS n FROM parking_slots s JOIN parking_zones z ON z.id = s.zone_id WHERE s.retired_at IS NULL AND s.status = 'maintenance' AND z.is_active = 1`)
    .get().n;
  const available = Math.max(0, total - occupied - reserved);
  return { total, available, reserved, occupied, unavailable, maintenance, inactive: unavailable - maintenance };
}

function adminDashboard() {
  const db = ctx.get();
  const today = time.todayLocal();
  const settings = settingsService.getAll();
  const snapshot = slotSnapshot();

  const todaysReservations = db
    .prepare(`SELECT COUNT(*) AS n FROM reservations WHERE substr(start_at, 1, 10) = ? AND status <> 'cancelled'`)
    .get(today).n;

  // Reservations over time (14 days).
  const days14 = lastNDays(14);
  const perDay = new Map(
    db
      .prepare(
        `SELECT substr(start_at, 1, 10) AS d, COUNT(*) AS n FROM reservations
         WHERE start_at >= ? AND start_at <= ? AND status <> 'cancelled' GROUP BY d`,
      )
      .all(`${days14[0]} 00:00:00`, `${today} 23:59:59`)
      .map((r) => [r.d, r.n]),
  );
  const reservationsOverTime = { labels: days14.map(time.fmtDateShort), values: days14.map((d) => perDay.get(d) || 0) };

  const from30 = time.addDays(`${today} 00:00:00`, -29).slice(0, 10);

  // Outcome rates (30 days, bookings whose window has been resolved or are otherwise in the period).
  const statusRows = db
    .prepare(`SELECT status, COUNT(*) AS n FROM reservations WHERE start_at >= ? AND start_at <= ? GROUP BY status`)
    .all(`${from30} 00:00:00`, `${today} 23:59:59`);
  const byStatus = Object.fromEntries(statusRows.map((r) => [r.status, r.n]));
  const totalPeriod = statusRows.reduce((a, r) => a + r.n, 0);
  const rate = (n) => (totalPeriod ? Math.round(((n || 0) / totalPeriod) * 1000) / 10 : 0);
  const outcomes = {
    labels: ['Completed / active', 'Upcoming', 'Cancelled', 'No-show'],
    values: [(byStatus.completed || 0) + (byStatus.checked_in || 0), byStatus.confirmed || 0, byStatus.cancelled || 0, byStatus.no_show || 0],
    cancellationRate: rate(byStatus.cancelled),
    noShowRate: rate(byStatus.no_show),
    total: totalPeriod,
  };

  // Manually recorded collections (14 days).
  const collected = new Map(
    db
      .prepare(
        `SELECT substr(paid_at, 1, 10) AS d, SUM(amount_centavos) AS c FROM payments
         WHERE status = 'valid' AND paid_at >= ? AND paid_at <= ? GROUP BY d`,
      )
      .all(`${days14[0]} 00:00:00`, `${today} 23:59:59`)
      .map((r) => [r.d, r.c]),
  );
  const collections = {
    labels: days14.map(time.fmtDateShort),
    values: days14.map((d) => (collected.get(d) || 0) / 100),
    totalCentavos: days14.reduce((a, d) => a + (collected.get(d) || 0), 0),
  };

  const recentActivity = db
    .prepare(
      `SELECT a.id, a.action, a.entity_type, a.entity_id, a.details, a.created_at, u.full_name AS user_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.entity_type IN ('reservation', 'payment') ORDER BY a.id DESC LIMIT 10`,
    )
    .all();

  return {
    snapshot,
    kpis: {
      totalSlots: snapshot.total,
      available: snapshot.available,
      reserved: snapshot.reserved,
      occupied: snapshot.occupied,
      todaysReservations,
      maintenance: snapshot.maintenance,
    },
    charts: { reservationsOverTime, outcomes, collections },
    recentActivity,
    lateArrivals: db
      .prepare(
        `SELECT COUNT(*) AS n FROM reservations WHERE status = 'confirmed' AND start_at <= ? AND end_at > ?`,
      )
      .get(time.addMinutes(time.nowLocal(), -settings.late_arrival_grace_minutes), time.nowLocal()).n,
  };
}

function driverDashboard(userId) {
  const db = ctx.get();
  const now = time.nowLocal();
  const upcoming = db
    .prepare(`${reservations.RES_SELECT} WHERE r.user_id = ? AND r.status = 'confirmed' AND r.end_at > ? ORDER BY r.start_at LIMIT 1`)
    .get(userId, now);
  const active = db
    .prepare(
      `${reservations.RES_SELECT.replace('SELECT r.*,', 'SELECT ps.check_in_at, r.*,')}
       JOIN parking_sessions ps ON ps.reservation_id = r.id
       WHERE r.user_id = ? AND r.status = 'checked_in' AND ps.check_out_at IS NULL LIMIT 1`,
    )
    .get(userId);
  const recent = db
    .prepare(`${reservations.RES_SELECT} WHERE r.user_id = ? ORDER BY r.updated_at DESC, r.id DESC LIMIT 5`)
    .all(userId)
    .map(reservations.decorate);
  const recentPayments = payments.listPayments({ userId }, { page: 1, perPage: 5 }).rows;
  return {
    upcoming: reservations.decorate(upcoming),
    active: reservations.decorate(active),
    outstandingCentavos: payments.totalOutstanding({ userId }),
    counts: reservations.countByTab(userId),
    recent,
    recentPayments,
  };
}

module.exports = { adminDashboard, driverDashboard, slotSnapshot, lastNDays };
