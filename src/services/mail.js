'use strict';

/**
 * Outgoing e-mail, configured only through the environment (see .env.example):
 *
 *   MAIL_MODE=console   print the message in the terminal; nothing is sent. Development only.
 *   MAIL_MODE=smtp      send through SMTP with nodemailer (SMTP_HOST / PORT / USER / PASS, MAIL_FROM).
 *   MAIL_MODE=brevo     send through Brevo's transactional e-mail API over HTTPS (BREVO_API_KEY, MAIL_FROM). For hosts
 *                       that block outgoing SMTP ports, such as Railway below the Pro plan.
 *
 * Console mode cannot be switched on when NODE_ENV=production: the mailer refuses to start (and config.assertReady()
 * reports it first), because it would print verification codes and reset links into server logs.
 *
 * Codes and links are never logged in smtp mode. A failed send logs only the template name, the recipient's domain
 * and an error code.
 */

const nodemailer = require('nodemailer');
const config = require('../config');
const templates = require('./mailTemplates');
const { helpers } = require('../middleware/view');

const SAFE_ADDRESS = /^[^\s<>"',;:\\()[\]]+@[^\s<>"',;:\\()[\]]+$/;
const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
const BREVO_TIMEOUT_MS = 15000;

class MailConfigError extends Error {}

/** A log-safe reason for a failed send: the error code, plus Brevo's own explanation with any address removed. */
function failureReason(err) {
  if (!err) return 'unknown error';
  const code = err.code || err.responseCode || '';
  if (String(code).startsWith('BREVO_')) return `${code} ${String(err.message).replace(/[^\s@]+@[^\s@]+/g, '<address>')}`;
  return String(code || err.message);
}

/** 'University Parking <you@gmail.com>' -> { name: 'University Parking', email: 'you@gmail.com' }; a bare address works too. */
function parseFrom(from) {
  const value = String(from || '').trim();
  const m = /^"?([^"<]*?)"?\s*<([^<>\s]+@[^<>\s]+)>$/.exec(value);
  if (m) return m[1].trim() ? { name: m[1].trim(), email: m[2] } : { email: m[2] };
  return SAFE_ADDRESS.test(value) ? { email: value } : null;
}

function createMailer({ mail = config.mail, isProduction = config.isProduction, isTest = config.isTest, transport = null, fetchImpl = globalThis.fetch, timeZone = config.timezone, baseUrl } = {}) {
  const mode = String(mail.mode || '').toLowerCase();
  if (!['console', 'smtp', 'brevo'].includes(mode)) throw new MailConfigError(`MAIL_MODE must be "console", "smtp" or "brevo" (got "${mail.mode}").`);
  if (mode === 'console' && isProduction) {
    throw new MailConfigError('MAIL_MODE=console is not allowed when NODE_ENV=production. Use MAIL_MODE=smtp or MAIL_MODE=brevo.');
  }
  if (mode === 'smtp') {
    const missing = [['SMTP_HOST', mail.host], ['SMTP_USER', mail.user], ['SMTP_PASS', mail.pass], ['MAIL_FROM', mail.from]].filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) throw new MailConfigError(`MAIL_MODE=smtp needs ${missing.join(', ')}.`);
  }
  if (mode === 'brevo') {
    const missing = [['BREVO_API_KEY', mail.brevoApiKey], ['MAIL_FROM', parseFrom(mail.from)]].filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) throw new MailConfigError(`MAIL_MODE=brevo needs ${missing.join(' and ')} (MAIL_FROM must be a sender verified in Brevo).`);
  }

  const from = mail.from || `${helpers.appName} <no-reply@university-parking.invalid>`;
  const outbox = []; // the last few messages, kept only in tests so they can read the code or link
  let smtp = transport;

  function smtpTransport() {
    if (!smtp) {
      const secure = Number(mail.port) === 465;
      smtp = nodemailer.createTransport({
        host: mail.host,
        port: mail.port,
        secure, // 465: TLS from the first byte
        requireTLS: !secure, // 587 etc.: refuse to continue unless STARTTLS succeeds
        auth: { user: mail.user, pass: mail.pass },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 20000,
      });
    }
    return smtp;
  }

  function clean(message) {
    const to = String(message.to || '').trim();
    if (!SAFE_ADDRESS.test(to) || /[\r\n]/.test(to)) throw new MailConfigError('Invalid recipient address.');
    return {
      from,
      to,
      subject: String(message.subject || '').replace(/[\r\n]+/g, ' ').trim(),
      text: String(message.text || ''),
      html: message.html ? String(message.html) : undefined,
      headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
    };
  }

  function printToConsole(msg) {
    const rule = '-'.repeat(64);
    console.log(
      [
        '',
        rule,
        'MAIL (console mode: printed here, NOT sent)',
        `To:      ${msg.to}`,
        `From:    ${msg.from}`,
        `Subject: ${msg.subject}`,
        '',
        msg.text,
        rule,
        '',
      ].join('\n'),
    );
  }

  async function send(message) {
    const msg = clean(message);
    if (mode === 'console') {
      if (isTest) {
        outbox.push(msg);
        if (outbox.length > 50) outbox.shift();
      } else {
        printToConsole(msg);
      }
      return { mode, messageId: null };
    }
    if (mode === 'brevo') return sendWithBrevo(msg);
    const info = await smtpTransport().sendMail(msg);
    return { mode, messageId: (info && info.messageId) || null };
  }

  /**
   * One POST to Brevo. A refusal throws an error whose code is BREVO_<HTTP status> (401 = bad key or an IP Brevo has
   * not authorised, 400 = usually a sender that is not verified); the API key is never part of any message.
   */
  async function sendWithBrevo(msg) {
    const payload = {
      sender: parseFrom(msg.from),
      to: [{ email: msg.to }],
      subject: msg.subject,
      textContent: msg.text,
      headers: msg.headers,
    };
    if (msg.html) payload.htmlContent = msg.html;
    const res = await fetchImpl(BREVO_URL, {
      method: 'POST',
      headers: { 'api-key': mail.brevoApiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(BREVO_TIMEOUT_MS),
    });
    let body = {};
    try {
      body = await res.json();
    } catch {
      body = {};
    }
    if (!res.ok) {
      const reason = [body.code, body.message].filter(Boolean).join(': ').slice(0, 200);
      const err = new Error(`Brevo refused the message (HTTP ${res.status}${reason ? `, ${reason}` : ''})`);
      err.code = `BREVO_${res.status}`;
      err.responseCode = res.status;
      throw err;
    }
    return { mode, messageId: body.messageId || null };
  }

  /** Build one of the three templates with this site's name, address and time zone filled in. */
  function render(template, data = {}) {
    if (typeof templates[template] !== 'function' || ['esc', 'when'].includes(template)) throw new Error(`Unknown mail template "${template}".`);
    return templates[template](Object.assign({ appName: helpers.appName, baseUrl: baseUrl || config.appBaseUrl, timeZone }, data));
  }

  function sendTemplate(template, data) {
    return send(Object.assign({ to: data.to }, render(template, data)));
  }

  /**
   * Send without waiting and without ever throwing, so a request's response time cannot reveal whether a mail was
   * really sent (used for "forgot password"). Failures are logged without any secret.
   */
  function sendTemplateInBackground(template, data) {
    let promise;
    try {
      promise = sendTemplate(template, data);
    } catch (err) {
      promise = Promise.reject(err);
    }
    promise.catch((err) => {
      const domain = String((data && data.to) || '').split('@')[1] || 'unknown';
      console.error(`[mail] "${template}" to @${domain} was not sent: ${failureReason(err)}`);
    });
  }

  function describe() {
    if (mode === 'console') return 'Mail: console mode. Messages are printed in this window; nothing is sent.';
    if (mode === 'brevo') return `Mail: Brevo API (HTTPS) as ${parseFrom(mail.from).email}.`;
    return `Mail: SMTP via ${mail.host}:${mail.port} as ${mail.user}.`;
  }

  return { mode, from, outbox, send, render, sendTemplate, sendTemplateInBackground, describe };
}

let shared = null;

/** The app-wide mailer (created on first use from the environment). */
function getMailer() {
  if (!shared) shared = createMailer();
  return shared;
}

/** Tests: swap in a mailer (or null to rebuild from the environment next time). */
function setMailer(mailer) {
  shared = mailer;
}

module.exports = { createMailer, getMailer, setMailer, MailConfigError, parseFrom, failureReason };
