(function() {
  if (window.WorkerCmsAllGuestsEmbedded) {
    window.WorkerCmsAllGuestsEmbedded.scan(document);
    return;
  }

  function text(root, selector, value) {
    var node = root.querySelector(selector);
    if (node) node.textContent = value == null ? '' : String(value);
    return node;
  }

  function setHref(node, value) {
    if (!(node instanceof HTMLAnchorElement)) return;
    node.href = String(value || '');
  }

  function setFormAction(node, value) {
    var form = node instanceof HTMLFormElement ? node : node && node.closest('form');
    if (form instanceof HTMLFormElement) form.action = String(value || '');
  }

  function updateStatus(row, data) {
    var control = row.querySelector('[data-guest-status]');
    if (!control) return;
    Array.from(control.classList).forEach(function(name) {
      if (name.indexOf('response-state-') === 0) control.classList.remove(name);
    });
    if (data.statusClass) control.classList.add(String(data.statusClass));
    control.style.color = String(data.statusColor || '');
    if (control instanceof HTMLSelectElement) {
      control.value = String(data.status || '');
      setFormAction(control, data.statusAction);
    } else {
      control.textContent = String(data.status || '');
    }
  }

  function updateColorPicker(row, data) {
    var form = row.querySelector('[data-color-tag-picker]');
    if (!(form instanceof HTMLFormElement)) return;
    form.action = String(data.colorAction || '');
    form.setAttribute('data-color-tag-value', String(data.color_tag || ''));
    form.removeAttribute('data-color-tag-busy');
    form.removeAttribute('data-color-tag-suppress-open');
    var returnTo = form.querySelector('input[name="return_to"]');
    if (returnTo instanceof HTMLInputElement) returnTo.value = String(data.returnTo || '');
  }

  function resetPrivacyState(row) {
    row.querySelectorAll('[data-private-field]').forEach(function(field) {
      field.removeAttribute('data-private-original-html');
      field.removeAttribute('data-private-original-text');
      field.removeAttribute('data-private-mask');
      field.removeAttribute('data-private-masked');
    });
  }

  function updateCheckin(row, checkedIn) {
    var cell = row.querySelector('[data-guest-checkin]');
    if (!cell) return;
    cell.textContent = '';
    var label = document.createElement('span');
    if (checkedIn) {
      label.className = 'inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-700';
      label.textContent = 'Checked in';
    } else {
      label.className = 'text-xs text-gray-400';
      label.textContent = 'Not checked in';
    }
    cell.appendChild(label);
  }

  function updateActions(row, data) {
    var cell = row.querySelector('[data-guest-actions]');
    if (!cell) return;
    var qr = cell.querySelector('[data-guest-qr]');
    var edit = cell.querySelector('[data-guest-edit]');
    cell.textContent = '';
    if (qr instanceof HTMLAnchorElement && data.qrHref) {
      setHref(qr, data.qrHref);
      cell.appendChild(qr);
    }
    if (edit instanceof HTMLAnchorElement && data.editHref) {
      setHref(edit, data.editHref);
      if (cell.childNodes.length) cell.appendChild(document.createTextNode(' · '));
      cell.appendChild(edit);
    }
  }

  function fillRow(prototype, data) {
    var row = prototype.cloneNode(true);
    row.setAttribute('data-filter-search', String(data.searchText || ''));
    row.setAttribute('data-filter-status', String(data.status || ''));
    row.setAttribute('data-filter-color', String(data.color_tag || ''));

    var name = text(row, '[data-guest-name]', data.name);
    if (name instanceof HTMLAnchorElement) setHref(name, data.editHref);
    text(row, '[data-guest-email]', data.email);
    text(row, '[data-guest-list]', data.listName);
    text(row, '[data-guest-organization]', data.organization);
    var job = text(row, '[data-guest-job-title]', data.job_title);
    if (job) job.hidden = !data.job_title;
    var custom = text(row, '[data-guest-custom-field]', data.customFieldValue || '—');
    if (custom) custom.classList.toggle('text-gray-400', !data.customFieldValue);
    updateStatus(row, data);
    updateColorPicker(row, data);
    updateCheckin(row, Boolean(data.checkedIn));
    updateActions(row, data);
    resetPrivacyState(row);
    return row;
  }

  function setSummary(root, rendered, filtered, total, done) {
    var summary = root.parentElement && root.parentElement.querySelector('[data-all-guests-summary-text]');
    if (!summary) summary = document.querySelector('[data-all-guests-summary-text]');
    if (!summary) return;
    if (!done) {
      summary.textContent = rendered + ' of ' + filtered + ' matching guests rendered';
      return;
    }
    summary.textContent = '';
    var count = document.createElement('span');
    count.setAttribute('data-table-filter-count', 'guests');
    count.textContent = String(filtered);
    summary.appendChild(count);
    summary.appendChild(document.createTextNode(' of ' + total + ' guest' + (total === 1 ? '' : 's') + ' across every list'));
  }

  function nextPaint() {
    // Yield to the browser between batches. Timers keep progressing in a
    // background tab, unlike requestAnimationFrame which may be fully paused.
    return new Promise(function(resolve) { setTimeout(resolve, 0); });
  }

  async function load(root) {
    if (root.getAttribute('data-all-guests-started') === '1') return;
    root.setAttribute('data-all-guests-started', '1');
    var target = root.querySelector('[data-all-guests-table]');
    var loading = root.querySelector('[data-all-guests-loading]');
    var progress = root.querySelector('[data-all-guests-progress]');
    var dataNode = root.querySelector('[data-all-guests-json]');
    if (!target || !dataNode) return;

    var tbody = target.querySelector('tbody');
    var prototype = target.querySelector('[data-guest-row]');
    var emptyRow = target.querySelector('[data-table-filter-empty]');
    if (!prototype || !tbody) return;
    if (emptyRow) emptyRow.remove();

    var initial = Number(root.getAttribute('data-initial-count') || 0);
    var filtered = Number(root.getAttribute('data-filtered-count') || initial);
    var total = Number(root.getAttribute('data-total-count') || filtered);
    try {
      var deferred = JSON.parse(dataNode.textContent || '[]');
      dataNode.remove();
      var rendered = initial;

      // Let Liquid's first 100 rows and the spinner paint before adding more.
      await nextPaint();
      for (var offset = 0; offset < deferred.length; offset += 100) {
        if (!root.isConnected) return;
        var fragment = document.createDocumentFragment();
        deferred.slice(offset, offset + 100).forEach(function(data) {
          fragment.appendChild(fillRow(prototype, data));
          rendered += 1;
        });
        if (window.WorkerCmsColorTag) window.WorkerCmsColorTag.scan(fragment);
        tbody.appendChild(fragment);
        setSummary(root, rendered, filtered, total, false);
        if (progress) progress.textContent = 'Rendering ' + rendered + ' of ' + filtered + ' matching guests…';
        await nextPaint();
      }

      deferred.length = 0;
      if (filtered === 0 && emptyRow) {
        emptyRow.hidden = false;
        tbody.appendChild(emptyRow);
      } else if (emptyRow) {
        emptyRow.hidden = true;
        tbody.appendChild(emptyRow);
      }
      setSummary(root, filtered, filtered, total, true);
      if (loading) loading.remove();
      if (window.WorkerCmsTableFilter) window.WorkerCmsTableFilter.scan(document);
    } catch (error) {
      if (progress) progress.textContent = 'The remaining guests could not be rendered. Refresh the page to try again.';
      if (loading) loading.classList.add('border-red-200', 'bg-red-50');
    }
  }

  function scan(root) {
    (root || document).querySelectorAll('[data-all-guests-async]').forEach(load);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { scan(document); });
  } else {
    scan(document);
  }
  new MutationObserver(function() { scan(document); }).observe(document.documentElement, { childList: true, subtree: true });
  window.WorkerCmsAllGuestsEmbedded = { scan: scan };
})();
