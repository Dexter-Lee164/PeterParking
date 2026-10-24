/*
 * Admin penalty form: show the amount field for an additional fee and the days field for a temporary ban, and word
 * the confirmation dialog (app.js reads data-confirm when the form is submitted) after what is about to happen.
 */
(function () {
  'use strict';

  document.querySelectorAll('form[data-penalty-form]').forEach(function (form) {
    var kind = form.querySelector('[name="kind"]');
    var amount = form.querySelector('[name="amount"]');
    var days = form.querySelector('[name="days"]');
    var plate = form.dataset.plate;

    function sync() {
      form.querySelectorAll('[data-penalty-for]').forEach(function (input) {
        input.closest('[class*="col-"]').classList.toggle('d-none', input.dataset.penaltyFor !== kind.value);
      });
      var what = kind.value === 'surcharge' ? 'add ' + (amount.value ? '₱' + amount.value.trim() : 'an additional fee') + ' to every new reservation made with ' + plate
        : kind.value === 'temp_ban' ? 'ban ' + plate + ' from parking reservations for ' + (days.value ? days.value + ' day(s)' : 'the chosen number of days')
        : kind.value === 'perm_ban' ? 'ban ' + plate + ' from parking reservations permanently'
        : 'apply this penalty to ' + plate;
      form.setAttribute('data-confirm', 'This will ' + what + '. It takes effect immediately, stays with the plate and is recorded in the audit log. Continue?');
    }

    kind.addEventListener('change', sync);
    amount.addEventListener('input', sync);
    days.addEventListener('input', sync);
    sync();
  });
})();
