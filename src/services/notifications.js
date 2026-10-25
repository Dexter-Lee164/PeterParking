'use strict';

const ctx = require('../db/context');
const { nowLocal } = require('../utils/time');

/**
 * Unread updates for administrators and drivers: sidebar badges, and the records behind them highlighted on the page
 * that shows them.
 *
 * Updates come from the audit log (real events, never hard-coded). An event counts as unread for a user when it is
 * newer than the last entry they reviewed in that section (table notification_reads) and somebody else caused it
 * (or the system did): nobody is notified about their own actions.
 *
 * Administrators
 *   reservations   a booking was created, cancelled or rescheduled, or marked as a no-show
 *   payments       a payment was recorded (the Payments page lists paid bookings only, so balances owed and voided
 *                  receipts are not announced there)
 *   etiquette      a driver submitted a parking etiquette report, or appealed a penalty
 * Drivers (only about their own bookings, payments, reports and penalties)
 *   reservations   staff cancelled, rescheduled, checked in or out, or marked one of their bookings as a no-show
 *   payments       a payment of theirs was recorded or voided
 *   etiquette      a report they sent changed status; a penalty on their account was issued, modified, charged to a
 *                  booking or revoked; their appeal was decided. Never anything about who reported them.
 *
 * Opening the section marks everything up to now as reviewed; the records that were unread stay highlighted on that
 * one page view (see middleware()). A user's first check starts from "now", so the history that existed before the
 * feature does not appear as hundreds of updates.
 */

const SECTIONS = {
  admin: {
    reservations: `a.action IN ('reservation.create', 'reservation.cancel', 'reservation.reschedule', 'reservation.no_show')`,
    payments: `a.action = 'payment.record'`,
    etiquette: `a.action IN ('etiquette.submit', 'appeal.submit')`,
  },
  driver: {
    reservations: `a.entity_type = 'reservation'
      AND a.action IN ('reservation.cancel', 'reservation.reschedule', 'reservation.no_show', 'reservation.move', 'session.check_in', 'session.check_out')
      AND EXISTS (SELECT 1 FROM reservations r WHERE r.id = a.entity_id AND r.user_id = @me)`,
    payments: `a.entity_type = 'payment' AND a.action IN ('payment.record', 'payment.void')
      AND EXISTS (SELECT 1 FROM payments p WHERE p.id = a.entity_id AND p.user_id = @me)`,
    etiquette: `((a.entity_type = 'etiquette_report' AND a.action IN ('etiquette.under_review', 'etiquette.resolve', 'etiquette.dismiss')
        AND EXISTS (SELECT 1 FROM etiquette_reports e WHERE e.id = a.entity_id AND e.reporter_id = @me))
      OR (a.entity_type = 'penalty' AND a.action IN ('penalty.issue', 'penalty.modify', 'penalty.charge', 'penalty.revoke')
        AND EXISTS (SELECT 1 FROM penalties p WHERE p.id = a.entity_id AND p.user_id = @me))
      OR (a.entity_type = 'penalty_appeal' AND a.action = 'appeal.decide'
        AND EXISTS (SELECT 1 FROM penalty_appeals pa WHERE pa.id = a.entity_id AND pa.user_id = @me)))`,
  },
};

const sectionsFor = (role) => SECTIONS[role === 'admin' ? 'admin' : 'driver'];
const latestAuditId = (db) => db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM audit_logs').get().id;

function lastSeen(db, userId, section) {
  const row = db.prepare('SELECT last_seen_audit_id FROM notification_reads WHERE user_id = ? AND section = ?').get(userId, section);
  if (row) return row.last_seen_audit_id;
  const start = latestAuditId(db);
  db.prepare('INSERT OR IGNORE INTO notification_reads (user_id, section, last_seen_audit_id, seen_at) VALUES (?, ?, ?, ?)')
    .run(userId, section, start, nowLocal());
  return start;
}

const unreadWhere = (where) => `a.id > @seen AND (a.user_id IS NULL OR a.user_id <> @me) AND ${where}`;

/** { section: n } unread for this user (sections depend on the role). */
function counts(user) {
  const db = ctx.get();
  const out = {};
  for (const [section, where] of Object.entries(sectionsFor(user.role))) {
    out[section] = db
      .prepare(`SELECT COUNT(*) AS n FROM audit_logs a WHERE ${unreadWhere(where)}`)
      .get({ seen: lastSeen(db, user.id, section), me: user.id }).n;
  }
  return out;
}

/** The records behind a section's unread updates: { reservation: Set(ids), payment: Set(ids), ... }. */
function unreadRecords(user, section) {
  const where = sectionsFor(user.role)[section];
  const out = {};
  if (!where) return out;
  const db = ctx.get();
  const rows = db
    .prepare(`SELECT a.entity_type, a.entity_id FROM audit_logs a WHERE ${unreadWhere(where)} AND a.entity_id IS NOT NULL`)
    .all({ seen: lastSeen(db, user.id, section), me: user.id });
  for (const r of rows) (out[r.entity_type] = out[r.entity_type] || new Set()).add(r.entity_id);
  return out;
}

/** The user has reviewed a section: everything logged so far is acknowledged. */
function markSeen(user, section) {
  if (!sectionsFor(user.role)[section]) return;
  const db = ctx.get();
  db.prepare(
    `INSERT INTO notification_reads (user_id, section, last_seen_audit_id, seen_at) VALUES (@user, @section, @id, @now)
     ON CONFLICT (user_id, section) DO UPDATE SET last_seen_audit_id = MAX(last_seen_audit_id, excluded.last_seen_audit_id), seen_at = excluded.seen_at`,
  ).run({ user: user.id, section, id: latestAuditId(db), now: nowLocal() });
}

/**
 * Router middleware for the admin and driver areas. Opening a section (GET /<section>…) takes note of its unread
 * records (so that page can highlight them: res.locals.isUnread(type, id), res.locals.unreadTotal), then acknowledges
 * them, before the badge counts are taken, so the badge disappears on the page that shows the updates.
 */
function middleware(req, res, next) {
  const user = req.user;
  const sections = Object.keys(sectionsFor(user.role));
  // A page view, not a file it loads (an evidence image), opens the section.
  const page = req.method === 'GET' && !/\/evidence$/.test(req.path);
  const section = page && ((new RegExp(`^/(${sections.join('|')})(/|$)`)).exec(req.path) || [])[1];
  if (section) {
    const unread = unreadRecords(user, section);
    res.locals.isUnread = (type, id) => !!(unread[type] && unread[type].has(Number(id)));
    res.locals.unreadTotal = Object.values(unread).reduce((n, set) => n + set.size, 0);
    markSeen(user, section);
  }
  res.locals.navBadges = counts(user);
  res.locals.navBadgesUrl = user.role === 'admin' ? '/admin/notifications' : '/driver/notifications';
  next();
}

module.exports = { SECTIONS: { admin: Object.keys(SECTIONS.admin), driver: Object.keys(SECTIONS.driver) }, counts, unreadRecords, markSeen, middleware };
