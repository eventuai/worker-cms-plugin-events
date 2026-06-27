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
  return clientViewResponse(title, `/templates/${template}.json`, data);
}

export function clientViewResponse(title: string, viewPath: string, data: Record<string, unknown>): Response {
  return Response.json(data, {
    headers: {
      'x-cms-chrome': '1',
      'x-cms-client-view': '1',
      'x-cms-view-path': viewPath,
      // Encoded so non-ASCII titles stay header-safe; the CMS proxy decodes it.
      'x-cms-title': encodeURIComponent(title),
    },
  });
}

/** Returns a proper admin-chrome 404 page instead of bare "not found" text. */
export function notFoundView(views: Fetcher, message = 'Page not found.', jsonOnly = false): Promise<Response> {
  return adminView(views, 'Not found', 'error', { heading: 'Not found', message }, jsonOnly);
}
