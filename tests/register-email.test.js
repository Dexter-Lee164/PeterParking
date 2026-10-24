'use strict';

/**
 * Phase 1 on the real routes: the e-mail rules and the DNS check applied by POST /register, the "Did you mean ...?"
 * markup, existing accounts staying usable, and the logo being a plain label on every auth screen.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const bcrypt = require('bcryptjs');
const { startApp, PASSWORD, signUp } = require('./helpers');
const config = require('../src/config');
const users = require('../src/services/users');
const emailUtil = require('../src/utils/email');

const form = (email, extra = {}) => Object.assign({ full_name: 'Test Person', email, password: PASSWORD, confirm_password: PASSWORD }, extra);
const countUsers = (db) => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
};
/** The register pane's markup (everything from its opening tag to the next pane/overlay). */
function pane(html, name) {
  const start = html.indexOf(`data-auth-pane="${name}"`);
  assert.notEqual(start, -1);
  const tail = html.slice(start + 1);
  const next = tail.search(/<section class="auth-pane |<aside class="auth-overlay"|<div class="visually-hidden" role="status"/);
  return next === -1 ? tail : tail.slice(0, next);
}

describe('POST /register: address rules', () => {
  let env;
  before(async () => {
    env = await startApp({ fixture: 'minimal', now: '2026-03-10 09:00' });
  });
  after(async () => env.stop());

  const rejected = [
    ['hehe!@gmail.com.com', /looks mistyped/],
    ['gmail.com.com', /like name@example\.com/],
    ['hehe@gmial.com', /looks mistyped/],
    ['a..b@gmail.com', /dot can&#39;t be first, last or doubled/],
    ['my_name@gmail.com', /Gmail addresses use only letters, numbers and periods/],
    ['user@@x.com', /exactly one @/],
  ];

  for (const [email, message] of rejected) {
    test(`rejects ${email} with a helpful message and creates nothing`, async () => {
      const c = env.client();
      await c.get('/register');
      const before = countUsers(env.db);
      const res = await c.post('/register', form(email));
      assert.equal(res.status, 422);
      assert.match(pane(res.text, 'register'), message);
      assert.equal(countUsers(env.db), before);
      assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM pending_registrations').get().n, 0);
    });
  }

  test('a mistyped provider gets a "Did you mean ...?" suggestion, already open in the server-rendered page', async () => {
    const c = env.client();
    await c.get('/register');
    const res = await c.post('/register', form('hehe!@gmail.com.com'));
    const rp = pane(res.text, 'register');
    assert.match(rp, /class="auth-suggest is-open" data-auth-suggest/);
    assert.match(rp, /Did you mean <strong data-suggest-value>hehe@gmail\.com<\/strong>\?/);
    assert.match(rp, /data-suggest-apply hidden aria-label="Use hehe@gmail\.com"/, 'the fix button exists (JS reveals it)');
    // a different kind of error shows no suggestion
    const other = await c.post('/register', form('a..b@gmail.com'));
    assert.match(pane(other.text, 'register'), /class="auth-suggest" data-auth-suggest/);
    assert.doesNotMatch(pane(other.text, 'register'), /Did you mean/);
  });

  test('a mixed-case address is accepted and stored in lower case; sign-in is case-insensitive', async () => {
    const c = env.client();
    const { res, verify } = await signUp(c, form('  Newer.Person@Example.Test '));
    assert.equal(res.status, 303);
    assert.equal(verify.status, 303);
    assert.equal(env.db.prepare('SELECT email FROM users WHERE id = (SELECT MAX(id) FROM users)').get().email, 'newer.person@example.test');
    const again = env.client();
    assert.equal((await again.login('NEWER.person@example.TEST')).status, 302);
  });

  test('uniqueness ignores case', async () => {
    const c = env.client();
    await c.get('/register');
    const res = await c.post('/register', form('ALICE@Test.Local'));
    assert.equal(res.status, 422);
    assert.match(pane(res.text, 'register'), /That email is already registered\./);
  });

  test('the sign-up server rules and the browser file are one and the same module', () => {
    assert.equal(emailUtil.rules, require('../public/js/email-rules'));
  });

  test('the file works as a plain browser script and agrees with Node', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'email-rules.js'), 'utf8');
    const sandbox = {};
    sandbox.self = sandbox;
    vm.runInNewContext(source, sandbox); // no `module`, like a <script> tag
    assert.equal(typeof sandbox.EmailRules.validate, 'function');
    for (const value of ['hehe!@gmail.com.com', 'a..b@gmail.com', 'Hehe@Gmail.com', 'my_name@gmail.com', 'user@@x.com', 'gmial.com', 'x@yahoo.com.ph']) {
      const here = emailUtil.rules.validate(value);
      const there = sandbox.EmailRules.validate(value);
      assert.deepEqual({ ok: there.ok, code: there.code, message: there.message, suggestion: there.suggestion, email: there.email }, { ok: here.ok, code: here.code, message: here.message, suggestion: here.suggestion, email: here.email }, value);
    }
  });
});

describe('POST /register: DNS deliverability', () => {
  let env;
  let asked;
  before(async () => {
    env = await startApp({ fixture: 'minimal', now: '2026-03-10 09:00' });
    config.emailDnsCheck = true; // off by default under test; switched on here with a stub resolver (no network)
    asked = [];
    emailUtil.setDomainChecker({
      check: async (domain) => {
        asked.push(domain);
        return { 'ghost.example': 'none', 'slow.example': 'unknown' }[domain] || 'ok';
      },
    });
  });
  after(async () => {
    config.emailDnsCheck = false;
    emailUtil.setDomainChecker(null);
    await env.stop();
  });

  test('a domain with no mail server is rejected with its name in the message', async () => {
    const c = env.client();
    await c.get('/register');
    const before = countUsers(env.db);
    const res = await c.post('/register', form('someone@ghost.example'));
    assert.equal(res.status, 422);
    assert.match(pane(res.text, 'register'), /We could not find a mail server for &#34;ghost\.example&#34;/);
    assert.equal(countUsers(env.db), before);
  });

  test('a lookup that timed out or failed does not block the sign-up', async () => {
    const c = env.client();
    await c.get('/register');
    assert.equal((await c.post('/register', form('someone@slow.example'))).location, '/register/verify');
  });

  test('a normal domain passes', async () => {
    const c = env.client();
    await c.get('/register');
    assert.equal((await c.post('/register', form('someone@fine.example'))).location, '/register/verify');
  });

  test('DNS is not consulted for an address the format rules already reject, or for a taken one', async () => {
    const c = env.client();
    await c.get('/register');
    asked.length = 0;
    await c.post('/register', form('a..b@ghost.example'));
    assert.deepEqual(asked, []);
  });

  test('a taken address is reported as taken, not as a DNS problem', async () => {
    const c = env.client();
    await c.get('/register');
    // alice@test.local is registered; make the checker say "none" for it — "taken" must still win.
    emailUtil.setDomainChecker({ check: async () => 'none' });
    const res = await c.post('/register', form('alice@test.local'));
    assert.match(pane(res.text, 'register'), /already registered/);
    assert.doesNotMatch(pane(res.text, 'register'), /mail server/);
  });
});

describe('existing accounts keep working', () => {
  let env;
  before(async () => {
    env = await startApp({ fixture: 'minimal', now: '2026-03-10 09:00' });
  });
  after(async () => env.stop());

  test('an account whose address the new rules would reject can still sign in and be re-saved by an administrator', async () => {
    // created under the older, looser rules: an underscore at Gmail, and mixed case
    const hash = bcrypt.hashSync(PASSWORD, 4);
    const { lastInsertRowid: id } = env.db
      .prepare(`INSERT INTO users (full_name, email, password_hash, role, email_verified) VALUES ('Old Timer', 'Old_Timer@gmail.com', ?, 'driver', 1)`)
      .run(hash);
    assert.equal(emailUtil.rules.validate('Old_Timer@gmail.com').ok, false);

    const c = env.client();
    const res = await c.login('old_timer@gmail.com');
    assert.equal(res.status, 302, 'sign-in does not apply the strict address rules');

    // an administrator saving other fields of that account is not blocked by its (unchanged) address
    assert.doesNotThrow(() => users.adminUpdateUser(id, { full_name: 'Old Timer Jr', email: 'old_timer@gmail.com', role: 'driver', is_active: '1' }, env.data.admin.id));
    assert.equal(env.db.prepare('SELECT full_name FROM users WHERE id = ?').get(id).full_name, 'Old Timer Jr');
    // but changing it to another invalid address is
    assert.throws(() => users.adminUpdateUser(id, { full_name: 'Old Timer Jr', email: 'other_one@gmail.com', role: 'driver', is_active: '1' }, env.data.admin.id), /correct the highlighted fields/);
  });

  test('the demo and minimal accounts still sign in (roles unchanged)', async () => {
    const admin = env.client();
    assert.equal((await admin.login('admin@test.local')).location, '/admin');
    const driver = env.client();
    assert.equal((await driver.login('alice@test.local')).location, '/driver');
  });
});

describe('the logo is a label, not a control', () => {
  let env;
  before(async () => {
    env = await startApp({ fixture: 'minimal', now: '2026-03-10 09:00' });
  });
  after(async () => env.stop());

  async function screens() {
    const c = env.client();
    const out = {};
    out.login = (await c.get('/login')).text;
    out.register = (await c.get('/register')).text;
    out.loginFailed = (await c.post('/login', { email: 'alice@test.local', password: 'wrong-pass-1' })).text;
    out.registerFailed = (await c.post('/register', form('not-an-email'))).text;
    return out;
  }

  test('on every auth screen both logos (mobile header and overlay) are plain divs: no link, no button, no tabindex, not draggable', async () => {
    for (const [name, html] of Object.entries(await screens())) {
      const brands = [...html.matchAll(/<(\w+)\b([^>]*\sclass="(?:[^"]*\s)?brand(?:\s[^"]*)?"[^>]*)>/g)];
      assert.equal(brands.length, 2, `${name}: two logos`);
      for (const [, tag, attrs] of brands) {
        assert.equal(tag, 'div', `${name}: the logo is a ${tag}`);
        assert.doesNotMatch(attrs, /\b(href|tabindex|role|onclick|draggable="true")\b/, `${name}: ${attrs}`);
        assert.match(attrs, /auth-brand/);
      }
      assert.doesNotMatch(html, /<a\b[^>]*>\s*<span class="brand-mark"/, `${name}: no anchor wraps the mark`);
      assert.doesNotMatch(html, /<a\b[^>]*\sclass="(?:[^"]*\s)?brand(?:\s[^"]*)?"/, `${name}: no anchor has the brand class`);
    }
  });

  test('the only links in the card are the switch and the forgot-password steps (never the logo)', async () => {
    const login = (await env.client().get('/login')).text;
    const card = login.slice(login.indexOf('data-auth-card'), login.indexOf('</main>'));
    const hrefs = [...card.matchAll(/<a\b[^>]*\shref="([^"]*)"/g)].map((m) => m[1]);
    assert.ok(hrefs.every((h) => ['/login', '/register', '/forgot-password'].includes(h)), `unexpected links: ${hrefs}`);
    assert.ok(!/<a\b[^>]*\sclass="(?:[^"]*\s)?brand(?:\s[^"]*)?"/.test(card));
  });

  test('the stylesheet gives the logo no pointer cursor and no hover or focus state', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'auth.css'), 'utf8');
    const rule = /\.auth-brand\s*\{([^}]*)\}/.exec(css);
    assert.ok(rule, '.auth-brand rule present');
    assert.match(rule[1], /cursor:\s*default/);
    assert.doesNotMatch(css, /\.auth-brand:(hover|focus|active)/);
    assert.doesNotMatch(css, /\.auth-brand[^{]*\{[^}]*cursor:\s*pointer/);
  });
});

describe('page wiring', () => {
  let env;
  before(async () => {
    env = await startApp({ fixture: 'minimal', now: '2026-03-10 09:00' });
  });
  after(async () => env.stop());

  test('the suggestion exists only on the sign-up e-mail field, closed until needed', async () => {
    const res = await env.client().get('/register');
    assert.equal((res.text.match(/data-auth-suggest/g) || []).length, 1);
    assert.match(pane(res.text, 'register'), /data-auth-suggest/);
    assert.doesNotMatch(pane(res.text, 'login'), /data-auth-suggest/);
    assert.doesNotMatch(res.text, /is-open/);
    const input = /<input\b[^>]*id="register-email"[^>]*>/.exec(res.text)[0];
    assert.match(attr(input, 'aria-describedby'), /register-email-error register-email-suggest-text/);
  });

  test('the shared rules file is served and loads before auth.js (script-src self, no inline script)', async () => {
    const res = await env.client().get('/register');
    // Local assets carry a ?v=<modified time> stamp (cache-busting).
    const rules = res.text.search(/<script src="\/js\/email-rules\.js(\?v=\w+)?"><\/script>/);
    const auth = res.text.search(/<script src="\/js\/auth\.js(\?v=\w+)?"><\/script>/);
    assert.ok(rules > 0 && auth > rules);
    const js = await env.client().get('/js/email-rules.js');
    assert.equal(js.status, 200);
    assert.match(js.type, /javascript/);
  });
});
