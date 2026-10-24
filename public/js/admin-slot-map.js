/* Admin Parking Slots: the zone's lot map is read-only; choosing a stall opens that slot's operations page. */
(function () {
  'use strict';

  var map = document.querySelector('[data-admin-slot-map]');
  if (!map) return;
  map.addEventListener('click', function (event) {
    var stall = event.target.closest('.slot[data-slot-id]');
    if (stall) window.location.href = '/admin/slots/' + encodeURIComponent(stall.dataset.slotId) + '/edit';
  });
})();
