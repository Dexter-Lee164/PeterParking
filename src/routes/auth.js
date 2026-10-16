'use strict';
const express = require('express');
const config = require('../config/env');
const users = require('../services/users');
const audit = require('../services/audit');
const { AppError, ValidationError } = require('../utils/errors');

const home = (u) => (u.role === 'admin' ? '/admin/dashboard' : '/driver/dashboard');
const safeReturn = (p) => (typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') && !p.includes('\\') ? p : null);
const regenerate = (req) => new Promise((res, rej) => req.session.regenerate((e) => (e ? rej(e) : res())));

module.exports = ({ rateLimit }) => {
  const r = express.Router();
  const limiter = rateLimit({
    windowMs: config.loginRateLimit.windowMs, limit: config.loginRateLimit.max, standardHeaders: 'draft-8', legacyHeaders: false, skipSuccessfulRequests: true,
    handler: (req, res, next) => next(new AppError('Too many sign-in attempts. Wait a few minutes, then try again.', 429, 'RATE_LIMIT')),
  });

  r.get('/', (req, res) => res.redirect(req.session.user ? home(req.session.user) : '/login'));

  r.get('/login', (req, res) => (req.session.user ? res.redirect(home(req.session.user)) : res.page('auth/login', { title: 'Sign in' })));
  r.post('/login', limiter, async (req, res) => {
    const { user, reason } = await users.authenticate(req.body.email, req.body.password);
    if (!user) {
      audit.log({ id: null, ip: req.ip }, 'auth.login_failed', 'user', null, { email: String(req.body.email || '').slice(0, 80), reason });
      const msg = reason === 'inactive' ? 'This account is inactive. Contact the parking office.' : 'Email or password is incorrect.';
      return res.status(401).page('auth/login', { title: 'Sign in', error: msg, old: { email: req.body.email } });
    }
    const returnTo = safeReturn(req.session.returnTo);
    await regenerate(req);
    req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
    audit.log({ id: user.id, ip: req.ip }, 'auth.login', 'user', user.id);
    res.redirect(returnTo && returnTo.startsWith(user.role === 'admin' ? '/admin' : '/driver') ? returnTo : home(user));
  });

  r.post('/logout', async (req, res) => {
    if (req.session.user) audit.log({ id: req.session.user.id, ip: req.ip }, 'auth.logout', 'user', req.session.user.id);
    req.session.destroy(() => { res.clearCookie('up.sid'); res.redirect('/login'); });
  });

  r.get('/register', (req, res) => (req.session.user ? res.redirect(home(req.session.user)) : res.page('auth/register', { title: 'Create account', driverTypes: users.DRIVER_TYPES })));
  r.post('/register', limiter, async (req, res) => {
    try {
      const user = users.createUser(req.body);
      await regenerate(req);
      req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
      req.flash('success', 'Welcome! Add your vehicle to start booking.');
      res.redirect('/driver/vehicles');
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      res.status(422).page('auth/register', { title: 'Create account', driverTypes: users.DRIVER_TYPES, errors: e.fields, old: { ...req.body, password: '', confirmPassword: '' } });
    }
  });
  return r;
};
