'use strict';

/** Small, dependency-free input helpers. Everything arriving from a form is a string. */

const clean = (v) => (v === undefined || v === null ? '' : String(v).trim());

const collapse = (v) => clean(v).replace(/\s+/g, ' ');

const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) && v.length <= 254;

const toInt = (v, fallback = null) => {
  const s = clean(v);
  if (!/^-?\d+$/.test(s)) return fallback;
  const n = parseInt(s, 10);
  return Number.isSafeInteger(n) ? n : fallback;
};

const normalizePlate = (v) => collapse(v).toUpperCase();
const plateKey = (v) => normalizePlate(v).replace(/\s/g, '');

/** At least 8 characters, with a letter and a number. */
function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < 8) return 'Password must be at least 8 characters.';
  if (password.length > 128) return 'Password is too long.';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'Password must include at least one letter and one number.';
  return null;
}

const oneOf = (v, list, fallback = null) => (list.includes(v) ? v : fallback);

module.exports = { clean, collapse, isEmail, toInt, normalizePlate, plateKey, passwordProblem, oneOf };
