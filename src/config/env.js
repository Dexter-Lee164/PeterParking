'use strict';
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..', '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch { /* .env is optional */ }

const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';

let sessionSecret = process.env.SESSION_SECRET || '';
const placeholder = !sessionSecret || sessionSecret.startsWith('change-me');
if (placeholder || sessionSecret.length < 32) {
  if (isProd) {
    console.error('FATAL: SESSION_SECRET must be set to a random string of 32+ characters in production.');
    process.exit(1);
  }
  sessionSecret = crypto.randomBytes(32).toString('hex');
  if (env !== 'test') console.warn('[config] SESSION_SECRET not set; using a temporary secret (sessions reset on restart). Run `npm run setup`.');
}

const dbFile = process.env.DB_PATH || 'data/parking.db';

module.exports = {
  root,
  env,
  isProd,
  port: num(process.env.PORT, 3000),
  dbPath: dbFile === ':memory:' ? dbFile : path.resolve(root, dbFile),
  sessionSecret,
  cookieSecure: String(process.env.SESSION_COOKIE_SECURE).toLowerCase() === 'true',
  tzOffsetMinutes: num(process.env.TZ_OFFSET_MINUTES, 480),
  loginRateLimit: {
    max: num(process.env.LOGIN_RATE_LIMIT_MAX, 10),
    windowMs: num(process.env.LOGIN_RATE_LIMIT_WINDOW_MINUTES, 15) * 60 * 1000,
  },
  bcryptRounds: num(process.env.BCRYPT_ROUNDS, 10),
  seed: {
    adminEmail: process.env.SEED_ADMIN_EMAIL || 'admin@university.test',
    adminPassword: process.env.SEED_ADMIN_PASSWORD || 'Admin#12345',
    driverPassword: process.env.SEED_DRIVER_PASSWORD || 'Driver#12345',
  },
};
