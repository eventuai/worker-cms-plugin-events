(function () {
  'use strict';

  var style = document.createElement('style');
  style.textContent = '@keyframes cms-long-submit-spin{to{transform:rotate(360deg)}}';
  document.head.appendChild(style);

  document.querySelectorAll('form[data-long-running-form]').forEach(function (form) {
    form.addEventListener('submit', function (event) {
      if (form.getAttribute('data-submitting') === '1') {
        event.preventDefault();
        return;
      }
      form.setAttribute('data-submitting', '1');
      form.setAttribute('aria-busy', 'true');

      var submitter = event.submitter || form.querySelector('button[type="submit"], input[type="submit"]');
      document.querySelectorAll('button').forEach(function (button) {
        button.disabled = true;
        button.setAttribute('aria-disabled', 'true');
        button.style.cursor = 'wait';
        button.style.opacity = '0.65';
      });
      document.querySelectorAll('a[href]').forEach(function (link) {
        link.setAttribute('aria-disabled', 'true');
        link.style.pointerEvents = 'none';
        link.style.opacity = '0.65';
      });

      if (!submitter || submitter.tagName !== 'BUTTON') return;
      submitter.style.width = submitter.getBoundingClientRect().width + 'px';
      submitter.setAttribute('aria-label', submitter.getAttribute('data-loading-label') || 'Working');
      Array.prototype.forEach.call(submitter.children, function (child) {
        child.style.display = 'none';
      });
      submitter.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true" style="animation:cms-long-submit-spin .8s linear infinite"><circle cx="12" cy="12" r="9" opacity=".25"></circle><path d="M21 12a9 9 0 0 0-9-9"></path></svg>');
    });
  });
}());
