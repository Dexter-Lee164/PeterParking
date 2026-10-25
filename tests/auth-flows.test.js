'use strict';

/**
 * Sign-up with an e-mailed code and forgot / reset password, on the real routes.
 * Mail is in console mode (tests keep an outbox instead of printing).
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { startApp, setNow, PASSWORD, lastCode } = require('./helpers');
const config = require('../src/config');
const { getMailer } = require('../src/services/mail');

const GENEROUS = { verify: { windowMs: 60000, limit: 1000 }, resend: { windowMs: 60000, limit: 1000 }, forgot: { windowMs: 60000, limit: 1000 }, reset: { windowMs: 60000, limit: 1000 }, register: { windowMs: 60000, limit: 1000 } };
const JSON_ACCEPT = { headers: { Accept: 'application/json' } };
// University IDs are unique, so each sign-up gets its own (U-777, U-778, ...).
let uid = 776;
const form = (email, extra = {}) => {
  uid += 1;
  return Object.assign({ full_name: 'Pat Newdriver', email, password: 'Passw0rd!x', confirm_password: 'Passw0rd!x', university_id: `U-${uid}`, phone: '0917 123 4567' }, extra);
};
const count = (db, sql, ...p) => db.prepare(sql).get(...p).n;
const outboxTo = (to) => getMailer().outbox.filter((m) => m.to === to);
const settle = () => new Promise((resolve) => setTimeout(resolve, 30)); // let setImmediate + the background send run

async function startSignup(c, email, extra) {
  await c.get('/register');
  const res = await c.post('/register', form(email, extra));
  await c.get('/register/verify'); // picks up the CSRF token, like the browser would
  return res;
}

describe('sign-up with a verification code', () => {
  let env;
  before(async () => {
    env = await startApp({ fixture: 'minimal', now: '2026-03-10 09:00', authLimits: GENEROUS });
  });
  after(async () => env.stop());
  beforeEach(() => setNow('2026-03-10 09:00'));

  test('POST /register creates no user, stores only an HMAC of the code, e-mails it, and redirects without the id in the URL', async () => {
    const c = env.client();
    const users = count(env.db, 'SELECT COUNT(*) AS n FROM users');
    const res = await startSignup(c, 'pat.one@example.test');
    assert.equal(res.status, 303);
    assert.equal(res.location, '/register/verify');
    assert.equal(count(env.db, 'SELECT COUNT(*) AS n FROM users'), users, 'no users row before verification');
    const row = env.db.prepare(`SELECT * FROM pending_registrations WHERE email = 'pat.one@example.test'`).get();
    const code = lastCode('pat.one@example.test');
    assert.match(code, /^\d{6}$/);
    assert.match(row.code_hmac, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(row).includes(code), 'the code itself is not stored');
    assert.ok(bcrypt.compareSync('Passw0rd!x', row.password_hash), 'password stored as a bcrypt hash');
    assert.equal(row.send_count, 1);
    const page = await c.get('/register/verify');
    assert.match(page.text, /We sent a 6-digit code to <strong class="auth-email">pat\.one@example\.test<\/strong>\. It expires in 10 minutes\./);
    assert.match(page.text, /autocomplete="one-time-code" inputmode="numeric" pattern="\[0-9\]\*" maxlength="6"/);
    assert.match(page.text, /spam/);
    assert.doesNotMatch(page.text, new RegExp(row.id), 'the pending id never reaches the page');
  });

  test('the right code (with spaces) creates a driver, regenerates the session and signs in', async () => {
    const c = env.client();
    await startSignup(c, 'pat.two@example.test');
    const before = c.cookies.get('up.sid');
    const code = lastCode('pat.two@example.test');
    const res = await c.post('/register/verify', { code: `${code.slice(0, 3)} ${code.slice(3)}` });
    assert.equal(res.status, 303);
    assert.equal(res.location, '/driver/vehicles');
    assert.notEqual(c.cookies.get('up.sid'), before, 'session id rotated');
    const user = env.db.prepare(`SELECT * FROM users WHERE email = 'pat.two@example.test'`).get();
    assert.equal(user.role, 'driver');
    assert.equal(user.email_verified, 1);
    assert.match(user.university_id, /^U-\d+$/);
    assert.equal(count(env.db, `SELECT COUNT(*) AS n FROM pending_registrations WHERE email = 'pat.two@example.test'`), 0);
    assert.equal((await c.get('/driver')).status, 200);
    assert.equal(count(env.db, `SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'auth.registration_verified' AND user_id = ?`, user.id), 1);
  });

  test('JSON answers for the in-page check: wrong (with tries left), then ok', async () => {
    const c = env.client();
    await startSignup(c, 'pat.json@example.test');
    const wrong = await c.post('/register/verify', { code: '000000' === lastCode('pat.json@example.test') ? '111111' : '000000' }, JSON_ACCEPT);
    assert.equal(wrong.status, 422);
    assert.deepEqual(JSON.parse(wrong.text), { ok: false, state: 'wrong', message: "That code isn't right. You have 4 tries left." });
    const ok = await c.post('/register/verify', { code: lastCode('pat.json@example.test') }, JSON_ACCEPT);
    assert.deepEqual(JSON.parse(ok.text), { ok: true, redirect: '/driver/vehicles' });
  });

  test('five wrong codes kill the code (even the right one stops working) until a new one is sent', async () => {
    const c = env.client();
    await startSignup(c, 'pat.three@example.test');
    const code = lastCode('pat.three@example.test');
    const wrongCode = code === '123456' ? '654321' : '123456';
    for (let i = 4; i >= 1; i -= 1) {
      const r = await c.post('/register/verify', { code: wrongCode }, JSON_ACCEPT);
      assert.equal(JSON.parse(r.text).state, 'wrong');
    }
    const fifth = JSON.parse((await c.post('/register/verify', { code: wrongCode }, JSON_ACCEPT)).text);
    assert.equal(fifth.state, 'locked');
    assert.match(fifth.message, /Too many incorrect tries/);
    assert.equal(JSON.parse((await c.post('/register/verify', { code }, JSON_ACCEPT)).text).state, 'locked');
    // HTML (no-JS) version of the same state
    const html = await c.post('/register/verify', { code });
    assert.equal(html.status, 422);
    assert.match(html.text, /Send a new code to continue/);
    assert.match(html.text, /class="auth-link-btn is-emphasis"/);

    setNow('2026-03-10 09:01:05'); // past the 60 s cooldown
    await c.post('/register/resend');
    const fresh = lastCode('pat.three@example.test');
    assert.equal((await c.post('/register/verify', { code: fresh })).location, '/driver/vehicles');
  });

  test('a code expires after 10 minutes', async () => {
    const c = env.client();
    await startSignup(c, 'pat.four@example.test');
    setNow('2026-03-10 09:10:01');
    const r = JSON.parse((await c.post('/register/verify', { code: lastCode('pat.four@example.test') }, JSON_ACCEPT)).text);
    assert.equal(r.state, 'expired');
    assert.equal(r.message, 'This code has expired. Send a new code to continue.');
  });

  test('resend: 60 s cooldown, then a new code that replaces the old one; at most 5 sends', async () => {
    const c = env.client();
    await startSignup(c, 'pat.five@example.test');
    const first = lastCode('pat.five@example.test');
    const early = await c.post('/register/resend');
    assert.equal(early.location, '/register/verify');
    assert.match((await c.get('/register/verify')).text, /Please wait \d+ seconds/);
    assert.equal(outboxTo('pat.five@example.test').length, 1, 'no mail during the cooldown');
    assert.match((await c.get('/register/verify')).text, /data-cooldown="60"/);

    let minute = 1;
    for (let sends = 2; sends <= 5; sends += 1) {
      setNow(`2026-03-10 09:0${minute}:05`);
      minute += 1;
      await c.post('/register/resend');
      assert.equal(outboxTo('pat.five@example.test').length, sends);
    }
    const latest = lastCode('pat.five@example.test');
    setNow(`2026-03-10 09:0${minute}:05`);
    await c.post('/register/resend');
    assert.equal(outboxTo('pat.five@example.test').length, 5, 'the sixth send is refused');
    assert.match((await c.get('/register/verify')).text, /last code we can send/);
    if (first !== latest) {
      assert.equal(JSON.parse((await c.post('/register/verify', { code: first }, JSON_ACCEPT)).text).state, 'wrong', 'old codes stop working');
    }
    assert.equal((await c.post('/register/verify', { code: latest })).location, '/driver/vehicles');
  });

  test('a pending sign-up expires after 30 minutes', async () => {
    const c = env.client();
    await startSignup(c, 'pat.six@example.test');
    setNow('2026-03-10 09:30:01');
    const res = await c.get('/register/verify');
    assert.equal(res.location, '/register?notice=signup-expired');
    assert.equal(count(env.db, `SELECT COUNT(*) AS n FROM pending_registrations WHERE email = 'pat.six@example.test'`), 0, 'purged');
    assert.match((await c.get(res.location)).text, /Your sign-up expired/);
  });

  test('"Wrong email? Edit" refills everything except the passwords; fixing the address moves the sign-up', async () => {
    const c = env.client();
    await startSignup(c, 'pat.typo@example.test');
    const edit = await c.get('/register/edit');
    assert.equal(edit.status, 200);
    assert.match(edit.text, /name="email" type="email"\s+value="pat\.typo@example\.test"/);
    assert.match(edit.text, /name="full_name" type="text"\s+value="Pat Newdriver"/);
    assert.match(edit.text, /name="university_id" type="text"\s+value="U-\d+"/);
    assert.doesNotMatch(edit.text, /name="password" type="password"\s+value="[^"]/);
    const moved = await c.post('/register', form('pat.fixed@example.test'));
    assert.equal(moved.location, '/register/verify');
    assert.equal(count(env.db, `SELECT COUNT(*) AS n FROM pending_registrations WHERE email = 'pat.typo@example.test'`), 0);
    await c.get('/register/verify');
    assert.equal((await c.post('/register/verify', { code: lastCode('pat.fixed@example.test') })).location, '/driver/vehicles');
  });

  test('someone else signing up with the same address cannot take over the first visitor\'s sign-up', async () => {
    const owner = env.client();
    await startSignup(owner, 'pat.race@example.test');
    const other = env.client();
    await other.get('/register');
    const blocked = await other.post('/register', form('pat.race@example.test', { password: 'Other123x', confirm_password: 'Other123x' }));
    assert.equal(blocked.status, 422, 'within the cooldown the address is busy');
    assert.match(blocked.text, /A code was just sent to this address/);

    setNow('2026-03-10 09:01:05');
    await other.get('/register');
    assert.equal((await other.post('/register', form('pat.race@example.test', { password: 'Other123x', confirm_password: 'Other123x' }))).location, '/register/verify');
    // the first session's pending id is gone: its (old) code can no longer create the account
    const r = await owner.post('/register/verify', { code: '000000' });
    assert.equal(r.location, '/register?notice=signup-expired');
  });

  test('an address that already has an account says so and offers Sign in / Forgot password', async () => {
    const c = env.client();
    await c.get('/register');
    const res = await c.post('/register', form('alice@test.local'));
    assert.equal(res.status, 422);
    assert.match(res.text, /That email is already registered\./);
    assert.match(res.text, /class="auth-error-actions">[\s\S]*href="\/login">Sign in<[\s\S]*href="\/forgot-password">Forgot password\?</);
    assert.equal(count(env.db, `SELECT COUNT(*) AS n FROM pending_registrations WHERE email = 'alice@test.local'`), 0);
  });

  test('a code mail that fails to send allows an immediate resend', async () => {
    const mailer = getMailer();
    const original = mailer.sendTemplate;
    mailer.sendTemplate = async () => { throw Object.assign(new Error('boom'), { code: 'ECONNREFUSED' }); };
    const c = env.client();
    try {
      await startSignup(c, 'pat.down@example.test');
    } finally {
      mailer.sendTemplate = original;
    }
    const page = (await c.get('/register/verify')).text;
    assert.match(page, /data-cooldown="0"/);
    await c.post('/register/resend');
    assert.match(lastCode('pat.down@example.test'), /^\d{6}$/);
  });

  test('GET /register/verify without a sign-up in progress goes back to the form', async () => {
    assert.equal((await env.client().get('/register/verify')).location, '/register');
  });
});

describe('forgot / reset password', () => {
  let env;
  before(async () => {
    env = await startApp({ fixture: 'minimal', now: '2026-03-10 09:00', authLimits: GENEROUS });
  });
  after(async () => env.stop());
  beforeEach(() => setNow('2026-03-10 09:00'));

  async function requestLink(c, email) {
    await c.get('/forgot-password');
    const res = await c.post('/forgot-password', { email });
    await settle();
    return res;
  }
  const lastLink = (to) => {
    const msg = [...getMailer().outbox].reverse().find((m) => m.to === to && /Reset your/.test(m.subject));
    return msg ? /^(http\S+reset-password\?token=\S+)$/m.exec(msg.text)[1] : null;
  };

  test('the login page links to /forgot-password below the Sign in button; the route renders the step', async () => {
    const login = (await env.client().get('/login')).text;
    assert.match(login, /<span class="auth-submit-label">Sign in<\/span>[\s\S]*?<\/form>\s*<p class="auth-foot auth-r" style="--i:4"><a class="auth-text-link" href="\/forgot-password" data-auth-goto="forgot">Forgot password\?<\/a><\/p>/);
    const page = await env.client().get('/forgot-password');
    assert.equal(page.status, 200);
    assert.match(page.text, /data-auth-step="forgot"[^>]*>|class="auth-step is-current" data-auth-step="forgot"/);
    assert.match(page.text, /Reset your password/);
    assert.match(page.text, /Send reset link/);
    assert.match(page.text, /Back to sign in/);
  });

  test('a link is sent only to a registered, active account', async () => {
    const a = env.client();
    const ra = await requestLink(a, 'alice@test.local');
    assert.equal(ra.status, 303);
    const pa = (await a.get('/forgot-password')).text;
    assert.match(pa, /We've sent a reset link to <strong class="auth-email">alice@test\.local<\/strong>\. It expires in 30 minutes\./);
    assert.match(pa, /Wrong email\? <a class="auth-text-link" href="\/forgot-password" data-auth-goto="forgot">Edit<\/a>/);
    assert.ok(lastLink('alice@test.local'), 'a link went to the real account');

    const b = env.client();
    const rb = await requestLink(b, 'nobody@test.local');
    assert.equal(rb.status, 422);
    assert.match(rb.text, /No account is registered with this email address\./);
    assert.equal(outboxTo('nobody@test.local').length, 0);

    env.db.prepare(`INSERT INTO users (full_name, email, password_hash, role, is_active, email_verified) VALUES ('Gone Driver', 'gone@test.local', 'x', 'driver', 0, 1)`).run();
    const rc = await requestLink(env.client(), 'gone@test.local');
    assert.equal(rc.status, 422);
    assert.match(rc.text, /This account has been deactivated/);
    assert.equal(outboxTo('gone@test.local').length, 0);
  });

  test('the token is stored only as a SHA-256 hash; the link is built from APP_BASE_URL', async () => {
    const c = env.client();
    await requestLink(c, 'bob@test.local');
    const link = lastLink('bob@test.local');
    assert.ok(link.startsWith(`${config.appBaseUrl}/reset-password?token=`));
    const token = new URL(link).searchParams.get('token');
    assert.match(token, /^[A-Za-z0-9_-]{43}$/, '32 random bytes, base64url');
    const row = env.db.prepare('SELECT * FROM password_resets WHERE user_id = ? ORDER BY id DESC').get(env.data.bob.id);
    assert.equal(row.token_hash, require('crypto').createHash('sha256').update(token).digest('hex'));
    assert.ok(!JSON.stringify(row).includes(token));
  });

  test('the link works once: new password set, old one rejected, other sessions signed out, notice e-mailed', async () => {
    const elsewhere = env.client();
    await elsewhere.login('bob@test.local');
    assert.equal((await elsewhere.get('/driver')).status, 200);

    const c = env.client();
    await requestLink(c, 'bob@test.local');
    const link = new URL(lastLink('bob@test.local'));
    const open = await c.get(link.pathname + link.search);
    assert.equal(open.status, 303);
    assert.equal(open.location, '/reset-password', 'the token leaves the address bar at once');
    assert.equal(open.headers.get('referrer-policy'), 'no-referrer');
    const formPage = await c.get('/reset-password');
    assert.equal(formPage.headers.get('referrer-policy'), 'no-referrer');
    assert.match(formPage.text, /Choose a new password/);
    assert.match(formPage.text, /data-mode="login" data-flow="reset"/);

    const weak = await c.post('/reset-password', { password: 'short', confirm_password: 'short' });
    assert.equal(weak.status, 422);
    assert.match(weak.text, /at least 8 characters/);

    const done = await c.post('/reset-password', { password: 'N3wPassword', confirm_password: 'N3wPassword' });
    assert.equal(done.status, 303);
    assert.equal(done.location, '/login?notice=password-updated');
    assert.match((await env.client().get(done.location)).text, /Password updated\. Sign in with your new password\./);

    assert.equal((await elsewhere.get('/driver')).status, 302, 'the other session is gone');
    assert.equal((await env.client().login('bob@test.local', PASSWORD)).status, 401);
    assert.equal((await env.client().login('bob@test.local', 'N3wPassword')).status, 302);
    await settle();
    assert.ok(outboxTo('bob@test.local').some((m) => /password was changed/.test(m.subject)));

    const again = env.client();
    const reopened = await again.get(link.pathname + link.search);
    assert.match((await again.get(reopened.location)).text, /This link has expired/);
    assert.match((await again.get('/reset-password')).text, /Request a new link/);
  });

  test('a new request invalidates the earlier link; an expired link is refused', async () => {
    const c = env.client();
    await requestLink(c, 'alice@test.local');
    const older = new URL(lastLink('alice@test.local'));
    await requestLink(c, 'alice@test.local');
    const newer = new URL(lastLink('alice@test.local'));
    assert.notEqual(older.search, newer.search);

    const x = env.client();
    await x.get(older.pathname + older.search);
    assert.match((await x.get('/reset-password')).text, /This link has expired/);

    setNow('2026-03-10 09:30:01');
    const y = env.client();
    await y.get(newer.pathname + newer.search);
    assert.match((await y.get('/reset-password')).text, /This link has expired/);
    assert.equal((await y.post('/reset-password', { password: 'N3wPassword', confirm_password: 'N3wPassword' })).status, 410);
  });

  test('at most three links per account per hour; the visitor sees no difference', async () => {
    setNow('2026-03-10 11:00');
    const c = env.client();
    const before = outboxTo('admin@test.local').length;
    for (let i = 0; i < 4; i += 1) assert.equal((await requestLink(c, 'admin@test.local')).location, '/forgot-password');
    assert.equal(outboxTo('admin@test.local').length - before, 3);
  });

  test('no token, a garbage token, or a malformed address', async () => {
    assert.match((await env.client().get('/reset-password')).text, /This link has expired/);
    const c = env.client();
    await c.get('/reset-password?token=nope');
    assert.match((await c.get('/reset-password')).text, /This link has expired/);
    const d = env.client();
    await d.get('/forgot-password');
    const bad = await d.post('/forgot-password', { email: 'not-an-email' });
    assert.equal(bad.status, 422);
    assert.match(bad.text, /Enter a valid email address\./);
  });

});

describe('rate limits on the new endpoints', () => {
  let env;
  const tight = { windowMs: 60000, limit: 2 };
  before(async () => {
    env = await startApp({ fixture: 'minimal', now: '2026-03-10 09:00', authLimits: { forgot: tight, verify: tight, reset: tight } });
  });
  after(async () => env.stop());

  test('forgot password: the third request in a minute is refused', async () => {
    const c = env.client();
    await c.get('/forgot-password');
    await c.post('/forgot-password', { email: 'a@test.local' });
    await c.post('/forgot-password', { email: 'a@test.local' });
    const third = await c.post('/forgot-password', { email: 'a@test.local' });
    assert.equal(third.status, 429);
    assert.match(third.text, /Too many requests/);
  });

  test('verify: the JSON answer says so', async () => {
    const c = env.client();
    await c.get('/register');
    await c.post('/register/verify', { code: '1' }, JSON_ACCEPT);
    await c.post('/register/verify', { code: '1' }, JSON_ACCEPT);
    const third = await c.post('/register/verify', { code: '1' }, JSON_ACCEPT);
    assert.equal(third.status, 429);
    assert.equal(JSON.parse(third.text).state, 'rate');
  });
});

describe('auth screens', () => {
  let env;
  before(async () => {
    env = await startApp({ fixture: 'minimal', now: '2026-03-10 09:00' });
  });
  after(async () => env.stop());

  test('the logo stays a plain label on the verify, forgot, sent and reset screens too', async () => {
    const c = env.client();
    await c.get('/register');
    await c.post('/register', form('logo.check@example.test'));
    const pages = {
      verify: (await c.get('/register/verify')).text,
      forgot: (await c.get('/forgot-password')).text,
      reset: (await c.get('/reset-password')).text,
    };
    await c.post('/forgot-password', { email: 'logo.check@example.test' });
    pages.sent = (await c.get('/forgot-password')).text;
    for (const [name, html] of Object.entries(pages)) {
      const brands = [...html.matchAll(/<(\w+)\b([^>]*\sclass="(?:[^"]*\s)?brand(?:\s[^"]*)?"[^>]*)>/g)];
      assert.equal(brands.length, 2, `${name}: two logos`);
      for (const [, tag, attrs] of brands) {
        assert.equal(tag, 'div', name);
        assert.doesNotMatch(attrs, /\b(href|tabindex|role|onclick)\b/, name);
      }
    }
    assert.match(pages.verify, /data-flow="verify"/);
    assert.match(pages.forgot, /data-flow="forgot"/);
    assert.match(pages.reset, /data-flow="reset"/);
  });
});
