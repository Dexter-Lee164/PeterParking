'use strict';

/** Money is stored as integer centavos and displayed as Philippine pesos. */

function formatPeso(centavos) {
  const n = Number(centavos) || 0;
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(Math.round(n));
  const pesos = Math.floor(abs / 100);
  const cents = String(abs % 100).padStart(2, '0');
  return `${sign}₱${pesos.toLocaleString('en-PH')}.${cents}`;
}

/** Plain decimal pesos for CSV / inputs, e.g. 12550 -> "125.50". */
function toPesoString(centavos) {
  const n = Number(centavos) || 0;
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(Math.round(n));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Parse a user-entered peso amount ("125", "125.5", "1,250.00") into integer
 * centavos. Returns null for anything that is not a valid non-negative amount
 * with at most two decimal places.
 */
function parsePesoToCentavos(input) {
  if (input === null || input === undefined) return null;
  const s = String(input).replace(/[₱,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const centavos = parseInt(whole, 10) * 100 + parseInt((frac + '00').slice(0, 2), 10);
  return Number.isSafeInteger(centavos) ? centavos : null;
}

module.exports = { formatPeso, toPesoString, parsePesoToCentavos };
