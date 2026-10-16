/* Reservation filter toolbar: validates the time range, shows the duration, and refreshes availability from the server. */
(function () {
  'use strict';
  var form = document.getElementById('availability-form');
  if (!form) return;
  var results = document.getElementById('slot-results');
  var $ = function (n) { return form.elements[n]; };
  var out = document.getElementById('duration-out'), hint = document.getElementById('range-hint');
  var stale = document.getElementById('stale-banner'), live = document.getElementById('results-status');
  var searched = null;

  var mins = function (hm) { var p = String(hm || '').split(':'); return p.length === 2 ? (+p[0]) * 60 + (+p[1]) : NaN; };
  var durationText = function (m) { var h = Math.floor(m / 60), r = m % 60; return h ? (r ? h + ' h ' + r + ' min' : h + ' h') : r + ' min'; };
  var snapshot = function () { return [$('date').value, $('start').value, $('end').value, $('vehicleType') ? $('vehicleType').value : ''].join('|'); };

  function syncEndOptions(keepGap) {
    var s = mins($('start').value), end = $('end'), prev = mins(end.value) - s;
    Array.prototype.forEach.call(end.options, function (o) { o.disabled = mins(o.value) <= s; });
    if (mins(end.value) <= s) {
      var want = keepGap && prev > 0 ? prev : 120, best = null;
      Array.prototype.forEach.call(end.options, function (o) { if (!o.disabled && best === null && mins(o.value) - s >= want) best = o; });
      if (!best) { for (var i = end.options.length - 1; i >= 0; i--) { if (!end.options[i].disabled) { best = end.options[i]; break; } } }
      if (best) end.value = best.value;
    }
  }

  function validate() {
    var msgs = [], s = mins($('start').value), e = mins($('end').value), d = $('date').value;
    if (!d) msgs.push('Choose a reservation date.');
    else if ($('date').min && d < $('date').min) msgs.push('That date has already passed.');
    else if ($('date').max && d > $('date').max) msgs.push('Bookings open up to ' + $('date').dataset.days + ' days ahead.');
    if (!(e > s)) msgs.push('End time must be after the start time.');
    out.textContent = e > s ? durationText(e - s) : '—';
    out.classList.toggle('is-bad', !(e > s));
    hint.textContent = msgs.join(' ');
    return { ok: !msgs.length, minutes: e - s, hours: Math.ceil((e - s) / 60) };
  }

  function markStale() {
    var isStale = searched !== null && snapshot() !== searched;
    if (stale) stale.hidden = !isStale;
    document.dispatchEvent(new CustomEvent('range:changed', { detail: { stale: isStale, range: currentRange() } }));
  }
  function currentRange() { var v = validate(); return { date: $('date').value, start: $('start').value, end: $('end').value, ok: v.ok, minutes: v.minutes, hours: v.hours }; }

  async function search() {
    var v = validate(); if (!v.ok) { hint.setAttribute('tabindex', '-1'); hint.focus(); return; }
    var params = new URLSearchParams();
    ['date', 'start', 'end', 'zone', 'vehicleType'].forEach(function (n) { if ($(n) && $(n).value) params.set(n, $(n).value); });
    results.parentElement.classList.add('is-loading');
    try {
      var res = await fetch('/driver/find-parking/results?' + params.toString(), { credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' } });
      if (res.status === 401) { window.location.href = '/login'; return; }
      results.innerHTML = await res.text();
      searched = snapshot();
      history.replaceState(null, '', '/driver/find-parking?' + params.toString());
      var n = results.querySelector('.slot-results'), free = n ? n.getAttribute('data-available') : '0';
      live.textContent = res.ok ? free + ' slots available for the selected time.' : 'Check your reservation time.';
      document.dispatchEvent(new CustomEvent('slots:rendered', { detail: { ok: res.ok, range: currentRange() } }));
      if (stale) stale.hidden = true;
    } catch (err) {
      live.textContent = 'Could not refresh availability. Check your connection and try again.';
      hint.textContent = live.textContent;
    } finally { results.parentElement.classList.remove('is-loading'); }
  }

  form.addEventListener('submit', function (e) { e.preventDefault(); search(); });
  $('start').addEventListener('change', function () { syncEndOptions(true); validate(); markStale(); });
  ['date', 'end', 'vehicleType'].forEach(function (n) { if ($(n)) $(n).addEventListener('change', function () { validate(); markStale(); }); });
  if ($('zone')) $('zone').addEventListener('change', function () { document.dispatchEvent(new CustomEvent('zone:select', { detail: { id: $('zone').value } })); });

  syncEndOptions(false); validate();
  if (results.querySelector('.slot-results')) searched = snapshot();
  window.UPForm = { range: currentRange, isStale: function () { return searched !== null && snapshot() !== searched; } };
  document.dispatchEvent(new CustomEvent('range:changed', { detail: { stale: false, range: currentRange() } }));
})();
