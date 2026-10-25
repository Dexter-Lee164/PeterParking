'use strict';

/**
 * 009 — etiquette reports have three statuses: under review, resolved and dismissed.
 *
 *   'pending' reports become 'under_review' (a new report now starts under review), and a report that already led to a
 *   penalty is marked resolved. Nothing else is changed; the table keeps accepting the old value, so older code and
 *   backups still load.
 *
 * Idempotent: running it again finds nothing to change.
 */

function up(db) {
  const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'etiquette_reports'`).get();
  if (!exists) return;
  db.prepare(`UPDATE etiquette_reports SET status = 'under_review', updated_at = datetime('now', 'localtime') WHERE status = 'pending'`).run();
  db.prepare(
    `UPDATE etiquette_reports SET status = 'resolved', updated_at = datetime('now', 'localtime')
     WHERE status <> 'resolved' AND EXISTS (SELECT 1 FROM plate_penalties p WHERE p.report_id = etiquette_reports.id)`,
  ).run();
}

module.exports = { up };
