'use strict';

/**
 * Renders the three e-mails (verification code, reset link, password-changed notice) to data/mail-preview/ so you can
 * open the HTML in a browser and read the plain-text version, without sending anything.
 *
 *   node scripts/mail-preview.js
 *
 * The code and link below are made-up samples; no database, no SMTP and no secrets are involved.
 */

const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const { createMailer } = require('../src/services/mail');

const outDir = path.join(config.rootDir, 'data', 'mail-preview');
fs.mkdirSync(outDir, { recursive: true });

// A console-mode mailer is only used to render; it is built with isProduction=false so this works on any machine.
const mailer = createMailer({ mail: { mode: 'console' }, isProduction: false });

const now = new Date();
const samples = {
  verificationCode: { name: 'Hehe Sample', code: '482913', expiresMinutes: 10, expiresAt: new Date(now.getTime() + 10 * 60000) },
  passwordReset: {
    name: 'Hehe Sample',
    resetUrl: config.url('/reset-password', { token: 'SAMPLE-TOKEN-NOT-VALID' }),
    expiresMinutes: 30,
    expiresAt: new Date(now.getTime() + 30 * 60000),
  },
  passwordChanged: { name: 'Hehe Sample', forgotUrl: config.url('/forgot-password'), changedAt: now },
};

for (const [template, data] of Object.entries(samples)) {
  const mail = mailer.render(template, Object.assign({ sentAt: now }, data));
  fs.writeFileSync(path.join(outDir, `${template}.html`), mail.html);
  fs.writeFileSync(path.join(outDir, `${template}.txt`), `Subject: ${mail.subject}\n\n${mail.text}\n`);
  console.log(`${template.padEnd(18)} ${mail.subject}`);
}
console.log(`\nWritten to ${outDir}\nOpen the .html files in your browser; the .txt files are the plain-text versions.`);
