/* Parking map behaviour: select a slot, keep map + list in sync, switch zones/views, drive the summary rail. */
(function () {
  'use strict';
  var root = document.getElementById('slot-results');
  if (!root) return;
  var selected = null;
  var $ = function (id) { return document.getElementById(id); };
  var peso = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' });
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var time12 = function (hm) { var p = String(hm || '').split(':'), h = +p[0]; return isNaN(h) ? '—' : (h % 12 || 12) + ':' + p[1] + ' ' + (h < 12 ? 'AM' : 'PM'); };
  var dateText = function (d) { if (!d) return '—'; var x = new Date(d + 'T00:00:00Z'); return isNaN(x) ? '—' : x.toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); };
  var durationText = function (m) { if (!(m > 0)) return '—'; var h = Math.floor(m / 60), r = m % 60; return h ? (r ? h + ' h ' + r + ' min' : h + ' h') : r + ' min'; };

  function range() { return window.UPForm ? window.UPForm.range() : { date: '', start: '', end: '', ok: false, minutes: 0, hours: 0 }; }
  function stale() { return window.UPForm ? window.UPForm.isStale() : false; }

  function paint() {
    root.querySelectorAll('.slot.is-selected, tr.is-selected').forEach(function (n) { n.classList.remove('is-selected'); });
    root.querySelectorAll('.slot[aria-pressed="true"]').forEach(function (n) { n.setAttribute('aria-pressed', 'false'); });
    if (!selected) return;
    root.querySelectorAll('.slot[data-slot-id="' + selected.id + '"]').forEach(function (n) { n.classList.add('is-selected'); n.setAttribute('aria-pressed', 'true'); });
    var row = root.querySelector('tr[data-slot-row="' + selected.id + '"]'); if (row) row.classList.add('is-selected');
  }

  function renderSummary() {
    var r = range(), s = selected, isStale = stale();
    $('sum-date').textContent = dateText(r.date);
    $('sum-start').textContent = time12(r.start);
    $('sum-end').textContent = time12(r.end);
    $('sum-duration').textContent = r.ok ? durationText(r.minutes) : '—';
    $('sum-slot').textContent = s ? s.code : 'None selected';
    $('sum-zone').textContent = s ? s.zone : '—';
    $('sum-rate').textContent = s ? peso.format(s.rate / 100) + ' / hour' : '—';
    $('sum-fee').textContent = s && r.ok ? peso.format((s.rate * r.hours) / 100) : '—';
    $('sel-empty').hidden = !!s;
    $('sel-card').classList.toggle('is-on', !!s);
    if (s) {
      $('sel-code').textContent = s.code; $('sel-zone').textContent = s.zone; $('sel-type').textContent = s.type;
      $('sel-status').textContent = isStale ? 'Search again to confirm' : s.stateText;
      $('sel-rate').textContent = peso.format(s.rate / 100) + ' / hour';
      $('sel-period').textContent = dateText(r.date) + ', ' + time12(r.start) + ' – ' + time12(r.end);
      $('sel-ok').hidden = isStale;
    }
    var ok = !!s && r.ok && !isStale, btn = $('continue-btn');
    btn.setAttribute('aria-disabled', ok ? 'false' : 'true');
    $('continue-help').textContent = !s ? 'Select an available slot to continue.' : isStale ? 'You changed the time. Press Search availability first.' : !r.ok ? 'Fix the reservation time to continue.' : 'You will review the booking before it is confirmed.';
  }

  function select(el) {
    var d = el.dataset;
    selected = { id: d.slotId, code: d.code, zone: d.zone, type: d.type, rate: +d.rate, stateText: d.stateText || 'Available' };
    paint(); renderSummary();
  }
  function clear() { selected = null; paint(); renderSummary(); }

  function activateZone(id) {
    root.querySelectorAll('.zone-panel').forEach(function (p) { p.hidden = p.getAttribute('data-zone-panel') !== String(id); });
    root.querySelectorAll('.zone-tab').forEach(function (t) { var on = t.getAttribute('data-zone-id') === String(id); t.classList.toggle('active', on); t.setAttribute('aria-selected', on ? 'true' : 'false'); });
    var z = document.getElementById('flt-zone'); if (z && z.value !== String(id)) z.value = String(id);
    paint();
  }
  function setView(v) {
    var n = root.querySelector('.slot-results'); if (!n) return;
    n.setAttribute('data-view', v);
    root.querySelectorAll('[data-view-btn]').forEach(function (b) { var on = b.getAttribute('data-view-btn') === v; b.classList.toggle('active', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
  }

  root.addEventListener('click', function (e) {
    var tab = e.target.closest('.zone-tab'); if (tab) { e.preventDefault(); activateZone(tab.getAttribute('data-zone-id')); return; }
    var vb = e.target.closest('[data-view-btn]'); if (vb) { setView(vb.getAttribute('data-view-btn')); return; }
    var link = e.target.closest('.js-select-slot'); if (link) { e.preventDefault(); select(link); return; }
    var slot = e.target.closest('.slot'); if (slot && !slot.disabled) select(slot);
  });
  // Keyboard: arrow keys move between tabs in the zone tablist.
  root.addEventListener('keydown', function (e) {
    var tab = e.target.closest && e.target.closest('.zone-tab'); if (!tab || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return;
    var tabs = Array.prototype.slice.call(root.querySelectorAll('.zone-tab')), i = tabs.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : -1);
    var next = tabs[(i + tabs.length) % tabs.length]; next.focus(); activateZone(next.getAttribute('data-zone-id')); e.preventDefault();
  });

  document.addEventListener('slots:rendered', function () { clear(); });
  document.addEventListener('range:changed', renderSummary);
  document.addEventListener('zone:select', function (e) { activateZone(e.detail.id); });

  $('continue-form').addEventListener('submit', function (e) {
    var r = range();
    if (!selected || !r.ok || stale()) { e.preventDefault(); renderSummary(); return; }
    var f = e.target;
    f.elements.slot.value = selected.id; f.elements.date.value = r.date; f.elements.start.value = r.start; f.elements.end.value = r.end;
  });

  renderSummary();
})();
