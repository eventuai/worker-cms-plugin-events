// ============================================================
// Worker CMS plugin — "events" suite.
//
// One Worker covering the whole event side of the system, to stay within the
// Cloudflare Free plan's per-request subrequest cap (50) and daily request
// budget (100k): events + RSVP + EDM (email) + QR codes.
//
// Exposes three admin nav items (Events / RSVP / EDM) under a single manifest
// id, plus public guest-facing routes on its own domain (QR images, RSVP forms,
// unsubscribe). Content types ported from the legacy Eventuai config/cms.mjs.
// ============================================================

interface PluginEnv {
  PLUGIN_SECRET?: string;
}

type BlueprintEntry = string | Record<string, BlueprintEntry[]>;

// ── Blueprints ────────────────────────────────────────────────────────────────
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

const EDM_BLUEPRINT: BlueprintEntry[] = [
  '@text_color', '@font_size', '@font_family', '@bg_color', '@image_padding',
  '@button_color', '@button_text_color', '@headline_font_size', '@headline_padding',
  '@table_padding', '@paragraph_bottom_margin',
  '*event', '*event.name', '@sender', '@reply_to', '@bcc',
  'subject', 'heading', 'body:richtext/md', 'landing_subject', 'date_text', 'time',
  'address_1', 'address_2', 'address_3',
  'thankyou_heading:text', 'thankyou_body:richtext/md', '@thankyou_picture:picture',
  '@quick_confirm', '@cc_enable', 'rsvp_button',
];

const MAIL_LIST_BLUEPRINT: BlueprintEntry[] = [
  '*event', '*edm', '*mail_preview_list', '@blast_datetime', '@allow_checkin',
  '@show_in_checkin_lite', '@checkin_lite_passcode',
];

const MAIL_PREVIEW_LIST_BLUEPRINT: BlueprintEntry[] = [
  '@name', { user: ['@name', '@email'] },
];

// ── Blocks ────────────────────────────────────────────────────────────────────
const CONTENT_BLOCKS: Record<string, BlueprintEntry[]> = {
  label: ['name'],
  logos: ['label', { pictures: ['url'] }],
  paragraph: ['subject', 'body:richtext/md'],
  picture: ['@picture:picture', 'caption', '@width', '@align'],
  button: ['label', 'url'],
  table: ['title:richtext/md', '@first_column_width', { row: ['name:richtext/md', 'description:richtext/md'] }],
  spacer: ['@lines'],
};

const EDM_BLOCKS: Record<string, BlueprintEntry[]> = {
  'edm-attachments': [{ attachment: ['@file:picture', '@name'] }],
  'edm-unsubscribe': [],
};

const RSVP_BLOCKS: Record<string, BlueprintEntry[]> = {
  'rsvp-location': ['name', 'address_1', 'address_2', 'address_3', 'city', 'state', 'country'],
  'rsvp-date-time': ['date_text', 'time', 'timezone'],
  'rsvp-plus-one': ['@max_guests', 'title'],
  'rsvp-meal-preferences': [
    'title', 'body:richtext/md', '@allow_message:boolean', 'message_placeholder',
    { food: ['name', 'description'] },
  ],
  'rsvp-travel-hotel': [
    'title', 'body:richtext/md',
    { flight_custom_input: ['@type', 'label'] },
    { hotel_custom_input: ['@type', 'label'] },
  ],
  'rsvp-custom': [
    'title', 'body:richtext/md',
    { custom_input: ['@required:boolean', '@type', 'label', 'default_value'] },
  ],
  'rsvp-public-form': [
    'title', 'body:richtext/md', 'label_salutation', 'label_first_name', 'label_last_name',
    'label_email', 'label_organization', 'label_job_title',
    { custom_input: ['@name', '@required:boolean', '@type', 'label', 'default_value'] },
  ],
  'rsvp-accept': ['label'],
  'rsvp-sessions': [],
  'rsvp-qrcode': ['title', 'message', '@size'],
  'rsvp-pickup': [
    'title', 'pickup_date_label', 'pickup_time_label', 'pickup_location_label',
    'dropoff_date_label', 'dropoff_time_label', 'dropoff_location_label',
    'accommodation_title', 'checkin_date_label', 'checkout_date_label',
  ],
  'rsvp-button': ['label'],
};

const MANIFEST = {
  id: 'events',
  name: 'Events Suite',
  version: '0.1.0',
  hooks: ['publish', 'unpublish', 'delete'],
  nav: [
    { label: 'Events', href: 'events', roles: ['admin', 'editor'] },
    { label: 'RSVP', href: 'rsvp', roles: ['admin', 'editor'] },
    { label: 'EDM', href: 'edm', roles: ['admin', 'editor'] },
  ],
  contentTypes: {
    blueprint: {
      event: EVENT_BLUEPRINT,
      guest: GUEST_BLUEPRINT,
      label: LABEL_BLUEPRINT,
      edm: EDM_BLUEPRINT,
      mail_list: MAIL_LIST_BLUEPRINT,
      mail_preview_list: MAIL_PREVIEW_LIST_BLUEPRINT,
    },
    blocks: { ...CONTENT_BLOCKS, ...EDM_BLOCKS, ...RSVP_BLOCKS },
    blockLists: {
      events: ['picture', 'paragraph', 'table', 'button', ...Object.keys(RSVP_BLOCKS)],
      edm: ['picture', 'paragraph', 'table', 'button', 'spacer', 'edm-attachments', 'edm-unsubscribe', ...Object.keys(RSVP_BLOCKS)],
      rsvp: Object.keys(RSVP_BLOCKS),
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
      console.log(`[events-suite] hook ${event}:`, JSON.stringify(payload));
      return new Response('ok');
    }

    if (path.startsWith('/__plugin/admin')) {
      const user = parseUser(request.headers.get('x-cms-user'));
      const section = path.replace(/^\/__plugin\/admin\/?/, '').split('/')[0] || 'events';
      return html(adminDashboard(section, user));
    }

    // ── Public guest-facing routes (own domain) ────────────────────────────
    // QR codes — signed with PLUGIN_SECRET so they can't be forged.
    if (path === '/qr') {
      const data = url.searchParams.get('data') ?? '';
      const sig = url.searchParams.get('sig') ?? '';
      if (!data || !sig) return new Response('missing data/sig', { status: 400 });
      if (!env.PLUGIN_SECRET) return new Response('server misconfigured', { status: 500 });
      if (!(await verify(env.PLUGIN_SECRET, data, sig))) return new Response('bad signature', { status: 403 });
      return new Response(placeholderQrSvg(data), {
        headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' },
      });
    }
    if (path === '/sign') {
      if (env.PLUGIN_SECRET && request.headers.get('x-plugin-secret') !== env.PLUGIN_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      const data = url.searchParams.get('data') ?? '';
      if (!data) return new Response('missing data', { status: 400 });
      const sig = await sign(env.PLUGIN_SECRET ?? '', data);
      return Response.json({ data, sig, url: `/qr?data=${encodeURIComponent(data)}&sig=${sig}` });
    }

    // TODO public: RSVP form (/:lang?/rsvp/:event/:edm/:view/:sign + submit + thank-you),
    //              event check-in (/checkin/...), EDM unsubscribe (/unsubscribe/:token).

    return new Response('not found', { status: 404 });
  },

  // TODO scheduled(): drain due mail_list blasts (wire a Cron Trigger + Queue).
};

// ── QR signing (Web Crypto) ─────────────────────────────────────────────────
async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function sign(secret: string, data: string): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(data));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function verify(secret: string, data: string, hexSig: string): Promise<boolean> {
  const bytes = hexSig.match(/.{1,2}/g)?.map((h) => parseInt(h, 16));
  if (!bytes || bytes.length !== 32) return false;
  return crypto.subtle.verify('HMAC', await hmacKey(secret), new Uint8Array(bytes), new TextEncoder().encode(data));
}
function placeholderQrSvg(data: string): string {
  const label = data.replace(/[<&]/g, '').slice(0, 40);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="220" viewBox="0 0 200 220">
  <rect width="200" height="220" fill="#fff"/>
  <rect x="20" y="20" width="160" height="160" fill="none" stroke="#111" stroke-width="2"/>
  <text x="100" y="105" text-anchor="middle" font-family="monospace" font-size="12" fill="#111">QR (placeholder)</text>
  <text x="100" y="205" text-anchor="middle" font-family="monospace" font-size="9" fill="#555">${label}</text>
</svg>`;
}

// ── Admin ───────────────────────────────────────────────────────────────────
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

const SECTIONS: Record<string, { title: string; pageType?: string; status: string[] }> = {
  events: {
    title: 'Events',
    pageType: 'event',
    status: [
      '✅ event / guest / label blueprints + content blocks + <code>events</code> block list',
      '⬜ Guest lists, reorder, export/import, "all guests", archive',
      '⬜ Label designer (SVG templates, save/load)',
      '⬜ Public check-in (adhoc / RFID / kiosk) on own domain + write-back (F1)',
    ],
  },
  rsvp: {
    title: 'RSVP',
    status: [
      `✅ ${Object.keys(RSVP_BLOCKS).length} RSVP block types + <code>rsvp</code> block list`,
      '⬜ Guest management: assign status/color/custom field, toggle not-send',
      '⬜ Bulk add/remove contacts, update-from-contact',
      '⬜ Public multilingual RSVP form + submit (own domain → write-back F1)',
    ],
  },
  edm: {
    title: 'EDM',
    pageType: 'edm',
    status: [
      '✅ edm / mail_list / mail_preview_list blueprints + EDM blocks + <code>edm</code> block list',
      '⬜ Render-to-HTML, preview, duplicate',
      '⬜ Outbound email (Cloudflare Email Service / Resend) + delivery tracking',
      '⬜ Scheduled blasts (Cron + Queue), unsubscribe, attachments',
    ],
  },
};

function adminDashboard(section: string, user: { name?: string; role?: string }): string {
  const meta = SECTIONS[section] ?? SECTIONS.events;
  const name = (user.name ?? 'there').replace(/</g, '&lt;');
  const createBtn = meta.pageType
    ? `<div class="flex gap-3 mt-4">
         <a href="/admin/pages/new?page_type=${meta.pageType}" class="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold">New ${meta.title}</a>
         <a href="/admin/pages?page_type=${meta.pageType}" class="px-4 py-2 rounded-lg bg-white border border-gray-300 text-sm font-semibold text-gray-700">All ${meta.title}</a>
       </div>`
    : '';
  const tabs = Object.entries(SECTIONS).map(([key, s]) =>
    `<a href="/admin/plugins/events/${key}" class="px-3 py-1.5 rounded-lg text-sm font-semibold ${key === section ? 'bg-indigo-600 text-white' : 'bg-white border border-gray-300 text-gray-700'}">${s.title}</a>`,
  ).join('');

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${meta.title}</title>
<script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-gray-50 p-8">
  <div class="max-w-3xl mx-auto space-y-6">
    <div class="flex gap-2">${tabs}</div>
    <div class="bg-white rounded-xl shadow p-6">
      <h1 class="text-2xl font-bold text-gray-900 mb-1">${meta.title}</h1>
      <p class="text-gray-600">Hello, ${name}. Part of the Events Suite plugin.</p>
      ${createBtn}
    </div>
    <div class="bg-white rounded-xl shadow p-6">
      <h2 class="text-lg font-semibold text-gray-900 mb-3">Status</h2>
      <ul class="text-sm text-gray-700 space-y-1">${meta.status.map((s) => `<li>${s}</li>`).join('')}</ul>
    </div>
  </div>
</body>
</html>`;
}
