'use strict';
const session = require('express-session');

/** Minimal SQLite-backed express-session store (reuses the app's better-sqlite3 connection). */
class SqliteStore extends session.Store {
  constructor(db, { ttlMs = 1000 * 60 * 60 * 8 } = {}) {
    super();
    this.ttlMs = ttlMs;
    db.exec('CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires INTEGER NOT NULL)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires)');
    this.stmts = {
      get: db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expires > ?'),
      set: db.prepare('INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires'),
      del: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      touch: db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?'),
      purge: db.prepare('DELETE FROM sessions WHERE expires <= ?'),
    };
    this.timer = setInterval(() => this.stmts.purge.run(Date.now()), 15 * 60 * 1000);
    this.timer.unref();
  }
  _exp(sess) {
    const c = sess && sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : NaN;
    return Number.isFinite(c) ? c : Date.now() + this.ttlMs;
  }
  get(sid, cb) { try { const r = this.stmts.get.get(sid, Date.now()); cb(null, r ? JSON.parse(r.sess) : null); } catch (e) { cb(e); } }
  set(sid, sess, cb) { try { this.stmts.set.run(sid, JSON.stringify(sess), this._exp(sess)); cb && cb(null); } catch (e) { cb && cb(e); } }
  destroy(sid, cb) { try { this.stmts.del.run(sid); cb && cb(null); } catch (e) { cb && cb(e); } }
  touch(sid, sess, cb) { try { this.stmts.touch.run(this._exp(sess), sid); cb && cb(null); } catch (e) { cb && cb(e); } }
}
module.exports = SqliteStore;
