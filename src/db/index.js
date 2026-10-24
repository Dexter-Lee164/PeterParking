'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Open (creating if needed) the single local SQLite database and apply
 * any pending migrations. Foreign keys are always enabled.
 */
function openDatabase(databasePath) {
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }
  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  return db;
}

/**
 * Migrations live in ./migrations and run once each, in version order, inside a transaction:
 *   NNN_name.sql  plain SQL
 *   NNN_name.js   `module.exports = { up(db) { ... } }` — for changes SQLite cannot express idempotently in SQL
 *                 (ALTER TABLE ... ADD COLUMN has no IF NOT EXISTS). These must also be safe to run twice.
 */
function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  )`);
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.(sql|js)$/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  const seen = new Set();
  for (const file of files) {
    const version = parseInt(file.split('_')[0], 10);
    if (seen.has(version)) throw new Error(`Two migrations share version ${version} (${file}).`);
    seen.add(version);
    if (applied.has(version)) continue;

    const apply = file.endsWith('.js')
      ? () => require(path.join(MIGRATIONS_DIR, file)).up(db)
      : () => db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
    const run = db.transaction(() => {
      apply();
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(version, file);
    });
    run();
  }
}

/**
 * Run `fn(db)` inside an IMMEDIATE transaction. IMMEDIATE takes the write lock up
 * front, so a read-check-then-write sequence (e.g. conflict check + insert) can
 * never interleave with another writer.
 */
function immediate(db, fn) {
  const tx = db.transaction(fn);
  return tx.immediate(db);
}

module.exports = { openDatabase, migrate, immediate };
