/* University Parking — sign-in / sign-up screen behaviour.
 *
 * Progressive enhancement: the server renders the right mode and step (data-mode / data-flow on the card, .is-current
 * on a step) and every control is a real link or form, so everything works without this file. With it:
 *   - switching panes sets data-mode (all movement is CSS transitions off that attribute), updates the URL, the title
 *     and the inert state, and handles Back / Forward;
 *   - steps inside a pane (sign in -> forgot password, form -> verify) change in place with a short forward / back
 *     slide; the URL follows with pushState and every URL is also a real server route;
 *   - focus lands in the new form (the heading on touch devices); a polite live region announces the change;
 *   - password show/hide, inline validation that mirrors the server rules (the server still decides), loading states;
 *   - the create-account e-mail field uses the SAME rules file as the server (js/email-rules.js) and offers a
 *     "Did you mean ...?" fix for a mistyped provider. Sign-in and "forgot password" keep the lenient check: people
 *     who already have an account must always be able to use it;
 *   - the 6-digit code: one input drawn as six boxes, paste with spaces, auto-submit on the 6th digit, a resend
 *     countdown that is announced once, when it ends.
 */
(function () {
  'use strict';

  var card = document.querySelector('[data-auth-card]');
  if (!card) return;
  card.classList.add('js-auth');

  var overlay = card.querySelector('[data-auth-overlay]');
  var live = card.querySelector('[data-auth-live]');
  var backLink = card.querySelector('[data-auth-back]');
  var panes = {
    login: card.querySelector('[data-auth-pane="login"]'),
    register: card.querySelector('[data-auth-pane="register"]'),
  };
  var prompts = {
    login: card.querySelector('[data-auth-prompt="login"]'),
    register: card.querySelector('[data-auth-prompt="register"]'),
  };

  var STEP_ORDER = { login: ['signin', 'forgot', 'sent', 'reset', 'reset-invalid'], register: ['form', 'verify'] };
  var FLOW = { forgot: 'forgot', sent: 'forgot', reset: 'reset', 'reset-invalid': 'reset', verify: 'verify' };
  var BACK = { forgot: '/login', verify: '/register/edit', reset: '/login' };
  var ANNOUNCE = {
    signin: 'Showing sign in form',
    forgot: 'Showing password reset form',
    sent: 'Reset link sent. Check your email.',
    reset: 'Showing new password form',
    'reset-invalid': 'This reset link has expired',
    form: 'Showing create account form',
    verify: 'Showing verification code form',
  };

  var coarsePointer = window.matchMedia('(pointer: coarse)');
  var wideLayout = window.matchMedia('(min-width: 900px)');
  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  var mode = card.getAttribute('data-mode') === 'register' ? 'register' : 'login';
  var switchId = 0; // bumped on every pane switch so a stale "slide finished" callback does nothing

  function setInert(el, inert) {
    if (!el) return;
    if (inert) el.setAttribute('inert', '');
    else el.removeAttribute('inert');
  }

  function say(text) {
    if (!live) return;
    live.textContent = '';
    window.requestAnimationFrame(function () {
      live.textContent = text;
    });
  }

  /* ---------------------------------------------------------------- steps */
  function stepEl(paneName, step) {
    return panes[paneName] ? panes[paneName].querySelector('[data-auth-step="' + step + '"]') : null;
  }
  function currentStepEl(paneName) {
    return panes[paneName].querySelector('.auth-step.is-current') || stepEl(paneName, STEP_ORDER[paneName][0]);
  }
  function currentStep(paneName) {
    var el = currentStepEl(paneName);
    return el ? el.getAttribute('data-auth-step') : STEP_ORDER[paneName][0];
  }

  /** Card-level state that follows the active pane's current step: flow, mobile Back target, title, labels. */
  function syncChrome() {
    var flow = FLOW[currentStep(mode)] || '';
    card.setAttribute('data-flow', flow);
    if (backLink && BACK[flow]) backLink.setAttribute('href', BACK[flow]);
    var el = currentStepEl(mode);
    if (el && el.getAttribute('data-title')) document.title = el.getAttribute('data-title');
    ['login', 'register'].forEach(function (name) {
      var step = currentStepEl(name);
      if (step) panes[name].setAttribute('aria-labelledby', step.getAttribute('data-heading'));
    });
  }

  function focusTarget(paneName) {
    var step = currentStepEl(paneName);
    if (!step) return null;
    var heading = step.querySelector('.auth-title');
    if (coarsePointer.matches) return heading; // touch: do not open the on-screen keyboard unprompted
    return step.querySelector('[aria-invalid="true"]') || step.querySelector('input:not([type="hidden"]):not([tabindex="-1"])') || heading;
  }

  var stepTimer = 0;
  /**
   * Show another step of a pane. The incoming step is first placed on its starting side with no transition, then
   * both steps transition: out to the opposite side, in to the centre. Interrupting simply retargets the transitions.
   */
  function showStep(paneName, name, opts) {
    var options = opts || {};
    var next = stepEl(paneName, name);
    var prev = currentStepEl(paneName);
    if (!next || next === prev) return false;
    var order = STEP_ORDER[paneName];
    var dir = options.dir || (order.indexOf(name) < order.indexOf(prev.getAttribute('data-auth-step')) ? 'back' : 'forward');
    var steps = next.parentNode;

    steps.setAttribute('data-dir', dir);
    next.classList.add('is-instant');
    next.classList.remove('is-out');
    void next.offsetWidth; // commit the starting position before transitions come back
    next.classList.remove('is-instant');

    card.classList.add('is-stepping');
    window.clearTimeout(stepTimer);
    stepTimer = window.setTimeout(function () { card.classList.remove('is-stepping'); }, 500);

    prev.classList.remove('is-current');
    prev.classList.add('is-out');
    setInert(prev, true);
    next.classList.add('is-current');
    setInert(next, false);

    if (paneName === mode) {
      syncChrome();
      var path = next.getAttribute('data-path');
      if (options.push && path && path !== window.location.pathname) {
        window.history.pushState({ authMode: mode, authStep: name }, '', path);
      }
      say(ANNOUNCE[name] || '');
      var target = focusTarget(paneName);
      if (target) target.focus({ preventScroll: true });
    }
    return true;
  }

  /* ---------------------------------------------------------------- first frame: no animation on load */
  // A step that the server reached through a round trip (form -> verify, verify -> Edit, forgot -> sent) still plays
  // its entrance: it starts hidden on its side and becomes current once transitions are switched on.
  var entering = [];
  ['login', 'register'].forEach(function (name) {
    var steps = panes[name] && panes[name].querySelector('[data-auth-steps]');
    var dir = steps && steps.getAttribute('data-step-enter');
    if (!dir || name !== mode) return;
    var cur = currentStepEl(name);
    steps.setAttribute('data-dir', dir);
    cur.classList.remove('is-current');
    entering.push(cur);
  });
  var banners = card.querySelectorAll('.auth-step.is-current .auth-banner, .auth-banner[data-auth-banner]');
  banners.forEach(function (b) { b.classList.add('is-new'); });

  window.requestAnimationFrame(function () {
    window.requestAnimationFrame(function () {
      card.classList.add('is-ready');
      entering.forEach(function (el) { el.classList.add('is-current'); });
      initialFocus();
      window.setTimeout(function () {
        banners.forEach(function (b) { b.classList.remove('is-new'); });
      }, 600);
    });
  });

  /* ---------------------------------------------------------------- switching panes */
  function longestTransitionMs(el) {
    var style = window.getComputedStyle(el);
    var durations = style.transitionDuration.split(',');
    var delays = style.transitionDelay.split(',');
    var longest = 0;
    function ms(value) {
      var n = parseFloat(value);
      return /ms\s*$/.test(value) ? n : n * 1000;
    }
    for (var i = 0; i < durations.length; i += 1) {
      var total = ms(durations[i]) + ms(delays[i % delays.length]);
      if (total > longest) longest = total;
    }
    return longest;
  }

  function moveFocus(target) {
    var pane = panes[target];
    var active = document.activeElement;
    // The user already moved into the new form (or is typing there): leave them alone.
    if (active && active !== pane && pane.contains(active)) return;
    var el = focusTarget(target);
    if (el) el.focus({ preventScroll: true });
  }

  function afterSlide(id, target) {
    // Desktop: the overlay is the long pole (600ms). Below 900px: the incoming pane slides.
    var primary = wideLayout.matches ? overlay : panes[target];
    var finished = false;

    function finish() {
      if (finished) return;
      finished = true;
      primary.removeEventListener('transitionend', onEnd);
      if (id !== switchId) return; // a newer switch is in charge now
      card.classList.remove('is-sliding');
      moveFocus(target);
    }
    function onEnd(event) {
      if (event.target === primary) finish();
    }

    var total = card.classList.contains('is-ready') ? longestTransitionMs(primary) : 0;
    if (total <= 0) {
      window.requestAnimationFrame(finish); // nothing is moving (reduced motion / first frame): focus now
      return;
    }
    primary.addEventListener('transitionend', onEnd);
    // Safety net only: if the browser never reports the end of the transition, still put focus in the form.
    window.setTimeout(finish, total + 150);
  }

  function carryEmail(fromStep, toStep) {
    var source = fromStep && fromStep.querySelector('input[name="email"]');
    var destination = toStep && toStep.querySelector('input[name="email"]');
    if (source && destination && source.value && !destination.value) destination.value = source.value;
  }

  function setMode(target, options) {
    var opts = options || {};
    if (target !== 'login' && target !== 'register') return false;
    if (target === mode) return false;

    var previous = mode;
    mode = target;
    switchId += 1;
    var id = switchId;

    carryEmail(currentStepEl(previous), currentStepEl(target));

    card.classList.add('is-sliding'); // will-change only while something is moving
    card.setAttribute('data-mode', target);

    setInert(panes.login, target !== 'login');
    setInert(panes.register, target !== 'register');
    setInert(prompts.login, target !== 'login');
    setInert(prompts.register, target !== 'register');

    card.querySelectorAll('.auth-switch a[data-auth-switch]').forEach(function (link) {
      if (link.getAttribute('data-auth-switch') === target) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });

    syncChrome();
    if (opts.push) {
      var path = currentStepEl(target).getAttribute('data-path');
      window.history.pushState({ authMode: target, authStep: currentStep(target) }, '', path + window.location.search + window.location.hash);
    }
    say(ANNOUNCE[currentStep(target)] || '');

    // Keyboard users: the link they pressed has just gone inert, so give focus a home in the new form straight away.
    if (opts.keyboard) panes[target].focus({ preventScroll: true });

    afterSlide(id, target);
    return true;
  }

  function plainClick(event) {
    return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey; // else: new tab
  }

  card.addEventListener('click', function (event) {
    if (!event.target.closest || event.defaultPrevented || !plainClick(event)) return;

    var link = event.target.closest('a[data-auth-switch]');
    if (link) {
      event.preventDefault();
      setMode(link.getAttribute('data-auth-switch'), { push: true, keyboard: event.detail === 0 });
      return;
    }

    var go = event.target.closest('a[data-auth-goto]');
    if (go) {
      var paneEl = go.closest('[data-auth-pane]');
      var paneName = paneEl && paneEl.getAttribute('data-auth-pane');
      var name = go.getAttribute('data-auth-goto');
      if (!paneName || !stepEl(paneName, name)) return; // not on this page: let the link load it
      event.preventDefault();
      if (name === 'forgot') carryEmail(stepEl(paneName, 'signin'), stepEl(paneName, 'forgot'));
      showStep(paneName, name, { push: true });
      return;
    }

    var back = event.target.closest('a[data-auth-back]');
    if (back) {
      var flow = card.getAttribute('data-flow');
      if ((flow === 'forgot' || flow === 'reset') && stepEl('login', 'signin')) {
        event.preventDefault();
        showStep('login', 'signin', { push: true, dir: 'back' });
      }
    }
  });

  function routeFromPath() {
    var p = window.location.pathname.replace(/\/+$/, '') || '/';
    if (/^\/register\/verify$/i.test(p)) return { mode: 'register', step: 'verify' };
    if (/^\/register(\/edit)?$/i.test(p)) return { mode: 'register', step: 'form' };
    if (/^\/forgot-password$/i.test(p)) return { mode: 'login', step: currentStep('login') === 'sent' ? 'sent' : 'forgot' };
    if (/^\/reset-password$/i.test(p)) return { mode: 'login', step: stepEl('login', 'reset') ? 'reset' : 'reset-invalid' };
    return { mode: 'login', step: 'signin' };
  }

  window.addEventListener('popstate', function () {
    var route = routeFromPath();
    if (!stepEl(route.mode, route.step)) {
      window.location.reload(); // that step needs the server (e.g. a code that is no longer pending)
      return;
    }
    if (route.mode !== mode) {
      showStep(route.mode, route.step, { push: false });
      setMode(route.mode, { push: false });
    } else {
      showStep(route.mode, route.step, { push: false });
    }
    syncChrome();
  });

  /* ---------------------------------------------------------------- password show / hide */
  card.addEventListener('click', function (event) {
    var button = event.target.closest ? event.target.closest('[data-auth-toggle]') : null;
    if (!button) return;
    var input = document.getElementById(button.getAttribute('aria-controls'));
    if (!input) return;
    var reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    button.setAttribute('aria-pressed', reveal ? 'true' : 'false');
    button.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
    var icon = button.querySelector('i');
    if (icon) icon.className = 'bi ' + (reveal ? 'bi-eye-slash' : 'bi-eye');
  });

  function hidePasswords(form) {
    form.querySelectorAll('[data-auth-toggle]').forEach(function (button) {
      var input = document.getElementById(button.getAttribute('aria-controls'));
      if (input) input.type = 'password';
      button.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-label', 'Show password');
      var icon = button.querySelector('i');
      if (icon) icon.className = 'bi bi-eye';
    });
  }

  /* ---------------------------------------------------------------- inline validation (mirrors the server; never replaces it) */
  var EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var EmailRules = window.EmailRules || null; // js/email-rules.js, the file the server also runs

  // Sign-in and "forgot password": lenient on purpose. An account created under older rules must still work.
  function emailProblem(value) {
    var v = value.trim();
    if (!v) return 'Enter your email address.';
    if (!EMAIL.test(v) || v.length > 254) return 'Enter a valid email address.';
    return '';
  }

  // Create account: the full shared rules (format, provider-typo guard, Gmail rules). DNS is checked by the server only.
  function newEmailResult(value) {
    if (!EmailRules) return { ok: !emailProblem(value), message: emailProblem(value) || '', suggestion: null };
    return EmailRules.validate(value);
  }
  function passwordProblem(value) {
    if (value.length < 8) return 'Password must be at least 8 characters.';
    if (value.length > 128) return 'Password is too long.';
    if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return 'Password must include at least one letter and one number.';
    return '';
  }
  function confirmProblem(value, form) {
    return value !== form.elements.password.value ? 'Passwords do not match.' : '';
  }

  var rules = {
    login: {
      email: emailProblem,
      password: function (value) { return value ? '' : 'Enter your password.'; },
    },
    forgot: { email: emailProblem },
    register: {
      full_name: function (value) {
        // The shared rules (public/js/name-rules.js); the server applies the very same file.
        if (window.NameRules) return window.NameRules.validate(value).message;
        var name = value.replace(/\s+/g, ' ').trim();
        return name.length < 2 || name.length > 80 ? 'Enter your full name.' : '';
      },
      email: function (value) {
        return newEmailResult(value).message || '';
      },
      university_id: function (value) { return value.trim().length > 30 ? 'University ID is too long.' : ''; },
      phone: function (value) {
        var v = value.trim();
        return v && !/^[0-9+()\-\s]{7,20}$/.test(v) ? 'Enter a valid phone number.' : '';
      },
      password: passwordProblem,
      confirm_password: confirmProblem,
    },
    reset: { password: passwordProblem, confirm_password: confirmProblem },
    verify: {
      code: function (value) { return /^\d{6}$/.test(value) ? '' : 'Enter the 6-digit code from the email.'; },
    },
  };

  function setFieldError(wrap, message) {
    var input = wrap.querySelector('input');
    var out = wrap.querySelector('.auth-error');
    if (message) {
      out.textContent = message;
      wrap.classList.add('is-invalid');
      input.classList.add('is-invalid');
      input.setAttribute('aria-invalid', 'true');
    } else {
      wrap.classList.remove('is-invalid');
      input.classList.remove('is-invalid');
      input.removeAttribute('aria-invalid');
      out.textContent = '';
    }
    // "Sign in · Forgot password?" belongs to the server's "already registered" message only.
    var actions = wrap.querySelector('.auth-error-actions');
    if (actions && !message) actions.remove();
  }

  function validateField(wrap) {
    var form = wrap.closest('form');
    var input = wrap.querySelector('input');
    var set = rules[form.getAttribute('data-auth-form')] || {};
    var rule = set[input.name];
    if (!rule) return '';
    var message = rule(input.value, form);
    setFieldError(wrap, message);
    if (form.getAttribute('data-auth-form') === 'register' && input.name === 'email') {
      syncSuggestion(wrap, message ? newEmailResult(input.value).suggestion : null);
    }
    return message;
  }

  /* ---------------------------------------------------------------- "Did you mean ...?" (create-account e-mail only) */
  var suggestTimers = new WeakMap();

  function syncSuggestion(wrap, suggestion) {
    var box = wrap.querySelector('[data-auth-suggest]');
    if (!box) return;
    var text = box.querySelector('.auth-suggest-text');
    var button = box.querySelector('[data-suggest-apply]');
    window.clearTimeout(suggestTimers.get(box));
    if (suggestion) {
      var current = box.querySelector('[data-suggest-value]');
      if (!current || current.textContent !== suggestion) {
        text.textContent = 'Did you mean ';
        var strong = document.createElement('strong');
        strong.setAttribute('data-suggest-value', '');
        strong.textContent = suggestion; // textContent: whatever was typed can never become markup
        text.appendChild(strong);
        text.appendChild(document.createTextNode('?'));
      }
      button.hidden = false;
      button.setAttribute('aria-label', 'Use ' + suggestion);
      box.classList.add('is-open');
    } else {
      box.classList.remove('is-open');
      // Empty the sentence only after the 200ms collapse, so it does not vanish mid-fade; it is part of the field's
      // accessible description, so stale text must not be left behind.
      suggestTimers.set(box, window.setTimeout(function () {
        if (!box.classList.contains('is-open')) {
          text.textContent = '';
          button.removeAttribute('aria-label');
        }
      }, 220));
    }
  }

  function applySuggestion(button) {
    var wrap = button.closest('.auth-field');
    var strong = wrap && wrap.querySelector('[data-suggest-value]');
    var input = wrap && wrap.querySelector('input');
    if (!strong || !input) return;
    input.value = strong.textContent;
    wrap.setAttribute('data-touched', 'true');
    validateField(wrap); // clears the error and the suggestion
    var box = input.closest('.auth-input');
    box.classList.add('is-applied'); // 150ms highlight (CSS keyframes) so the change is noticed
    window.setTimeout(function () { box.classList.remove('is-applied'); }, 200);
    input.focus();
    try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) { /* type=email has no selection API in some browsers */ }
    say('Email address changed to ' + input.value);
  }

  // The fix button is rendered hidden (it does nothing without this script); reveal those the server already opened.
  card.querySelectorAll('[data-auth-suggest].is-open [data-suggest-apply]').forEach(function (button) { button.hidden = false; });

  card.addEventListener('click', function (event) {
    var button = event.target.closest ? event.target.closest('[data-suggest-apply]') : null;
    if (button) applySuggestion(button);
  });

  card.addEventListener('input', function (event) {
    var input = event.target;
    var wrap = input.closest ? input.closest('.auth-field') : null;
    if (!wrap || input.name === 'code') return; // the code field has its own handling below
    wrap.setAttribute('data-touched', 'true');
    if (wrap.classList.contains('is-invalid')) validateField(wrap); // clear the message as soon as it is fixed
    var kind = input.form && input.form.getAttribute('data-auth-form');
    if (input.name === 'password' && (kind === 'register' || kind === 'reset')) {
      var confirm = input.form.querySelector('.auth-field[data-field="confirm_password"]');
      if (confirm && confirm.getAttribute('data-touched') === 'true') validateField(confirm);
    }
  });

  // Validate when focus leaves the whole field (input + its show/hide button), not on the way between the two:
  // Tab from the password input to its eye button must not flash an error at someone who is still typing.
  card.addEventListener('focusout', function (event) {
    var wrap = event.target.closest ? event.target.closest('.auth-field') : null;
    if (!wrap) return;
    if (event.relatedTarget && wrap.contains(event.relatedTarget)) return;
    var input = wrap.querySelector('input');
    if (input.name === 'code') return;
    if (wrap.getAttribute('data-touched') === 'true' || input.value) validateField(wrap);
  });

  // Pressing the eye with a mouse or finger keeps focus (and the caret) in the password input.
  card.addEventListener('mousedown', function (event) {
    if (event.target.closest && event.target.closest('[data-auth-toggle]')) event.preventDefault();
  });

  /* ---------------------------------------------------------------- loading states */
  function setLoading(form, loading) {
    var button = form.querySelector('[data-auth-submit]');
    if (!button) return;
    var label = button.querySelector('.auth-submit-label');
    if (loading) {
      button.setAttribute('data-label', label.textContent);
      label.textContent = form.getAttribute('data-loading-label');
      button.classList.add('is-loading');
      button.setAttribute('aria-busy', 'true');
      form.setAttribute('aria-busy', 'true');
      window.setTimeout(function () { button.disabled = true; }, 0); // after the browser has read the form
    } else {
      if (button.getAttribute('data-label')) label.textContent = button.getAttribute('data-label');
      button.classList.remove('is-loading');
      button.removeAttribute('aria-busy');
      form.removeAttribute('aria-busy');
      button.disabled = false;
    }
  }

  /* ---------------------------------------------------------------- 6-digit code */
  var codeForm = card.querySelector('form[data-auth-form="verify"]');
  var codeInput = codeForm && codeForm.querySelector('input[name="code"]');
  var codeBox = codeForm && codeForm.querySelector('[data-auth-code]');
  var codeWrap = codeForm && codeForm.querySelector('.auth-field[data-field="code"]');
  var codeBusy = false;

  function digitsOf(value) {
    return String(value || '').replace(/\D/g, '').slice(0, 6);
  }

  function paintCode() {
    var value = codeInput.value;
    var focused = document.activeElement === codeInput;
    codeBox.querySelectorAll('.auth-code-cells > span').forEach(function (cell, i) {
      cell.textContent = value.charAt(i) || '';
      cell.classList.toggle('is-active', focused && i === Math.min(value.length, 5));
    });
  }

  function codeChanged() {
    paintCode();
    if (codeWrap.classList.contains('is-invalid') && codeInput.value) setFieldError(codeWrap, '');
    if (codeInput.value.length === 6 && !codeBusy) {
      if (typeof codeForm.requestSubmit === 'function') codeForm.requestSubmit();
      else submitCode();
    }
  }

  function codeFailed(message) {
    codeBusy = false;
    setLoading(codeForm, false);
    setFieldError(codeWrap, message);
    codeInput.value = '';
    paintCode();
    codeInput.focus();
  }

  function submitCode() {
    if (codeBusy) return;
    codeBusy = true;
    setLoading(codeForm, true);
    var meta = document.querySelector('meta[name="csrf-token"]');
    window
      .fetch(codeForm.action, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRF-Token': meta ? meta.getAttribute('content') : '',
        },
        body: new URLSearchParams(new FormData(codeForm)).toString(),
      })
      .then(function (res) {
        return res.json().catch(function () { return { ok: false, message: 'Something went wrong. Please try again.' }; });
      })
      .then(function (data) {
        if (data.ok) {
          codeBox.classList.add('is-success'); // green boxes + the check scales in (200ms), then go
          say('Email verified. Signing you in.');
          window.setTimeout(function () { window.location.assign(data.redirect); }, reducedMotion.matches ? 150 : 400);
          return;
        }
        if (data.redirect) {
          window.location.assign(data.redirect);
          return;
        }
        codeFailed(data.message || 'That code did not work. Please try again.');
        var resend = card.querySelector('[data-auth-resend]');
        if (resend && (data.state === 'expired' || data.state === 'locked')) resend.classList.add('is-emphasis');
      })
      .catch(function () {
        codeFailed('We could not reach the server. Check your connection and try again.');
      });
  }

  if (codeForm && codeInput && codeBox) {
    codeBox.classList.add('is-segmented');
    codeInput.addEventListener('paste', function (event) {
      var data = event.clipboardData || window.clipboardData;
      if (!data) return;
      event.preventDefault(); // maxlength would cut "123 456" to "123 45"; keep the digits instead
      codeInput.value = digitsOf(data.getData('text'));
      codeChanged();
    });
    codeInput.addEventListener('input', function () {
      var clean = digitsOf(codeInput.value);
      if (clean !== codeInput.value) codeInput.value = clean;
      codeChanged();
    });
    codeInput.addEventListener('focus', paintCode);
    codeInput.addEventListener('blur', paintCode);
    document.addEventListener('selectionchange', function () {
      if (document.activeElement === codeInput) paintCode();
    });
    paintCode();
  }

  /* ---------------------------------------------------------------- resend countdown */
  var resendButton = card.querySelector('[data-auth-resend]');
  if (resendButton) {
    var readyAt = Date.now() + (parseInt(resendButton.getAttribute('data-cooldown'), 10) || 0) * 1000;
    var waited = false;
    var shown = '';
    (function tick() {
      var left = Math.ceil((readyAt - Date.now()) / 1000);
      var text = left > 0 ? 'Resend code in ' + left + 's' : 'Resend code';
      if (text !== shown) {
        resendButton.textContent = text;
        shown = text;
      }
      if (left > 0) {
        waited = true;
        resendButton.disabled = true;
        window.setTimeout(tick, 250);
        return;
      }
      resendButton.disabled = false;
      if (waited) say('You can now request a new code.'); // once, when it becomes available — not every second
    })();
    resendButton.form.addEventListener('submit', function () {
      window.setTimeout(function () { resendButton.disabled = true; }, 0);
      resendButton.textContent = 'Sending...';
    });
  }

  /* ---------------------------------------------------------------- submit: validate, then show the loading state */
  card.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form.matches || !form.matches('[data-auth-form]') || event.defaultPrevented) return;

    var firstInvalid = null;
    form.querySelectorAll('.auth-field').forEach(function (wrap) {
      wrap.setAttribute('data-touched', 'true');
      if (validateField(wrap) && !firstInvalid) firstInvalid = wrap.querySelector('input');
    });
    if (firstInvalid) {
      event.preventDefault();
      firstInvalid.focus();
      return;
    }
    if (form === codeForm && window.fetch && window.URLSearchParams && window.FormData) {
      event.preventDefault(); // checked in place, so success and failure can be shown before anything reloads
      submitCode();
      return;
    }
    hidePasswords(form);
    setLoading(form, true);
  });

  /* ---------------------------------------------------------------- page load / back-forward cache */
  window.addEventListener('pageshow', function (event) {
    if (!event.persisted) return;
    card.querySelectorAll('[data-auth-form]').forEach(function (form) { setLoading(form, false); });
    codeBusy = false;
    var route = routeFromPath();
    if (stepEl(route.mode, route.step)) {
      showStep(route.mode, route.step, { push: false });
      setMode(route.mode, { push: false });
      syncChrome();
    }
  });

  // After a failed POST the server re-renders the same step with its messages: put focus on the first invalid field
  // or the alert. Otherwise: the code field on the verify step, the email field on sign in (mouse/keyboard), or the
  // step heading after a round trip on touch devices.
  function initialFocus() {
    var step = currentStepEl(mode);
    if (!step) return;
    var invalid = step.querySelector('[aria-invalid="true"]');
    if (invalid) {
      invalid.focus();
      return;
    }
    var alertBox = step.querySelector('.auth-alert');
    if (alertBox) {
      alertBox.focus();
      return;
    }
    var name = step.getAttribute('data-auth-step');
    if (entering.length) {
      say(ANNOUNCE[name] || '');
      var target = focusTarget(mode);
      if (target) target.focus({ preventScroll: true });
      return;
    }
    if (name === 'signin' && !coarsePointer.matches) {
      var email = step.querySelector('input[name="email"]');
      if (email) email.focus();
    }
  }
})();
