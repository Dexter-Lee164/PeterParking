'use strict';

/**
 * Database command line:  node src/db/cli.js init | seed | reset
 *   init  – create the SQLite file and apply migrations
 *   seed  – add demo data (only when no users exist yet)
 *   reset – delete the database file, re-create it and load demo data
 *   lots  – add the planned parking slots to an existing database (src/db/lotPlans.js); keeps users and bookings
 */
const fs = require('fs');
const config = require('../config');
const { openDatabase } = require('./index');
const ctx = require('./context');
const seed = require('./seed');
const lotPlans = require('./lotPlans');

const command = process.argv[2];

function removeDbFiles() {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${config.databasePath}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

if (!['init', 'seed', 'reset', 'lots'].includes(command)) {
  console.error('Usage: node src/db/cli.js <init|seed|reset|lots>');
  process.exit(1);
}

if (command === 'reset') {
  if (config.isProduction) {
    console.error('Refusing to reset the database when NODE_ENV=production.');
    process.exit(1);
  }
  removeDbFiles();
}

const db = openDatabase(config.databasePath);
ctx.set(db);

if (command === 'lots') {
  lotPlans.applyPlans(db).forEach((line) => console.log(line));
} else if (command === 'init') {
  const created = seed.ensureAdminFromEnv(db);
  console.log(`Database ready at ${config.databasePath}${created ? ' (administrator created from ADMIN_EMAIL / ADMIN_PASSWORD)' : ''}.`);
} else {
  if (!seed.isEmpty(db)) {
    console.log('The database already contains users, so demo data was not added. Use "npm run db:reset" for a fresh demo database.');
  } else {
    seed.seedDemoData(db);
    console.log('Demo data loaded.');
    console.log(`  Admin : ${seed.DEMO_CREDENTIALS.admin.email} / ${seed.DEMO_CREDENTIALS.admin.password}`);
    console.log(`  Driver: ${seed.DEMO_CREDENTIALS.driver.email} / ${seed.DEMO_CREDENTIALS.driver.password}`);
  }
}
db.close();
