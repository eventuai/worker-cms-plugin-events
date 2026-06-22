// ============================================================
// Worker CMS plugin — "events".
//
// Registers the `event`, `guest` and `label` content types plus the generic
// content blocks and the `events` block list, so events and their guest lists
// are authored as CMS pages. Admin UI (guest lists, label designer, check-in
// management) is proxied at /admin/plugins/events/*.
//
// Public guest-facing pages (kiosk / adhoc / RFID check-in, QR) are served by
// this Worker on its own public domain — see cms-to-rsvp.md §5.2 (TODO).
//
// Blueprints ported from: eventuai/admin/application/config/cms.mjs
// ============================================================

interface PluginEnv {
  PLUGIN_SECRET?: string;
}

type BlueprintEntry = string | Record<string, BlueprintEntry[]>;

const EVENT_BLUEPRINT: BlueprintEntry[] = [
  '@creator', '@users', '@type', '@start', '@end', '@timezone', '@label', '@rfid',
  '@show_guest_info', '@waiting_message', '@kiosk_title', '@checkin_require_login',
  '@virtual_event_link', '@featured_image:picture', 'logo:picture', 'name:text/title',
  'location:location', 'description:textarea',
  {
    session: [
      '@checkin', '@type', '@start', '@duration', '@capacity', 'name:text/title',
      'location', 'description:textarea',
      { inputs: ['@type', '@name', '@values'] },
    ],
  },
];

const GUEST_BLUEPRINT: BlueprintEntry[] = [
  '@picture', '@email:email', '@primary_guest', '@max_main_checkin', '@nationality',
  '@cc', '@organization', '@contact_id', '@plus_guests', '@phone', '@parent',
  '@rsvp_code', '@status', '@checkin_remark', '@qrcode_remark', '@not_send', '@no',
  '@prefix', '@prefer_language', '@zh_hant_name', '@zh_hans_name', 'name', 'last_name',
  '@job_title', '@wechat', '@remarks', '@total_guests', '@color_tag', '@qrcode',
  {
    response: ['@status', '@date', '@message'],
    checkin: ['@status', '@date', '@message'],
  },
];

const LABEL_BLUEPRINT: BlueprintEntry[] = [
  { frame: ['@width', '@height', '@direction', '@svg'] },
];

// Generic content blocks (shared with the EDM plugin; identical definitions
// merge harmlessly via Object.assign in the CMS).
const CONTENT_BLOCKS: Record<string, BlueprintEntry[]> = {
  label: ['name'],
  logos: ['label', { pictures: ['url'] }],
  paragraph: ['subject', 'body:richtext/md'],
  picture: ['@picture:picture', 'caption', '@width', '@align'],
  button: ['label', 'url'],
  table: ['title:richtext/md', '@first_column_width', { row: ['name:richtext/md', 'description:richtext/md'] }],
  spacer: ['@lines'],
};

const MANIFEST = {
  id: 'events',
  name: 'Events',
  version: '0.1.0',
  hooks: ['publish', 'unpublish', 'delete'],
  nav: [{ label: 'Events', href: 'dashboard', roles: ['admin', 'editor'] }],
  contentTypes: {
    blueprint: { event: EVENT_BLUEPRINT, guest: GUEST_BLUEPRINT, label: LABEL_BLUEPRINT },
    blocks: CONTENT_BLOCKS,
    blockLists: {
      events: [
        'picture', 'paragraph', 'table', 'button',
      ],
    },
  },
};

export default {
  async fetch(request: Request, env: PluginEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    const secretRequired = path.startsWith('/__plugin/hooks/')
      || path.startsWith('/__plugin/publish/')
      || path.startsWith('/__plugin/admin');
    if (secretRequired && env.PLUGIN_SECRET && request.headers.get('x-plugin-secret') !== env.PLUGIN_SECRET) {
      return new Response('forbidden', { status: 403 });
    }

    if (path === '/__plugin/manifest') {
      return Response.json(MANIFEST);
    }

    if (path.startsWith('/__plugin/hooks/')) {
      const event = path.split('/').pop();
      const payload = await request.json().catch(() => ({}));
      console.log(`[events] hook ${event}:`, JSON.stringify(payload));
      return new Response('ok');
    }

    if (path.startsWith('/__plugin/admin')) {
      const user = parseUser(request.headers.get('x-cms-user'));
      return html(adminDashboard(user));
    }

    // ── Public guest-facing routes (own domain) ────────────────────────────
    // TODO: /checkin/:event/:guest, /checkin/rfid, kiosk screens.

    return new Response('not found', { status: 404 });
  },
};

function parseUser(header: string | null): { name?: string; role?: string } {
  if (!header) return {};
  try {
    return JSON.parse(header) as { name?: string; role?: string };
  } catch {
    return {};
  }
}

function html(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function adminDashboard(user: { name?: string; role?: string }): string {
  const name = (user.name ?? 'there').replace(/</g, '&lt;');
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Events</title>
<script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-gray-50 p-8">
  <div class="max-w-3xl mx-auto space-y-6">
    <div class="bg-white rounded-xl shadow p-6">
      <h1 class="text-2xl font-bold text-gray-900 mb-1">Events</h1>
      <p class="text-gray-600 mb-4">Hello, ${name}. The <code>event</code>, <code>guest</code> and
      <code>label</code> content types are registered.</p>
      <div class="flex gap-3">
        <a href="/admin/pages/new?page_type=event"
           class="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold">New event</a>
        <a href="/admin/pages?page_type=event"
           class="px-4 py-2 rounded-lg bg-white border border-gray-300 text-sm font-semibold text-gray-700">All events</a>
      </div>
    </div>
    <div class="bg-white rounded-xl shadow p-6">
      <h2 class="text-lg font-semibold text-gray-900 mb-3">Status</h2>
      <ul class="text-sm text-gray-700 space-y-1">
        <li>✅ event / guest / label blueprints + content blocks + <code>events</code> block list</li>
        <li>⬜ Guest lists, reorder, export/import, "all guests", archive</li>
        <li>⬜ Label designer (SVG templates, save/load)</li>
        <li>⬜ Public check-in (adhoc / RFID / kiosk) on own domain + write-back (F1)</li>
      </ul>
    </div>
  </div>
</body>
</html>`;
}
