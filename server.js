'use strict';

const config = require('./src/config');
const { openDatabase } = require('./src/db');
const ctx = require('./src/db/context');
const seed = require('./src/db/seed');
const reservations = require('./src/services/reservations');

// Fail fast on missing secrets / unsafe settings (production, mail, public address) before touching the database.
try {
  config.assertReady();
  console.log(require('./src/services/mail').getMailer().describe());
} catch (err) {
  console.error(`\nCannot start: ${err.message}\n\nFix this in your .env file (see .env.example), then start again.`);
  process.exit(1);
}

const db = openDatabase(config.databasePath);
ctx.set(db);

// First run: optional administrator from the environment, then optional demo data.
if (seed.isEmpty(db)) {
  if (config.seedDemoData) {
    seed.seedDemoData(db);
    console.log('First run: demo data loaded (see README for development credentials).');
  } else if (seed.ensureAdminFromEnv(db)) {
    console.log('First run: administrator account created from ADMIN_EMAIL / ADMIN_PASSWORD.');
  } else {
    console.warn('No users exist yet. Set ADMIN_EMAIL and ADMIN_PASSWORD in .env, or SEED_DEMO_DATA=true, then restart.');
  }
}

const { createApp } = require('./src/app');
const app = createApp();

const server = app.listen(config.port, config.host, () => {
  console.log(`University Parking running at http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
});

// Close bookings that ended without a vehicle arriving (no-show sweep).
const sweep = setInterval(() => {
  try {
    const n = reservations.sweepNoShows();
    if (n) console.log(`No-show sweep: closed ${n} reservation(s).`);
  } catch (err) {
    console.error('No-show sweep failed:', err.message);
  }
}, config.noShowSweepSeconds * 1000);
sweep.unref();

function shutdown() {
  clearInterval(sweep);
  server.close(() => {
    try {
      app.locals.sessionStore.close();
      db.close();
    } finally {
      process.exit(0);
    }
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
