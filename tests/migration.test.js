'use strict';

/**
 * Migration 002 (e-mail verification / reset / Google groundwork): an existing database is upgraded in place without
 * losing anything, running it again changes nothing, and a fresh database ends up with the same shape.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
require('./helpers'); // NODE_ENV=test, BCRYPT_ROUNDS=4, ...
const Database = require('better-sqlite3');
const { openDatabase, migrate } = require('../src/db');

const MIGRATIONS = path.join(__dirname, '..', 'src', 'db', 'migrations');
const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
const objects = (db) => new Set(db.prepare('SELECT name FROM sqlite_master').all().map((r) => r.name));
const versions = (db) => db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version);

/** A database exactly as the previous release left it: only migration 001 applied, with a few accounts. */
function legacyDatabase() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(MIGRATIONS, '001_initial_schema.sql'), 'utf8'));
  db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')))`);
  db.prepare('INSERT INTO schema_migrations (version, name) VALUES (1, ?)').run('001_initial_schema.sql');
  const add = db.prepare('INSERT INTO users (full_name, email, password_hash, role, university_id) VALUES (?, ?, ?, ?, ?)');
  add.run('Ada Admin', 'admin@legacy.test', 'hash-admin', 'admin', null);
  add.run('Dan Driver', 'Dan@Legacy.test', 'hash-dan', 'driver', 'U-1');
  add.run('Eve Driver', 'eve@legacy.test', 'hash-eve', 'driver', 'U-2');
  return db;
}

describe('migration 002 on an existing database', () => {
  test('adds the columns, indexes and tables; keeps every account, role and hash; marks existing accounts verified', () => {
    const db = legacyDatabase();
    const before = db.prepare('SELECT id, full_name, email, password_hash, role, university_id FROM users ORDER BY id').all();
    migrate(db);

    assert.deepEqual(versions(db), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const name of ['google_id', 'email_verified', 'password_changed_at']) assert.ok(columns(db, 'users').includes(name), name);
    const names = objects(db);
    for (const name of ['pending_registrations', 'password_resets', 'ux_users_email_lower', 'ux_users_google_id', 'ux_users_email']) assert.ok(names.has(name), name);

    assert.deepEqual(db.prepare('SELECT id, full_name, email, password_hash, role, university_id FROM users ORDER BY id').all(), before);
    const flags = db.prepare('SELECT email_verified, google_id, password_changed_at FROM users').all();
    assert.equal(flags.length, 3);
    for (const row of flags) assert.deepEqual(row, { email_verified: 1, google_id: null, password_changed_at: null });
    db.close();
  });

  test('running it again is a no-op, and never flips a later unverified account to verified', () => {
    const db = legacyDatabase();
    migrate(db);
    migrate(db);
    assert.deepEqual(versions(db), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // A new, unverified sign-up arrives after the upgrade...
    db.prepare('INSERT INTO users (full_name, email, password_hash) VALUES (?, ?, ?)').run('New Person', 'new@legacy.test', 'hash-new');
    assert.equal(db.prepare(`SELECT email_verified FROM users WHERE email = 'new@legacy.test'`).get().email_verified, 0);

    // ...and even if the migration body is forced to run again (as if its record were lost), nothing changes.
    db.prepare('DELETE FROM schema_migrations WHERE version = 2').run();
    migrate(db);
    assert.deepEqual(versions(db), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(db.prepare(`SELECT email_verified FROM users WHERE email = 'new@legacy.test'`).get().email_verified, 0);
    assert.equal(columns(db, 'users').filter((c) => c === 'google_id').length, 1);
    db.close();
  });

  test('tolerates a database that already has some of the new columns', () => {
    const db = legacyDatabase();
    db.exec('ALTER TABLE users ADD COLUMN google_id TEXT');
    db.exec('ALTER TABLE users ADD COLUMN password_changed_at TEXT');
    assert.doesNotThrow(() => migrate(db));
    assert.ok(columns(db, 'users').includes('email_verified'));
    db.close();
  });

  test('two accounts whose e-mails differ only by case stop the upgrade with a clear message and change nothing', () => {
    const db = legacyDatabase();
    db.exec('DROP INDEX ux_users_email'); // the old unique index is case-insensitive already; remove it to create the clash
    db.prepare('INSERT INTO users (full_name, email, password_hash) VALUES (?, ?, ?)').run('Dan Two', 'dan@legacy.test', 'hash-x');
    assert.throws(() => migrate(db), /more than one account uses "dan@legacy\.test"/);
    assert.deepEqual(versions(db), [1], 'the failed migration is not recorded');
    assert.ok(!columns(db, 'users').includes('email_verified'), 'and its column changes were rolled back');
    db.close();
  });
});

describe('a fresh database', () => {
  const fresh = () => openDatabase(':memory:');

  test('has the same shape as an upgraded one', () => {
    const db = fresh();
    const upgraded = legacyDatabase();
    migrate(upgraded);
    assert.deepEqual(versions(db), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.deepEqual(columns(db, 'users').sort(), columns(upgraded, 'users').sort());
    assert.deepEqual(columns(db, 'pending_registrations'), columns(upgraded, 'pending_registrations'));
    assert.deepEqual(columns(db, 'password_resets'), columns(upgraded, 'password_resets'));
    // Migration 010 retired parking etiquette reports and plate penalties; old bookings keep their stored surcharge.
    for (const d of [db, upgraded]) {
      const names = objects(d);
      for (const name of ['etiquette_reports', 'etiquette_evidence', 'plate_penalties']) assert.ok(!names.has(name), name);
      assert.ok(columns(d, 'reservations').includes('surcharge_centavos'));
    }
    db.close();
    upgraded.close();
  });

  test('new accounts start unverified; the flag only accepts 0 or 1', () => {
    const db = fresh();
    db.prepare('INSERT INTO users (full_name, email, password_hash) VALUES (?, ?, ?)').run('A', 'a@x.test', 'h');
    assert.equal(db.prepare('SELECT email_verified FROM users').get().email_verified, 0);
    assert.throws(() => db.prepare('UPDATE users SET email_verified = 2').run(), /CHECK/);
    db.close();
  });

  test('e-mail is unique ignoring case; google_id is unique when present and may be empty for many users', () => {
    const db = fresh();
    const add = db.prepare('INSERT INTO users (full_name, email, password_hash, google_id) VALUES (?, ?, ?, ?)');
    add.run('A', 'Mixed@Case.test', 'h', null);
    assert.throws(() => add.run('B', 'mixed@case.test', 'h', null), /UNIQUE/);
    add.run('C', 'c@x.test', 'h', null); // a second NULL google_id is fine
    add.run('D', 'd@x.test', 'h', 'google-sub-1');
    assert.throws(() => add.run('E', 'e@x.test', 'h', 'google-sub-1'), /UNIQUE/);
    db.close();
  });

  test('pending_registrations: random id, e-mail unique ignoring case, no users row involved', () => {
    const db = fresh();
    const add = db.prepare(`INSERT INTO pending_registrations (email, name, password_hash, code_hmac, expires_at) VALUES (?, 'N', 'h', 'c', '2026-01-01T00:00:00.000Z')`);
    add.run('p@x.test');
    const row = db.prepare('SELECT * FROM pending_registrations').get();
    assert.match(row.id, /^[0-9a-f]{32}$/);
    assert.equal(row.attempts, 0);
    assert.equal(row.send_count, 0);
    assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.throws(() => add.run('P@X.test'), /UNIQUE/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
    db.close();
  });

  test('password_resets: token hash unique; rows disappear with their user', () => {
    const db = fresh();
    const { lastInsertRowid: id } = db.prepare('INSERT INTO users (full_name, email, password_hash) VALUES (?, ?, ?)').run('A', 'a@x.test', 'h');
    const add = db.prepare(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, '2026-01-01T00:00:00.000Z')`);
    add.run(id, 'hash-1');
    assert.throws(() => add.run(id, 'hash-1'), /UNIQUE/);
    assert.throws(() => add.run(9999, 'hash-2'), /FOREIGN KEY/);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM password_resets').get().n, 0);
    db.close();
  });
});

describe('accounts created by the app itself', () => {
  test('seeded and administrator-created accounts are verified', () => {
    const db = openDatabase(':memory:');
    const ctx = require('../src/db/context');
    ctx.set(db);
    try {
      require('../src/db/seed').seedDemoData(db);
      const unverified = db.prepare('SELECT email FROM users WHERE email_verified = 0').all();
      assert.deepEqual(unverified, []);
      assert.ok(db.prepare('SELECT COUNT(*) AS n FROM users').get().n >= 3);

      const users = require('../src/services/users');
      const made = users.adminCreateUser({ full_name: 'Made By Admin', email: 'made@x.test', password: 'Passw0rd!', role: 'driver' }, null);
      assert.equal(db.prepare('SELECT email_verified FROM users WHERE id = ?').get(made.id).email_verified, 1);
    } finally {
      ctx.clear();
      db.close();
    }
  });
});
