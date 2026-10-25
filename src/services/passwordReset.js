'use strict';

/**
 * "Forgot password": single-use reset links.
 *
 *   request()   for an active account, invalidate its earlier links and create a new token (30 minutes)
 *   findValid() the unused, unexpired reset row for a token hash, or null
 *   complete()  set the new password, burn the token (and every other open token of that user)
 *
 * A token is 32 random bytes (base64url) that exists only in the e-mailed link; the database keeps its SHA-256 hash.
 * The route keeps only the hash in the session after the link is opened, so the token leaves the address bar at once.
 */

const crypto = require('crypto');
const ctx = require('../db/context');
const { immediate } = require('../db');
const users = require('./users');
const audit = require('./audit');
const { AppError } = require('../utils/errors');
const { clean, passwordProblem } = require('../utils/validate');
const { clock } = require('../utils/time');

const TOKEN_TTL_MS = 30 * 60 * 1000;
const MAX_PER_HOUR = 3; // per account; extra requests are silently dropped (the response never changes)

const nowMs = () => clock.now().getTime();
const iso = (ms) => new Date(ms).toISOString();

const hashToken = (token) => crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');

function sameHash(a, b) {
  const x = Buffer.from(String(a || ''), 'hex');
  const y = Buffer.from(String(b || ''), 'hex');
  return x.length === 32 && y.length === 32 && crypto.timingSafeEqual(x, y);
}

/** 'missing' (no account with this address), 'inactive' (deactivated) or 'ok': checked before a link is requested. */
function accountState(email) {
  const user = ctx.get().prepare('SELECT is_active FROM users WHERE email = ? COLLATE NOCASE').get(clean(email));
  if (!user) return 'missing';
  return user.is_active ? 'ok' : 'inactive';
}

/**
 * @returns { user, token, expiresAt } when a link should be e-mailed, otherwise null (unknown, inactive, throttled).
 * Throttled requests look the same to the visitor as a sent link.
 */
function request(email, ip) {
  const db = ctx.get();
  return immediate(db, () => {
    db.prepare('DELETE FROM password_resets WHERE expires_at < ? AND created_at < ?').run(iso(nowMs()), iso(nowMs() - 24 * 3600 * 1000));
    const user = db.prepare('SELECT id, full_name, email, is_active FROM users WHERE email = ? COLLATE NOCASE').get(clean(email));
    if (!user || !user.is_active) return null;
    const recent = db.prepare('SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ? AND created_at > ?').get(user.id, iso(nowMs() - 3600 * 1000)).n;
    if (recent >= MAX_PER_HOUR) return null;

    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = iso(nowMs() + TOKEN_TTL_MS);
    db.prepare('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(iso(nowMs()), user.id);
    db.prepare('INSERT INTO password_resets (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)').run(
      user.id, hashToken(token), expiresAt, iso(nowMs()),
    );
    audit.log(user.id, 'auth.reset_requested', 'user', user.id, null, ip);
    return { user, token, expiresAt };
  });
}

/** The open reset row (joined with its user's e-mail and name) for this token hash, or null. */
function findValid(tokenHash) {
  if (!tokenHash || !/^[a-f0-9]{64}$/.test(tokenHash)) return null;
  const row = ctx
    .get()
    .prepare(
      `SELECT r.*, u.email, u.full_name, u.is_active FROM password_resets r JOIN users u ON u.id = r.user_id
       WHERE r.token_hash = ?`,
    )
    .get(tokenHash);
  if (!row || !sameHash(row.token_hash, tokenHash)) return null;
  if (row.used_at || Date.parse(row.expires_at) <= nowMs() || !row.is_active) return null;
  return row;
}

/**
 * @returns { status: 'ok', user } | { status: 'invalid' }
 * @throws AppError VALIDATION (password rules) — the token is NOT used up by a rejected password
 */
function complete(tokenHash, { password, confirm_password } = {}, ip) {
  const fields = {};
  const problem = passwordProblem(password);
  if (problem) fields.password = problem;
  else if (password !== confirm_password) fields.confirm_password = 'Passwords do not match.';
  if (!findValid(tokenHash)) return { status: 'invalid' };
  if (Object.keys(fields).length) throw new AppError('Please correct the highlighted fields.', { code: 'VALIDATION', fields });

  const hash = users.hashPassword(password);
  const db = ctx.get();
  return immediate(db, () => {
    const row = findValid(tokenHash); // again, under the write lock: a link can be used once, even by two tabs at once
    if (!row) return { status: 'invalid' };
    const now = iso(nowMs());
    db.prepare(`UPDATE users SET password_hash = ?, password_changed_at = ?, email_verified = 1, updated_at = datetime('now','localtime') WHERE id = ?`).run(
      hash, now, row.user_id,
    );
    db.prepare('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(now, row.user_id);
    audit.log(row.user_id, 'auth.reset_completed', 'user', row.user_id, null, ip);
    return { status: 'ok', user: users.getUser(row.user_id) };
  });
}

module.exports = { TOKEN_TTL_MS, MAX_PER_HOUR, hashToken, accountState, request, findValid, complete };
