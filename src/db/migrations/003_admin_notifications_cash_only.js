'use strict';

/**
 * 003 — sidebar notifications for administrators, and cash-only payments.
 *
 *   admin_notification_reads   per administrator and sidebar section ('reservations' | 'payments'): the newest audit
 *                              log entry they have already reviewed. Anything newer is "unread" (services/notifications.js).
 *   trg_payments_cash_only     new payments must be cash. Older GCash / bank-transfer / other rows stay exactly as they
 *                              are (the column's CHECK constraint still accepts them), so history and reports are intact.
 *
 * Idempotent: IF NOT EXISTS everywhere, no existing row is changed.
 */

function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_notification_reads (
      user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      section             TEXT NOT NULL CHECK (section IN ('reservations', 'payments')),
      last_seen_audit_id  INTEGER NOT NULL DEFAULT 0,
      seen_at             TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      PRIMARY KEY (user_id, section)
    );

    CREATE TRIGGER IF NOT EXISTS trg_payments_cash_only
    BEFORE INSERT ON payments
    WHEN NEW.method <> 'cash'
    BEGIN
      SELECT RAISE(ABORT, 'PAYMENT_METHOD_NOT_ALLOWED');
    END;
  `);
}

module.exports = { up };
