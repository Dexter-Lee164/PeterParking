'use strict';

const express = require('express');
const dashboard = require('../../services/dashboard');
const sessions = require('../../services/sessions');
const time = require('../../utils/time');

const router = express.Router();

router.get('/', (req, res) => {
  const data = dashboard.adminDashboard();
  const parked = sessions.activeSessions();
  const arrivals = sessions.expectedArrivals().slice(0, 6);
  res.view('admin/dashboard', {
    title: 'Dashboard',
    nav: 'dashboard',
    data,
    parked: parked.slice(0, 6),
    parkedCount: parked.length,
    overstayCount: parked.filter((p) => p.overstaying).length,
    arrivals,
    today: time.fmtDate(time.todayLocal()),
    chartData: data.charts,
    extraScripts: ['/vendor/chartjs/chart.umd.min.js', '/js/charts.js'],
  });
});

module.exports = router;
