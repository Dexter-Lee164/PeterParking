'use strict';
const { ValidationError } = require('./errors');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clean = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');
const cleanMultiline = (v) => (typeof v === 'string' ? v.trim() : '');

function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Use at least 8 characters.';
  if (pw.length > 72) return 'Use 72 characters or fewer.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Include at least one letter and one number.';
  return null;
}
const normalizePlate = (v) => clean(v).replace(/\s+/g, '').toUpperCase();
const PLATE_RE = /^[A-Z0-9-]{4,10}$/;

function assertNoErrors(fields) {
  if (Object.keys(fields).length) throw new ValidationError(fields);
}
const toInt = (v, d = null) => (/^-?\d+$/.test(String(v ?? '').trim()) ? parseInt(v, 10) : d);
const oneOf = (v, list) => list.includes(v);

module.exports = { EMAIL_RE, clean, cleanMultiline, passwordProblem, normalizePlate, PLATE_RE, assertNoErrors, toInt, oneOf };
