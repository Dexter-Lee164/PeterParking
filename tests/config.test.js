'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseEnv } = require('node:util');

const root = path.resolve(__dirname, '..');

test('.env.example parses to the documented development credentials (a bare # would start a comment)', () => {
  const env = parseEnv(fs.readFileSync(path.join(root, '.env.example'), 'utf8'));
  assert.equal(env.SEED_ADMIN_EMAIL, 'admin@university.test');
  assert.equal(env.SEED_ADMIN_PASSWORD, 'Admin#12345');
  assert.equal(env.SEED_DRIVER_PASSWORD, 'Driver#12345');
  assert.equal(env.TZ_OFFSET_MINUTES, '480');
});

test('npm run setup creates a .env with a random secret and keeps the documented defaults loadable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parking-setup-'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(path.join(root, 'scripts', 'setup.js'), path.join(dir, 'scripts', 'setup.js'));
  fs.copyFileSync(path.join(root, '.env.example'), path.join(dir, '.env.example'));
  const out = execFileSync(process.execPath, [path.join(dir, 'scripts', 'setup.js')], { encoding: 'utf8' });
  assert.match(out, /Created \.env/);
  const env = parseEnv(fs.readFileSync(path.join(dir, '.env'), 'utf8'));
  assert.match(env.SESSION_SECRET, /^[a-f0-9]{64}$/);
  assert.equal(env.SEED_DRIVER_PASSWORD, 'Driver#12345');
  const again = execFileSync(process.execPath, [path.join(dir, 'scripts', 'setup.js')], { encoding: 'utf8' });
  assert.match(again, /already exists/, 'never overwrites an existing .env');
});

test('production refuses to start without a strong SESSION_SECRET', () => {
  const run = (secret) => {
    try {
      execFileSync(process.execPath, ['-e', "require('./src/config/env')"], { cwd: root, env: { ...process.env, NODE_ENV: 'production', SESSION_SECRET: secret, DB_PATH: ':memory:' }, stdio: 'pipe' });
      return 0;
    } catch (e) { return e.status; }
  };
  assert.equal(run(''), 1); assert.equal(run('change-me-to-a-long-random-string-at-least-32-chars'), 1); assert.equal(run('short'), 1);
  assert.equal(run('x'.repeat(48)), 0);
});
