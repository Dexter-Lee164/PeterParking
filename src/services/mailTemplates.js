'use strict';

/**
 * The three e-mails the app sends. Each builder returns { subject, text, html }:
 *   verificationCode  6-digit sign-up code
 *   passwordReset     single-use reset link
 *   passwordChanged   notice after a password was changed
 *
 * Plain text is the source of truth; the HTML is a simple, inline-styled version of the same words (no images, no
 * scripts, no external CSS — mail clients ignore or block those). Every dynamic value is escaped.
 * Links are passed in already built from APP_BASE_URL; nothing here reads the request or the Host header.
 */

const FONT = "'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace";

const esc = (value) =>
  String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** "20 Oct 2026, 23:35" in the campus time zone. */
function when(date, timeZone) {
  const d = date instanceof Date ? date : new Date(date);
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: timeZone || 'UTC' }).format(d);
}

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const greeting = (name) => (firstName(name) ? `Hi ${firstName(name)},` : 'Hello,');

function hostOf(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return '';
  }
}

function sender({ appName, baseUrl, sentAt, timeZone }) {
  const host = hostOf(baseUrl);
  return `Sent by ${appName}${host ? ` (${host})` : ''} on ${when(sentAt, timeZone)}.`;
}

/** Shared HTML frame. `body` is trusted markup built below from escaped values. */
function frame({ appName, preheader, body, footer }) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(appName)}</title></head>
<body style="margin:0;padding:0;background:#f3f5f9;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f9;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="width:100%;max-width:480px;background:#ffffff;border:1px solid #dde3ee;border-radius:12px;font-family:${FONT};color:#1b2437;">
<tr><td style="padding:24px 28px 4px;font-size:15px;font-weight:700;color:#2563eb;letter-spacing:0.01em;">${esc(appName)}</td></tr>
<tr><td style="padding:8px 28px 4px;font-size:15px;line-height:1.55;">${body}</td></tr>
<tr><td style="padding:16px 28px 24px;font-size:12px;line-height:1.5;color:#5b6577;border-top:1px solid #eef1f6;">${footer}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

const paragraph = (html) => `<p style="margin:0 0 14px;">${html}</p>`;

function verificationCode({ appName, baseUrl, name, code, expiresMinutes = 10, expiresAt, sentAt = new Date(), timeZone }) {
  const until = expiresAt ? ` (until ${when(expiresAt, timeZone)})` : '';
  const subject = `Your ${appName} verification code`;
  const text = [
    greeting(name),
    '',
    `Use this code to finish creating your ${appName} account:`,
    '',
    `    ${code}`,
    '',
    `It expires in ${expiresMinutes} minutes${until}. Never share it with anyone.`,
    '',
    "If you didn't request this, you can ignore this email.",
    '',
    sender({ appName, baseUrl, sentAt, timeZone }),
  ].join('\n');

  const html = frame({
    appName,
    preheader: `Your verification code is ${code}. It expires in ${expiresMinutes} minutes.`,
    body:
      paragraph(esc(greeting(name))) +
      paragraph(`Use this code to finish creating your ${esc(appName)} account:`) +
      `<div style="margin:6px 0 18px;padding:16px 12px;background:#f3f6fd;border:1px solid #d6e0f7;border-radius:10px;text-align:center;font-family:${MONO};font-size:34px;line-height:1.1;font-weight:700;letter-spacing:10px;color:#0b1220;">${esc(code)}</div>` +
      paragraph(`It expires in <strong>${esc(expiresMinutes)} minutes</strong>${esc(until)}. Never share it with anyone.`) +
      paragraph("If you didn't request this, you can ignore this email."),
    footer: esc(sender({ appName, baseUrl, sentAt, timeZone })),
  });
  return { subject, text, html };
}

function passwordReset({ appName, baseUrl, name, resetUrl, expiresMinutes = 30, expiresAt, sentAt = new Date(), timeZone }) {
  const until = expiresAt ? ` (until ${when(expiresAt, timeZone)})` : '';
  const subject = `Reset your ${appName} password`;
  const text = [
    greeting(name),
    '',
    `We received a request to reset the password for your ${appName} account. Open this link to choose a new one:`,
    '',
    resetUrl,
    '',
    `The link works once and expires in ${expiresMinutes} minutes${until}.`,
    '',
    "If you didn't request this, you can ignore this email. Your password will not change.",
    '',
    sender({ appName, baseUrl, sentAt, timeZone }),
  ].join('\n');

  const html = frame({
    appName,
    preheader: `Reset your password. The link expires in ${expiresMinutes} minutes.`,
    body:
      paragraph(esc(greeting(name))) +
      paragraph(`We received a request to reset the password for your ${esc(appName)} account.`) +
      `<p style="margin:6px 0 18px;"><a href="${esc(resetUrl)}" style="display:inline-block;padding:13px 22px;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:700;border-radius:9px;">Choose a new password</a></p>` +
      paragraph(`Or paste this address into your browser:<br><a href="${esc(resetUrl)}" style="color:#2563eb;word-break:break-all;">${esc(resetUrl)}</a>`) +
      paragraph(`The link works once and expires in <strong>${esc(expiresMinutes)} minutes</strong>${esc(until)}.`) +
      paragraph("If you didn't request this, you can ignore this email. Your password will not change."),
    footer: esc(sender({ appName, baseUrl, sentAt, timeZone })),
  });
  return { subject, text, html };
}

function passwordChanged({ appName, baseUrl, name, forgotUrl, changedAt = new Date(), sentAt = new Date(), timeZone }) {
  const subject = `Your ${appName} password was changed`;
  const stamp = when(changedAt, timeZone);
  const text = [
    greeting(name),
    '',
    `The password for your ${appName} account was changed on ${stamp}. You were signed out everywhere.`,
    '',
    "If this was you, there is nothing more to do. If it wasn't, reset your password right away and tell the parking administration:",
    forgotUrl,
    '',
    sender({ appName, baseUrl, sentAt, timeZone }),
  ].join('\n');

  const html = frame({
    appName,
    preheader: `Your password was changed on ${stamp}.`,
    body:
      paragraph(esc(greeting(name))) +
      paragraph(`The password for your ${esc(appName)} account was changed on <strong>${esc(stamp)}</strong>. You were signed out everywhere.`) +
      paragraph("If this was you, there is nothing more to do. If it wasn't, reset your password right away and tell the parking administration:") +
      paragraph(`<a href="${esc(forgotUrl)}" style="color:#2563eb;word-break:break-all;">${esc(forgotUrl)}</a>`),
    footer: esc(sender({ appName, baseUrl, sentAt, timeZone })),
  });
  return { subject, text, html };
}

module.exports = { verificationCode, passwordReset, passwordChanged, esc, when };
