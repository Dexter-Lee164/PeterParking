/*
 * Find Parking page controller.
 *  - Time-range validation and live duration / fee calculation
 *  - Availability search against the Express/SQLite backend (HTML fragments from the same EJS partials). It runs by
 *    itself whenever the date, times, vehicle (type) or zone change; only the newest request may update the page
 *    (older ones are aborted, and any late answer is ignored), and a selected slot that no longer fits is cleared
 *  - Zone switching, slot selection on the map (the only view), details and summary panels
 *  - The driver's registered vehicle drawn into the selected stall (vehicle-art.js), parked cars in occupied ones,
 *    and the Selected slot preview: a zoomed copy of the real map centred on the chosen stall
 *  - A car or motorcycle icon that follows the chosen vehicle, and a notice when its plate is banned
 */
(function () {
  'use strict';

  var cfgEl = document.getElementById('findParkingConfig');
  if (!cfgEl) return;
  var cfg = JSON.parse(cfgEl.textContent);
  var R = window.UPReservation;
  var V = window.UPVehicle;
  var vehicles = cfg.vehicles || [];

  var form = document.getElementById('searchForm');
  var dateEl = form.querySelector('[name="date"]');
  var startEl = form.querySelector('[name="start"]');
  var endEl = form.querySelector('[name="end"]');
  var vehicleEl = form.querySelector('[name="vehicle_type"]');
  var zoneEl = form.querySelector('[name="zone_id"]');
  var retryBtn = document.getElementById('retrySearch');
  var errorsEl = document.getElementById('searchForm-errors');
  var durationText = document.getElementById('durationText');
  var durationPill = document.getElementById('durationPill');
  var staleNotice = document.getElementById('staleNotice');
  var mapBox = document.getElementById('mapContainer');
  var counts = document.getElementById('slotCounts');
  var zoneTabs = document.getElementById('zoneTabs');
  var searchStatus = document.getElementById('searchStatus');

  var detailEmpty = document.getElementById('slotDetailEmpty');
  var detailBody = document.getElementById('slotDetailBody');
  var continueForm = document.getElementById('continueForm');
  var continueBtns = [document.getElementById('continueBtn'), document.getElementById('continueBtnMobile')].filter(Boolean);
  var preview = document.getElementById('slotPreview');
  var previewView = preview && preview.querySelector('[data-preview-view]');
  var picker = document.getElementById('vehiclePicker');
  var vehicleNote = document.getElementById('vehicleNote');

  var loadedAt = Date.now();
  var state = {
    selectedId: cfg.selectedSlotId ? String(cfg.selectedSlotId) : null,
    zoneId: cfg.zoneId ? String(cfg.zoneId) : '',
    vehicleId: cfg.vehicleId ? String(cfg.vehicleId) : (picker ? picker.value : null),
    searchedKey: null,
    loading: false,
    pending: false, // a refresh is scheduled or running
    failed: false, // the last refresh could not reach the server
  };

  function currentVehicle() {
    for (var i = 0; i < vehicles.length; i++) if (String(vehicles[i].id) === state.vehicleId) return vehicles[i];
    return null;
  }
  /** The chosen vehicle, but only while it matches the vehicle-type filter (a car is never drawn in a motorcycle bay). */
  function drawableVehicle() {
    var v = currentVehicle();
    var type = vehicleEl ? vehicleEl.value : '';
    return v && (!type || v.vehicle_type === type) ? v : null;
  }

  function nowMinutesToday() {
    return cfg.nowMinutes + (Date.now() - loadedAt) / 60000;
  }
  function values() {
    return { date: dateEl.value, start: startEl.value, end: endEl.value, vehicle_type: vehicleEl ? vehicleEl.value : '' };
  }
  function keyOf(v) {
    return [v.date, v.start, v.end, v.vehicle_type].join('|');
  }
  function minutes() {
    return R.hhmmToMinutes(endEl.value) - R.hhmmToMinutes(startEl.value);
  }
  function problems() {
    var v = values();
    return R.validate(cfg, v.date, v.start, v.end, nowMinutesToday(), cfg.today).concat(
      v.date && v.date > cfg.maxDate ? ['Bookings can be made up to ' + cfg.maxAdvanceDays + ' days in advance.'] : []
    );
  }
  function selectedButton() {
    return state.selectedId ? mapBox.querySelector('.slot[data-slot-id="' + state.selectedId + '"]') : null;
  }
  function isStale() {
    return keyOf(values()) !== state.searchedKey;
  }
  function set(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  // ---- UI refresh ---------------------------------------------------------
  function updateAll() {
    var errs = problems();
    var mins = minutes();
    durationText.textContent = mins > 0 ? R.fmtDuration(mins) : '—';
    durationPill.classList.toggle('is-invalid', errs.length > 0);
    errorsEl.textContent = errs.join(' ');
    var stale = isStale();
    if (staleNotice) staleNotice.hidden = !(stale && errs.length === 0 && state.failed && !state.pending);

    var btn = selectedButton();
    var v = values();
    set('sumDate', v.date ? formatDate(v.date) : '—');
    set('sumTime', errs.length || mins <= 0 ? '—' : R.label12(v.start) + ' – ' + R.label12(v.end));
    set('sumDuration', mins > 0 ? R.fmtDuration(mins) : '—');
    var fee = null;
    if (btn && mins > 0 && errs.length === 0) {
      fee = R.calcFee(parseInt(btn.dataset.rate, 10), mins, cfg.increment);
    }
    set('sumSlot', btn ? btn.dataset.code : 'None selected');
    set('sumZone', btn ? btn.dataset.zone : '—');
    set('sumRate', btn ? R.formatPeso(parseInt(btn.dataset.rate, 10)) + ' / hour' : '—');
    set('sumFee', fee === null ? '₱0.00' : R.formatPeso(fee));
    set('detailPeriod', errs.length || mins <= 0 ? '—' : formatDate(v.date) + ', ' + R.label12(v.start) + ' – ' + R.label12(v.end));
    set('mobileSelected', btn ? btn.dataset.code + ' · ' + (fee === null ? '' : R.formatPeso(fee)) : 'Select an available slot');

    var canContinue = !!btn && !stale && errs.length === 0;
    continueBtns.forEach(function (b) { b.disabled = !canContinue; });
    var hint = document.getElementById('continueHint');
    if (hint) {
      hint.textContent = !btn ? 'Select an available slot to continue.'
        : errs.length ? 'Fix the time range to continue.'
        : stale ? (state.pending ? 'Checking this slot for your new search…' : 'Availability could not be refreshed. Try again to confirm this slot for the new time.') : '';
    }
    if (continueForm) {
      continueForm.querySelector('[name="slot_id"]').value = btn ? btn.dataset.slotId : '';
      continueForm.querySelector('[name="date"]').value = v.date;
      continueForm.querySelector('[name="start"]').value = v.start;
      continueForm.querySelector('[name="end"]').value = v.end;
      continueForm.querySelector('[name="vehicle_type"]').value = v.vehicle_type;
      var vid = continueForm.querySelector('[name="vehicle_id"]');
      var dv = drawableVehicle();
      if (vid) vid.value = dv ? dv.id : '';
    }
    if (vehicleNote) {
      var cv = currentVehicle();
      var shown = drawableVehicle();
      vehicleNote.textContent = !cv ? '' : !shown ? 'This vehicle does not match the vehicle type you searched for.'
        : btn ? 'Shown parked in ' + btn.dataset.code + '.' : 'Select a slot to see it parked.';
    }
  }

  // ---- vehicle icons -------------------------------------------------------------------
  function iconClass(type) {
    return type === 'motorcycle' ? 'vi vi-motorcycle' : 'bi bi-car-front';
  }
  function showIcons() {
    var v = currentVehicle();
    var type = v ? v.vehicle_type : (vehicleEl ? vehicleEl.value : '');
    ['vehiclePickerIcon', 'vehicleTypeIcon'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.className = iconClass(type) + (id === 'vehicleTypeIcon' ? ' me-1' : '');
    });
    var notice = document.getElementById('banNotice');
    if (notice) {
      notice.hidden = !(v && v.ban);
      set('banText', v && v.ban ? v.ban.message : '');
    }
  }

  // ---- the driver's vehicle card ----------------------------------------------------
  function showVehicle() {
    showIcons();
    var v = currentVehicle();
    var art = document.getElementById('vehicleArt');
    if (!art) return;
    art.innerHTML = v && V ? V.side(v) : '';
    set('vehicleName', v ? ([v.make, v.model].filter(Boolean).join(' ') || v.vehicle_type) : '—');
    set('vehiclePlate', v ? v.plate_number : '');
    set('vehicleColor', v && v.color ? v.color : 'Colour not set');
    var dot = document.getElementById('vehicleDot');
    if (dot) dot.style.background = v && V ? V.colorOf(v) : 'transparent';
  }

  // ---- vehicles on the map ------------------------------------------------------
  var STALL_CM = { car: { w: 260, l: 520 }, moto: { w: 140, l: 260 }, parallel: { w: 240, l: 580 } };
  function drawVehicle(btn, v, kind) {
    var box = btn.querySelector('.slot-vehicle');
    if (!box) return;
    if (!v || !V) {
      box.innerHTML = '';
      box.removeAttribute('data-kind');
      btn.classList.remove('has-vehicle');
      return;
    }
    var key = kind + ':' + [v.id, v.vehicle_type, v.make, v.model, v.color].join('|');
    if (box.getAttribute('data-key') === key) return;
    var dims = V.size(v);
    var frame = STALL_CM[btn.dataset.kind] || STALL_CM.car;
    box.innerHTML = V.svg(v);
    var art = box.firstChild;
    // The drawing keeps the vehicle's real size and proportions inside the stall (in centimetres).
    art.style.width = Math.min(96, (dims.w / frame.w) * 100) + '%';
    art.style.height = Math.min(94, (dims.l / frame.l) * 100) + '%';
    box.setAttribute('data-kind', kind);
    box.setAttribute('data-key', key);
    btn.classList.add('has-vehicle');
  }

  function decorate() {
    var mine = drawableVehicle();
    mapBox.querySelectorAll('.slot').forEach(function (btn) {
      if (btn.dataset.state === 'occupied') drawVehicle(btn, V && V.parked(btn.dataset.slotId, btn.dataset.type), 'parked');
      else if (btn.classList.contains('is-selected')) drawVehicle(btn, mine, 'mine');
      else drawVehicle(btn, null);
    });
  }

  // ---- selected slot preview: a zoomed, inert copy of the map ------------------------
  var STALLS_ACROSS = 5.2; // how many stalls fit across the preview
  function renderPreview(btn) {
    var stage = mapBox.querySelector('[data-lot-stage]');
    if (!preview || !previewView || !btn || !stage) {
      if (preview) preview.hidden = true;
      return;
    }
    preview.hidden = false;
    var svg = stage.querySelector('svg');
    var vb = svg && svg.viewBox && svg.viewBox.baseVal;
    if (!vb || !vb.width) return;
    var pw = previewView.clientWidth;
    var ph = previewView.clientHeight;
    var cloneW = pw * (vb.width / (26 * STALLS_ACROSS));
    var cloneH = cloneW * (vb.height / vb.width);

    var clone = stage.cloneNode(true);
    clone.removeAttribute('data-lot-stage');
    clone.removeAttribute('id');
    clone.classList.add('is-preview');
    clone.setAttribute('inert', '');
    clone.querySelectorAll('[id]').forEach(function (el) { el.removeAttribute('id'); });
    clone.querySelectorAll('button').forEach(function (b) {
      b.tabIndex = -1;
      b.removeAttribute('aria-label');
      b.removeAttribute('title');
    });
    clone.style.width = cloneW + 'px';

    var pctOf = function (v) { return parseFloat(v) / 100; };
    var cx = (pctOf(btn.style.left) + pctOf(btn.style.width) / 2) * cloneW;
    var cy = (pctOf(btn.style.top) + pctOf(btn.style.height) / 2) * cloneH;
    var clamp = function (v, min, max) { return Math.max(min, Math.min(max, v)); };
    var tx = clamp(pw / 2 - cx, pw - cloneW, 0);
    var ty = clamp(ph / 2 - cy, ph - cloneH, 0);

    var pan = previewView.firstElementChild;
    if (!pan) {
      pan = document.createElement('div');
      pan.className = 'slot-preview-pan';
      previewView.appendChild(pan);
    }
    pan.replaceChildren(clone);
    pan.style.transform = 'translate(' + tx.toFixed(1) + 'px, ' + ty.toFixed(1) + 'px)';
  }

  function neighbourText(btn) {
    var rot = btn.style.getPropertyValue('--rot');
    var cx = parseFloat(btn.dataset.cx);
    var cy = parseFloat(btn.dataset.cy);
    var line = [];
    var axis = 'x';
    mapBox.querySelectorAll('.slot').forEach(function (b) {
      if (b.style.getPropertyValue('--rot') === rot && Math.abs(parseFloat(b.dataset.cy) - cy) < 1) line.push(b);
    });
    if (line.length < 2) {
      line = [];
      axis = 'y';
      mapBox.querySelectorAll('.slot').forEach(function (b) {
        if (b.style.getPropertyValue('--rot') === rot && Math.abs(parseFloat(b.dataset.cx) - cx) < 1) line.push(b);
      });
    }
    var pos = function (b) { return parseFloat(axis === 'x' ? b.dataset.cx : b.dataset.cy); };
    line.sort(function (a, b) { return pos(a) - pos(b); });
    var i = line.indexOf(btn);
    // Neighbours are the next stalls along the line, no further apart than about one stall (plus its markings).
    var sideways = rot === '90deg' || rot === '-90deg';
    var frame = STALL_CM[btn.dataset.kind] || STALL_CM.car;
    var pitch = (axis === 'x') === sideways ? frame.l / 10 : frame.w / 10;
    var gap = function (a, b) { return a && b && Math.abs(pos(a) - pos(b)) < pitch * 1.4; };
    var before = gap(line[i - 1], btn) ? line[i - 1].dataset.code : null;
    var after = gap(line[i + 1], btn) ? line[i + 1].dataset.code : null;
    if (before && after) return 'Between ' + before + ' and ' + after;
    if (before || after) return 'End of row, next to ' + (before || after);
    return 'Standalone bay';
  }

  function refreshVehicleViews() {
    decorate();
    renderPreview(selectedButton());
  }
  function formatDate(iso) {
    var p = iso.split('-');
    if (p.length !== 3) return iso;
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  }

  // ---- slot selection -------------------------------------------------------
  function paintSlot(btn, selected) {
    if (btn.dataset.state !== 'available') return;
    btn.classList.toggle('is-selected', selected);
    btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
    var glyph = btn.querySelector('.slot-glyph');
    if (glyph) glyph.className = 'bi ' + (selected ? 'bi-check-circle-fill' : 'bi-check-circle') + ' slot-glyph';
    var label = btn.querySelector('.slot-state');
    if (label) label.textContent = selected ? 'Selected' : 'Available';
  }

  function showDetails(btn) {
    if (!btn) {
      detailEmpty.hidden = false;
      detailBody.hidden = true;
      return;
    }
    detailEmpty.hidden = true;
    detailBody.hidden = false;
    set('detailCode', btn.dataset.code);
    set('detailZone', btn.dataset.zone);
    set('detailType', btn.dataset.typeLabel);
    set('detailStatus', btn.dataset.opStatus);
    set('detailRate', R.formatPeso(parseInt(btn.dataset.rate, 10)) + ' / hour');
    set('detailLocation', neighbourText(btn));
    set('previewCode', btn.dataset.code);
    var badge = document.getElementById('detailBadge');
    if (badge) badge.textContent = 'Available';
    var icon = document.getElementById('detailTypeIcon');
    if (icon) icon.className = btn.dataset.typeIcon;
  }

  function selectSlot(id) {
    if (state.loading) return; // this map is about to be replaced by the refreshed one
    var btn = mapBox.querySelector('.slot[data-slot-id="' + id + '"]');
    if (!btn || btn.disabled || btn.dataset.state !== 'available') return;
    // Toggle off when choosing the same bay again.
    var next = state.selectedId === String(id) ? null : String(id);
    mapBox.querySelectorAll('.slot.is-selected').forEach(function (b) { paintSlot(b, false); });
    state.selectedId = next;
    if (next) paintSlot(btn, true);
    showDetails(next ? btn : null);
    refreshVehicleViews();
    updateAll();
  }

  mapBox.addEventListener('click', function (event) {
    var btn = event.target.closest('.slot');
    if (btn && !btn.disabled) selectSlot(btn.dataset.slotId);
  });

  // ---- search -----------------------------------------------------------------
  function applyResponse(data, v, asked) {
    mapBox.innerHTML = data.mapHtml;
    state.zoneId = String(data.zoneId || '');
    zoneEl.value = state.zoneId;
    state.searchedKey = keyOf(v);
    state.selectedId = data.selectedSlotId ? String(data.selectedSlotId) : null;
    // The server keeps a selection only while that slot is still free and fits the vehicle: say so when it was dropped.
    if (asked.id && !state.selectedId && searchStatus) {
      searchStatus.textContent = 'Slot ' + asked.code + ' is not available for this search, so it was deselected.';
    }

    (data.zones || []).forEach(function (z) {
      var tab = zoneTabs && zoneTabs.querySelector('[data-zone-id="' + z.id + '"]');
      if (!tab) return;
      tab.setAttribute('aria-selected', String(String(z.id) === state.zoneId));
      var c = tab.querySelector('.zone-count');
      if (c) {
        c.textContent = String(z.available);
        c.classList.toggle('none', z.available === 0);
      }
    });
    if (counts && data.counts) {
      counts.textContent = data.counts.available + ' available · ' + data.counts.reserved + ' reserved · ' + data.counts.occupied + ' occupied · ' + data.counts.unavailable + ' unavailable';
    }
    showDetails(selectedButton());
    refreshVehicleViews();
    var url = new URL(window.location.href);
    var query = { date: v.date, start: v.start, end: v.end, vehicle_type: v.vehicle_type, zone_id: state.zoneId };
    if (state.vehicleId) query.vehicle_id = state.vehicleId;
    url.search = new URLSearchParams(query).toString();
    window.history.replaceState(null, '', url.toString());
    updateAll();
  }

  var requestSeq = 0; // only the answer to the newest request may touch the page
  var inFlight = null; // AbortController of the running request
  var searchTimer = null;

  function setLoading(on) {
    state.loading = on;
    mapBox.classList.toggle('search-loading', on);
    mapBox.setAttribute('aria-busy', on ? 'true' : 'false');
    if (searchStatus && on) {
      searchStatus.innerHTML = '<span class="spinner-border" aria-hidden="true"></span><span></span>';
      searchStatus.lastChild.textContent = 'Updating availability…';
    }
  }

  function cancelSearch() {
    window.clearTimeout(searchTimer);
    searchTimer = null;
    requestSeq += 1; // an answer still on its way is now outdated
    if (inFlight) inFlight.abort();
    inFlight = null;
    state.pending = false;
    if (state.loading) setLoading(false);
    if (searchStatus) searchStatus.textContent = '';
  }

  /** Refresh availability soon (changes in quick succession make one request). Invalid filters cancel instead. */
  function scheduleSearch(delay) {
    window.clearTimeout(searchTimer);
    if (problems().length) {
      cancelSearch();
      updateAll();
      return;
    }
    state.pending = true;
    updateAll();
    searchTimer = window.setTimeout(search, delay === undefined ? 250 : delay);
  }

  function search() {
    window.clearTimeout(searchTimer);
    searchTimer = null;
    var errs = problems();
    if (errs.length) {
      cancelSearch();
      updateAll();
      return Promise.resolve();
    }
    var v = values();
    var askedBtn = selectedButton();
    var asked = { id: state.selectedId, code: askedBtn ? askedBtn.dataset.code : state.selectedId };
    var params = new URLSearchParams({
      fragment: '1', date: v.date, start: v.start, end: v.end, vehicle_type: v.vehicle_type,
      zone_id: state.zoneId, slot_id: state.selectedId || '',
    });
    if (inFlight) inFlight.abort();
    inFlight = window.AbortController ? new AbortController() : null;
    var seq = ++requestSeq;
    var current = function () { return seq === requestSeq; };
    state.pending = true;
    setLoading(true);
    return fetch(cfg.fragmentUrl + '?' + params.toString(), {
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'same-origin',
      signal: inFlight ? inFlight.signal : undefined,
    })
      .then(function (res) { return res.json().then(function (j) { return { status: res.status, body: j }; }); })
      .then(function (r) {
        if (!current()) return;
        if (r.status === 401) {
          window.location.href = '/login';
          return;
        }
        state.failed = false;
        if (searchStatus) searchStatus.textContent = '';
        if (!r.body || r.body.ok === false || r.body.error) {
          var msg = (r.body && (r.body.errors || []).join(' ')) || (r.body && r.body.error) || 'Could not load availability.';
          errorsEl.textContent = msg;
          return;
        }
        applyResponse(r.body, v, asked);
      })
      .catch(function (err) {
        if (!current() || (err && err.name === 'AbortError')) return;
        state.failed = true;
        if (searchStatus) searchStatus.textContent = '';
        window.UPToast('error', 'Could not reach the server. Check your connection and try searching again.');
      })
      .then(function () {
        if (!current()) return;
        inFlight = null;
        state.pending = false;
        setLoading(false);
        updateAll();
      });
  }

  // There is no search button (results refresh by themselves); "Try again" retries after a failed refresh.
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    search();
  });
  if (retryBtn) retryBtn.addEventListener('click', function () { search(); });

  function switchZone(id) {
    if (!id || String(id) === state.zoneId) return;
    state.zoneId = String(id);
    state.selectedId = null; // a slot from another zone is no longer shown
    zoneEl.value = state.zoneId;
    if (zoneTabs) zoneTabs.querySelectorAll('.zone-tab').forEach(function (t) { t.setAttribute('aria-selected', String(t.dataset.zoneId === state.zoneId)); });
    scheduleSearch(0);
  }
  if (zoneEl && zoneEl.tagName === 'SELECT') zoneEl.addEventListener('change', function () { switchZone(zoneEl.value); });

  if (zoneTabs) {
    zoneTabs.addEventListener('click', function (event) {
      var tab = event.target.closest('.zone-tab');
      if (tab) switchZone(tab.dataset.zoneId);
    });
  }

  // ---- time controls ------------------------------------------------------------
  var previousDuration = Math.max(minutes(), cfg.minDuration);
  startEl.addEventListener('change', function () {
    var s = R.hhmmToMinutes(startEl.value);
    var close = R.hhmmToMinutes(cfg.close);
    var target = Math.min(s + previousDuration, close);
    if (target <= s) target = Math.min(s + cfg.step, close);
    endEl.value = R.minutesToHHMM(target);
    if (endEl.value !== R.minutesToHHMM(target)) {
      // end option missing for this value: pick the nearest later option
      for (var i = 0; i < endEl.options.length; i++) {
        if (R.hhmmToMinutes(endEl.options[i].value) > s) { endEl.selectedIndex = i; break; }
      }
    }
    scheduleSearch();
  });
  endEl.addEventListener('change', function () {
    var m = minutes();
    if (m > 0) previousDuration = m;
    scheduleSearch();
  });
  if (dateEl) {
    dateEl.addEventListener('change', function () { scheduleSearch(); });
    // Typing a date fires "input" on every keystroke; wait a little longer before searching.
    dateEl.addEventListener('input', function () { if (dateEl.value) scheduleSearch(500); });
  }
  if (vehicleEl && vehicleEl.tagName === 'SELECT') {
    vehicleEl.addEventListener('change', function () {
      // Follow the filter with the picker when one of the driver's vehicles is of that type.
      var cv = currentVehicle();
      if (picker && vehicleEl.value && (!cv || cv.vehicle_type !== vehicleEl.value)) {
        for (var i = 0; i < vehicles.length; i++) {
          if (vehicles[i].vehicle_type === vehicleEl.value) {
            state.vehicleId = String(vehicles[i].id);
            picker.value = state.vehicleId;
            break;
          }
        }
      }
      showIcons();
      refreshVehicleViews();
      // Another vehicle type changes which bays fit: refresh their states straight away.
      scheduleSearch(0);
    });
  }

  // ---- registered vehicle picker ----------------------------------------------------
  if (picker) {
    picker.addEventListener('change', function () {
      state.vehicleId = picker.value;
      showVehicle();
      var v = currentVehicle();
      refreshVehicleViews();
      if (v && vehicleEl && vehicleEl.value !== v.vehicle_type) {
        // Another vehicle type changes which bays fit: refresh their states straight away.
        vehicleEl.value = v.vehicle_type;
        scheduleSearch(0);
        return;
      }
      updateAll();
    });
  }

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(function () { renderPreview(selectedButton()); }, 120);
  });

  // ---- init --------------------------------------------------------------------------
  state.searchedKey = typeof cfg.searchedKey === 'string' ? cfg.searchedKey : keyOf(values());
  showDetails(selectedButton());
  showVehicle();
  refreshVehicleViews();
  updateAll();
})();
