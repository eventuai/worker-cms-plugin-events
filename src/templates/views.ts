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
  return `<div data-events-client-root class="min-w-0">Loading...</div>
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
