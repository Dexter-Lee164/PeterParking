'use strict';
// Usage: node src/db/init.js [--reset] [--seed]
const fs = require('fs');
const config = require('../config/env');

const args = new Set(process.argv.slice(2));
if (args.has('--reset') && config.dbPath !== ':memory:') {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.rmSync(config.dbPath + suffix); } catch { /* not present */ } }
  console.log('Removed existing database.');
}
const { db } = require('./index'); // opening the connection applies pending migrations
console.log(`Database ready at ${config.dbPath}`);
if (args.has('--seed')) {
  const { seed } = require('./seed');
  const r = seed(db);
  if (r.skipped) console.log('Seed skipped: an administrator already exists. Use `npm run db:reset` to start over.');
  else console.log(`Seeded. Admin: ${r.admin} | Drivers: ${r.drivers.join(', ')} (passwords come from .env or the defaults in the README).`);
}
db.close();
