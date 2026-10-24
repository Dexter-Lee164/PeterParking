/*
 * Shared reservation helpers (window.UPReservation) + behaviour for any form marked
 * data-time-form (used by the reschedule dialog). The server always re-validates
 * every rule; this exists only to give instant feedback.
 */
(function () {
  'use strict';

  function hhmmToMinutes(hhmm) {
    var p = String(hhmm || '').split(':');
    return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
  }
  function minutesToHHMM(m) {
    var h = Math.floor(m / 60);
    var mm = m % 60;
    return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm;
  }
  function label12(hhmm) {
    var m = hhmmToMinutes(hhmm);
    var h = Math.floor(m / 60);
    var mm = m % 60;
    var suffix = h >= 12 ? 'PM' : 'AM';
    var h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + ':' + (mm < 10 ? '0' : '') + mm + ' ' + suffix;
  }
  function fmtDuration(minutes) {
    if (!isFinite(minutes) || minutes <= 0) return '—';
    var h = Math.floor(minutes / 60);
    var r = minutes % 60;
    if (h && r) return h + 'h ' + r + 'm';
    if (h) return h + 'h';
    return r + 'm';
  }
  function formatPeso(centavos) {
    var n = Math.round(centavos || 0);
    var pesos = Math.floor(Math.abs(n) / 100);
    var cents = Math.abs(n) % 100;
    return (n < 0 ? '-' : '') + '₱' + pesos.toLocaleString('en-PH') + '.' + (cents < 10 ? '0' : '') + cents;
  }
  /** Billing policy: duration rounds UP to the billing increment. */
  function calcFee(rateCentavos, minutes, increment) {
    if (!(minutes > 0) || !(increment > 0)) return 0;
    var units = Math.ceil(minutes / increment);
    return Math.round((units * increment * rateCentavos) / 60);
  }
  /** Time <option> list from open to close in steps. */
  function timeOptions(open, close, step, includeFirst, includeLast) {
    var out = [];
    var a = hhmmToMinutes(open);
    var b = hhmmToMinutes(close);
    for (var m = a; m <= b; m += step) {
      if (m === a && !includeFirst) continue;
      if (m === b && !includeLast) continue;
      out.push(minutesToHHMM(m));
    }
    return out;
  }
  /** Returns an array of problem messages (empty when the window looks valid). */
  function validate(cfg, date, start, end, nowMinutesToday, today) {
    var errors = [];
    if (!date) errors.push('Choose a date.');
    if (!start || !end) {
      errors.push('Choose a start and end time.');
      return errors;
    }
    var s = hhmmToMinutes(start);
    var e = hhmmToMinutes(end);
    if (e <= s) {
      errors.push('End time must be after the start time.');
      return errors;
    }
    var dur = e - s;
    if (dur < cfg.minDuration) errors.push('Minimum booking is ' + fmtDuration(cfg.minDuration) + '.');
    if (dur > cfg.maxDuration) errors.push('Maximum booking is ' + fmtDuration(cfg.maxDuration) + '.');
    if (date && today) {
      if (date < today) errors.push('That date has already passed.');
      else if (date === today && nowMinutesToday !== undefined && s < Math.floor(nowMinutesToday / cfg.step) * cfg.step) {
        errors.push('That start time has already passed.');
      }
    }
    return errors;
  }
  function fillSelect(select, values, selected) {
    var keep = selected !== undefined ? selected : select.value;
    select.innerHTML = '';
    values.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v;
      o.textContent = label12(v);
      if (v === keep) o.selected = true;
      select.appendChild(o);
    });
  }

  window.UPReservation = {
    hhmmToMinutes: hhmmToMinutes,
    minutesToHHMM: minutesToHHMM,
    label12: label12,
    fmtDuration: fmtDuration,
    formatPeso: formatPeso,
    calcFee: calcFee,
    timeOptions: timeOptions,
    validate: validate,
    fillSelect: fillSelect,
  };

  // ---- generic time form (reschedule dialog) ---------------------------------
  document.querySelectorAll('form[data-time-form]').forEach(function (form) {
    var cfg = {
      step: parseInt(form.dataset.step, 10) || 60,
      open: form.dataset.open || '06:00',
      close: form.dataset.close || '22:00',
      minDuration: parseInt(form.dataset.min, 10) || 60,
      maxDuration: parseInt(form.dataset.max, 10) || 480,
      increment: parseInt(form.dataset.increment, 10) || 60,
      rate: parseInt(form.dataset.rate, 10) || 0,
    };
    var date = form.querySelector('[name="date"]');
    var start = form.querySelector('[name="start"]');
    var end = form.querySelector('[name="end"]');
    var durOut = form.querySelector('[data-duration]');
    var feeOut = form.querySelector('[data-fee]');
    var errOut = form.querySelector('[data-errors]');
    var submit = form.querySelector('[data-submit]');
    var initialStart = start.value;
    var initialEnd = end.value;

    fillSelect(start, timeOptions(cfg.open, cfg.close, cfg.step, true, false), initialStart);
    fillSelect(end, timeOptions(cfg.open, cfg.close, cfg.step, false, true), initialEnd);

    function refresh() {
      if (hhmmToMinutes(end.value) <= hhmmToMinutes(start.value)) {
        var next = Math.min(hhmmToMinutes(start.value) + Math.max(cfg.minDuration, cfg.step), hhmmToMinutes(cfg.close));
        end.value = minutesToHHMM(next);
      }
      var mins = hhmmToMinutes(end.value) - hhmmToMinutes(start.value);
      var errors = validate(cfg, date.value, start.value, end.value);
      if (durOut) durOut.textContent = fmtDuration(mins);
      if (feeOut) feeOut.textContent = errors.length ? '—' : formatPeso(calcFee(cfg.rate, mins, cfg.increment));
      if (errOut) errOut.textContent = errors.join(' ');
      if (submit) submit.disabled = errors.length > 0;
    }
    [date, start, end].forEach(function (el) { el.addEventListener('change', refresh); });
    refresh();
  });
})();
