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

import {
  CmsClient,
  CmsApiError,
  CmsNotConfiguredError,
  PLUGIN_ID,
  attr,
  items,
  localized,
  type CmsPage,
} from './cms';

interface PluginEnv {
  PLUGIN_SECRET?: string;
  /** Base URL of the CMS Worker (for the F1 write-back API), e.g. https://cms.eventuai.com */
  CMS_URL?: string;
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
      return handleAdmin(request, env, url);
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
function html(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"]/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string
  ));
}

const ADMIN_BASE = `/admin/plugins/${PLUGIN_ID}`;

function redirect(to: string): Response {
  return new Response(null, { status: 302, headers: { Location: to } });
}

/** Shared chrome: a section tab bar (Events / RSVP / EDM) + a content body. */
function layout(title: string, section: string, body: string): Response {
  const tabs = [['events', 'Events'], ['rsvp', 'RSVP'], ['edm', 'EDM']].map(([key, label]) =>
    `<a href="${ADMIN_BASE}/${key}" class="px-3 py-1.5 rounded-lg text-sm font-semibold ${
      key === section ? 'bg-indigo-600 text-white' : 'bg-white border border-gray-300 text-gray-700'
    }">${label}</a>`,
  ).join('');
  return html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-gray-50 p-8"><div class="max-w-5xl mx-auto space-y-6">
  <div class="flex gap-2">${tabs}</div>
  ${body}
</div></body></html>`);
}

/** Renders an error panel when the CMS link is unconfigured or returns an error. */
function errorPanel(section: string, message: string): Response {
  return layout('Error', section, `<div class="bg-white rounded-xl shadow p-6">
    <h1 class="text-xl font-bold text-gray-900 mb-2">Cannot reach the CMS</h1>
    <p class="text-sm text-gray-600">${esc(message)}</p>
    <p class="text-sm text-gray-500 mt-3">Set <code>CMS_URL</code> and <code>PLUGIN_SECRET</code> on this plugin Worker
    (the secret must match the CMS), then reload.</p>
  </div>`);
}

// ── Admin router ──────────────────────────────────────────────────────────────

async function handleAdmin(request: Request, env: PluginEnv, url: URL): Promise<Response> {
  const rest = url.pathname.replace(/^\/__plugin\/admin\/?/, '');
  const segments = rest.split('/').filter(Boolean);
  const section = segments[0] || 'events';

  if (section === 'rsvp' || section === 'edm') {
    return layout(section.toUpperCase(), section, sectionPlaceholder(section));
  }

  // section === 'events'
  let cms: CmsClient;
  try {
    cms = new CmsClient(env);
  } catch (error) {
    if (error instanceof CmsNotConfiguredError) return errorPanel('events', error.message);
    throw error;
  }

  try {
    // /events/:id/...
    const eventId = segments[1] ? Number(segments[1]) : null;
    const sub = segments[2] ?? '';

    if (eventId && sub === 'adhoc-checkin') {
      if (request.method === 'POST') return adhocCheckinSubmit(cms, eventId, request);
      return adhocCheckinForm(cms, eventId);
    }
    if (eventId && sub === 'all-guests') return allGuests(cms, eventId);
    if (eventId) return eventDashboard(cms, eventId);
    return eventsList(cms);
  } catch (error) {
    if (error instanceof CmsApiError) return errorPanel('events', `CMS responded ${error.status} (${error.code}).`);
    throw error;
  }
}

function sectionPlaceholder(section: string): string {
  const note = section === 'rsvp'
    ? 'Guest management, bulk add/remove, and the public multilingual RSVP form (write-back via F1) live here.'
    : 'Compose/render/preview EDMs, mail lists, scheduled blasts (Cron + Queue), unsubscribe, and attachments live here.';
  return `<div class="bg-white rounded-xl shadow p-6">
    <h1 class="text-2xl font-bold text-gray-900 mb-1">${section.toUpperCase()}</h1>
    <p class="text-gray-600">${esc(note)}</p>
    <p class="text-sm text-gray-500 mt-3">Blueprints and blocks for this section are already registered — author records in the CMS editor.</p>
  </div>`;
}

// ── Guest rollups (mirrors the legacy event dashboard tallies) ────────────────

interface Rollup {
  guests: number; total: number;
  confirmed: number; declined: number; unconfirmed: number;
  invited: number; toBeInvited: number; onhold: number;
  checkedIn: number; checkedInTotal: number;
}

function rollupGuests(guests: CmsPage[]): Rollup {
  const r: Rollup = { guests: 0, total: 0, confirmed: 0, declined: 0, unconfirmed: 0, invited: 0, toBeInvited: 0, onhold: 0, checkedIn: 0, checkedInTotal: 0 };
  for (const g of guests) {
    const plus = parseInt(attr(g.lect, 'plus_guests'), 10) || 0;
    const headcount = plus + 1;
    r.guests += 1;
    r.total += headcount;
    const status = (attr(g.lect, 'status') || 'to be invited').toLowerCase();
    if (status === 'confirmed') r.confirmed += 1;
    else if (status === 'decline' || status === 'declined') r.declined += 1;
    else if (status === 'unconfirmed') r.unconfirmed += 1;
    else if (status === 'invited') r.invited += 1;
    else if (status === 'onhold') r.onhold += 1;
    else r.toBeInvited += 1;

    const checkins = items(g.lect, 'checkin');
    if (checkins.length > 0) { r.checkedIn += 1; r.checkedInTotal += headcount; }
  }
  return r;
}

function statTiles(r: Rollup): string {
  const tile = (label: string, value: number, color: string) =>
    `<div class="rounded-lg border ${color} p-3 text-center"><div class="text-2xl font-bold">${value}</div><div class="text-xs text-gray-500 mt-0.5">${label}</div></div>`;
  return `<div class="grid grid-cols-3 sm:grid-cols-6 gap-3">
    ${tile('Guests', r.guests, 'border-gray-200')}
    ${tile('Headcount', r.total, 'border-gray-200')}
    ${tile('Confirmed', r.confirmed, 'border-emerald-200 bg-emerald-50')}
    ${tile('Declined', r.declined, 'border-rose-200 bg-rose-50')}
    ${tile('To invite', r.toBeInvited, 'border-amber-200 bg-amber-50')}
    ${tile('Checked-in', r.checkedIn, 'border-indigo-200 bg-indigo-50')}
  </div>`;
}

// ── Events section views ──────────────────────────────────────────────────────

async function eventsList(cms: CmsClient): Promise<Response> {
  const { pages } = await cms.list('event', { limit: 200 });
  const rows = pages.map((e) =>
    `<tr class="border-t">
      <td class="px-4 py-2"><a class="text-indigo-600 font-medium" href="${ADMIN_BASE}/events/${e.id}">${esc(e.name)}</a></td>
      <td class="px-4 py-2 text-sm text-gray-500">${esc(attr(e.lect, 'start'))}</td>
      <td class="px-4 py-2 text-right"><a class="text-sm text-gray-600" href="/admin/pages/${e.id}/edit">Edit ↗</a></td>
    </tr>`,
  ).join('') || `<tr><td colspan="3" class="px-4 py-6 text-center text-gray-400 text-sm">No events yet.</td></tr>`;

  return layout('Events', 'events', `<div class="bg-white rounded-xl shadow overflow-hidden">
    <div class="flex items-center justify-between p-5">
      <h1 class="text-xl font-bold text-gray-900">Events</h1>
      <a href="/admin/pages/new?page_type=event" class="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold">New event</a>
    </div>
    <table class="w-full"><thead class="bg-gray-50 text-left text-xs uppercase text-gray-500">
      <tr><th class="px-4 py-2">Name</th><th class="px-4 py-2">Start</th><th class="px-4 py-2"></th></tr>
    </thead><tbody>${rows}</tbody></table>
  </div>`);
}

async function eventDashboard(cms: CmsClient, eventId: number): Promise<Response> {
  const [event, guestList] = await Promise.all([
    cms.get(eventId),
    cms.list('guest', { parentId: eventId, limit: 500 }),
  ]);
  const r = rollupGuests(guestList.pages);

  return layout(event.name, 'events', `
    <div class="bg-white rounded-xl shadow p-6 space-y-4">
      <div class="flex items-center justify-between">
        <div>
          <a href="${ADMIN_BASE}/events" class="text-xs text-gray-400">← Events</a>
          <h1 class="text-2xl font-bold text-gray-900">${esc(event.name)}</h1>
        </div>
        <div class="flex gap-2">
          <a href="${ADMIN_BASE}/events/${eventId}/adhoc-checkin" class="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold">Adhoc check-in</a>
          <a href="${ADMIN_BASE}/events/${eventId}/all-guests" class="px-4 py-2 rounded-lg bg-white border text-sm font-semibold text-gray-700">All guests</a>
          <a href="/admin/pages/${eventId}/edit" class="px-4 py-2 rounded-lg bg-white border text-sm font-semibold text-gray-700">Edit event ↗</a>
        </div>
      </div>
      ${statTiles(r)}
    </div>`);
}

async function allGuests(cms: CmsClient, eventId: number): Promise<Response> {
  const [event, guestList] = await Promise.all([
    cms.get(eventId),
    cms.list('guest', { parentId: eventId, limit: 500 }),
  ]);
  const rows = guestList.pages.map((g) => {
    const status = attr(g.lect, 'status') || 'to be invited';
    const checkedIn = items(g.lect, 'checkin').length > 0;
    return `<tr class="border-t">
      <td class="px-4 py-2"><a class="text-indigo-600" href="/admin/pages/${g.id}/edit">${esc(g.name || localized(g.lect, 'name'))}</a></td>
      <td class="px-4 py-2 text-sm">${esc(attr(g.lect, 'email'))}</td>
      <td class="px-4 py-2 text-sm">${esc(status)}</td>
      <td class="px-4 py-2 text-sm">${checkedIn ? '✅' : ''}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="4" class="px-4 py-6 text-center text-gray-400 text-sm">No guests yet.</td></tr>`;

  return layout(`Guests — ${event.name}`, 'events', `<div class="bg-white rounded-xl shadow overflow-hidden">
    <div class="p-5"><a href="${ADMIN_BASE}/events/${eventId}" class="text-xs text-gray-400">← ${esc(event.name)}</a>
      <h1 class="text-xl font-bold text-gray-900">All guests (${guestList.total})</h1></div>
    <table class="w-full"><thead class="bg-gray-50 text-left text-xs uppercase text-gray-500">
      <tr><th class="px-4 py-2">Name</th><th class="px-4 py-2">Email</th><th class="px-4 py-2">Status</th><th class="px-4 py-2">In</th></tr>
    </thead><tbody>${rows}</tbody></table>
  </div>`);
}

async function adhocCheckinForm(cms: CmsClient, eventId: number): Promise<Response> {
  const event = await cms.get(eventId);
  const field = (name: string, label: string, type = 'text') =>
    `<label class="block"><span class="text-sm text-gray-600">${label}</span>
      <input name="${name}" type="${type}" class="mt-1 w-full rounded-lg border-gray-300 border px-3 py-2"></label>`;
  return layout(`Adhoc check-in — ${event.name}`, 'events', `<div class="bg-white rounded-xl shadow p-6 max-w-lg">
    <a href="${ADMIN_BASE}/events/${eventId}" class="text-xs text-gray-400">← ${esc(event.name)}</a>
    <h1 class="text-xl font-bold text-gray-900 mb-4">Adhoc check-in</h1>
    <form method="post" class="space-y-3">
      ${field('name', 'Name')}
      ${field('last_name', 'Last name')}
      ${field('email', 'Email', 'email')}
      ${field('phone', 'Phone')}
      ${field('organization', 'Organization')}
      ${field('job_title', 'Job title')}
      ${field('plus_guests', 'Plus guests', 'number')}
      <button class="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold">Add & check in</button>
    </form>
  </div>`);
}

async function adhocCheckinSubmit(cms: CmsClient, eventId: number, request: Request): Promise<Response> {
  const form = await request.formData();
  const name = String(form.get('name') ?? '').trim();
  if (!name) return redirect(`${ADMIN_BASE}/events/${eventId}/adhoc-checkin`);

  const now = new Date().toISOString();
  // Adhoc guests are confirmed and checked-in immediately, mirroring the legacy
  // Event.action_adhoc_checkin_post flow. Stored in the canonical lect shape so
  // the guest is fully editable in the CMS editor.
  await cms.create({
    page_type: 'guest',
    name,
    page_id: eventId,
    lect: {
      _type: 'guest',
      name: { en: name },
      last_name: { en: String(form.get('last_name') ?? '') },
      email: String(form.get('email') ?? ''),
      phone: String(form.get('phone') ?? ''),
      organization: String(form.get('organization') ?? ''),
      job_title: String(form.get('job_title') ?? ''),
      plus_guests: String(form.get('plus_guests') ?? '0'),
      status: 'confirmed',
      type: 'adhoc',
      _pointers: { event: String(eventId) },
      response: [{ status: 'confirmed', date: now, message: 'adhoc guest added via admin panel' }],
      checkin: [{ status: 'checked-in', date: now, message: 'main attendee checked-in via admin panel' }],
    },
  });

  return redirect(`${ADMIN_BASE}/events/${eventId}/all-guests`);
}
