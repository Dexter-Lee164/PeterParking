/*
 * My Vehicles form: dependent Manufacturer and Model dropdowns (window.VehicleCatalog), each with an "Other" choice.
 *  - the vehicle type decides which manufacturers are offered; the manufacturer decides the models
 *  - changing the type or the manufacturer clears a choice that no longer fits
 *  - choosing Other turns the dropdown into a text box in the same place (its list button turns it back); a
 *    manufacturer typed in has no listed models, so its model is typed in too (or left out)
 *  - the plate number stops at C.PLATE_MAX characters, not counting spaces
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
  var plateEl = form.querySelector('[data-plate-max]');

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

  /** While Other is chosen the text box stands in for the dropdown (the hidden dropdown still sends Other). */
  function toggleOther(select, input) {
    var on = select.value === OTHER && !select.disabled;
    select.classList.toggle('d-none', on);
    input.closest('[data-other-group]').classList.toggle('d-none', !on);
    var label = form.querySelector('label[for="' + (on ? select.id : input.id) + '"]');
    if (label) label.htmlFor = on ? input.id : select.id;
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
  form.querySelector('[data-other-back="make"]').addEventListener('click', function () {
    makeEl.value = '';
    syncModels();
    makeEl.focus();
  });
  form.querySelector('[data-other-back="model"]').addEventListener('click', function () {
    modelEl.value = '';
    toggleOther(modelEl, modelOther);
    modelEl.focus();
  });
  // Drop whatever is typed or pasted past the limit (spaces do not count towards it).
  plateEl.addEventListener('input', function () {
    var count = 0;
    var kept = '';
    for (var i = 0; i < plateEl.value.length; i++) {
      var ch = plateEl.value[i];
      if (ch !== ' ' && ++count > C.PLATE_MAX) continue;
      kept += ch;
    }
    if (kept !== plateEl.value) {
      plateEl.value = kept;
      setError(plateEl, 'Plate numbers have at most ' + C.PLATE_MAX + ' letters or numbers (spaces do not count).');
    } else setError(plateEl, '');
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
