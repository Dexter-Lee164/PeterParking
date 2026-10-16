/* Shared behaviour: confirmation dialog, toast auto-hide, double-submit guard, print buttons. */
(function () {
  'use strict';

  // ---- Confirmation dialog (buttons carry data-confirm-* attributes) ----
  var modalEl = document.getElementById('confirmModal');
  if (modalEl) {
    var form = document.getElementById('confirmForm');
    modalEl.addEventListener('show.bs.modal', function (ev) {
      var t = ev.relatedTarget; if (!t) return;
      var d = t.dataset;
      form.setAttribute('action', d.confirmAction || '');
      document.getElementById('confirmTitle').textContent = d.confirmTitle || 'Are you sure?';
      document.getElementById('confirmMessage').textContent = d.confirmMessage || '';
      var btn = document.getElementById('confirmSubmit');
      btn.textContent = d.confirmLabel || 'Confirm';
      btn.className = 'btn ' + (d.confirmTone === 'primary' ? 'btn-primary' : 'btn-danger');
      var wrap = document.getElementById('confirmReasonWrap'), ta = document.getElementById('confirmReason');
      var mode = d.confirmReason || '';
      wrap.hidden = !mode; ta.required = mode === 'required'; ta.value = '';
      document.getElementById('confirmReasonLabel').textContent = d.confirmReasonLabel || (mode === 'required' ? 'Reason (required)' : 'Reason (optional)');
      // Extra hidden fields, e.g. data-confirm-fields='{"sessionId":"4"}'
      var extra = document.getElementById('confirmExtra'); extra.textContent = '';
      if (d.confirmFields) {
        try { var f = JSON.parse(d.confirmFields); Object.keys(f).forEach(function (k) { var i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = f[k]; extra.appendChild(i); }); } catch (e) { /* ignore */ }
      }
    });
    modalEl.addEventListener('shown.bs.modal', function () {
      var ta = document.getElementById('confirmReason');
      if (!document.getElementById('confirmReasonWrap').hidden) ta.focus(); else document.getElementById('confirmSubmit').focus();
    });
  }

  // ---- Toasts: success messages fade away, warnings and errors stay until dismissed ----
  document.querySelectorAll('.app-toast').forEach(function (el) {
    var ms = parseInt(el.getAttribute('data-autohide'), 10);
    if (ms > 0) setTimeout(function () { if (window.bootstrap) window.bootstrap.Toast.getOrCreateInstance(el, { autohide: false }).hide(); }, ms);
  });

  // ---- Guard against double submits on POST forms ----
  document.addEventListener('submit', function (ev) {
    var f = ev.target;
    if (!(f instanceof HTMLFormElement) || f.method.toLowerCase() !== 'post' || f.hasAttribute('data-allow-resubmit')) return;
    if (f.dataset.submitting === '1') { ev.preventDefault(); return; }
    f.dataset.submitting = '1';
    setTimeout(function () {
      f.querySelectorAll('button[type="submit"]').forEach(function (b) { b.disabled = true; });
    }, 0);
  });
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    document.querySelectorAll('form[data-submitting]').forEach(function (f) { delete f.dataset.submitting; f.querySelectorAll('button[type="submit"]').forEach(function (b) { b.disabled = false; }); });
  });

  // ---- Print buttons ----
  document.querySelectorAll('[data-print]').forEach(function (b) { b.addEventListener('click', function () { window.print(); }); });

  // ---- Close the mobile navigation after choosing a link ----
  var side = document.getElementById('sidebar');
  if (side) side.addEventListener('click', function (e) {
    if (e.target.closest('a') && window.bootstrap && window.innerWidth < 992) window.bootstrap.Offcanvas.getOrCreateInstance(side).hide();
  });
})();
