(function () {
  'use strict';

  class TemplateNotFoundError extends Error {}

  var payloadEl = document.querySelector('script[data-events-render-payload]');
  var root = document.querySelector('[data-events-client-root]');
  if (!payloadEl || !root) return;

  var payload = JSON.parse(payloadEl.textContent || '{}');

  function withRevision(url) {
    var revision = payload.viewRevision;
    if (!revision) return url;
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'r=' + encodeURIComponent(revision);
  }

  if (!window.liquidjs) {
    var liquidScript = document.createElement('script');
    liquidScript.src = withRevision('/admin/plugins/events/assets/liquid.browser.min.js');
    liquidScript.onload = function () {
      var renderScript = document.createElement('script');
      renderScript.src = withRevision('/admin/plugins/events/assets/client-render.js');
      document.body.appendChild(renderScript);
    };
    document.body.appendChild(liquidScript);
    return;
  }

  var templateCache = new Map();
  var engine = new liquidjs.Liquid({
    cache: true,
    extname: '.liquid',
    root: ['layout', 'templates', 'sections', 'snippets'],
    relativeReference: false,
    fs: {
      readFileSync: function (file) {
        throw new Error('Synchronous template reads are not supported: ' + file);
      },
      readFile: function (file) {
        return loadTemplate(file);
      },
      existsSync: function () {
        return false;
      },
      exists: function (file) {
        return templateExists(file);
      },
      contains: function () {
        return true;
      },
      containsSync: function () {
        return true;
      },
      resolve: function (templateRoot, file, ext) {
        var fileKey = file.endsWith(ext) ? file : file + ext;
        var folder = String(templateRoot).split('/').pop();
        if ((folder === 'sections' || folder === 'snippets') && !fileKey.startsWith(folder + '/')) {
          return folder + '/' + fileKey;
        }
        return fileKey;
      },
    },
  });

  function normalizePath(path) {
    return path.startsWith('/') ? path : '/' + path;
  }

  function loadTemplate(path) {
    var normalized = normalizePath(path);
    if (templateCache.has(normalized)) return templateCache.get(normalized);

    var promise = fetch(withRevision((payload.viewBasePath || '/admin/plugins/events/views') + normalized), {
      credentials: 'same-origin',
      headers: { Accept: normalized.endsWith('.json') ? 'application/json' : 'text/plain' },
    }).then(function (response) {
      if (!response.ok) {
        templateCache.delete(normalized);
        throw new TemplateNotFoundError('View file not found: ' + normalized);
      }
      return response.text();
    });
    templateCache.set(normalized, promise);
    return promise;
  }

  function templateExists(path) {
    return loadTemplate(path).then(
      function () { return true; },
      function (error) {
        if (error instanceof TemplateNotFoundError) return false;
        throw error;
      },
    );
  }

  async function renderLiquid(templatePath, data) {
    var template = await loadTemplate(templatePath);
    return String(await engine.parseAndRender(template, data || {}));
  }

  async function renderView(templatePath, data) {
    if (templatePath.endsWith('.liquid')) return renderLiquid(templatePath, data);

    var rawTemplate = await loadTemplate(templatePath.endsWith('.json') ? templatePath : templatePath + '.json');
    var jsonTemplate = JSON.parse(rawTemplate);
    if (!jsonTemplate.order || !jsonTemplate.order.length) return '';

    var sections = [];
    for (var i = 0; i < jsonTemplate.order.length; i++) {
      var key = jsonTemplate.order[i];
      var section = jsonTemplate.sections && jsonTemplate.sections[key];
      if (!section) continue;
      sections.push(await renderLiquid('/sections/' + section.type + '.liquid', {
        ...(data || {}),
        section: { ...section, id: key },
      }));
    }

    var content = sections.join('\n');
    if (!jsonTemplate.wrapper) return content;
    throw new Error('JSON template wrappers are not supported by the events client renderer.');
  }

  function runScripts(container) {
    Array.from(container.querySelectorAll('script')).forEach(function (oldScript) {
      var script = document.createElement('script');
      Array.from(oldScript.attributes).forEach(function (attr) {
        script.setAttribute(attr.name, attr.value);
      });
      script.textContent = oldScript.textContent;
      document.body.appendChild(script);
      oldScript.remove();
    });
  }

  async function main() {
    try {
      var content = await renderView(payload.templatePath, payload.data || {});
      var html = payload.wrapLayout === false
        ? content
        : await renderLiquid(payload.layoutPath || '/layout/default.liquid', { content: content });
      root.innerHTML = html;
      runScripts(root);
    } catch (error) {
      console.error(error);
      root.innerHTML = '<div class="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">Unable to render this plugin view.</div>';
    }
  }

  main();
})();
