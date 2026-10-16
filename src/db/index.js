'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config/env');

if (config.dbPath !== ':memory:') fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

function migrate(conn = db) {
  conn.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const dir = path.join(__dirname, 'migrations');
  const applied = new Set(conn.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    conn.transaction(() => {
      conn.exec(sql);
      conn.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(file, new Date().toISOString());
    })();
  }
}

migrate();

module.exports = { db, migrate, close: () => db.close() };
