(function () {
  'use strict';

  var editorScrollKey = 'cms-editor-scroll:' + window.location.pathname;
  var savedEditorScroll = window.sessionStorage.getItem(editorScrollKey);
  if (savedEditorScroll !== null) {
    window.sessionStorage.removeItem(editorScrollKey);
    window.requestAnimationFrame(function () {
      window.scrollTo(0, Number(savedEditorScroll) || 0);
    });
  }

  var structuredActions = new Set([
    'block-add',
    'block-delete',
    'item-add',
    'item-delete',
    'block-item-add',
    'block-item-delete',
  ]);
  var editorForm = document.querySelector('form[data-editor-form]');
  if (!editorForm) return;

  editorForm.addEventListener('submit', function (event) {
    var submitter = event.submitter || document.activeElement;
    var action = submitter && submitter.getAttribute
      ? submitter.getAttribute('value') || ''
      : '';
    if (structuredActions.has(action.split(':')[0])) {
      window.sessionStorage.setItem(editorScrollKey, String(window.scrollY));
    }
  });
})();
