'use strict';

const express = require('express');
const notifications = require('../../services/notifications');

const router = express.Router();

// Sidebar badges (Reservations, Payments, Etiquette Reports) and the unread records highlighted on those pages.
// Opening a section acknowledges its updates before the counts are taken, so the badge disappears on the page that
// shows them.
router.use(notifications.middleware);

// Polled by public/js/app.js so the badges update while a page stays open.
router.get('/notifications', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(res.locals.navBadges);
});

router.use('/', require('./dashboard'));
router.use('/slots', require('./slots'));
router.use('/reservations', require('./reservations'));
router.use('/operations', require('./operations'));
router.use('/payments', require('./payments'));
router.use('/drivers', require('./drivers'));
router.use('/reports', require('./reports'));
router.use('/settings', require('./settings'));

module.exports = router;
