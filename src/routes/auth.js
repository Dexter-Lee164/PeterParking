'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const users = require('../services/users');
const audit = require('../services/audit');
const registration = require('../services/registration');
const passwordReset = require('../services/passwordReset');
const { getMailer, failureReason } = require('../services/mail');
const security = require('../middleware/security');
const config = require('../config');
const { AppError } = require('../utils/errors');
const { deliverabilityProblem, rules: emailRules } = require('../utils/email');
const { clean, isEmail } = require('../utils/validate');
const { clock } = require('../utils/time');
const { homeFor } = require('../utils/navigation');

/** Where a new driver lands: they cannot book until a vehicle is on file. */
const NEW_DRIVER_HOME = '/driver/vehicles';

/** Rate limits per IP address (login keeps its own, configurable limiter). See README "Rate limits". */
const DEFAULT_LIMITS = {
  register: { windowMs: 60 * 60 * 1000, limit: 30 },
  verify: { windowMs: 15 * 60 * 1000, limit: 30 },
  resend: { windowMs: 60 * 60 * 1000, limit: 10 },
  forgot: { windowMs: 15 * 60 * 1000, limit: 10 },
  reset: { windowMs: 15 * 60 * 1000, limit: 10 },
};

/** Fixed banner texts for /login?notice=... (the query only picks one; nothing from it is echoed). */
const NOTICES = {
  'password-updated': { tone: 'success', text: 'Password updated. Sign in with your new password.' },
  'signup-expired': { tone: 'danger', text: 'Your sign-up expired before it was confirmed. Please fill in the form again.' },
  'signup-taken': { tone: 'danger', text: 'An account with this email was created in the meantime. Sign in, or use "Forgot password?".' },
};

const VERIFY_MESSAGES = {
  wrong: (n) => `That code isn't right. You have ${n} ${n === 1 ? 'try' : 'tries'} left.`,
  expired: 'This code has expired. Send a new code to continue.',
  locked: 'Too many incorrect tries, so this code no longer works. Send a new code to continue.',
  format: 'Enter the 6-digit code from the email.',
  rate: 'Too many tries from this network. Please wait a few minutes and try again.',
};

const TITLES = {
  signin: 'Sign in',
  forgot: 'Reset your password',
  sent: 'Check your email',
  reset: 'Choose a new password',
  'reset-invalid': 'Link expired',
  form: 'Create account',
  verify: 'Check your email',
};

/** Only allow same-site relative redirects after login. */
function safeReturnTo(value, role) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  const area = role === 'admin' ? '/admin' : '/driver';
  return value === area || value.startsWith(`${area}/`) ? value : null;
}

function startSession(req, user, cb) {
  // Regenerate the session id on every sign-in to prevent session fixation.
  const returnTo = req.session.returnTo;
  req.session.regenerate((err) => {
    if (err) return cb(err);
    req.session.userId = user.id;
    req.session.authAt = clock.now().toISOString(); // compared with users.password_changed_at on every request
    req.session.returnTo = returnTo;
    return req.session.save(cb);
  });
}

function landing(req, user) {
  const target = safeReturnTo(req.session.returnTo, user.role) || homeFor(user.role);
  delete req.session.returnTo;
  return target;
}

const wantsJson = (req) => req.accepts(['html', 'json']) === 'json';

/** Render the shared auth card. mode: login | register; step: see TITLES. */
function screen(res, mode, step, data = {}, status) {
  const view = mode === 'register' ? 'auth/register' : 'auth/login';
  const locals = Object.assign({ layout: 'auth', title: TITLES[step], mode, step, values: {}, errors: {}, formError: null }, data);
  return res.view(view, locals, status);
}

function verifyLocals(req, row, extra = {}) {
  const notice = req.session.verifyNotice || null;
  delete req.session.verifyNotice;
  return Object.assign(
    {
      verify: { email: row.email, cooldown: registration.cooldownSeconds(row), error: '', state: '' },
      notice,
      values: registration.editValues(row),
    },
    extra,
  );
}

module.exports = function authRoutes({ loginRateLimit, limits = {} } = {}) {
  const router = express.Router();
  const mailer = () => getMailer();
  const lim = Object.assign({}, DEFAULT_LIMITS, limits);


  function limiter(name, onLimit) {
    return rateLimit({ windowMs: lim[name].windowMs, limit: lim[name].limit, standardHeaders: 'draft-7', legacyHeaders: false, handler: onLimit });
  }

  const registerLimiter = limiter('register', (req, res) =>
    screen(res, 'register', 'form', { values: safeValues(req.body), formError: 'Too many sign-up attempts. Please try again later.' }, 429));
  const verifyLimiter = limiter('verify', (req, res) => {
    if (wantsJson(req)) return res.status(429).json({ ok: false, state: 'rate', message: VERIFY_MESSAGES.rate });
    req.session.verifyNotice = { tone: 'danger', text: VERIFY_MESSAGES.rate };
    return res.redirect(303, '/register/verify');
  });
  const resendLimiter = limiter('resend', (req, res) => {
    req.session.verifyNotice = { tone: 'danger', text: 'Too many codes requested from this network. Please try again later.' };
    return res.redirect(303, '/register/verify');
  });
  const forgotLimiter = limiter('forgot', (req, res) =>
    screen(res, 'login', 'forgot', { forgot: { email: clean((req.body || {}).email), error: 'Too many requests. Please wait a few minutes and try again.' } }, 429));
  const resetLimiter = limiter('reset', (req, res) =>
    screen(res, 'login', 'reset', { reset: { email: '', errors: {} }, formError: 'Too many attempts. Please wait a few minutes and try again.' }, 429));

  function safeValues(body) {
    const safe = Object.assign({}, body || {});
    delete safe.password;
    delete safe.confirm_password;
    delete safe._csrf;
    return safe;
  }

  /* ------------------------------------------------------------------ sign in / out */

  router.get('/login', (req, res) => {
    if (req.user) return res.redirect(homeFor(req.user.role));
    const notice = NOTICES[String(req.query.notice || '')] || null;
    return screen(res, 'login', 'signin', { values: { email: '' }, notice });
  });

  router.post('/login', security.loginLimiter(loginRateLimit), (req, res, next) => {
    const { email, password } = req.body || {};
    const result = users.authenticate(email, password);
    if (result.error) {
      audit.log(null, 'auth.login_failed', 'user', null, { email: String(email || '').slice(0, 120) }, req.ip);
      return screen(res, 'login', 'signin', { values: { email: String(email || '') }, formError: result.error }, 401);
    }
    return startSession(req, result.user, (err) => {
      if (err) return next(err);
      audit.log(result.user.id, 'auth.login', 'user', result.user.id, null, req.ip);
      return res.redirect(landing(req, result.user));
    });
  });

  router.post('/logout', (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    const userId = req.user.id;
    const ip = req.ip;
    return req.session.destroy((err) => {
      if (err) return next(err);
      audit.log(userId, 'auth.logout', 'user', userId, null, ip);
      res.clearCookie('up.sid');
      return res.redirect('/login');
    });
  });

  /* ------------------------------------------------------------------ sign up with an e-mailed code */

  router.get('/register', (req, res) => {
    if (req.user) return res.redirect(homeFor(req.user.role));
    const notice = NOTICES[String(req.query.notice || '')] || null;
    return screen(res, 'register', 'form', { notice });
  });

  router.post('/register', registerLimiter, async (req, res, next) => {
    try {
      // Server-only DNS check (can the domain receive mail?). A lookup that times out or errors never blocks anyone.
      const emailProblem = await deliverabilityProblem((req.body || {}).email);
      const { pending, code } = registration.start(req.body || {}, { pendingId: req.session.pendingId, emailProblem });
      req.session.pendingId = pending.id;
      if (code) await sendCode(req, pending, code);
      return res.redirect(303, '/register/verify');
    } catch (err) {
      if (err instanceof AppError && err.fields) {
        return screen(res, 'register', 'form', {
          values: safeValues(req.body),
          errors: err.fields,
          emailTaken: err.fields.email === emailRules.MESSAGES.taken,
        }, 422);
      }
      return next(err);
    }
  });

  async function sendCode(req, pending, code) {
    try {
      await mailer().sendTemplate('verificationCode', {
        to: pending.email,
        name: pending.name,
        code,
        expiresMinutes: registration.CODE_TTL_MS / 60000,
        expiresAt: pending.expires_at,
      });
      return true;
    } catch (err) {
      registration.markSendFailed(pending.id);
      console.error(`[mail] verification code to @${pending.email.split('@')[1]} was not sent: ${failureReason(err)}`);
      req.session.verifyNotice = { tone: 'danger', text: "We couldn't send the email just now. Press \"Resend code\" to try again." };
      return false;
    }
  }

  router.get('/register/verify', (req, res) => {
    if (req.user) return res.redirect(homeFor(req.user.role));
    const hadPending = Boolean(req.session.pendingId);
    const row = registration.get(req.session.pendingId);
    if (!row) {
      delete req.session.pendingId;
      return res.redirect(hadPending ? '/register?notice=signup-expired' : '/register');
    }
    return screen(res, 'register', 'verify', verifyLocals(req, row, { enter: 'forward' }));
  });

  router.post('/register/verify', verifyLimiter, (req, res, next) => {
    const pendingId = req.session.pendingId;
    const result = registration.verify(pendingId, (req.body || {}).code, req.ip);

    if (result.status === 'gone' || result.status === 'taken') {
      delete req.session.pendingId;
      const redirect = result.status === 'gone' ? '/register?notice=signup-expired' : '/login?notice=signup-taken';
      return wantsJson(req) ? res.status(410).json({ ok: false, state: result.status, redirect }) : res.redirect(303, redirect);
    }

    if (result.status !== 'ok') {
      const message = result.status === 'wrong' ? VERIFY_MESSAGES.wrong(result.attemptsLeft) : VERIFY_MESSAGES[result.status];
      if (wantsJson(req)) return res.status(422).json({ ok: false, state: result.status, message });
      const row = registration.get(pendingId);
      const locals = verifyLocals(req, row);
      locals.verify.error = message;
      locals.verify.state = result.status;
      return screen(res, 'register', 'verify', locals, 422);
    }

    return startSession(req, result.user, (err) => {
      if (err) return next(err);
      req.flash('success', `Welcome, ${result.user.full_name.split(' ')[0]}! Add your vehicle to start reserving parking.`);
      return wantsJson(req) ? res.json({ ok: true, redirect: NEW_DRIVER_HOME }) : res.redirect(303, NEW_DRIVER_HOME);
    });
  });

  router.post('/register/resend', resendLimiter, async (req, res, next) => {
    try {
      const result = registration.resend(req.session.pendingId);
      if (result.status === 'gone') {
        delete req.session.pendingId;
        return res.redirect(303, '/register?notice=signup-expired');
      }
      if (result.status === 'cooldown') {
        req.session.verifyNotice = { tone: 'info', text: `Please wait ${result.seconds} seconds before asking for another code.` };
      } else if (result.status === 'limit') {
        req.session.verifyNotice = { tone: 'danger', text: 'That was the last code we can send for this sign-up. Use it, or fill in the form again in 30 minutes.' };
      } else if (await sendCode(req, result.pending, result.code)) {
        req.session.verifyNotice = { tone: 'success', text: `We sent a new code to ${result.pending.email}. Earlier codes no longer work.` };
      }
      return res.redirect(303, '/register/verify');
    } catch (err) {
      return next(err);
    }
  });

  // "Wrong email? Edit": back to the form with everything but the passwords filled in.
  router.get('/register/edit', (req, res) => {
    if (req.user) return res.redirect(homeFor(req.user.role));
    const row = registration.get(req.session.pendingId);
    if (!row) return res.redirect('/register');
    return screen(res, 'register', 'form', { values: registration.editValues(row), verify: { email: row.email, cooldown: registration.cooldownSeconds(row) }, enter: 'back' });
  });

  /* ------------------------------------------------------------------ forgot / reset password */

  router.get('/forgot-password', (req, res) => {
    if (req.user) return res.redirect(homeFor(req.user.role));
    const sent = req.session.forgotSent || null;
    delete req.session.forgotSent;
    if (sent) return screen(res, 'login', 'sent', { forgot: { email: sent, error: '' }, enter: 'forward' });
    return screen(res, 'login', 'forgot', { forgot: { email: '', error: '' } });
  });

  router.post('/forgot-password', forgotLimiter, (req, res) => {
    const email = clean((req.body || {}).email).toLowerCase();
    // Lenient format check on purpose (the same as sign-in): accounts made under older, looser address rules must be
    // able to reset too.
    if (!email || !isEmail(email)) {
      return screen(res, 'login', 'forgot', { forgot: { email, error: email ? 'Enter a valid email address.' : 'Enter your email address.' } }, 422);
    }
    // A reset link is sent only to a registered, active account.
    const state = passwordReset.accountState(email);
    if (state !== 'ok') {
      const error = state === 'missing'
        ? 'No account is registered with this email address.'
        : 'This account has been deactivated. Please contact the parking office.';
      return screen(res, 'login', 'forgot', { forgot: { email, error } }, 422);
    }
    const ip = req.ip;
    // Send after the response is on its way, so a slow mail server never holds up the page.
    setImmediate(() => {
      try {
        const result = passwordReset.request(email, ip);
        if (!result) return;
        mailer().sendTemplateInBackground('passwordReset', {
          to: result.user.email,
          name: result.user.full_name,
          resetUrl: config.url('/reset-password', { token: result.token }),
          expiresMinutes: passwordReset.TOKEN_TTL_MS / 60000,
          expiresAt: result.expiresAt,
        });
      } catch (err) {
        console.error(`[reset] request failed: ${err.message}`);
      }
    });
    req.session.forgotSent = email;
    return res.redirect(303, '/forgot-password');
  });

  router.get('/reset-password', (req, res) => {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Cache-Control', 'no-store');
    if (typeof req.query.token === 'string' && req.query.token) {
      // Keep only the token's hash, in the session, and take the token out of the address bar and history at once.
      req.session.resetTokenHash = passwordReset.hashToken(req.query.token);
      return req.session.save(() => res.redirect(303, '/reset-password'));
    }
    const row = passwordReset.findValid(req.session.resetTokenHash);
    if (!row) return screen(res, 'login', 'reset-invalid', { flow: 'reset' });
    return screen(res, 'login', 'reset', { reset: { email: row.email, errors: {} } });
  });

  router.post('/reset-password', resetLimiter, (req, res, next) => {
    res.set('Referrer-Policy', 'no-referrer');
    let result;
    try {
      result = passwordReset.complete(req.session.resetTokenHash, req.body || {}, req.ip);
    } catch (err) {
      if (err instanceof AppError && err.fields) {
        const row = passwordReset.findValid(req.session.resetTokenHash);
        return screen(res, 'login', 'reset', { reset: { email: row ? row.email : '', errors: err.fields } }, 422);
      }
      return next(err);
    }
    if (result.status !== 'ok') return screen(res, 'login', 'reset-invalid', {}, 410);

    const user = result.user;
    req.app.locals.sessionStore.destroyUserSessions(user.id);
    mailer().sendTemplateInBackground('passwordChanged', {
      to: user.email,
      name: user.full_name,
      forgotUrl: config.url('/forgot-password'),
      changedAt: new Date(),
    });
    return req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie('up.sid');
      return res.redirect(303, '/login?notice=password-updated');
    });
  });
  return router;
};

module.exports.NOTICES = NOTICES;
module.exports.VERIFY_MESSAGES = VERIFY_MESSAGES;
