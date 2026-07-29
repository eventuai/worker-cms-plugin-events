(function () {
  'use strict';

  var nameInput = document.getElementById('event-name') || document.getElementById('edm-name');
  var slugInput = document.getElementById('event-slug') || document.getElementById('edm-slug');
  if (!nameInput || !slugInput) return;

  var slugEdited = Boolean(slugInput.value);
  slugInput.addEventListener('input', function () {
    slugEdited = true;
  });

  nameInput.addEventListener('input', function () {
    if (slugEdited) return;
    slugInput.value = nameInput.value.toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  });
}());
