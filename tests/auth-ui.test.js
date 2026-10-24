'use strict';

/**
 * The unified sign-in / sign-up screen: server-rendered mode, inert inactive form, error re-rendering in the
 * right mode, and the form contract (field names, actions, methods, CSRF) that the redesign must not change.
 * Motion, focus and history behaviour are checked in a real browser (see README "Manual checks"); this file covers
 * everything the server decides.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, signUp } = require('./helpers');

/** The markup of one <form id="..."> up to its </form>. */
function formHtml(html, id) {
  const start = html.indexOf(`id="${id}"`);
  assert.notEqual(start, -1, `${id} present`);
  return html.slice(html.lastIndexOf('<form', start), html.indexOf('</form>', start));
}

/** The markup of one form pane: from its opening tag up to whatever follows it (the other pane, the overlay or the live region). */
function pane(html, name) {
  const start = html.indexOf(`data-auth-pane="${name}"`);
  assert.notEqual(start, -1, `${name} pane present`);
  const tail = html.slice(start + 1);
  const next = tail.search(/<section class="auth-pane |<aside class="auth-overlay"|<div class="visually-hidden" role="status"/);
  return next === -1 ? tail : tail.slice(0, next);
}

const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
};
const inputs = (html) => [...html.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]);
const inputByName = (html, name) => inputs(html).find((t) => attr(t, 'name') === name);

describe('unified auth screen', () => {
  let env;
  before(async () => {
    env = await startApp({ fixture: 'minimal', now: '2026-03-10 09:00', loginRateLimit: { windowMs: 60000, max: 3 } });
  });
  after(async () => env.stop());

  test('GET /login and GET /register render the same card in the right mode', async () => {
    const c = env.client();
    const login = await c.get('/login');
    const register = await c.get('/register');
    assert.equal(login.status, 200);
    assert.equal(register.status, 200);
    assert.match(login.text, /<section class="auth-card" data-auth-card data-mode="login"/);
    assert.match(register.text, /<section class="auth-card" data-auth-card data-mode="register"/);
    assert.match(login.text, /<title>Sign in · /);
    assert.match(register.text, /<title>Create account · /);
    // the same shell on both URLs, so a client-side switch needs no extra markup
    for (const html of [login.text, register.text]) {
      assert.match(html, /data-auth-pane="login"/);
      assert.match(html, /data-auth-pane="register"/);
      assert.match(html, /data-auth-overlay/);
      assert.match(html, /data-auth-live/);
    }
  });

  test('only the active form is interactive: the other pane and prompt are inert', async () => {
    const c = env.client();
    const login = (await c.get('/login')).text;
    const register = (await c.get('/register')).text;

    assert.doesNotMatch(/<section[^>]*data-auth-pane="login"[^>]*>/.exec(login)[0], /\binert\b/);
    assert.match(/<section[^>]*data-auth-pane="register"[^>]*>/.exec(login)[0], /\binert\b/);
    assert.match(/<section[^>]*data-auth-pane="login"[^>]*>/.exec(register)[0], /\binert\b/);
    assert.doesNotMatch(/<section[^>]*data-auth-pane="register"[^>]*>/.exec(register)[0], /\binert\b/);

    assert.doesNotMatch(/<p[^>]*data-auth-prompt="login"[^>]*>/.exec(login)[0], /\binert\b/);
    assert.match(/<p[^>]*data-auth-prompt="register"[^>]*>/.exec(login)[0], /\binert\b/);
    assert.match(/<p[^>]*data-auth-prompt="login"[^>]*>/.exec(register)[0], /\binert\b/);
    assert.doesNotMatch(/<p[^>]*data-auth-prompt="register"[^>]*>/.exec(register)[0], /\binert\b/);
  });

  test('switch controls are real links to /login and /register (work without JavaScript)', async () => {
    const html = (await env.client().get('/login')).text;
    const links = [...html.matchAll(/<a\b[^>]*data-auth-switch="(login|register)"[^>]*>/g)].map((m) => ({ mode: m[1], href: attr(m[0], 'href'), current: /aria-current="page"/.test(m[0]) }));
    assert.ok(links.length >= 4, 'two in the compact header, two in the overlay');
    for (const l of links) assert.equal(l.href, l.mode === 'login' ? '/login' : '/register');
    // the two-segment control marks the page you are on
    const nav = /<nav class="auth-switch"[\s\S]*?<\/nav>/.exec(html)[0];
    assert.match(nav, /data-auth-switch="login" aria-current="page"/);
    assert.doesNotMatch(/data-auth-switch="register"[^>]*>/.exec(nav)[0], /aria-current/);
    const reg = (await env.client().get('/register')).text;
    assert.match(/<nav class="auth-switch"[\s\S]*?<\/nav>/.exec(reg)[0], /data-auth-switch="register" aria-current="page"/);
  });

  test('form contract is unchanged: actions, methods, field names, CSRF, no autofill surprises', async () => {
    const c = env.client();
    const loginHtml = (await c.get('/login')).text;
    const loginForm = /<form[^>]*id="login-form"[^>]*>/.exec(loginHtml)[0];
    assert.equal(attr(loginForm, 'action'), '/login');
    assert.equal(attr(loginForm, 'method'), 'post');
    const lp = formHtml(loginHtml, 'login-form');
    assert.deepEqual(inputs(lp).map((t) => attr(t, 'name')).sort(), ['_csrf', 'email', 'password']);
    assert.match(attr(inputByName(lp, '_csrf'), 'value'), /^[a-f0-9]{32,}$/);
    assert.equal(attr(inputByName(lp, 'email'), 'type'), 'email');
    assert.equal(attr(inputByName(lp, 'email'), 'autocomplete'), 'username');
    assert.equal(attr(inputByName(lp, 'password'), 'type'), 'password');
    assert.equal(attr(inputByName(lp, 'password'), 'autocomplete'), 'current-password');

    const regHtml = (await c.get('/register')).text;
    const regForm = /<form[^>]*id="register-form"[^>]*>/.exec(regHtml)[0];
    assert.equal(attr(regForm, 'action'), '/register');
    assert.equal(attr(regForm, 'method'), 'post');
    const rp = pane(regHtml, 'register');
    assert.deepEqual(inputs(rp).map((t) => attr(t, 'name')).sort(), ['_csrf', 'confirm_password', 'email', 'full_name', 'password', 'phone', 'university_id']);
    const ac = (n) => attr(inputByName(rp, n), 'autocomplete');
    assert.equal(ac('full_name'), 'name');
    assert.equal(ac('email'), 'email');
    assert.equal(ac('phone'), 'tel');
    assert.equal(ac('password'), 'new-password');
    assert.equal(ac('confirm_password'), 'new-password');
    assert.equal(attr(inputByName(rp, 'phone'), 'type'), 'tel');
    assert.equal(attr(inputByName(rp, 'phone'), 'inputmode'), 'tel');
    assert.equal(attr(inputByName(rp, 'email'), 'type'), 'email');
    // the CSRF token is the session's, identical in both forms and in the <meta>
    const meta = /name="csrf-token" content="([a-f0-9]+)"/.exec(regHtml)[1];
    assert.equal(attr(inputByName(rp, '_csrf'), 'value'), meta);
    assert.equal(attr(inputByName(pane(regHtml, 'login'), '_csrf'), 'value'), meta);
  });

  test('every password field has an accessible show/hide toggle', async () => {
    const html = (await env.client().get('/register')).text;
    const toggles = [...html.matchAll(/<button\b[^>]*data-auth-toggle[^>]*>/g)].map((m) => m[0]);
    assert.equal(toggles.length, 3, 'sign-in password, sign-up password, sign-up confirmation');
    for (const t of toggles) {
      assert.equal(attr(t, 'aria-pressed'), 'false');
      assert.match(attr(t, 'aria-label'), /^Show password$/);
      assert.match(attr(t, 'type'), /^button$/, 'a toggle must never submit the form');
      assert.ok(html.includes(`id="${attr(t, 'aria-controls')}"`), 'aria-controls points at a real field');
    }
  });

  test('ids are unique across both forms and labels point at real controls', async () => {
    for (const url of ['/login', '/register']) {
      const html = (await env.client().get(url)).text;
      const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
      const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
      assert.deepEqual(dupes, [], `${url}: duplicate ids`);
      for (const m of html.matchAll(/<label\b[^>]*\sfor="([^"]+)"/g)) assert.ok(ids.includes(m[1]), `${url}: label for=${m[1]}`);
      for (const m of html.matchAll(/aria-labelledby="([^"]+)"/g)) assert.ok(ids.includes(m[1]), `${url}: aria-labelledby=${m[1]}`);
      for (const m of html.matchAll(/aria-describedby="([^"]+)"/g)) for (const id of m[1].split(' ')) assert.ok(ids.includes(id), `${url}: aria-describedby=${id}`);
    }
  });

  test('one h1 per page, the decorative slot grid is hidden from assistive tech, the password hint is real text', async () => {
    for (const url of ['/login', '/register']) {
      const html = (await env.client().get(url)).text;
      const steps = [...html.matchAll(/<div class="auth-step(?: is-current)?"[^>]*>/g)].map((m) => m[0]);
      assert.equal((html.match(/<h1\b/g) || []).length, steps.length, 'one heading per step');
      assert.equal(steps.filter((s) => !/\binert\b/.test(s)).length, 2, 'one live step per pane; every other step is inert');
      assert.match(html, /<div class="auth-mini-map[^"]*" aria-hidden="true">/);
    }
    const reg = (await env.client().get('/register')).text;
    assert.match(reg, /id="register-password-hint"[^>]*>At least 8 characters, with a letter and a number\.</);
    assert.match(attr(inputByName(pane(reg, 'register'), 'password'), 'aria-describedby') || '', /register-password-hint/);
  });

  test('no inline scripts or inline event handlers (CSP script-src self)', async () => {
    for (const url of ['/login', '/register']) {
      const res = await env.client().get(url);
      assert.doesNotMatch(res.text, /<script(?![^>]*\ssrc=)[^>]*>/i, `${url}: inline <script>`);
      assert.doesNotMatch(res.text, /\son[a-z]+="/i, `${url}: inline handler`);
      assert.match(res.text, /<link rel="stylesheet" href="\/css\/auth\.css\?v=\w+">/);
      assert.match(res.text, /<script src="\/js\/auth\.js\?v=\w+"><\/script>/);
    }
  });

  test('POST /login failure re-renders the sign-in mode with a focusable alert and no sign-up errors', async () => {
    const c = env.client();
    await c.get('/login');
    const res = await c.post('/login', { email: 'alice@test.local', password: 'wrong-pass-1' });
    assert.equal(res.status, 401);
    assert.match(res.text, /data-auth-card data-mode="login"/);
    const lp = pane(res.text, 'login');
    assert.match(lp, /<div class="alert alert-danger auth-alert[^"]*" role="alert" tabindex="-1"[^>]*>[\s\S]*Invalid email or password\./);
    assert.equal(attr(inputByName(lp, 'email'), 'value'), 'alice@test.local', 'email kept');
    assert.equal(attr(inputByName(lp, 'password'), 'value') || '', '', 'password never echoed');
    assert.doesNotMatch(pane(res.text, 'register'), /role="alert"|is-invalid/);
  });

  test('POST /register validation failure re-renders the sign-up mode, per-field, without echoing passwords', async () => {
    const c = env.client();
    await c.get('/register');
    // The server checks the profile fields first and the password on the next round (existing behaviour, untouched).
    const res = await c.post('/register', { full_name: 'X', email: 'not-an-email', university_id: 'U-9', phone: 'abc', password: 'short', confirm_password: 'different' });
    assert.equal(res.status, 422);
    assert.match(res.text, /data-auth-card data-mode="register"/);
    const rp = pane(res.text, 'register');
    for (const name of ['full_name', 'email', 'phone']) {
      const tag = inputByName(rp, name);
      assert.match(tag, /aria-invalid="true"/, `${name} flagged`);
      assert.match(tag, /\bis-invalid\b/, `${name} styled`);
    }
    assert.match(rp, /Enter your full name\./);
    assert.match(rp, /Enter a valid email address/);
    assert.match(rp, /Enter a valid phone number\./);
    assert.equal(attr(inputByName(rp, 'email'), 'value'), 'not-an-email');
    assert.equal(attr(inputByName(rp, 'university_id'), 'value'), 'U-9');
    for (const name of ['password', 'confirm_password']) assert.equal(attr(inputByName(rp, name), 'value') || '', '', `${name} never echoed`);
    assert.doesNotMatch(pane(res.text, 'login'), /role="alert"|is-invalid/);
  });

  test('password problems are shown on the password fields of the sign-up form', async () => {
    const c = env.client();
    await c.get('/register');
    const short = await c.post('/register', { full_name: 'Pat Driver', email: 'pat@test.local', password: 'short', confirm_password: 'short' });
    assert.equal(short.status, 422);
    const sp = pane(short.text, 'register');
    assert.match(inputByName(sp, 'password'), /aria-invalid="true"/);
    assert.match(sp, /Password must be at least 8 characters\./);
    assert.equal(attr(inputByName(sp, 'full_name'), 'value'), 'Pat Driver', 'valid fields keep their values');

    const mismatch = await c.post('/register', { full_name: 'Pat Driver', email: 'pat@test.local', password: 'Passw0rd!x', confirm_password: 'Passw0rd!y' });
    assert.equal(mismatch.status, 422);
    const mp = pane(mismatch.text, 'register');
    assert.match(inputByName(mp, 'confirm_password'), /aria-invalid="true"/);
    assert.match(mp, /Passwords do not match\./);
    assert.equal(attr(inputByName(mp, 'password'), 'value') || '', '');
  });

  test('a duplicate email is reported on the email field of the sign-up form', async () => {
    const c = env.client();
    await c.get('/register');
    const res = await c.post('/register', { full_name: 'Alice Again', email: 'alice@test.local', password: 'Passw0rd!x', confirm_password: 'Passw0rd!x' });
    assert.equal(res.status, 422);
    const rp = pane(res.text, 'register');
    assert.match(inputByName(rp, 'email'), /aria-invalid="true"/);
    assert.match(rp, /already registered/i);
  });

  test('submitted values are HTML-escaped when the form is re-rendered', async () => {
    const c = env.client();
    await c.get('/register');
    const evil = '"><script>alert(1)</script>';
    const res = await c.post('/register', { full_name: evil, email: 'bad', password: 'x', confirm_password: 'y' });
    assert.equal(res.status, 422);
    assert.doesNotMatch(res.text, /<script>alert\(1\)<\/script>/);
    assert.match(res.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    await c.get('/login');
    const l = await c.post('/login', { email: evil, password: 'whatever1' });
    assert.doesNotMatch(l.text, /<script>alert\(1\)<\/script>/);
  });

  test('a successful sign-up (after its code) and sign-in land where they did before', async () => {
    const c = env.client();
    const { res: created, verify } = await signUp(c, { full_name: 'Casey Newdriver', email: 'casey@test.local', password: 'Passw0rd!x', confirm_password: 'Passw0rd!x' });
    assert.equal(created.status, 303);
    assert.equal(created.location, '/register/verify');
    assert.equal(verify.location, '/driver/vehicles');
    const again = env.client();
    const ok = await again.login('casey@test.local', 'Passw0rd!x');
    assert.equal(ok.status, 302);
    assert.equal(ok.location, '/driver');
  });

  test('POST without a CSRF token is still rejected', async () => {
    const c = env.client();
    await c.get('/login');
    const res = await c.post('/login', { email: 'alice@test.local', password: 'Passw0rd!' }, { csrf: false });
    assert.equal(res.status, 403);
  });

  test('signed-in visitors are still redirected away from both screens', async () => {
    const c = env.client();
    await c.login('alice@test.local');
    for (const url of ['/login', '/register']) {
      const res = await c.get(url);
      assert.equal(res.status, 302, url);
      assert.equal(res.location, '/driver', url);
    }
  });

  // Keep this one last: it exhausts the per-IP sign-in allowance for the rest of the minute.
  test('sign-in rate limit (429) re-renders the sign-in mode with the lock-out message', async () => {
    const c = env.client();
    await c.get('/login');
    let last;
    for (let i = 0; i < 5; i += 1) last = await c.post('/login', { email: 'ghost@test.local', password: 'nope-nope-1' });
    assert.equal(last.status, 429);
    assert.match(last.text, /data-auth-card data-mode="login"/);
    assert.match(pane(last.text, 'login'), /role="alert"[\s\S]*Too many failed sign-in attempts/);
  });
});
