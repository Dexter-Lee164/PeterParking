'use strict';

/**
 * Sign-up with an e-mailed 6-digit code.
 *
 *   start()    validate the form, store it in pending_registrations with a fresh code, and return the code to e-mail
 *   resend()   a new code for the same pending sign-up (60 s cooldown, at most 5 sends per pending sign-up)
 *   verify()   check a code; on success create the driver and delete the pending row
 *
 * No users row exists until verify() succeeds. The code is stored only as HMAC-SHA256(server secret, id:code) and
 * compared in constant time. A code works for 10 minutes and 5 wrong tries; then it is dead and a new one must be sent.
 * A pending row lives 30 minutes and is purged on the next sign-up activity after that.
 *
 * The pending id is kept in the visitor's session, never in a URL. Every sign-up from ANOTHER session for the same
 * address gets a new id (so whoever submitted last cannot complete someone else's sign-up), and must respect the
 * cooldown, so nobody can flood an inbox by re-submitting the form.
 */

const crypto = require('crypto');
const ctx = require('../db/context');
const { immediate } = require('../db');
const config = require('../config');
const users = require('./users');
const { AppError } = require('../utils/errors');
const { clock } = require('../utils/time');

const CODE_TTL_MS = 10 * 60 * 1000;
const PENDING_TTL_MS = 30 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_SENDS = 5;

const nowMs = () => clock.now().getTime();
const iso = (ms) => new Date(ms).toISOString();

const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const newId = () => crypto.randomBytes(16).toString('hex');

function codeHmac(id, code) {
  return crypto.createHmac('sha256', config.resolveAuthCodeSecret()).update(`${id}:${code}`).digest('hex');
}

function sameHmac(a, b) {
  const x = Buffer.from(String(a || ''), 'hex');
  const y = Buffer.from(String(b || ''), 'hex');
  return x.length === 32 && y.length === 32 && crypto.timingSafeEqual(x, y);
}

function purge() {
  ctx.get().prepare('DELETE FROM pending_registrations WHERE created_at < ?').run(iso(nowMs() - PENDING_TTL_MS));
}

/** The live pending sign-up with this id, or null. */
function get(id) {
  if (!id || typeof id !== 'string') return null;
  purge();
  return ctx.get().prepare('SELECT * FROM pending_registrations WHERE id = ?').get(id) || null;
}

/** Seconds until another code may be sent (0 = now). */
function cooldownSeconds(row) {
  if (!row || !row.last_sent_at) return 0;
  return Math.max(0, Math.ceil((Date.parse(row.last_sent_at) + RESEND_COOLDOWN_MS - nowMs()) / 1000));
}

function issueCode(db, id) {
  const code = newCode();
  const now = nowMs();
  db.prepare(
    `UPDATE pending_registrations SET code_hmac = ?, expires_at = ?, attempts = 0, send_count = send_count + 1, last_sent_at = ?
     WHERE id = ?`,
  ).run(codeHmac(id, code), iso(now + CODE_TTL_MS), iso(now), id);
  return code;
}

/**
 * Validate the form and park it as a pending sign-up.
 * @returns { pending, code }  code is null when the existing code was kept (same session, still in its cooldown)
 * @throws AppError VALIDATION with per-field messages
 */
function start(input, { pendingId = null, emailProblem = null } = {}) {
  const v = users.validateRegistration(input, { emailProblem });
  const passwordHash = users.hashPassword(input.password); // slow: done before taking the write lock
  const db = ctx.get();

  return immediate(db, () => {
    purge();
    const own = pendingId ? db.prepare('SELECT * FROM pending_registrations WHERE id = ?').get(pendingId) : null;
    if (own && own.email !== v.email) db.prepare('DELETE FROM pending_registrations WHERE id = ?').run(own.id);
    const existing = db.prepare('SELECT * FROM pending_registrations WHERE email = ?').get(v.email);

    if (existing && existing.id === pendingId) {
      // The same visitor came back through "Edit": keep their row, refresh the details.
      db.prepare('UPDATE pending_registrations SET name = ?, university_id = ?, mobile = ?, password_hash = ? WHERE id = ?').run(
        v.full_name, v.university_id, v.phone, passwordHash, existing.id,
      );
      const canSend = cooldownSeconds(existing) === 0 && existing.send_count < MAX_SENDS;
      const code = canSend ? issueCode(db, existing.id) : null;
      return { pending: get(existing.id), code };
    }

    let carriedSends = 0;
    if (existing) {
      const wait = cooldownSeconds(existing);
      if (wait > 0) {
        throw new AppError('Please correct the highlighted fields.', {
          code: 'VALIDATION',
          fields: { email: `A code was just sent to this address. Try again in ${wait} seconds.` },
        });
      }
      if (existing.send_count >= MAX_SENDS) {
        throw new AppError('Please correct the highlighted fields.', {
          code: 'VALIDATION',
          fields: { email: 'Too many codes were sent to this address. Please try again in 30 minutes.' },
        });
      }
      carriedSends = existing.send_count;
      db.prepare('DELETE FROM pending_registrations WHERE id = ?').run(existing.id);
    }

    const id = newId();
    db.prepare(
      `INSERT INTO pending_registrations (id, email, name, university_id, mobile, password_hash, code_hmac, expires_at, send_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?)`,
    ).run(id, v.email, v.full_name, v.university_id, v.phone, passwordHash, iso(nowMs()), carriedSends, iso(nowMs()));
    const code = issueCode(db, id);
    return { pending: get(id), code };
  });
}

/** The code could not be e-mailed: allow an immediate resend instead of making the visitor wait out the cooldown. */
function markSendFailed(id) {
  ctx.get().prepare('UPDATE pending_registrations SET last_sent_at = NULL WHERE id = ?').run(id);
}

/** @returns { status: 'sent', pending, code } | { status: 'cooldown', seconds } | { status: 'limit' } | { status: 'gone' } */
function resend(id) {
  const db = ctx.get();
  return immediate(db, () => {
    const row = get(id);
    if (!row) return { status: 'gone' };
    const wait = cooldownSeconds(row);
    if (wait > 0) return { status: 'cooldown', seconds: wait };
    if (row.send_count >= MAX_SENDS) return { status: 'limit' };
    const code = issueCode(db, row.id);
    return { status: 'sent', pending: get(row.id), code };
  });
}

/**
 * @returns { status: 'ok', user } | { status: 'wrong', attemptsLeft } | { status: 'expired' | 'locked' | 'format' | 'gone' | 'taken' }
 */
function verify(id, rawCode, ip) {
  const code = String(rawCode || '').replace(/\D/g, '');
  const db = ctx.get();
  return immediate(db, () => {
    const row = get(id);
    if (!row) return { status: 'gone' };
    if (!row.code_hmac || row.attempts >= MAX_ATTEMPTS) return { status: 'locked' };
    if (Date.parse(row.expires_at) <= nowMs()) return { status: 'expired' };
    if (code.length !== 6) return { status: 'format' };

    if (!sameHmac(codeHmac(row.id, code), row.code_hmac)) {
      const attempts = row.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        db.prepare(`UPDATE pending_registrations SET attempts = ?, code_hmac = '' WHERE id = ?`).run(attempts, row.id);
        return { status: 'locked' };
      }
      db.prepare('UPDATE pending_registrations SET attempts = ? WHERE id = ?').run(attempts, row.id);
      return { status: 'wrong', attemptsLeft: MAX_ATTEMPTS - attempts };
    }

    db.prepare('DELETE FROM pending_registrations WHERE id = ?').run(row.id);
    const user = users.createVerifiedDriver(
      { full_name: row.name, email: row.email, phone: row.mobile, university_id: row.university_id, password_hash: row.password_hash },
      ip,
      'auth.registration_verified',
    );
    return user ? { status: 'ok', user } : { status: 'taken' };
  });
}

/** Form values for "Wrong email? Edit" (never the password). */
function editValues(row) {
  return row ? { full_name: row.name, email: row.email, university_id: row.university_id || '', phone: row.mobile || '' } : {};
}

module.exports = {
  CODE_TTL_MS,
  PENDING_TTL_MS,
  RESEND_COOLDOWN_MS,
  MAX_ATTEMPTS,
  MAX_SENDS,
  get,
  start,
  resend,
  verify,
  markSendFailed,
  cooldownSeconds,
  editValues,
  codeHmac,
};
