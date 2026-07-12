(function () {
  'use strict';

  var form = document.getElementById('import-continue-form');
  if (!form || form.getAttribute('data-auto') !== '1') return;

  // Brief pause so the pass summary is readable before the next pass starts.
  setTimeout(function () {
    if (form.requestSubmit) form.requestSubmit();
    else form.submit();
  }, 800);
}());
