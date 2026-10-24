/* Global behaviours: toasts, confirmation dialog, double-submit guard, print, off-canvas menu. */
(function () {
  'use strict';

  // ---- toasts -----------------------------------------------------------
  document.querySelectorAll('.toast.up-toast').forEach(function (el) {
    var autohide = el.getAttribute('data-autohide') === 'true';
    var toast = new bootstrap.Toast(el, { autohide: autohide, delay: 6500 });
    toast.show();
  });

  // Public helper so other scripts can show toasts.
  window.UPToast = function (type, message) {
    var stack = document.getElementById('toastStack');
    if (!stack) return;
    var icons = { success: 'bi-check-circle-fill', error: 'bi-exclamation-octagon-fill', warning: 'bi-exclamation-triangle-fill', info: 'bi-info-circle-fill' };
    var el = document.createElement('div');
    el.className = 'toast up-toast toast-' + type;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.innerHTML =
      '<div class="d-flex align-items-start gap-2 p-3"><i class="bi ' + (icons[type] || icons.info) + ' toast-icon" aria-hidden="true"></i>' +
      '<div class="flex-grow-1"></div><button type="button" class="btn-close btn-close-sm" data-bs-dismiss="toast" aria-label="Dismiss notification"></button></div>';
    el.querySelector('.flex-grow-1').textContent = message;
    stack.appendChild(el);
    new bootstrap.Toast(el, { autohide: type === 'success' || type === 'info', delay: 6000 }).show();
    el.addEventListener('hidden.bs.toast', function () { el.remove(); });
  };

  // ---- confirmation dialog for <form data-confirm="..."> -------------------
  var modalEl = document.getElementById('confirmModal');
  var modal = modalEl ? new bootstrap.Modal(modalEl) : null;
  var pendingForm = null;

  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement)) return;

    if (form.hasAttribute('data-confirm') && modal && !form.dataset.confirmed) {
      event.preventDefault();
      pendingForm = form;
      document.getElementById('confirmModalTitle').textContent = form.getAttribute('data-confirm-title') || 'Please confirm';
      document.getElementById('confirmModalMessage').textContent = form.getAttribute('data-confirm');
      var ok = document.getElementById('confirmModalOk');
      ok.textContent = form.getAttribute('data-confirm-label') || 'Confirm';
      ok.className = 'btn ' + (form.getAttribute('data-confirm-tone') === 'danger' ? 'btn-danger' : 'btn-primary');
      var reasonLabel = form.getAttribute('data-confirm-reason');
      var wrap = document.getElementById('confirmModalReasonWrap');
      var reason = document.getElementById('confirmModalReason');
      wrap.hidden = !reasonLabel;
      reason.value = '';
      reason.classList.remove('is-invalid');
      if (reasonLabel) document.getElementById('confirmModalReasonLabel').textContent = reasonLabel;
      modal.show();
      return;
    }

    // Guard against double submission (e.g. double-clicking "Confirm reservation").
    if (String(form.method).toLowerCase() === 'post' && !event.defaultPrevented) {
      setTimeout(function () {
        form.querySelectorAll('button[type="submit"]').forEach(function (b) {
          b.disabled = true;
          b.setAttribute('aria-busy', 'true');
        });
      }, 0);
    }
  });

  if (modalEl) {
    document.getElementById('confirmModalOk').addEventListener('click', function () {
      if (!pendingForm) return;
      var reasonLabel = pendingForm.getAttribute('data-confirm-reason');
      if (reasonLabel) {
        var reason = document.getElementById('confirmModalReason');
        var text = reason.value.trim();
        if (text.length < 3) {
          reason.classList.add('is-invalid');
          reason.focus();
          return;
        }
        var hidden = pendingForm.querySelector('input[name="reason"]');
        if (!hidden) {
          hidden = document.createElement('input');
          hidden.type = 'hidden';
          hidden.name = 'reason';
          pendingForm.appendChild(hidden);
        }
        hidden.value = text;
      }
      var form = pendingForm;
      pendingForm = null;
      form.dataset.confirmed = '1';
      modal.hide();
      HTMLFormElement.prototype.submit.call(form);
    });
    modalEl.addEventListener('hidden.bs.modal', function () { pendingForm = null; });
  }

  // Re-enable buttons if the page is restored from the back/forward cache.
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    document.querySelectorAll('button[aria-busy="true"]').forEach(function (b) {
      b.disabled = false;
      b.removeAttribute('aria-busy');
    });
    document.querySelectorAll('form[data-confirmed]').forEach(function (f) { delete f.dataset.confirmed; });
  });

  // ---- print buttons -------------------------------------------------------
  document.addEventListener('click', function (event) {
    var btn = event.target.closest('[data-print]');
    if (btn) {
      event.preventDefault();
      window.print();
    }
  });

  // Close the mobile menu when a link inside it is chosen.
  var sidebar = document.getElementById('appSidebar');
  if (sidebar) {
    sidebar.addEventListener('click', function (event) {
      if (event.target.closest('a.nav-link') && window.innerWidth < 992) {
        var inst = bootstrap.Offcanvas.getInstance(sidebar);
        if (inst) inst.hide();
      }
    });
  }

  // ---- sidebar badges for unread updates (administrators and drivers) ----------------
  var badgeNav = document.querySelector('[data-nav-badges]');
  if (badgeNav && window.fetch) {
    var paintBadges = function (counts) {
      badgeNav.querySelectorAll('[data-badge-for]').forEach(function (b) {
        var n = Number(counts[b.getAttribute('data-badge-for')]) || 0;
        b.hidden = n === 0;
        b.firstElementChild.textContent = n > 99 ? '99+' : String(n);
        b.lastElementChild.textContent = n === 1 ? '1 new update' : n + ' new updates';
      });
    };
    var pollBadges = function () {
      if (document.hidden) return;
      fetch(badgeNav.getAttribute('data-nav-badges'), { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (counts) { if (counts) paintBadges(counts); })
        .catch(function () { /* offline: keep the last counts */ });
    };
    window.setInterval(pollBadges, 30000);
    document.addEventListener('visibilitychange', pollBadges);
  }

  // ---- instant field checks (the server repeats every one of them) ------------------
  //   input[data-name-rule]            full name (public/js/name-rules.js)
  //   form[data-password-change]       new password must differ from the current one, and match its confirmation
  function fieldError(input, message) {
    var wrap = input.closest('[class*="col-"]') || input.parentNode;
    var out = wrap.querySelector('.invalid-feedback');
    if (!out && message) {
      out = document.createElement('div');
      out.className = 'invalid-feedback d-block';
      out.id = input.id + '-error';
      input.insertAdjacentElement('afterend', out);
    }
    if (out) out.textContent = message || '';
    input.classList.toggle('is-invalid', !!message);
    if (message) {
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', out.id);
    } else {
      input.removeAttribute('aria-invalid');
    }
    return !message;
  }
  window.UPFieldError = fieldError;
  function checkName(input) {
    if (!window.NameRules) return true;
    var result = window.NameRules.validate(input.value);
    if (result.ok) input.value = result.name; // trimmed, single spaces
    return fieldError(input, result.message);
  }
  function checkPasswords(form) {
    var current = form.elements.current_password;
    var next = form.elements.new_password;
    var confirm = form.elements.confirm_password;
    var ok = true;
    if (next && current && next.value && next.value === current.value) {
      ok = fieldError(next, 'Your new password must be different from your current password.') && ok;
    } else if (next) fieldError(next, '');
    if (confirm && next && confirm.value && confirm.value !== next.value) ok = fieldError(confirm, 'Passwords do not match.') && ok;
    else if (confirm) fieldError(confirm, '');
    return ok;
  }
  document.addEventListener('change', function (event) {
    var el = event.target;
    if (!el.matches) return;
    if (el.matches('input[data-name-rule]')) checkName(el);
    if (el.form && el.form.hasAttribute('data-password-change') && el.type === 'password') checkPasswords(el.form);
  });
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    var ok = true;
    var first = null;
    form.querySelectorAll('input[data-name-rule]').forEach(function (input) {
      if (!checkName(input)) {
        ok = false;
        first = first || input;
      }
    });
    if (form.hasAttribute('data-password-change') && !checkPasswords(form)) {
      ok = false;
      first = first || form.querySelector('.is-invalid');
    }
    if (!ok) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (first) first.focus();
    }
  }, true);

  // Auto-submit selects marked data-autosubmit (used by simple filters).
  document.addEventListener('change', function (event) {
    var el = event.target;
    if (el.matches && el.matches('select[data-autosubmit], input[type="date"][data-autosubmit]') && el.form) el.form.submit();
  });

  // Text/search inputs marked data-autosubmit submit after a short pause in typing.
  var typingTimer;
  document.addEventListener('input', function (event) {
    var el = event.target;
    if (!(el.matches && el.matches('input[type="search"][data-autosubmit], input[type="text"][data-autosubmit]') && el.form)) return;
    clearTimeout(typingTimer);
    typingTimer = setTimeout(function () { el.form.submit(); }, 500);
  });

  // After such a reload, put the cursor back at the end of the search the user was typing.
  var typed = document.querySelector('input[type="search"][data-autosubmit], input[type="text"][data-autosubmit]');
  if (typed && typed.value && new URLSearchParams(window.location.search).has(typed.name)) {
    typed.focus();
    typed.setSelectionRange(typed.value.length, typed.value.length);
  }
})();
