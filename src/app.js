'use strict';

const path = require('path');
const express = require('express');
const session = require('express-session');
const config = require('./config');
const SqliteSessionStore = require('./db/sessionStore');
const ctx = require('./db/context');
const security = require('./middleware/security');
const { view, flash } = require('./middleware/view');
const { loadUser } = require('./middleware/auth');
const { notFound, errorHandler } = require('./middleware/errors');
const { requireRole } = require('./middleware/auth');
const { homeFor } = require('./utils/navigation');

/**
 * Build the Express application. The SQLite connection must already be open and
 * registered with db/context (see server.js and tests/helpers).
 */
function createApp({ loginRateLimit, sessionSecret, authLimits } = {}) {
  const db = ctx.get();
  const app = express();

  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  // Views: an array lets nested EJS includes resolve as include('partials/…') from anywhere.
  app.set('view engine', 'ejs');
  app.set('views', [path.join(config.rootDir, 'views')]);

  app.use(security.securityHeaders());

  // Static assets (no session needed). Bootstrap, icons and Chart.js are served from node_modules.
  const nm = path.join(config.rootDir, 'node_modules');
  app.use('/vendor/bootstrap', express.static(path.join(nm, 'bootstrap', 'dist'), { maxAge: '7d' }));
  app.use('/vendor/bootstrap-icons', express.static(path.join(nm, 'bootstrap-icons', 'font'), { maxAge: '7d' }));
  app.use('/vendor/chartjs', express.static(path.join(nm, 'chart.js', 'dist'), { maxAge: '7d' }));
  app.use(express.static(path.join(config.rootDir, 'public'), { maxAge: config.isProduction ? '1d' : 0 }));

  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

  app.use(view);
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(express.json({ limit: '100kb' }));

  const store = new SqliteSessionStore(db, { ttlMs: config.sessionMaxAgeHours * 3600 * 1000 });
  app.locals.sessionStore = store;
  app.use(
    session({
      name: 'up.sid',
      secret: sessionSecret || config.resolveSessionSecret(),
      store,
      resave: false,
      saveUninitialized: false,
      rolling: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.cookieSecure,
        maxAge: config.sessionMaxAgeHours * 3600 * 1000,
      },
    }),
  );

  app.use(flash);
  app.use(loadUser);
  app.use(security.csrf);

  app.get('/', (req, res) => res.redirect(req.user ? homeFor(req.user.role) : '/login'));

  app.use('/', require('./routes/auth')({ loginRateLimit, limits: authLimits }));
  app.use('/driver', requireRole('driver'), require('./routes/driver'));
  app.use('/admin', requireRole('admin'), require('./routes/admin'));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
