'use strict';

const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ quiet: true });

const rootDir = path.resolve(__dirname, '..');

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** "http://127.0.0.1:3000/anything" -> "http://127.0.0.1:3000" (origin only), or '' when it is not an http(s) URL. */
function originOf(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : '';
  } catch {
    return '';
  }
}

const env = process.env.NODE_ENV || 'development';
const isProduction = env === 'production';
const host = process.env.HOST || '127.0.0.1';
const port = int(process.env.PORT, 3000);

const rawBaseUrl = (process.env.APP_BASE_URL || '').trim();
const defaultBaseUrl = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;

const rawMailMode = String(process.env.MAIL_MODE || (isProduction ? 'smtp' : 'console')).trim().toLowerCase();
const smtpPort = int(process.env.SMTP_PORT, 587);

const config = {
  env,
  isProduction,
  isTest: env === 'test',
  rootDir,
  port,
  host,
  timezone: process.env.APP_TIMEZONE || 'Asia/Manila',
  databasePath: path.resolve(rootDir, process.env.DATABASE_PATH || 'data/parking.sqlite'),
  sessionSecret: process.env.SESSION_SECRET || '',
  sessionMaxAgeHours: int(process.env.SESSION_MAX_AGE_HOURS, 8),
  cookieSecure: bool(process.env.COOKIE_SECURE, false),
  trustProxy: bool(process.env.TRUST_PROXY, false),
  loginRateLimit: {
    windowMs: int(process.env.LOGIN_RATE_WINDOW_MINUTES, 15) * 60 * 1000,
    max: int(process.env.LOGIN_RATE_MAX_ATTEMPTS, 10),
  },
  // Demo data (with publicly documented passwords) is on by default only outside production.
  seedDemoData: bool(process.env.SEED_DEMO_DATA, env !== 'production'),
  bcryptRounds: int(process.env.BCRYPT_ROUNDS, 10),
  adminEmail: process.env.ADMIN_EMAIL || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  noShowSweepSeconds: int(process.env.NO_SHOW_SWEEP_SECONDS, 60),

  // ---- public address: every link inside an e-mail is built from this, never from the request's Host header
  appBaseUrl: originOf(rawBaseUrl || defaultBaseUrl),
  appBaseUrlRaw: rawBaseUrl,

  // ---- secret used to HMAC verification codes (never stored in clear)
  authCodeSecret: process.env.AUTH_CODE_SECRET || '',

  // ---- e-mail address checks
  // Ask DNS whether the domain of a new sign-up can receive mail. Off in tests (no network); on elsewhere.
  emailDnsCheck: bool(process.env.EMAIL_DNS_CHECK, env !== 'test'),

  // ---- outgoing mail
  mail: {
    mode: rawMailMode, // 'console' (print to the terminal) | 'smtp' | 'brevo' (Brevo's HTTPS API)
    host: (process.env.SMTP_HOST || '').trim(),
    port: smtpPort,
    user: (process.env.SMTP_USER || '').trim(),
    pass: process.env.SMTP_PASS || '',
    from: (process.env.MAIL_FROM || '').trim(),
    brevoApiKey: (process.env.BREVO_API_KEY || '').trim(),
  },
};

/** Absolute URL on this site, built only from APP_BASE_URL: config.url('/reset-password', { token }) */
config.url = function url(pathname = '/', query = null) {
  const target = new URL(pathname, `${config.appBaseUrl}/`);
  if (query) for (const [k, v] of Object.entries(query)) target.searchParams.set(k, String(v));
  return target.toString();
};

/**
 * Resolve the session secret. A missing secret is a hard error in production;
 * in development/test we generate an ephemeral random one so nothing insecure
 * (and nothing hard-coded) ships with the project.
 */
config.resolveSessionSecret = function resolveSessionSecret() {
  if (config.sessionSecret && config.sessionSecret.length >= 16) return config.sessionSecret;
  if (config.isProduction) {
    throw new Error('SESSION_SECRET must be set (at least 16 characters) when NODE_ENV=production.');
  }
  return crypto.randomBytes(32).toString('hex');
};

let ephemeralCodeSecret = null;

/**
 * Secret for HMAC-SHA256 over verification codes. Required in production (32+ characters). Elsewhere it is derived
 * from SESSION_SECRET when that is set, otherwise random for this process — nothing is hard-coded.
 */
config.resolveAuthCodeSecret = function resolveAuthCodeSecret() {
  if (config.authCodeSecret && config.authCodeSecret.length >= 32) return config.authCodeSecret;
  if (config.isProduction) {
    throw new Error('AUTH_CODE_SECRET must be set (at least 32 characters) when NODE_ENV=production.');
  }
  if (config.sessionSecret && config.sessionSecret.length >= 16) {
    return crypto.createHmac('sha256', config.sessionSecret).update('university-parking:auth-code:v1').digest('hex');
  }
  if (!ephemeralCodeSecret) ephemeralCodeSecret = crypto.randomBytes(32).toString('hex');
  return ephemeralCodeSecret;
};

/** Everything that is wrong with the current configuration, as readable sentences ([] when fine). */
config.problems = function problems() {
  const out = [];
  if (!config.appBaseUrl) {
    out.push(`APP_BASE_URL is not a valid http(s) address${rawBaseUrl ? ` ("${rawBaseUrl}")` : ''}. Example: http://127.0.0.1:${port}`);
  }
  if (!['console', 'smtp', 'brevo'].includes(config.mail.mode)) {
    out.push(`MAIL_MODE must be "console", "smtp" or "brevo" (got "${config.mail.mode}").`);
  }
  if (config.isProduction) {
    if (!rawBaseUrl) out.push('APP_BASE_URL must be set when NODE_ENV=production (the public address of the site).');
    const loopback = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(config.appBaseUrl);
    if (config.appBaseUrl && !config.appBaseUrl.startsWith('https://') && !loopback) {
      out.push('APP_BASE_URL must start with https:// when NODE_ENV=production (reset links carry secrets).');
    }
    if (config.mail.mode === 'console') {
      out.push('MAIL_MODE=console is not allowed when NODE_ENV=production. Use MAIL_MODE=smtp or MAIL_MODE=brevo.');
    }
    if (config.authCodeSecret.length < 32) out.push('AUTH_CODE_SECRET must be set (at least 32 characters) when NODE_ENV=production.');
  }
  if (config.mail.mode === 'smtp') {
    for (const [key, value] of [['SMTP_HOST', config.mail.host], ['SMTP_USER', config.mail.user], ['SMTP_PASS', config.mail.pass], ['MAIL_FROM', config.mail.from]]) {
      if (!value) out.push(`${key} must be set when MAIL_MODE=smtp.`);
    }
  }
  if (config.mail.mode === 'brevo') {
    if (!config.mail.brevoApiKey) out.push('BREVO_API_KEY must be set when MAIL_MODE=brevo.');
    if (!/[^\s<>@]+@[^\s<>@]+/.test(config.mail.from)) {
      out.push('MAIL_FROM must be set when MAIL_MODE=brevo, to a sender verified in Brevo, e.g. University Parking <you@gmail.com>.');
    }
  }
  return out;
};

/** Fail fast at start-up (server.js). Tests and the database CLI do not call this. */
config.assertReady = function assertReady() {
  config.resolveSessionSecret();
  const problems = config.problems();
  if (problems.length) {
    throw new Error(`Configuration problem${problems.length > 1 ? 's' : ''}:\n  - ${problems.join('\n  - ')}`);
  }
};

module.exports = config;
