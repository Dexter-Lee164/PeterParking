/* Dashboard and report charts (Chart.js, themed for the dark UI). Data comes from #chart-data as JSON. */
(function () {
  'use strict';
  var dataEl = document.getElementById('chart-data');
  if (!dataEl || !window.Chart) return;
  var d = JSON.parse(dataEl.textContent);
  var C = window.Chart;
  var css = getComputedStyle(document.documentElement);
  var v = function (n, f) { return (css.getPropertyValue(n) || f).trim() || f; };
  C.defaults.color = v('--muted', '#98A5BD');
  C.defaults.borderColor = v('--border', '#243049');
  C.defaults.font.family = v('--font', 'system-ui, sans-serif');
  C.defaults.plugins.legend.labels.boxWidth = 10;
  C.defaults.maintainAspectRatio = false;
  var blue = v('--primary', '#2563EB'), green = v('--available', '#16A34A'), red = v('--occupied', '#EF4444'), amber = v('--warning', '#F59E0B'), grey = v('--unavailable', '#6B7280');
  var grid = { color: 'rgba(255,255,255,.06)' };
  var peso = function (n) { return '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 0, maximumFractionDigits: 2 }); };

  function make(id, config) { var el = document.getElementById(id); if (el) new C(el, config); }

  if (d.reservations) make('chart-reservations', { type: 'line', data: { labels: d.reservations.labels, datasets: [{ label: 'Reservations', data: d.reservations.values, borderColor: blue, backgroundColor: 'rgba(37,99,235,.18)', fill: true, tension: .35, pointRadius: 3 }] },
    options: { plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 }, grid: grid } } } });
  if (d.peakHours) make('chart-peak', { type: 'bar', data: { labels: d.peakHours.labels, datasets: [{ label: 'Reservations starting', data: d.peakHours.values, backgroundColor: blue, borderRadius: 4 }] },
    options: { plugins: { legend: { display: false } }, scales: { x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } }, y: { beginAtZero: true, ticks: { precision: 0 }, grid: grid } } } });
  if (d.zones) make('chart-zones', { type: 'bar', data: { labels: d.zones.labels, datasets: [{ label: 'Reservations (30 days)', data: d.zones.values, backgroundColor: [blue, green, amber, '#8B5CF6', '#14B8A6', '#EC4899'], borderRadius: 4 }] },
    options: { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 }, grid: grid }, y: { grid: { display: false } } } } });
  if (d.outcomes) make('chart-outcomes', { type: 'doughnut', data: { labels: d.outcomes.labels, datasets: [{ data: d.outcomes.values, backgroundColor: [green, blue, amber, red], borderColor: v('--surface', '#111A2E'), borderWidth: 3 }] },
    options: { cutout: '64%', plugins: { legend: { position: 'bottom' } } } });
  if (d.collections) make('chart-collections', { type: 'bar', data: { labels: d.collections.labels, datasets: [{ label: 'Recorded collections', data: d.collections.values, backgroundColor: green, borderRadius: 4 }] },
    options: { plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (c) { return peso(c.parsed.y); } } } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { callback: function (x) { return peso(x); } }, grid: grid } } } });
  if (d.report) make('chart-report', { data: { labels: d.report.labels, datasets: [
      { type: 'bar', label: 'Reservations', data: d.report.reservations, backgroundColor: blue, borderRadius: 4, yAxisID: 'y' },
      { type: 'line', label: 'Utilization %', data: d.report.utilization, borderColor: amber, backgroundColor: amber, tension: .3, pointRadius: 3, yAxisID: 'y1' }] },
    options: { plugins: { legend: { position: 'bottom' } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 }, grid: grid }, y1: { position: 'right', beginAtZero: true, max: 100, grid: { display: false }, ticks: { callback: function (x) { return x + '%'; } } } } } });
})();
