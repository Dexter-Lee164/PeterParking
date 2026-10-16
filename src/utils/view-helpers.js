'use strict';
const T = require('./time');
const { pesos } = require('./money');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  map: '<path d="M9 4 3 6.5v13L9 17l6 3 6-2.5v-13L15 7 9 4Z"/><path d="M9 4v13M15 7v13"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  swap: '<path d="M7 7h13l-3-3M17 17H4l3 3"/>',
  card: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M2.5 10h19M6 15h4"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.5-3.6 3.2-5.5 6.5-5.5s6 1.9 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c1.9.7 3.2 2.4 3.5 5.2"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  car: '<path d="M5 16.5V12l1.6-4.2A2 2 0 0 1 8.5 6.5h7a2 2 0 0 1 1.9 1.3L19 12v4.5M3.5 16.5h17M5 16.5v2.5M19 16.5v2.5"/><circle cx="8" cy="13.5" r=".8"/><circle cx="16" cy="13.5" r=".8"/>',
  moto: '<circle cx="5.5" cy="16" r="3"/><circle cx="18.5" cy="16" r="3"/><path d="M5.5 16 9 9h4l3 4 2.5 3M13 9l-1.5-3H9"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c.7-4.2 4-6.5 8-6.5s7.3 2.3 8 6.5"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="M12 4 2.5 20h19L12 4Z"/><path d="M12 10v4.5M12 17.5v.1"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.1"/>',
  download: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
  print: '<path d="M7 9V3.5h10V9M7 17H4.5v-6.5h15V17H17M7 14h10v6.5H7z"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0-5 5L3.5 17.5a1.8 1.8 0 0 0 2.5 2.5l6.2-6.2a4 4 0 0 0 5-5l-2.4 2.4-2.4-.6-.6-2.4 2.4-2.4Z"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  accessible: '<circle cx="12" cy="4.5" r="1.8"/><path d="M12 8v6h5l2 5M12 11h5M9.5 11.5a5 5 0 1 0 5.5 7"/>',
  bike: '<circle cx="6" cy="16" r="3.5"/><circle cx="18" cy="16" r="3.5"/><path d="M6 16l4-8h5l3 8M10 8H8"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  edit: '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3ZM14 7l3 3"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
  bell: '<path d="M6 17V11a6 6 0 1 1 12 0v6l1.5 2h-15L6 17ZM10 21h4"/>',
};
const icon = (name, size = 18, cls = '') => `<svg class="icon ${esc(cls)}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] || ICONS.info}</svg>`;

/** Status vocabulary: [label, css modifier, icon] per kind. */
const STATUS = {
  reservation: { confirmed: ['Upcoming', 'info', 'calendar'], active: ['Parked', 'success', 'car'], completed: ['Completed', 'muted', 'check'], cancelled: ['Cancelled', 'danger', 'x'], no_show: ['No-show', 'warning', 'alert'] },
  slot: { available: ['Available', 'success', 'check'], reserved: ['Reserved', 'info', 'calendar'], occupied: ['Occupied', 'danger', 'car'], unavailable: ['Unavailable', 'muted', 'wrench'], active: ['In service', 'success', 'check'], maintenance: ['Maintenance', 'muted', 'wrench'], inactive: ['Inactive', 'muted', 'lock'] },
  payment: { unpaid: ['Unpaid', 'warning', 'clock'], partial: ['Partially paid', 'warning', 'clock'], paid: ['Paid', 'success', 'check'], overpaid: ['Credit due', 'info', 'info'], none: ['No fee', 'muted', 'info'], valid: ['Valid', 'success', 'check'], voided: ['Voided', 'danger', 'x'] },
  session: { active: ['Parked now', 'success', 'car'], completed: ['Checked out', 'muted', 'check'], late: ['Late arrival', 'warning', 'alert'], overstay: ['Overstay', 'danger', 'alert'] },
  account: { active: ['Active', 'success', 'check'], inactive: ['Inactive', 'muted', 'lock'] },
};
function statusBadge(kind, status) {
  const [label, tone, ic] = (STATUS[kind] && STATUS[kind][status]) || [String(status), 'muted', 'info'];
  return `<span class="status-badge status-${tone}">${icon(ic, 13)}<span>${esc(label)}</span></span>`;
}

const qs = (params, overrides = {}) => {
  const merged = { ...params, ...overrides };
  const s = Object.entries(merged).filter(([, v]) => v !== '' && v != null && v !== false).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return s ? `?${s}` : '';
};
const initials = (name) => String(name || '?').split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
const paginate = (total, page, size) => ({ page, size, total, pages: Math.max(1, Math.ceil(total / size)), from: total ? (page - 1) * size + 1 : 0, to: Math.min(total, page * size) });
const link = (href, text, cls = '') => `<a class="${esc(cls)}" href="${esc(href)}">${esc(text)}</a>`;
const stack = (mainHtml, sub) => `${mainHtml}<span class="cell-sub">${esc(sub)}</span>`;
const typeLabel = { standard: 'Standard', compact: 'Compact', accessible: 'Accessible', motorcycle: 'Motorcycle' };
const methodLabel = { cash: 'Cash', gcash: 'GCash', bank_transfer: 'Bank transfer', other: 'Other' };

module.exports = { esc, icon, statusBadge, qs, initials, paginate, link, stack, typeLabel, methodLabel, pesos, ...T };
