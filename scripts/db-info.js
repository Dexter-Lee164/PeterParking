'use strict';

/**
 * Read-only look at the database after the authentication migration. Changes nothing.
 *
 *   node scripts/db-info.js
 */

const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('../src/config');

if (!fs.existsSync(config.databasePath)) {
  console.log(`No database yet at ${config.databasePath}. Start the app once (npm run dev) to create it.`);
  process.exit(0);
}

const db = new Database(config.databasePath, { readonly: true, fileMustExist: true });
const has = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name);

console.log(`Database: ${config.databasePath}\n`);

console.log('Applied migrations:');
for (const row of db.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version').all()) {
  console.log(`  ${String(row.version).padStart(3, '0')}  ${row.name}  (${row.applied_at})`);
}

const columns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
console.log('\nusers columns the sign-in features need:');
for (const name of ['google_id', 'email_verified', 'password_changed_at']) {
  console.log(`  ${name.padEnd(20)} ${columns.includes(name) ? 'present' : 'MISSING (start the app to migrate)'}`);
}

console.log('\nTables / indexes:');
for (const name of ['pending_registrations', 'password_resets', 'ux_users_email_lower', 'ux_users_google_id']) {
  console.log(`  ${name.padEnd(24)} ${has(name) ? 'present' : 'MISSING'}`);
}

if (columns.includes('email_verified')) {
  console.log('\nUsers by role and e-mail verification:');
  for (const row of db.prepare('SELECT role, email_verified AS verified, COUNT(*) AS n FROM users GROUP BY role, email_verified ORDER BY role, verified').all()) {
    console.log(`  ${row.role.padEnd(8)} ${row.verified ? 'verified  ' : 'unverified'} ${row.n}`);
  }
}

const dupes = db.prepare('SELECT lower(email) AS email, COUNT(*) AS n FROM users GROUP BY lower(email) HAVING n > 1').all();
console.log(`\nDuplicate e-mails ignoring case: ${dupes.length ? dupes.map((d) => `${d.email} (${d.n})`).join(', ') : 'none'}`);
if (has('pending_registrations')) console.log(`Pending registrations: ${db.prepare('SELECT COUNT(*) AS n FROM pending_registrations').get().n}`);
if (has('password_resets')) console.log(`Reset tokens on file:  ${db.prepare('SELECT COUNT(*) AS n FROM password_resets').get().n}`);
db.close();
