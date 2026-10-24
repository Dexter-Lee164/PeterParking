'use strict';

/**
 * 002 — groundwork for e-mail verification, password reset and Google sign-in.
 *
 *   users.google_id            Google's stable "sub" identifier (nullable, unique when present)
 *   users.email_verified       0/1. Every account that exists when this migration first runs is marked 1 (see below).
 *   users.password_changed_at  set when a password is reset; lets older sessions be rejected
 *   ux_users_email_lower       explicit case-insensitive uniqueness (the column is already COLLATE NOCASE)
 *   pending_registrations      sign-ups waiting for their e-mail code; NO users row exists until the code is verified
 *   password_resets            single-use reset tokens, stored only as SHA-256 hashes
 *
 * Idempotent: every statement checks before it changes anything, so running it twice (or on a database that
 * already has some of these columns) is a no-op. Existing rows and data are never rewritten, except that
 * email_verified is set to 1 ONCE, at the moment its column is created.
 *
 * Timestamps in the two new tables are UTC ISO-8601 strings (e.g. 2026-10-20T15:35:00.000Z). They are compared as
 * strings, which is correct for that format. The rest of the schema keeps its campus-local text times.
 */

function columnNames(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}

function up(db) {
  const columns = columnNames(db, 'users');

  if (!columns.has('google_id')) {
    db.exec('ALTER TABLE users ADD COLUMN google_id TEXT');
  }
  if (!columns.has('password_changed_at')) {
    db.exec('ALTER TABLE users ADD COLUMN password_changed_at TEXT');
  }
  if (!columns.has('email_verified')) {
    db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1))');
    // Assumption: accounts that exist today were made by an administrator, by the seed, or by the old sign-up form
    // that had no e-mail check. They are trusted as they are, so nobody is locked out or asked to verify retroactively.
    db.exec('UPDATE users SET email_verified = 1');
  }

  const clash = db
    .prepare('SELECT lower(email) AS e, COUNT(*) AS n FROM users GROUP BY lower(email) HAVING COUNT(*) > 1 LIMIT 1')
    .get();
  if (clash) {
    throw new Error(`Cannot add the case-insensitive e-mail index: more than one account uses "${clash.e}". Merge or rename them and restart.`);
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_users_google_id ON users(google_id) WHERE google_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email_lower ON users(lower(email));

    CREATE TABLE IF NOT EXISTS pending_registrations (
      id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      email          TEXT NOT NULL COLLATE NOCASE UNIQUE,
      name           TEXT NOT NULL,
      university_id  TEXT,
      mobile         TEXT,
      password_hash  TEXT NOT NULL,
      code_hmac      TEXT NOT NULL,
      expires_at     TEXT NOT NULL,
      attempts       INTEGER NOT NULL DEFAULT 0,
      send_count     INTEGER NOT NULL DEFAULT 0,
      last_sent_at   TEXT,
      created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS ix_pending_created ON pending_registrations(created_at);

    CREATE TABLE IF NOT EXISTS password_resets (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash  TEXT NOT NULL UNIQUE,
      expires_at  TEXT NOT NULL,
      used_at     TEXT,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS ix_password_resets_user ON password_resets(user_id, used_at);
  `);
}

module.exports = { up };
