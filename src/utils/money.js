'use strict';
const fmt = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' });
const pesos = (centavos) => fmt.format((Number(centavos) || 0) / 100);
/** Parse "1,250.50" / "₱20" to integer centavos, or null if invalid. */
function parsePesos(input) {
  const s = String(input ?? '').replace(/[₱,\s]/g, '');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
}
const centavosToInput = (c) => (c / 100).toFixed(2);
module.exports = { pesos, parsePesos, centavosToInput };
