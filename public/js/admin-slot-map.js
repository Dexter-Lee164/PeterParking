/* Admin Parking Slots: the zone's lot map is read-only; choosing a stall opens that slot's operations page.
   The search / status / type filters act on the map straight away: stalls that do not match are set back. */
(function () {
  'use strict';

  var map = document.querySelector('[data-admin-slot-map]');
  if (!map) return;
  map.addEventListener('click', function (event) {
    var stall = event.target.closest('.slot[data-slot-id]');
    if (stall) window.location.href = '/admin/slots/' + encodeURIComponent(stall.dataset.slotId) + '/edit';
  });

  var form = document.getElementById('slotFilter');
  if (!form) return;
  var stalls = Array.prototype.slice.call(map.querySelectorAll('.slot[data-slot-id]'));
  var count = map.querySelector('[data-filter-count]');
  var zoneSlotsEl = document.getElementById('zoneSlots');
  var zoneSlots = zoneSlotsEl ? JSON.parse(zoneSlotsEl.textContent) : {};

  function matches(code, notes, type, status, f) {
    return (!f.status || status === f.status) && (!f.type || type === f.type)
      && (!f.q || code.toLowerCase().indexOf(f.q) >= 0 || (notes || '').toLowerCase().indexOf(f.q) >= 0);
  }

  function apply() {
    var f = { q: form.elements.q.value.trim().toLowerCase(), status: form.elements.status.value, type: form.elements.type.value };
    var filtering = !!(f.q || f.status || f.type);
    var shown = 0;
    stalls.forEach(function (s) {
      var match = matches(s.dataset.code, s.dataset.notes, s.dataset.type, s.dataset.status, f);
      s.classList.toggle('is-filtered-out', filtering && !match);
      if (match) shown += 1;
    });
    // Each zone tab shows how many of its slots match the filters.
    document.querySelectorAll('[data-zone-link]').forEach(function (a) {
      var badge = a.querySelector('[data-zone-count]');
      var list = zoneSlots[a.dataset.zoneLink] || [];
      if (badge) badge.textContent = list.filter(function (s) { return matches(s[0], s[1], s[2], s[3], f); }).length;
    });
    if (count) {
      count.hidden = !filtering;
      count.textContent = shown + ' of ' + stalls.length + ' slots match the filters';
    }
    // Keep the address in step so a reload or a shared link shows the same filter.
    var params = new URLSearchParams(new FormData(form));
    Array.from(params.keys()).forEach(function (k) { if (!params.get(k) && k !== 'zone') params.delete(k); });
    window.history.replaceState(null, '', form.action + '?' + params.toString());
    // Zone tabs carry the current filters so switching zones keeps them.
    document.querySelectorAll('[data-zone-link]').forEach(function (a) {
      params.set('zone', a.dataset.zoneLink);
      a.href = form.action + '?' + params.toString();
    });
  }

  form.addEventListener('input', apply);
  form.addEventListener('change', apply);
  form.addEventListener('submit', function (event) { event.preventDefault(); apply(); });
})();
