/*
 * Parking etiquette report form: the optional image is read in the browser and sent as a data: URL in the hidden
 * evidence_data field (the app has no multipart uploads). Type and size are checked here for instant feedback and
 * again on the server (src/services/etiquette.js), which also checks the file really is an image.
 */
(function () {
  'use strict';

  var form = document.querySelector('form[data-etiquette-form]');
  if (!form || !window.FileReader) return;

  var input = document.getElementById('evidenceFile');
  var hidden = form.querySelector('[name="evidence_data"]');
  var preview = document.getElementById('evidencePreview');
  var maxBytes = Number(form.dataset.maxBytes) || 2 * 1024 * 1024;
  var TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  var setError = window.UPFieldError || function () { return true; };

  function clear(message) {
    hidden.value = '';
    preview.hidden = true;
    preview.removeAttribute('src');
    setError(input, message || '');
  }

  input.addEventListener('change', function () {
    var file = input.files && input.files[0];
    if (!file) return clear();
    if (TYPES.indexOf(file.type) < 0) {
      input.value = '';
      return clear('Attach a JPEG, PNG, WebP or GIF image.');
    }
    if (file.size > maxBytes) {
      input.value = '';
      return clear('The image must be 2 MB or smaller.');
    }
    var reader = new FileReader();
    reader.onload = function () {
      hidden.value = String(reader.result || '');
      preview.src = hidden.value;
      preview.hidden = false;
      setError(input, '');
    };
    reader.onerror = function () { clear('That image could not be read. Try another file.'); };
    reader.readAsDataURL(file);
  });
})();
