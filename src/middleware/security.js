'use strict';

const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const config = require('../config');

/** Security headers. No inline scripts are used anywhere, so script-src stays 'self'. */
function securityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    hsts: config.isProduction && config.cookieSecure,
    crossOriginEmbedderPolicy: false,
  });
}

/**
 * Session-bound CSRF protection (synchronizer token). The token is rendered in every
 * form as `_csrf` and in a <meta> tag for fetch() calls (X-CSRF-Token header).
 */
function csrf(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const sent = String((req.body && req.body._csrf) || req.get('x-csrf-token') || '');
  const expected = req.session.csrfToken;
  const a = Buffer.from(sent);
  const b = Buffer.from(expected);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();

  const err = new Error('Your session expired or the form was invalid. Please go back, refresh the page and try again.');
  err.status = 403;
  err.code = 'CSRF';
  return next(err);
}

/** Throttle login attempts per IP address. */
function loginLimiter(options = config.loginRateLimit) {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: (req, res) => {
      res.status(429);
      if (req.accepts('html')) {
        return res.view('auth/login', {
          layout: 'auth',
          title: 'Sign in',
          values: { email: (req.body && req.body.email) || '' },
          errors: {},
          formError: 'Too many failed sign-in attempts. Please wait a few minutes and try again.',
        });
      }
      return res.json({ error: 'Too many attempts' });
    },
  });
}

module.exports = { securityHeaders, csrf, loginLimiter };
