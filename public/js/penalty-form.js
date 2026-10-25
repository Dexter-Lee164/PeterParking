/*
 * Admin penalty form: show only the fields of the chosen penalty type (amount, surcharge end, ban dates) and word the
 * confirmation dialog (app.js reads data-confirm when the form is submitted) after what is about to happen.
 * The server validates everything again (src/services/penalties.js).
 */
(function () {
  'use strict';

  document.querySelectorAll('form[data-penalty-form]').forEach(function (form) {
    var kind = form.querySelector('[name="kind"]');
    var amount = form.querySelector('[name="amount"]');
    var expires = form.querySelector('[name="expires_on"]');
    var start = form.querySelector('[name="start_date"]');
    var end = form.querySelector('[name="end_date"]');
    var who = form.dataset.driver + ' (' + form.dataset.plate + ')';

    function money() {
      return amount.value.trim() ? '₱' + amount.value.trim() : 'the fee';
    }

    function sync() {
      form.querySelectorAll('[data-penalty-for]').forEach(function (input) {
        var kinds = input.dataset.penaltyFor.split(' ');
        input.closest('[class*="col-"]').classList.toggle('d-none', kinds.indexOf(kind.value) < 0);
      });
      var what;
      if (kind.value === 'fee_once') what = 'add a one-time fee of ' + money() + ' to the next reservation of ' + who;
      else if (kind.value === 'surcharge') what = 'add ' + money() + ' to every new reservation of ' + who + (expires.value ? ' until ' + expires.value : ' until revoked');
      else if (kind.value === 'temp_ban') what = 'ban ' + who + ' from new reservations from ' + (start.value || 'the start date') + ' to ' + (end.value || 'the end date');
      else if (kind.value === 'perm_ban') what = 'ban ' + who + ' from new reservations until an administrator revokes the ban';
      else what = 'issue this penalty to ' + who;
      form.setAttribute('data-confirm', 'This will ' + what + '. The driver is notified and it is recorded in the audit log. Continue?');
    }

    [kind, amount, expires, start, end].forEach(function (el) {
      el.addEventListener('input', sync);
      el.addEventListener('change', sync);
    });
    sync();
  });
})();
