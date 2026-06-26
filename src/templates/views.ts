export async function adminView(
  views: Fetcher,
  title: string,
  template: string,
  data: Record<string, unknown> = {},
  jsonOnly = false,
): Promise<Response> {
  if (jsonOnly) {
    return Response.json({ title, template, data });
  }
  void views;
  const body = clientRenderFragment({
    title,
    templatePath: `/templates/${template}.json`,
    data,
    wrapLayout: true,
  });

  return new Response(body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'x-cms-chrome': '1',
      // Encoded so non-ASCII titles stay header-safe; the CMS proxy decodes it.
      'x-cms-title': encodeURIComponent(title),
    },
  });
}

/** Returns a proper admin-chrome 404 page instead of bare "not found" text. */
export function notFoundView(views: Fetcher, message = 'Page not found.', jsonOnly = false): Promise<Response> {
  return adminView(views, 'Not found', 'error', { heading: 'Not found', message }, jsonOnly);
}

export function clientRenderFragment(opts: {
  title: string;
  templatePath: string;
  data: Record<string, unknown>;
  wrapLayout?: boolean;
}): string {
  const payload = {
    title: opts.title,
    layoutPath: '/layout/default.liquid',
    templatePath: opts.templatePath,
    viewBasePath: '/admin/plugins/events/views',
    wrapLayout: opts.wrapLayout ?? true,
    data: opts.data,
  };
  return `<div data-events-client-root class="min-w-0">${clientLoadingMarkup()}</div>
<script type="application/json" data-events-render-payload>${jsonScript(payload)}</script>
<script src="/admin/plugins/events/assets/client-render.js"></script>`;
}

function jsonScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function clientLoadingMarkup(): string {
  return `<div role="status" aria-label="Loading" style="min-height:12rem;display:flex;align-items:center;justify-content:center;color:#6b7280">
    <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true" style="display:block">
      <circle cx="16" cy="16" r="12" fill="none" stroke="currentColor" stroke-width="3" opacity="0.2"></circle>
      <path d="M28 16a12 12 0 0 0-12-12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
        <animateTransform attributeName="transform" type="rotate" from="0 16 16" to="360 16 16" dur="0.8s" repeatCount="indefinite"></animateTransform>
      </path>
    </svg>
  </div>`;
}
