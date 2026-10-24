'use strict';

const session = require('express-session');

/**
 * express-session store backed by the application's own SQLite database
 * (table `sessions`). Keeps SQLite as the only database and avoids a second
 * native dependency.
 */
class SqliteSessionStore extends session.Store {
  constructor(db, { ttlMs = 8 * 60 * 60 * 1000, pruneIntervalMs = 15 * 60 * 1000 } = {}) {
    super();
    this.db = db;
    this.ttlMs = ttlMs;
    this._get = db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expires > ?');
    this._set = db.prepare(
      `INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
       ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires`,
    );
    this._destroy = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this._touch = db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?');
    this._prune = db.prepare('DELETE FROM sessions WHERE expires <= ?');
    this._timer = setInterval(() => this.prune(), pruneIntervalMs);
    this._timer.unref();
  }

  _expiry(sess) {
    const cookieExpires = sess && sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : null;
    return cookieExpires || Date.now() + this.ttlMs;
  }

  get(sid, cb) {
    try {
      const row = this._get.get(sid, Date.now());
      cb(null, row ? JSON.parse(row.sess) : null);
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      this._set.run(sid, JSON.stringify(sess), this._expiry(sess));
      cb && cb(null);
    } catch (err) {
      cb && cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      this._destroy.run(sid);
      cb && cb(null);
    } catch (err) {
      cb && cb(err);
    }
  }

  touch(sid, sess, cb) {
    try {
      this._touch.run(this._expiry(sess), sid);
      cb && cb(null);
    } catch (err) {
      cb && cb(err);
    }
  }

  /** Sign a user out everywhere (after a password reset). Sessions are JSON, so the user id is read with json_extract. */
  destroyUserSessions(userId) {
    return this.db.prepare(`DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?`).run(userId).changes;
  }

  prune() {
    try {
      this._prune.run(Date.now());
    } catch (_) {
      /* a failed prune is harmless */
    }
  }

  close() {
    clearInterval(this._timer);
  }
}

module.exports = SqliteSessionStore;
