'use strict';
// Creates .env from .env.example with a fresh random SESSION_SECRET (never overwrites an existing .env).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const target = path.join(root, '.env');
if (fs.existsSync(target)) {
  console.log('.env already exists; leaving it unchanged.');
} else {
  const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(target, example.replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET=${secret}`), { mode: 0o600 });
  console.log('Created .env with a random SESSION_SECRET.');
}
console.log('Next: npm run db:seed   (creates the database with demo data)   then   npm start');
