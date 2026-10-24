'use strict';

const users = require('../services/users');
const { homeFor } = require('../utils/navigation');

/** Load the signed-in user from the session on every request (so deactivation takes effect immediately). */
function loadUser(req, res, next) {
  req.user = null;
  const id = req.session && req.session.userId;
  if (id) {
    const user = users.getUser(id);
    // A session that began before the password was last reset is no longer valid (the store also deletes them; this is
    // the safety net for any copy that survived, and for sessions created before authAt existed).
    const stale = user && user.password_changed_at && !(req.session.authAt && req.session.authAt >= user.password_changed_at);
    if (user && user.is_active && !stale) {
      req.user = user;
    } else {
      // Account removed, deactivated or password reset while signed in.
      delete req.session.userId;
    }
  }
  res.locals.currentUser = req.user;
  req.actor = req.user ? { id: req.user.id, ip: req.ip } : { id: null, ip: req.ip };
  next();
}

function requireLogin(req, res, next) {
  if (req.user) return next();
  if (req.method === 'GET') req.session.returnTo = req.originalUrl;
  if (req.xhr || (req.accepts(['html', 'json']) === 'json')) return res.status(401).json({ error: 'Please sign in again.' });
  return res.redirect('/login');
}

/** Role gate. Signed-in users of the wrong role are sent to their own home area. */
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return requireLogin(req, res, next);
    if (req.user.role === role) return next();
    if (req.accepts(['html', 'json']) === 'json') return res.status(403).json({ error: 'You do not have access to this area.' });
    return res.redirect(homeFor(req.user.role));
  };
}

module.exports = { loadUser, requireLogin, requireRole };
