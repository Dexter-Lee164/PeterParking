'use strict';
const crypto = require('crypto');
const { AppError } = require('../utils/errors');

/** Session-bound CSRF token, checked on every state-changing request. */
function csrf(req, res, next) {
  if (!req.session) return next(new Error('Session middleware must run before csrf'));
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sent = String((req.body && req.body._csrf) || req.get('x-csrf-token') || '');
  const a = Buffer.from(sent), b = Buffer.from(req.session.csrfToken);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return next(new AppError('Your session expired or the form was invalid. Reload the page and try again.', 403, 'CSRF'));
  next();
}

const requireAuth = (req, res, next) => {
  if (req.session?.user) return next();
  if (req.method === 'GET') req.session.returnTo = req.originalUrl;
  if (req.xhr || req.get('x-requested-with') === 'fetch') return res.status(401).type('text/plain').send('Please sign in again.');
  req.flash('warning', 'Please sign in to continue.');
  return res.redirect('/login');
};
const requireRole = (role) => (req, res, next) => {
  if (!req.session?.user) return requireAuth(req, res, next);
  if (req.session.user.role !== role) return next(new AppError('You do not have access to this page.', 403, 'FORBIDDEN'));
  next();
};

function flash(req, res, next) {
  req.flash = (type, message) => { (req.session.flash ||= []).push({ type, message }); };
  res.locals.flash = req.session?.flash || [];
  if (req.session?.flash) delete req.session.flash;
  next();
}

const actorOf = (req) => ({ id: req.session.user.id, role: req.session.user.role, ip: req.ip });

module.exports = { csrf, requireAuth, requireRole, flash, actorOf };
