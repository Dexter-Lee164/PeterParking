'use strict';

/**
 * Outgoing mail and the configuration around it: console mode is impossible in production, SMTP settings are
 * validated, the three templates say what the brief requires and escape what they print, links come only from
 * APP_BASE_URL, and a failed background send never throws or leaks a code.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('node:child_process');
require('./helpers'); // NODE_ENV=test
const { createMailer, MailConfigError, parseFrom } = require('../src/services/mail');
const templates = require('../src/services/mailTemplates');

const consoleMail = { mode: 'console' };
const smtpMail = { mode: 'smtp', host: 'smtp.example.test', port: 587, user: 'sender@example.test', pass: 'not-a-real-password', from: 'University Parking <sender@example.test>' };
const BASE = 'https://parking.example.edu';

describe('mailer configuration', () => {
  test('console mode is refused when NODE_ENV=production', () => {
    assert.throws(() => createMailer({ mail: consoleMail, isProduction: true }), (err) => err instanceof MailConfigError && /not allowed when NODE_ENV=production/.test(err.message));
    assert.doesNotThrow(() => createMailer({ mail: consoleMail, isProduction: false }));
  });

  test('an unknown MAIL_MODE is refused', () => {
    assert.throws(() => createMailer({ mail: { mode: 'carrier-pigeon' }, isProduction: false }), /MAIL_MODE must be/);
  });

  test('smtp mode names every missing setting', () => {
    assert.throws(() => createMailer({ mail: { mode: 'smtp', port: 587 }, isProduction: true }), /SMTP_HOST, SMTP_USER, SMTP_PASS, MAIL_FROM/);
    assert.throws(() => createMailer({ mail: Object.assign({}, smtpMail, { pass: '' }), isProduction: true }), /SMTP_PASS/);
    assert.doesNotThrow(() => createMailer({ mail: smtpMail, isProduction: true, transport: { sendMail: async () => ({}) } }));
  });

  test('describe() never includes the password', () => {
    const mailer = createMailer({ mail: smtpMail, isProduction: true, transport: { sendMail: async () => ({}) } });
    assert.match(mailer.describe(), /smtp\.example\.test:587/);
    assert.doesNotMatch(mailer.describe(), /not-a-real-password/);
  });
});

describe('sending', () => {
  test('console mode under test keeps the message in the outbox and prints nothing', async (t) => {
    const log = t.mock.method(console, 'log', () => {});
    const mailer = createMailer({ mail: consoleMail, isProduction: false, isTest: true });
    const result = await mailer.send({ to: 'a@example.test', subject: 'Hi', text: 'Body 123456' });
    assert.equal(result.mode, 'console');
    assert.equal(mailer.outbox.length, 1);
    assert.equal(mailer.outbox[0].text, 'Body 123456');
    assert.equal(log.mock.callCount(), 0);
  });

  test('console mode in development prints the message (that is its purpose)', async (t) => {
    const log = t.mock.method(console, 'log', () => {});
    const mailer = createMailer({ mail: consoleMail, isProduction: false, isTest: false });
    await mailer.send({ to: 'a@example.test', subject: 'Your code', text: 'Code: 654321' });
    assert.equal(log.mock.callCount(), 1);
    const printed = String(log.mock.calls[0].arguments[0]);
    assert.match(printed, /console mode: printed here, NOT sent/);
    assert.match(printed, /To:\s+a@example\.test/);
    assert.match(printed, /654321/);
  });

  test('smtp mode hands the message to the transport with safe headers', async () => {
    const sent = [];
    const mailer = createMailer({ mail: smtpMail, isProduction: true, transport: { sendMail: async (m) => { sent.push(m); return { messageId: '<id@example.test>' }; } } });
    const result = await mailer.send({ to: 'driver@example.test', subject: 'Line one\r\nBcc: attacker@example.test', text: 'hello', html: '<p>hello</p>' });
    assert.equal(result.messageId, '<id@example.test>');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].from, smtpMail.from);
    assert.equal(sent[0].to, 'driver@example.test');
    assert.doesNotMatch(sent[0].subject, /[\r\n]/, 'a header cannot be injected through the subject');
    assert.equal(sent[0].headers['Auto-Submitted'], 'auto-generated');
  });

  test('recipients that could inject headers or are malformed are rejected before sending', async () => {
    const sent = [];
    const mailer = createMailer({ mail: smtpMail, isProduction: true, transport: { sendMail: async (m) => { sent.push(m); return {}; } } });
    for (const to of ['a@example.test\r\nBcc: evil@example.test', 'a@example.test, b@example.test', 'a b@example.test', '', undefined, '<a@example.test>', 'noatsign']) {
      await assert.rejects(() => mailer.send({ to, subject: 's', text: 't' }), MailConfigError, String(to));
    }
    assert.equal(sent.length, 0);
  });
});

describe('templates', () => {
  const mailer = createMailer({ mail: consoleMail, isProduction: false, isTest: true, baseUrl: BASE, timeZone: 'Asia/Manila' });
  const NOT_YOU = "If you didn't request this, you can ignore this email.";

  test('verification code: big monospaced code, expiry, sender, "ignore this email"; the code is not in the subject', () => {
    const mail = mailer.render('verificationCode', { name: 'Hehe Sample', code: '482913', sentAt: new Date('2026-10-20T15:35:00Z') });
    assert.doesNotMatch(mail.subject, /482913/);
    assert.match(mail.text, /\b482913\b/);
    assert.match(mail.text, /expires in 10 minutes/);
    assert.ok(mail.text.includes(NOT_YOU));
    assert.match(mail.text, /Sent by University Parking \(parking\.example\.edu\) on 20 Oct 2026, 23:35\./, 'campus time zone, Asia/Manila');
    assert.match(mail.html, /font-family:[^"]*(Consolas|monospace)[^"]*font-size:34px[^"]*"[^>]*>482913</, 'large monospaced code');
    assert.ok(mail.html.includes(NOT_YOU));
    assert.match(mail.text, /^Hi Hehe,/);
  });

  test('reset link: one button plus the plain URL, 30-minute single use, "ignore this email"', () => {
    const resetUrl = `${BASE}/reset-password?token=abc_DEF-123`;
    const mail = mailer.render('passwordReset', { name: 'Hehe Sample', resetUrl });
    assert.ok(mail.text.includes(resetUrl));
    assert.match(mail.text, /works once and expires in 30 minutes/);
    assert.ok(mail.text.includes(NOT_YOU));
    assert.equal((mail.html.match(/<a /g) || []).length, 2, 'the button and the plain URL');
    assert.ok(mail.html.includes(`href="${resetUrl}"`));
    assert.match(mail.html, />Choose a new password</);
    assert.ok(mail.html.includes(NOT_YOU));
    assert.doesNotMatch(mail.subject, /abc_DEF/);
  });

  test('password changed: when it happened and what to do if it was not you', () => {
    const mail = mailer.render('passwordChanged', { name: 'Hehe Sample', forgotUrl: `${BASE}/forgot-password`, changedAt: new Date('2026-10-20T16:00:00Z') });
    assert.match(mail.text, /changed on 21 Oct 2026, 00:00/);
    assert.match(mail.text, /signed out everywhere/);
    assert.ok(mail.text.includes(`${BASE}/forgot-password`));
  });

  test('everything dynamic is escaped in the HTML', () => {
    const hostile = '<script>alert(1)</script>"\'&';
    const code = mailer.render('verificationCode', { name: hostile, code: '"><img src=x onerror=alert(1)>' });
    const reset = mailer.render('passwordReset', { name: hostile, resetUrl: `${BASE}/reset-password?token="><script>x</script>` });
    for (const mail of [code, reset]) {
      assert.doesNotMatch(mail.html, /<script/i);
      assert.doesNotMatch(mail.html, /<img/i);
      assert.match(mail.html, /&lt;script&gt;/);
    }
  });

  test('a missing name still greets politely', () => {
    assert.match(mailer.render('verificationCode', { code: '111111' }).text, /^Hello,/);
  });

  test('only the three real templates can be rendered', () => {
    for (const name of ['esc', 'when', 'nope', '__proto__']) assert.throws(() => mailer.render(name, {}), /Unknown mail template/, name);
  });

  test('sendTemplate renders and sends in one step', async () => {
    const m = createMailer({ mail: consoleMail, isProduction: false, isTest: true, baseUrl: BASE });
    await m.sendTemplate('verificationCode', { to: 'driver@example.test', name: 'D', code: '246810' });
    assert.equal(m.outbox.length, 1);
    assert.equal(m.outbox[0].to, 'driver@example.test');
    assert.match(m.outbox[0].text, /246810/);
    assert.match(m.outbox[0].html, /246810/);
  });
});

describe('background sending', () => {
  test('a failing send never throws, and the log line contains no code, token, address or password', async (t) => {
    const errors = t.mock.method(console, 'error', () => {});
    const transport = { sendMail: async () => { throw Object.assign(new Error('connect failed for sender@example.test using not-a-real-password'), { code: 'ECONNECTION' }); } };
    const mailer = createMailer({ mail: smtpMail, isProduction: true, transport });
    assert.doesNotThrow(() => mailer.sendTemplateInBackground('verificationCode', { to: 'driver@mail.example.test', name: 'D', code: '135792' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(errors.mock.callCount(), 1);
    const line = String(errors.mock.calls[0].arguments[0]);
    assert.match(line, /verificationCode/);
    assert.match(line, /@mail\.example\.test/);
    assert.match(line, /ECONNECTION/);
    for (const secret of ['135792', 'driver@', 'not-a-real-password', 'sender@example.test']) assert.ok(!line.includes(secret), `log line must not contain ${secret}`);
  });

  test('an invalid recipient (a synchronous failure) is also swallowed and logged', async (t) => {
    const errors = t.mock.method(console, 'error', () => {});
    const mailer = createMailer({ mail: consoleMail, isProduction: false, isTest: true });
    assert.doesNotThrow(() => mailer.sendTemplateInBackground('passwordReset', { to: 'not an address', resetUrl: `${BASE}/x` }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(errors.mock.callCount(), 1);
  });

  test('it returns immediately, without waiting for a slow server', async () => {
    let release;
    const transport = { sendMail: () => new Promise((resolve) => { release = resolve; }) };
    const mailer = createMailer({ mail: smtpMail, isProduction: true, transport });
    const started = Date.now();
    mailer.sendTemplateInBackground('passwordReset', { to: 'a@example.test', resetUrl: `${BASE}/x` });
    assert.ok(Date.now() - started < 50);
    release({});
  });
});

describe('brevo mode (HTTPS API; a fake fetch, no network)', () => {
  const brevoMail = { mode: 'brevo', brevoApiKey: 'xkeysib-not-a-real-key', from: 'University Parking <sender@example.test>' };
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

  test('it needs an API key and a sender address', () => {
    assert.throws(() => createMailer({ mail: { mode: 'brevo', from: 'a@example.test' }, isProduction: true }), /BREVO_API_KEY/);
    assert.throws(() => createMailer({ mail: { mode: 'brevo', brevoApiKey: 'k', from: 'no address here' }, isProduction: true }), /MAIL_FROM/);
    assert.doesNotThrow(() => createMailer({ mail: brevoMail, isProduction: true, fetchImpl: async () => reply(201, {}) }));
  });

  test('MAIL_FROM is split into the sender name and address', () => {
    assert.deepEqual(parseFrom('University Parking <sender@example.test>'), { name: 'University Parking', email: 'sender@example.test' });
    assert.deepEqual(parseFrom('"Parking Office" <office@example.test>'), { name: 'Parking Office', email: 'office@example.test' });
    assert.deepEqual(parseFrom('sender@example.test'), { email: 'sender@example.test' });
    assert.equal(parseFrom('nope'), null);
  });

  test('one POST to the Brevo API with the key in a header and the message as JSON', async () => {
    const calls = [];
    const mailer = createMailer({ mail: brevoMail, isProduction: true, fetchImpl: async (url, init) => { calls.push({ url, init }); return reply(201, { messageId: '<brevo-1@example.test>' }); } });
    const result = await mailer.sendTemplate('verificationCode', { to: 'driver@example.test', name: 'Dee', code: '246810' });
    assert.equal(result.messageId, '<brevo-1@example.test>');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.brevo.com/v3/smtp/email');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers['api-key'], 'xkeysib-not-a-real-key');
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body.sender, { name: 'University Parking', email: 'sender@example.test' });
    assert.deepEqual(body.to, [{ email: 'driver@example.test' }]);
    assert.match(body.subject, /verification code/);
    assert.match(body.textContent, /246810/);
    assert.match(body.htmlContent, /246810/);
    assert.equal(body.headers['Auto-Submitted'], 'auto-generated');
    assert.ok(!calls[0].init.body.includes('xkeysib'), 'the key travels only in the header');
  });

  test('a refusal becomes BREVO_<status> with Brevo\'s reason; the log line hides the key and the address', async (t) => {
    const mailer = createMailer({ mail: brevoMail, isProduction: true, fetchImpl: async () => reply(401, { code: 'unauthorized', message: 'We have detected you are using an unrecognised IP address 203.0.113.9 for driver@example.test' }) });
    await assert.rejects(mailer.send({ to: 'driver@example.test', subject: 's', text: 't' }), (err) => err.code === 'BREVO_401' && /unrecognised IP/.test(err.message) && !/xkeysib/.test(err.message));
    const logged = [];
    t.mock.method(console, 'error', (line) => logged.push(line));
    mailer.sendTemplateInBackground('verificationCode', { to: 'driver@example.test', name: 'D', code: '135792' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(logged.length, 1);
    assert.match(logged[0], /BREVO_401/);
    assert.match(logged[0], /unrecognised IP address/);
    assert.doesNotMatch(logged[0], /135792|xkeysib|driver@example\.test/);
  });

  test('describe() names Brevo and the sender, never the key', () => {
    const d = createMailer({ mail: brevoMail, isProduction: true, fetchImpl: async () => reply(201, {}) }).describe();
    assert.match(d, /Brevo API/);
    assert.match(d, /sender@example\.test/);
    assert.doesNotMatch(d, /xkeysib/);
  });
});

/** Load src/config.js in a clean process with exactly this environment (and no .env file in reach). */
function probe(env, script) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-probe-'));
  const root = path.resolve(__dirname, '..');
  const result = spawnSync(process.execPath, ['-e', `const config = require(${JSON.stringify(path.join(root, 'src', 'config.js'))}); ${script}`], {
    cwd,
    env: Object.assign({ PATH: process.env.PATH }, env),
    encoding: 'utf8',
  });
  fs.rmSync(cwd, { recursive: true, force: true });
  return { status: result.status, out: result.stdout.trim(), err: result.stderr.trim() };
}
const problemsOf = (env) => JSON.parse(probe(env, 'console.log(JSON.stringify(config.problems()))').out);

describe('configuration (APP_BASE_URL, MAIL_MODE, secrets)', () => {
  const production = {
    NODE_ENV: 'production',
    SESSION_SECRET: 's'.repeat(32),
    AUTH_CODE_SECRET: 'c'.repeat(32),
    APP_BASE_URL: 'https://parking.example.edu',
    MAIL_MODE: 'smtp',
    SMTP_HOST: 'smtp.example.test',
    SMTP_USER: 'u@example.test',
    SMTP_PASS: 'p',
    MAIL_FROM: 'University Parking <u@example.test>',
  };

  test('a complete production setup has no problems', () => {
    assert.deepEqual(problemsOf(production), []);
  });

  test('production refuses console mail, a missing or non-https base URL, and a short code secret', () => {
    const none = problemsOf({ NODE_ENV: 'production', SESSION_SECRET: 's'.repeat(32), MAIL_MODE: 'console' }).join('\n');
    assert.match(none, /MAIL_MODE=console is not allowed/);
    assert.match(none, /APP_BASE_URL must be set/);
    assert.match(none, /AUTH_CODE_SECRET must be set/);

    assert.match(problemsOf(Object.assign({}, production, { APP_BASE_URL: 'http://parking.example.edu' })).join('\n'), /must start with https:\/\//);
    assert.deepEqual(problemsOf(Object.assign({}, production, { APP_BASE_URL: 'http://127.0.0.1:3000' })), [], 'loopback over http is fine for a local production test');
    assert.match(problemsOf(Object.assign({}, production, { AUTH_CODE_SECRET: 'short' })).join('\n'), /AUTH_CODE_SECRET/);
  });

  test('production with no MAIL_MODE at all defaults to smtp (never to console)', () => {
    const env = Object.assign({}, production);
    delete env.MAIL_MODE;
    delete env.SMTP_HOST;
    const problems = problemsOf(env).join('\n');
    assert.doesNotMatch(problems, /console/);
    assert.match(problems, /SMTP_HOST must be set when MAIL_MODE=smtp/);
  });

  test('smtp mode lists each missing SMTP setting; an invalid base URL or mode is reported', () => {
    const problems = problemsOf({ NODE_ENV: 'development', MAIL_MODE: 'smtp' }).join('\n');
    for (const key of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM']) assert.match(problems, new RegExp(key));
    assert.match(problemsOf({ NODE_ENV: 'development', APP_BASE_URL: 'ftp://nope' }).join('\n'), /APP_BASE_URL is not a valid http\(s\) address/);
    assert.match(problemsOf({ NODE_ENV: 'development', MAIL_MODE: 'pigeon' }).join('\n'), /MAIL_MODE must be/);
  });

  test('brevo mode: a complete setup has no problems; a missing key or sender is reported', () => {
    const brevo = Object.assign({}, production, { MAIL_MODE: 'brevo', BREVO_API_KEY: 'xkeysib-test' });
    delete brevo.SMTP_HOST;
    delete brevo.SMTP_USER;
    delete brevo.SMTP_PASS;
    assert.deepEqual(problemsOf(brevo), [], 'no SMTP settings needed');
    const missing = problemsOf(Object.assign({}, brevo, { BREVO_API_KEY: '', MAIL_FROM: '' })).join('\n');
    assert.match(missing, /BREVO_API_KEY must be set when MAIL_MODE=brevo/);
    assert.match(missing, /MAIL_FROM must be set when MAIL_MODE=brevo/);
  });

  test('development defaults: console mail, a local base URL, no problems', () => {
    const out = JSON.parse(probe({ NODE_ENV: 'development' }, 'console.log(JSON.stringify({ p: config.problems(), mode: config.mail.mode, base: config.appBaseUrl }))').out);
    assert.deepEqual(out, { p: [], mode: 'console', base: 'http://127.0.0.1:3000' });
  });

  test('links are built from APP_BASE_URL only: its path is dropped, values are encoded', () => {
    const out = probe({ NODE_ENV: 'development', APP_BASE_URL: 'https://parking.example.edu/some/where?x=1' }, "console.log(config.url('/reset-password', { token: 'a b&c=d' }))").out;
    assert.equal(out, 'https://parking.example.edu/reset-password?token=a+b%26c%3Dd');
  });

  test('assertReady stops start-up with every problem listed', () => {
    const res = probe({ NODE_ENV: 'production', SESSION_SECRET: 's'.repeat(32), MAIL_MODE: 'console' }, 'try { config.assertReady(); } catch (e) { console.log(e.message); }');
    assert.match(res.out, /Configuration problems:/);
    assert.match(res.out, /MAIL_MODE=console is not allowed/);
    assert.match(res.out, /APP_BASE_URL must be set/);
  });

  test('the production mailer itself also refuses console mode (second line of defence)', () => {
    const root = path.resolve(__dirname, '..');
    const res = probe({ NODE_ENV: 'production', SESSION_SECRET: 's'.repeat(32), MAIL_MODE: 'console' }, `try { require(${JSON.stringify(path.join(root, 'src', 'services', 'mail.js'))}).getMailer(); console.log('STARTED'); } catch (e) { console.log(e.message); }`);
    assert.match(res.out, /not allowed when NODE_ENV=production/);
    assert.doesNotMatch(res.out, /STARTED/);
  });

  test('without AUTH_CODE_SECRET, development derives one; production refuses to', () => {
    const dev = probe({ NODE_ENV: 'development', SESSION_SECRET: 'x'.repeat(20) }, 'console.log(config.resolveAuthCodeSecret().length)').out;
    assert.equal(dev, '64');
    const prod = probe({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(32) }, 'try { config.resolveAuthCodeSecret(); } catch (e) { console.log(e.message); }').out;
    assert.match(prod, /AUTH_CODE_SECRET must be set/);
  });
});
