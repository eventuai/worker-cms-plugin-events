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

  var dragRow = null;
  var dragScope = null;
  var dragHandle = null;
  var dragChanged = false;

  function sortableRows(scope) {
    return Array.prototype.slice.call(scope.querySelectorAll('[data-weight-sortable-row]'))
      .filter(function (row) { return row.parentElement === scope; });
  }

  function markSortableRows() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-weight-sortable]'), function (scope) {
      sortableRows(scope).forEach(function (row) { row.setAttribute('draggable', 'true'); });
    });
  }

  function syncSortableWeights(scope) {
    sortableRows(scope).forEach(function (row, index) {
      var input = row.querySelector('[data-weight-sortable-input]');
      if (!input) return;
      input.value = String(index);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  markSortableRows();

  document.addEventListener('mousedown', function (event) {
    dragHandle = event.target.closest && event.target.closest('[data-weight-sortable-handle]');
  });

  document.addEventListener('dragstart', function (event) {
    var row = event.target.closest && event.target.closest('[data-weight-sortable-row]');
    var scope = row && row.parentElement;
    if (!row || !scope || !scope.matches('[data-weight-sortable]')) return;
    if (!dragHandle || !row.contains(dragHandle)) {
      event.preventDefault();
      return;
    }
    dragRow = row;
    dragScope = scope;
    dragChanged = false;
    event.dataTransfer.effectAllowed = 'move';
    row.classList.add('opacity-40');
  });

  document.addEventListener('dragover', function (event) {
    if (!dragRow || !dragScope) return;
    var row = event.target.closest && event.target.closest('[data-weight-sortable-row]');
    if (!row || row === dragRow || row.parentElement !== dragScope) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    var rect = row.getBoundingClientRect();
    var reference = event.clientY > rect.top + rect.height / 2 ? row.nextSibling : row;
    if (reference !== dragRow && reference !== dragRow.nextSibling) {
      dragScope.insertBefore(dragRow, reference);
      dragChanged = true;
    }
  });

  document.addEventListener('drop', function (event) {
    if (dragRow) event.preventDefault();
  });

  document.addEventListener('dragend', function () {
    if (!dragRow) return;
    dragRow.classList.remove('opacity-40');
    if (dragChanged) syncSortableWeights(dragScope);
    dragRow = null;
    dragScope = null;
    dragHandle = null;
    dragChanged = false;
  });
})();
