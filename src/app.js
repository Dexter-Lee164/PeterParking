'use strict';
const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const config = require('./config/env');
const { db } = require('./db');
const SqliteStore = require('./db/sessionStore');
const sec = require('./middleware/security');
const H = require('./utils/view-helpers');
const { AppError, ValidationError } = require('./utils/errors');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.isProd) app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', path.join(config.root, 'views'));

  app.use(helmet({
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], styleSrcAttr: ["'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'], fontSrc: ["'self'"], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"],
      formAction: ["'self'"], baseUri: ["'self'"], upgradeInsecureRequests: config.isProd ? [] : null,
    } },
    hsts: config.isProd,
  }));

  const nm = (p) => path.join(config.root, 'node_modules', p);
  app.use('/vendor/bootstrap', express.static(nm('bootstrap/dist')));
  app.use('/vendor/chartjs', express.static(nm('chart.js/dist')));
  app.use(express.static(path.join(config.root, 'public'), { maxAge: config.isProd ? '1h' : 0 }));
  app.use(express.urlencoded({ extended: false, limit: '50kb' }));

  app.use(session({
    name: 'up.sid', secret: config.sessionSecret, resave: false, saveUninitialized: false, rolling: true,
    store: new SqliteStore(db),
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: 1000 * 60 * 60 * 8 },
  }));
  app.use(sec.flash);
  app.use(sec.csrf);

  app.use((req, res, next) => {
    res.locals.h = H;
    res.locals.user = req.session.user || null;
    res.locals.path = req.path;
    res.locals.title = '';
    res.locals.errors = {};
    res.locals.old = {};
    // Render a page inside the shared layout (EJS has no built-in layouts).
    res.page = (view, locals = {}) => {
      app.render(view, { ...res.locals, ...locals }, (err, body) => {
        if (err) return view === 'errors/error' ? res.status(500).type('text/plain').send('Server error') : next(err);
        res.render(view.startsWith('auth/') ? 'layouts/auth' : 'layouts/main', { ...locals, body });
      });
    };
    next();
  });

  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use(require('./routes/auth')({ rateLimit }));
  app.use('/driver', sec.requireRole('driver'), require('./routes/driver'));
  app.use('/admin', sec.requireRole('admin'), require('./routes/admin'));
  app.use('/api', sec.requireAuth, require('./routes/api'));

  app.use((req, res, next) => next(new AppError('Page not found.', 404, 'NOT_FOUND')));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    const message = status >= 500 ? 'Something went wrong on our side. Please try again.' : err.message;
    if (req.get('x-requested-with') === 'fetch') return res.status(status).type('text/plain').send(message);
    if (err instanceof ValidationError && req.session?.user) { req.flash('danger', message); return res.redirect(req.get('referer') || '/'); }
    res.status(status).page('errors/error', { title: status === 404 ? 'Page not found' : 'Something went wrong', status, message });
  });
  return app;
}
module.exports = { createApp };
