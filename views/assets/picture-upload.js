(function () {
  'use strict';

  function previewUrl(value) {
    var url = String(value || '').trim();
    if (!url) return '';
    try {
      var source = new URL(url, window.location.origin);
      if (source.origin !== window.location.origin || !source.pathname.startsWith('/media/')) return url;
      return '/media-preview/' + source.pathname.replace(/^\/media\//, '') + source.search;
    } catch (_error) {
      return url;
    }
  }

  function cleanResponseText(value) {
    return String(value || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180);
  }

  document.querySelectorAll('[data-picture-field]').forEach(function (root) {
    if (root.dataset.pictureUploadReady === 'true') return;
    root.dataset.pictureUploadReady = 'true';

    var fileInput = root.querySelector('[data-picture-file]');
    var urlInput = root.querySelector('[data-picture-url]');
    var preview = root.querySelector('[data-picture-preview]');
    var empty = root.querySelector('[data-picture-empty]');
    var status = root.querySelector('[data-picture-status]');
    if (!fileInput || !urlInput) return;

    function setPreview(url) {
      if (!preview) return;
      if (url) {
        preview.dataset.originalSrc = url;
        preview.src = previewUrl(url);
        preview.classList.remove('hidden');
        if (empty) empty.classList.add('hidden');
      } else {
        preview.removeAttribute('src');
        delete preview.dataset.originalSrc;
        preview.classList.add('hidden');
        if (empty) empty.classList.remove('hidden');
      }
    }

    preview && preview.addEventListener('error', function () {
      var original = preview.dataset.originalSrc || '';
      if (original && preview.src !== new URL(original, window.location.origin).href) preview.src = original;
    });
    if (urlInput.value.trim()) setPreview(urlInput.value.trim());
    urlInput.addEventListener('input', function () { setPreview(urlInput.value.trim()); });

    fileInput.addEventListener('change', async function () {
      var file = fileInput.files && fileInput.files[0];
      if (!file) return;
      if (status) status.textContent = 'Uploading...';

      var form = new FormData();
      form.append('dir', 'pictures');
      form.append('file', file);
      try {
        var response = await fetch('/admin/upload', {
          method: 'POST', body: form, credentials: 'same-origin', headers: { Accept: 'application/json' },
        });
        var rawBody = await response.text();
        var result = null;
        if ((response.headers.get('content-type') || '').includes('application/json') && rawBody) {
          try { result = JSON.parse(rawBody); } catch (_error) { result = null; }
        }
        if (!response.ok) {
          var detail = (result && result.error) || response.headers.get('x-cms-error') || cleanResponseText(rawBody);
          throw new Error(detail ? detail + ' (' + response.status + ')' : 'Upload failed (' + response.status + ')');
        }
        var url = result && result.success && Array.isArray(result.files) ? result.files[0] : '';
        if (!url) throw new Error((result && result.error) || 'Upload returned no file URL');
        urlInput.value = url;
        setPreview(url);
        if (status) status.textContent = 'Uploaded';
      } catch (error) {
        if (status) status.textContent = error instanceof Error ? error.message : 'Upload failed';
      } finally {
        fileInput.value = '';
      }
    });
  });
})();
