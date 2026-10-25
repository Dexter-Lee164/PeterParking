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

  // ---- dropdowns whose options carry an icon (<select data-icon-select>, <option data-icon="bi bi-car-front">) ----
  // An <option> can only hold text, so with a mouse or the keyboard the list opens as a menu that draws each icon
  // (the same .bi / .vi icons as the rest of the page). The <select> stays the real control: choosing sets its value
  // and fires change. Touch screens keep the phone's own picker, which shows the text alone.
  var iconMenu = null;
  function closeIconMenu(refocus) {
    if (!iconMenu) return;
    var select = iconMenu.select;
    iconMenu.el.remove();
    iconMenu = null;
    select.setAttribute('aria-expanded', 'false');
    if (refocus) select.focus();
  }
  function pickIconOption(index) {
    var select = iconMenu.select;
    closeIconMenu(true);
    if (select.selectedIndex === index) return;
    select.selectedIndex = index;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function markIconOption(index) {
    var items = iconMenu.el.children;
    if (!items[index]) return;
    if (items[iconMenu.active]) items[iconMenu.active].classList.remove('is-active');
    iconMenu.active = index;
    items[index].classList.add('is-active');
    items[index].scrollIntoView({ block: 'nearest' });
  }
  function openIconMenu(select) {
    closeIconMenu(false);
    var rect = select.getBoundingClientRect();
    var el = document.createElement('div');
    el.className = 'icon-select-menu';
    el.setAttribute('role', 'listbox');
    el.style.left = rect.left + 'px';
    el.style.top = rect.bottom + 2 + 'px';
    el.style.minWidth = rect.width + 'px';
    Array.prototype.forEach.call(select.options, function (o, i) {
      var item = document.createElement('div');
      item.className = 'icon-select-item' + (o.selected ? ' is-selected' : '') + (o.disabled ? ' is-disabled' : '');
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', o.selected ? 'true' : 'false');
      var icon = document.createElement('i');
      icon.className = (o.dataset.icon || '') + ' icon-select-icon';
      icon.setAttribute('aria-hidden', 'true');
      var text = document.createElement('span');
      text.textContent = o.textContent;
      item.append(icon, text);
      item.addEventListener('mousedown', function (event) { event.preventDefault(); });
      item.addEventListener('mousemove', function () { if (!o.disabled) markIconOption(i); });
      item.addEventListener('click', function () { if (!o.disabled) pickIconOption(i); });
      el.appendChild(item);
    });
    document.body.appendChild(el);
    // Open upwards when there is no room below.
    if (rect.bottom + el.offsetHeight > window.innerHeight && rect.top > el.offsetHeight) {
      el.style.top = rect.top - el.offsetHeight - 2 + 'px';
    }
    iconMenu = { select: select, el: el, active: -1 };
    select.setAttribute('aria-expanded', 'true');
    markIconOption(Math.max(select.selectedIndex, 0));
  }
  if (!window.matchMedia('(pointer: coarse)').matches) {
    document.addEventListener('mousedown', function (event) {
      var select = event.target.closest && event.target.closest('select[data-icon-select]');
      if (iconMenu && !iconMenu.el.contains(event.target)) {
        var same = iconMenu.select === select;
        closeIconMenu(false);
        if (same) { event.preventDefault(); return; }
      }
      if (!select || select.disabled || event.button !== 0) return;
      event.preventDefault(); // no native list
      select.focus();
      openIconMenu(select);
    });
    document.addEventListener('keydown', function (event) {
      var select = event.target.closest && event.target.closest('select[data-icon-select]');
      if (!select) return;
      var open = iconMenu && iconMenu.select === select;
      if (!open) {
        if (event.key === ' ' || event.key === 'Enter' || event.key === 'F4' || (event.altKey && event.key === 'ArrowDown')) {
          event.preventDefault();
          openIconMenu(select);
        }
        return; // arrows on a closed dropdown still change it the usual way
      }
      var step = function (dir) {
        for (var i = iconMenu.active + dir; i >= 0 && i < select.options.length; i += dir) {
          if (!select.options[i].disabled) return markIconOption(i);
        }
      };
      if (event.key === 'ArrowDown') step(1);
      else if (event.key === 'ArrowUp') step(-1);
      else if (event.key === 'Home') { iconMenu.active = -1; step(1); }
      else if (event.key === 'End') { iconMenu.active = select.options.length; step(-1); }
      else if (event.key === 'Enter' || event.key === ' ') pickIconOption(iconMenu.active);
      else if (event.key === 'Escape') closeIconMenu(true);
      else if (event.key === 'Tab') { closeIconMenu(false); return; }
      else return;
      event.preventDefault();
    });
    document.addEventListener('focusout', function (event) {
      if (iconMenu && event.target === iconMenu.select) setTimeout(function () {
        if (iconMenu && document.activeElement !== iconMenu.select) closeIconMenu(false);
      }, 0);
    });
    window.addEventListener('resize', function () { closeIconMenu(false); });
    window.addEventListener('scroll', function (event) {
      if (iconMenu && !iconMenu.el.contains(event.target)) closeIconMenu(false);
    }, true);
  }
})();
