/*
 * My Vehicles form: dependent Manufacturer and Model dropdowns (window.VehicleCatalog), each with an "Other" choice.
 *  - the vehicle type decides which manufacturers are offered; the manufacturer decides the models
 *  - changing the type or the manufacturer clears a choice that no longer fits
 *  - choosing Other reveals a text box for the name; a manufacturer typed in has no listed models, so its model is
 *    typed in too (or left out)
 * The server validates the same catalogue and rules (src/services/users.js); this only gives instant feedback.
 */
(function () {
  'use strict';

  var C = window.VehicleCatalog;
  var form = document.querySelector('form[data-vehicle-form]');
  if (!C || !form || !window.UPFieldError) return;

  var OTHER = C.OTHER;
  var typeEl = form.querySelector('[name="vehicle_type"]');
  var makeEl = form.querySelector('[data-vehicle-make]');
  var modelEl = form.querySelector('[data-vehicle-model]');
  var makeOther = form.querySelector('[data-other-for="make"]');
  var modelOther = form.querySelector('[data-other-for="model"]');
  var setError = window.UPFieldError; // app.js

  function fill(select, first, values, withOther) {
    var keep = select.value;
    select.replaceChildren();
    var add = function (value, label) {
      var o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      select.appendChild(o);
    };
    add('', first);
    values.forEach(function (v) { add(v, v); });
    if (withOther) add(OTHER, 'Other');
    select.value = keep;
    if (select.value !== keep) select.value = '';
  }

  /** Show the text box under a dropdown only while Other is chosen. */
  function toggleOther(select, input) {
    var on = select.value === OTHER && !select.disabled;
    input.closest('[class*="col-"]').classList.toggle('d-none', !on);
    if (!on) setError(input, '');
    return on;
  }

  function syncMakes() {
    fill(makeEl, 'Choose a manufacturer', C.manufacturers(typeEl.value), true);
    syncModels();
  }

  function syncModels() {
    var make = makeEl.value;
    var listed = make && make !== OTHER ? C.models(typeEl.value, make) : [];
    fill(modelEl, !make ? 'Choose a manufacturer first' : make === OTHER ? 'No model' : 'Choose a model', listed, !!make);
    modelEl.disabled = !make;
    toggleOther(makeEl, makeOther);
    toggleOther(modelEl, modelOther);
  }

  function checkOther(select, input, what) {
    if (!toggleOther(select, input)) return true;
    var text = input.value.replace(/\s+/g, ' ').trim();
    input.value = text;
    var problem = !text ? 'Enter the ' + what + '.'
      : text.length > 40 ? 'Keep the ' + what + ' under 40 characters.'
      : !/^[\p{L}\p{N}][\p{L}\p{N} .&'/+-]*$/u.test(text) ? "Use letters, numbers, spaces and . & ' / + - only." : '';
    setError(input, problem);
    return !problem;
  }

  typeEl.addEventListener('change', syncMakes);
  makeEl.addEventListener('change', function () {
    setError(makeEl, '');
    syncModels();
    if (makeEl.value === OTHER) makeOther.focus();
  });
  modelEl.addEventListener('change', function () {
    setError(modelEl, '');
    toggleOther(modelEl, modelOther);
    if (modelEl.value === OTHER) modelOther.focus();
  });
  [makeOther, modelOther].forEach(function (input) {
    input.addEventListener('input', function () { setError(input, ''); });
  });

  form.addEventListener('submit', function (event) {
    var ok = checkOther(makeEl, makeOther, 'manufacturer');
    ok = checkOther(modelEl, modelOther, 'model') && ok;
    if (!ok) {
      event.preventDefault();
      event.stopImmediatePropagation();
      (makeOther.classList.contains('is-invalid') ? makeOther : modelOther).focus();
    }
  }, true);
})();
