'use strict';

/**
 * Configuration defaults on Railway: the public domain Railway assigns becomes the address in e-mail links, the app
 * listens on all interfaces behind Railway's HTTPS proxy, and an attached volume holds the database.
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const KEYS = ['APP_BASE_URL', 'HOST', 'PORT', 'DATABASE_PATH', 'COOKIE_SECURE', 'TRUST_PROXY', 'NODE_ENV', 'MAIL_MODE',
  'RAILWAY_ENVIRONMENT', 'RAILWAY_PROJECT_ID', 'RAILWAY_PUBLIC_DOMAIN', 'RAILWAY_VOLUME_MOUNT_PATH'];

/** Loads src/config.js in a fresh process with exactly these variables (and no .env file from the project folder). */
function configWith(vars) {
  const env = Object.assign({}, process.env);
  for (const k of KEYS) delete env[k];
  Object.assign(env, vars);
  const out = execFileSync(process.execPath, ['-e', `
    const c = require(${JSON.stringify(path.join(ROOT, 'src/config.js'))});
    console.log(JSON.stringify({ host: c.host, port: c.port, appBaseUrl: c.appBaseUrl, link: c.url('/reset-password', { token: 't' }),
      databasePath: c.databasePath, cookieSecure: c.cookieSecure, trustProxy: c.trustProxy, problems: c.problems() }));
  `], { env, cwd: require('os').tmpdir(), encoding: 'utf8' });
  return JSON.parse(out);
}

describe('configuration on Railway', () => {
  test('links use the Railway public domain; the app listens on 0.0.0.0 behind the proxy; the volume holds the database', () => {
    const volume = path.join(require('os').tmpdir(), 'railway-volume');
    const c = configWith({
      NODE_ENV: 'production', MAIL_MODE: 'brevo', PORT: '8080',
      RAILWAY_ENVIRONMENT: 'production', RAILWAY_PUBLIC_DOMAIN: 'peterparking.up.railway.app', RAILWAY_VOLUME_MOUNT_PATH: volume,
    });
    assert.equal(c.appBaseUrl, 'https://peterparking.up.railway.app');
    assert.equal(c.link, 'https://peterparking.up.railway.app/reset-password?token=t');
    assert.equal(c.host, '0.0.0.0');
    assert.equal(c.port, 8080);
    assert.equal(c.cookieSecure, true);
    assert.equal(c.trustProxy, true);
    assert.equal(c.databasePath, path.join(volume, 'parking.sqlite'));
    assert.ok(!c.problems.some((p) => /APP_BASE_URL/.test(p)), 'the Railway domain counts as the public address');
  });

  test('explicit variables still win on Railway', () => {
    const c = configWith({
      RAILWAY_ENVIRONMENT: 'production', RAILWAY_PUBLIC_DOMAIN: 'peterparking.up.railway.app',
      APP_BASE_URL: 'https://parking.example.edu', HOST: '127.0.0.1', DATABASE_PATH: 'data/other.sqlite', COOKIE_SECURE: 'false',
    });
    assert.equal(c.appBaseUrl, 'https://parking.example.edu');
    assert.equal(c.host, '127.0.0.1');
    assert.equal(c.databasePath, path.join(ROOT, 'data', 'other.sqlite'));
    assert.equal(c.cookieSecure, false);
  });

  test('off Railway nothing changes: this computer only, plain http on localhost', () => {
    const c = configWith({});
    assert.equal(c.host, '127.0.0.1');
    assert.equal(c.appBaseUrl, 'http://127.0.0.1:3000');
    assert.equal(c.cookieSecure, false);
    assert.equal(c.trustProxy, false);
    assert.equal(c.databasePath, path.join(ROOT, 'data', 'parking.sqlite'));
  });
});
