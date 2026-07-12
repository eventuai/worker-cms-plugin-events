(function () {
  'use strict';

  var form = document.getElementById('import-continue-form');
  if (!form) return;

  // "Stop for now" must beat the auto-resubmit: cancel the pending timer the
  // moment it is clicked, so the navigation away actually ends the loop.
  // (long-running-submit.js keeps [data-stop-continue] links clickable while
  // a pass is in flight; a link click also cancels the in-flight form POST.)
  var timer = null;
  var stopped = false;
  document.querySelectorAll('[data-stop-continue]').forEach(function (link) {
    link.addEventListener('click', function () {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    });
  });

  if (form.getAttribute('data-auto') !== '1') return;

  // Brief pause so the pass summary is readable before the next pass starts.
  timer = setTimeout(function () {
    if (stopped) return;
    if (form.requestSubmit) form.requestSubmit();
    else form.submit();
  }, 800);
}());
