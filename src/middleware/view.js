'use strict';

const time = require('../utils/time');
const { formatPeso, toPesoString } = require('../utils/money');
const { badge } = require('../utils/badges');
const { navFor } = require('../utils/navigation');
const lotLayout = require('../utils/lotLayout');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const emailRules = require('../../public/js/email-rules');
const { methodLabel } = require('../services/payments');

const APP_NAME = 'University Parking';
const TAGLINE = 'Reserve. Park. Go.';

/** `/js/app.js` → `/js/app.js?v=<modified time>`: a changed file gets a new address, so no browser serves a stale copy. */
const assetVersions = new Map();
function asset(href) {
  if (config.isProduction && assetVersions.has(href)) return assetVersions.get(href);
  let out = href;
  try {
    out = `${href}?v=${Math.floor(fs.statSync(path.join(config.rootDir, 'public', href)).mtimeMs).toString(36)}`;
  } catch (err) {
    // Not a file under public/ (e.g. a vendor path): leave it as it is.
  }
  assetVersions.set(href, out);
  return out;
}

/** Template helpers available in every EJS view. */
const helpers = {
  asset,
  appName: APP_NAME,
  tagline: TAGLINE,
  fmtDate: time.fmtDate,
  fmtDateShort: time.fmtDateShort,
  fmtTime: time.fmtTime,
  fmtDateTime: time.fmtDateTime,
  fmtHHMM: time.fmtHHMM,
  fmtDuration: time.fmtDuration,
  peso: formatPeso,
  pesoPlain: toPesoString,
  badge,
  lotLayout,
  /** "Did you mean ...?" address for a mistyped provider domain, or null (shared rules; see public/js/email-rules.js). */
  suggestEmail: (value) => emailRules.suggest(value),
  /** 'today' | 'future' | 'past' for a stored start time, by the campus calendar day. */
  dayTier: (startAt) => {
    const day = String(startAt || '').slice(0, 10);
    const today = time.todayLocal();
    return day === today ? 'today' : day > today ? 'future' : 'past';
  },
  /** "Cash", or the label of an older non-cash record. */
  paymentMethod: (m) => methodLabel(m),
  titleCase: (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
  vehicleLabel: (v) => [v.make, v.model].filter(Boolean).join(' ') || v.vehicle_type,
  /** Icon classes for a vehicle type: a car, or a motorcycle (.vi-motorcycle in components.css; Bootstrap Icons has none). */
  vehicleIcon: (type) => (type === 'motorcycle' ? 'vi vi-motorcycle' : 'bi bi-car-front'),
  /** Is this record one of the unread updates the page was opened for? (see src/services/notifications.js) */
  isUnread: () => false,
  initials: (name) =>
    String(name || '?')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join(''),
  /** Compact peso for tiles: ₱30 or ₱37.50 */
  pesoShort: (c) => (Number(c) % 100 === 0 ? `₱${Number(c) / 100}` : formatPeso(c)),
  /** Build a query string from an object, dropping empty values, with optional overrides. */
  qs: (base = {}, overrides = {}) => {
    const merged = Object.assign({}, base, overrides);
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(merged)) {
      if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
    }
    const out = params.toString();
    return out ? `?${out}` : '';
  },
};

function flash(req, res, next) {
  req.flash = (type, message) => {
    req.session.flash = req.session.flash || [];
    req.session.flash.push({ type, message });
  };
  res.locals.flash = req.session.flash || [];
  if (req.session.flash) delete req.session.flash;
  next();
}

/**
 * Adds `res.view(name, data)`: renders views/<name>.ejs and wraps it in a layout
 * (views/layouts/main.ejs by default, or `layout: 'auth'`, or `layout: false`).
 */
function view(req, res, next) {
  Object.assign(res.locals, helpers);
  res.locals.currentPath = req.path;
  res.locals.title = '';
  res.locals.nav = '';
  res.locals.activeNav = '';
  res.locals.breadcrumbs = [];
  res.locals.pageActions = null;
  res.locals.unreadTotal = 0;
  res.locals.extraScripts = [];
  res.locals.extraStyles = [];
  res.locals.isProduction = config.isProduction;

  res.view = function renderView(name, data = {}, status) {
    // Express/EJS locate partials through a local named `settings`; overriding it breaks every include.
    if (Object.prototype.hasOwnProperty.call(data, 'settings')) {
      return next(new Error('res.view: "settings" is a reserved template variable. Pass booking rules as "rules" instead.'));
    }
    const layout = data.layout === undefined ? 'main' : data.layout;
    const locals = Object.assign({}, res.locals, data);
    locals.activeNav = data.nav || locals.activeNav || '';
    locals.navItems = req.user ? navFor(req.user.role) : [];
    if (status) res.status(status);
    req.app.render(name, locals, (err, body) => {
      if (err) return next(err);
      if (!layout) return res.send(body);
      return req.app.render(`layouts/${layout}`, Object.assign({}, locals, { body }), (err2, html) => {
        if (err2) return next(err2);
        return res.send(html);
      });
    });
  };
  next();
}

module.exports = { view, flash, helpers };
