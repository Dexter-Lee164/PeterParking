/* Admin dashboard charts. Data comes from a JSON <script id="chart-data"> rendered from real SQLite queries. */
(function () {
  'use strict';
  if (typeof Chart === 'undefined') return;

  var node = document.getElementById('chart-data');
  if (!node) return;
  var data;
  try { data = JSON.parse(node.textContent); } catch (e) { return; }

  var css = getComputedStyle(document.documentElement);
  function v(name, fallback) { return (css.getPropertyValue(name) || '').trim() || fallback; }
  var C = {
    text: v('--up-text', '#cbd5e1'),
    muted: v('--up-muted', '#94a3b8'),
    grid: 'rgba(148, 163, 184, 0.14)',
    blue: v('--up-accent', '#2563eb'),
    green: v('--up-available', '#16a34a'),
    red: v('--up-occupied', '#dc2626'),
    amber: v('--up-warning', '#f59e0b'),
    gray: v('--up-unavailable', '#64748b'),
    teal: '#14b8a6',
  };

  Chart.defaults.color = C.muted;
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.font.size = 12;
  Chart.defaults.maintainAspectRatio = false;
  Chart.defaults.plugins.legend.labels.boxWidth = 10;
  Chart.defaults.plugins.tooltip.backgroundColor = '#0f172a';
  Chart.defaults.plugins.tooltip.borderColor = 'rgba(148,163,184,.3)';
  Chart.defaults.plugins.tooltip.borderWidth = 1;

  var scales = function (extra) {
    return Object.assign({
      x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } },
      y: { beginAtZero: true, grid: { color: C.grid }, ticks: { precision: 0 } },
    }, extra || {});
  };
  function mount(id, config) {
    var el = document.getElementById(id);
    if (el) new Chart(el, config);
  }

  // ---- dashboard -----------------------------------------------------
  var ch = data.charts || data;
  if (ch.reservationsOverTime) {
    mount('chartReservations', {
      type: 'line',
      data: {
        labels: ch.reservationsOverTime.labels,
        datasets: [{ label: 'Reservations', data: ch.reservationsOverTime.values, borderColor: C.blue, backgroundColor: 'rgba(37,99,235,.18)', fill: true, tension: 0.3, pointRadius: 3 }],
      },
      options: { scales: scales(), plugins: { legend: { display: false } } },
    });
  }
  if (ch.outcomes) {
    mount('chartOutcomes', {
      type: 'doughnut',
      data: { labels: ch.outcomes.labels, datasets: [{ data: ch.outcomes.values, backgroundColor: [C.green, C.blue, C.gray, C.red], borderColor: '#111a2e', borderWidth: 2 }] },
      options: { cutout: '62%', plugins: { legend: { position: 'bottom' } } },
    });
  }
  if (ch.peakHours) {
    mount('chartPeak', {
      type: 'bar',
      data: { labels: ch.peakHours.labels, datasets: [{ label: 'Bookings', data: ch.peakHours.values, backgroundColor: C.teal, borderRadius: 4 }] },
      options: { scales: scales(), plugins: { legend: { display: false } } },
    });
  }
  if (ch.demandByZone) {
    mount('chartZones', {
      type: 'bar',
      data: { labels: ch.demandByZone.labels, datasets: [{ label: 'Bookings', data: ch.demandByZone.values, backgroundColor: C.blue, borderRadius: 4 }] },
      options: { indexAxis: 'y', scales: { x: { beginAtZero: true, grid: { color: C.grid }, ticks: { precision: 0 } }, y: { grid: { display: false } } }, plugins: { legend: { display: false } } },
    });
  }
  if (ch.collections) {
    mount('chartCollections', {
      type: 'bar',
      data: { labels: ch.collections.labels, datasets: [{ label: 'Collected (₱)', data: ch.collections.values, backgroundColor: C.green, borderRadius: 4 }] },
      options: { scales: scales({ y: { beginAtZero: true, grid: { color: C.grid } } }), plugins: { legend: { display: false } } },
    });
  }
})();
