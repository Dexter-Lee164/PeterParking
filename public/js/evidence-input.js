/*
 * Photo evidence (etiquette report: required; penalty appeal: optional): the chosen image is read in the browser and sent as a
 * data: URL in the hidden evidence_data field (the app has no multipart uploads). Type and size are checked here for
 * instant feedback and again on the server (src/services/evidence.js), which also checks the file really is an image.
 */
(function () {
  'use strict';

  if (!window.FileReader) return;
  var TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  var setError = window.UPFieldError || function () { return true; };

  document.querySelectorAll('input[data-evidence-input]').forEach(function (input) {
    var wrap = input.closest('[class*="col-"]');
    var hidden = wrap.querySelector('[name="evidence_data"]');
    var previewWrap = wrap.querySelector('.evidence-preview-wrap');
    var preview = previewWrap.querySelector('img');
    var maxBytes = Number(input.dataset.maxBytes) || 2 * 1024 * 1024;
    var maxText = Math.round(maxBytes / 1048576) + ' MB';

    function clear(message) {
      hidden.value = '';
      previewWrap.hidden = true;
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
        return clear('The image must be ' + maxText + ' or smaller.');
      }
      var reader = new FileReader();
      reader.onload = function () {
        hidden.value = String(reader.result || '');
        preview.src = hidden.value;
        previewWrap.hidden = false;
        setError(input, '');
      };
      reader.onerror = function () { clear('That image could not be read. Try another file.'); };
      reader.readAsDataURL(file);
    });

    previewWrap.querySelector('[data-evidence-clear]').addEventListener('click', function () {
      input.value = '';
      clear();
      input.focus();
    });
  });
})();
