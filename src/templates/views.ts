import { renderLiquid, renderView } from './liquid';

export async function adminView(
  views: Fetcher,
  title: string,
  template: string,
  data: Record<string, unknown> = {},
): Promise<Response> {
  const content = await renderView(views, `/templates/${template}.json`, data);
  const body = await renderLiquid(views, '/layout/default.liquid', { content });

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
export function notFoundView(views: Fetcher, message = 'Page not found.'): Promise<Response> {
  return adminView(views, 'Not found', 'error', { heading: 'Not found', message });
}
