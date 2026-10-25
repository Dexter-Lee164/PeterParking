'use strict';

const crypto = require('crypto');
const { AppError } = require('../utils/errors');

/**
 * Photo evidence for etiquette reports and penalty appeals.
 *
 * The app has no multipart uploads: public/js/evidence-input.js reads the chosen image in the browser and posts it as a
 * data: URL in a hidden field. Here it is checked again, never trusted: only JPEG, PNG, WebP and GIF (no SVG, which can
 * carry scripts), at most 2 MB, and the bytes must start with that format's signature. Images are stored in the
 * database (so backups carry them) and served only to the people allowed to see them (see send()).
 */

const MAX_BYTES = 2 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

const SIGNATURES = {
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/gif': (b) => b.length > 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1')),
  'image/webp': (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};

/**
 * A data: URL from a form → { mime, data, size, sha256 }, or null when nothing was attached. Throws a VALIDATION error
 * on `field` when it is not a usable image.
 */
function parse(dataUrl, field = 'evidence') {
  const raw = String(dataUrl || '').trim();
  if (!raw) return null;
  const problem = (msg) => new AppError('Please correct the highlighted fields.', { code: 'VALIDATION', fields: { [field]: msg } });
  // Rough size check before decoding: base64 is 4/3 of the bytes.
  if (raw.length > Math.ceil((MAX_BYTES * 4) / 3) + 64) throw problem('The image must be 2 MB or smaller.');
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(raw);
  if (!m) throw problem('Attach a JPEG, PNG, WebP or GIF image.');
  const data = Buffer.from(m[2], 'base64');
  if (!data.length) throw problem('The image is empty.');
  if (data.length > MAX_BYTES) throw problem('The image must be 2 MB or smaller.');
  if (!SIGNATURES[m[1]](data)) throw problem('That file is not a valid image.');
  return { mime: m[1], data, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
}

/** Send a stored image ({ mime, data }) inline, never cached by shared caches, never sniffed or run as a page. */
function send(res, file, name) {
  const mime = TYPES.includes(file.mime) ? file.mime : 'application/octet-stream';
  res.set({
    'Content-Type': mime,
    'Content-Disposition': `inline; filename="${name}.${EXT[mime] || 'bin'}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  res.send(file.data);
}

module.exports = { MAX_BYTES, TYPES, parse, send };
