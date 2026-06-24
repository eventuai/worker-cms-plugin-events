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
  computeGuestListSummary,
  emptyGuestListSummary,
  items,
  localized,
  type CmsPage,
} from './cms';
import { signPayload, verifyPayload } from './crypto';
import { deliverQueuedEmail, dispatchDueMailLists, handleEdmAdmin, type EdmEnv, type EmailDelivery } from './edm';
import { handleLabelsAdmin } from './labels';
import { handlePublicRsvp } from './public-rsvp';
import {
  ensureAdhocGuestList,
  eventGuestImport,
  eventGuestLists,
  eventSessions,
  exportEventGuests,
  flatAllGuests,
  handleRsvpAdmin,
  importEventGuests,
  reorderGuestLists,
  reorderSessions,
} from './rsvp';
import { renderLiquid } from './templates/liquid';
import { adminView } from './templates/views';

interface PluginEnv extends EdmEnv {
  PLUGIN_SECRET?: string;
  /** Base URL of the CMS Worker (for the F1 write-back API), e.g. https://cms.eventuai.com */
  CMS_URL?: string;
  /** Plugin-owned Liquid templates and other view assets. */
  VIEWS: Fetcher;
}

type BlueprintEntry = string | Record<string, BlueprintEntry[]>;

// ── Blueprints ────────────────────────────────────────────────────────────────
const EVENT_BLUEPRINT: BlueprintEntry[] = [
  '@type', '@label', '@rfid:switch',
  '@show_guest_info:switch', '@waiting_message', '@kiosk_title', '@checkin_require_login:switch',
  '@virtual_event_link', '@featured_image:picture', 'logo:picture', 'name:text/title',
  'location:location', 'description:textarea',
  {
    session: [
      '@checkin:switch', '@type', '@start', '@duration', '@capacity', 'name:text/title',
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
  '@quick_confirm:switch', '@cc_enable:switch', 'rsvp_button',
];

const MAIL_LIST_BLUEPRINT: BlueprintEntry[] = [
  '*event', '*edm', '*mail_preview_list', '@blast_datetime', '@allow_checkin',
  '@show_in_checkin_lite:switch', '@checkin_lite_passcode',
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
    // Read-only access to contact pages (owned by the contacts plugin) so a
    // guest can be refreshed from its linked contact.
    readTypes: ['contact'],
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
    const rsvpResponse = await handlePublicRsvp(request, env, url);
    if (rsvpResponse) return rsvpResponse;

    // QR codes — signed with PLUGIN_SECRET so they can't be forged.
    if (path === '/qr') {
      const data = url.searchParams.get('data') ?? '';
      const sig = url.searchParams.get('sig') ?? '';
      if (!data || !sig) return new Response('missing data/sig', { status: 400 });
      if (!env.PLUGIN_SECRET) return new Response('server misconfigured', { status: 500 });
      if (!(await verifyPayload(env.PLUGIN_SECRET, data, sig))) return new Response('bad signature', { status: 403 });
      return new Response(await placeholderQrSvg(env.VIEWS, data), {
        headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' },
      });
    }
    if (path === '/sign') {
      if (env.PLUGIN_SECRET && request.headers.get('x-plugin-secret') !== env.PLUGIN_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      const data = url.searchParams.get('data') ?? '';
      if (!data) return new Response('missing data', { status: 400 });
      const sig = await signPayload(env.PLUGIN_SECRET ?? '', data);
      return Response.json({ data, sig, url: `/qr?data=${encodeURIComponent(data)}&sig=${sig}` });
    }

    // TODO public: event check-in (/checkin/...) and EDM unsubscribe (/unsubscribe/:token).

    return new Response('not found', { status: 404 });
  },

  async queue(batch: MessageBatch<EmailDelivery>, env: PluginEnv): Promise<void> {
    for (const message of batch.messages) await deliverQueuedEmail(env, message.body);
  },

  async scheduled(_controller: ScheduledController, env: PluginEnv, ctx: ExecutionContext): Promise<void> {
    if (!env.CMS_URL || !env.PLUGIN_SECRET || !env.MAIL_QUEUE) return;
    ctx.waitUntil(dispatchDueMailLists(new CmsClient(env), env.VIEWS, env));
  },
};

function placeholderQrSvg(views: Fetcher, data: string): Promise<string> {
  return renderLiquid(views, '/templates/qr.liquid', { label: data.slice(0, 40) });
}

const ADMIN_BASE = `/admin/plugins/${PLUGIN_ID}`;

/**
 * Edit link into the CMS page editor that carries a `return_to` so the editor's
 * back arrow / Cancel button return to this plugin dashboard instead of the CMS
 * home (the CMS validates the path and only honours `/admin*` targets).
 */
function editHrefReturningTo(pageId: number | string, returnTo: string): string {
  return `/admin/pages/${pageId}/edit?return_to=${encodeURIComponent(returnTo)}`;
}

function redirect(to: string): Response {
  return new Response(null, { status: 302, headers: { Location: to } });
}

/** Renders an error panel when the CMS link is unconfigured or returns an error. */
function errorPanel(views: Fetcher, message: string): Promise<Response> {
  return adminView(views, 'Error', 'error', { message });
}

// ── Admin router ──────────────────────────────────────────────────────────────

async function handleAdmin(request: Request, env: PluginEnv, url: URL): Promise<Response> {
  const rest = url.pathname.replace(/^\/__plugin\/admin\/?/, '');
  const segments = rest.split('/').filter(Boolean);
  const section = segments[0] || 'events';

  let cms: CmsClient;
  try {
    cms = new CmsClient(env);
  } catch (error) {
    if (error instanceof CmsNotConfiguredError) return errorPanel(env.VIEWS, error.message);
    throw error;
  }

  try {
    if (section === 'rsvp') {
      const qr = { secret: env.PLUGIN_SECRET, publicBase: env.PUBLIC_BASE_URL };
      return handleRsvpAdmin(request, cms, env.VIEWS, segments.slice(1), url, qr);
    }
    if (section === 'edm') return handleEdmAdmin(request, cms, env.VIEWS, env, segments.slice(1), url);

    // section === 'events'
    // /events/:id/...
    const eventId = segments[1] ? Number(segments[1]) : null;
    const sub = segments[2] ?? '';

    if (eventId && sub === 'adhoc-checkin') {
      if (request.method === 'POST') return adhocCheckinSubmit(cms, eventId, request);
      return adhocCheckinForm(cms, env.VIEWS, eventId);
    }
    if (eventId && sub === 'labels') return handleLabelsAdmin(request, cms, env.VIEWS, eventId, segments.slice(3), url);
    if (eventId && sub === 'export') return exportEventGuests(cms, eventId);
    if (eventId && sub === 'import') {
      if (request.method === 'POST') return importEventGuests(request, cms, eventId);
      return eventGuestImport(cms, env.VIEWS, eventId);
    }
    if (eventId && sub === 'reorder-guest-lists' && request.method === 'POST') return reorderGuestLists(request, cms, eventId);
    if (eventId && sub === 'reorder-sessions' && request.method === 'POST') return reorderSessions(request, cms, eventId);
    if (eventId && sub === 'sessions') return eventSessions(cms, env.VIEWS, eventId);
    if (eventId && sub === 'lists') return eventGuestLists(cms, env.VIEWS, eventId);
    if (eventId && sub === 'all-guests') return flatAllGuests(cms, env.VIEWS, eventId, url);
    if (eventId) return eventDashboard(cms, env.VIEWS, eventId);
    return eventsList(cms, env.VIEWS);
  } catch (error) {
    if (error instanceof CmsApiError) return errorPanel(env.VIEWS, `CMS responded ${error.status} (${error.code}).`);
    throw error;
  }
}

// ── Guest rollups (mirrors the legacy event dashboard tallies) ────────────────

interface Rollup {
  guests: number; total: number;
  confirmed: number; declined: number; unconfirmed: number;
  invited: number; toBeInvited: number; onhold: number;
  checkedIn: number; checkedInTotal: number;
}

function statTiles(r: Rollup): Array<{ label: string; value: number; color?: string }> {
  return [
    { label: 'Guests', value: r.guests },
    { label: 'Headcount', value: r.total },
    { label: 'Confirmed', value: r.confirmed, color: '#059669' },
    { label: 'Declined', value: r.declined, color: '#e11d48' },
    { label: 'To invite', value: r.toBeInvited, color: '#b45309' },
    { label: 'Checked-in', value: r.checkedIn, color: '#4f46e5' },
  ];
}

function rollupGuestListSummaries(lists: CmsPage[]): Rollup {
  const r: Rollup = { guests: 0, total: 0, confirmed: 0, declined: 0, unconfirmed: 0, invited: 0, toBeInvited: 0, onhold: 0, checkedIn: 0, checkedInTotal: 0 };
  for (const list of lists) {
    const summary = list.guest_summary ?? emptyGuestListSummary();
    r.guests += summary.guest_count;
    r.total += summary.guest_total;
    r.confirmed += summary.confirmed_count;
    r.declined += summary.declined_count;
    r.unconfirmed += summary.unconfirmed_count;
    r.invited += summary.invited_count;
    r.toBeInvited += summary.to_be_invited_count;
    r.onhold += summary.onhold_count;
    r.checkedIn += summary.checked_in_count;
    r.checkedInTotal += summary.checked_in_total;
  }
  return r;
}

// ── Events section views ──────────────────────────────────────────────────────

async function eventsList(cms: CmsClient, views: Fetcher): Promise<Response> {
  const { pages } = await cms.list('event', { limit: 200 });
  return adminView(views, 'Events', 'events', {
    events: pages.map((event) => ({
      name: event.name,
      // `start` and `timezone` are native CMS page columns (the F1 API returns
      // them top-level, not in lect). Timezone is an offset like "+0800", so we
      // show the raw values rather than reformatting against an IANA zone.
      start: [(event.start ?? '').replace('T', ' '), event.timezone ?? ''].filter(Boolean).join(' '),
      dashboardHref: `${ADMIN_BASE}/events/${event.id}`,
      editHref: editHrefReturningTo(event.id, `${ADMIN_BASE}/events`),
    })),
  });
}

async function eventDashboard(cms: CmsClient, views: Fetcher, eventId: number): Promise<Response> {
  const [event, guestLists, edms] = await Promise.all([
    cms.get(eventId),
    cms.list('mail_list', { parentId: eventId, limit: 500 }),
    cms.list('edm', { parentId: eventId, limit: 500 }),
  ]);
  // The CMS page API is generic, so the plugin tallies each list's guests itself
  // (one fetch per list) rather than asking the CMS for RSVP-specific figures.
  // The same fetch also yields the guests who have responded, so the dashboard's
  // response feed costs no extra subrequests.
  const responsesByList = await Promise.all(
    guestLists.pages.map(async (list) => {
      const { pages: guests } = await cms.list('guest', { parentId: list.id, limit: 500 });
      list.guest_summary = computeGuestListSummary(guests);
      return guests.filter(hasResponded).map((guest) => responseRow(list, guest));
    }),
  );
  // Most recent response first, mirroring the legacy event "Guest Responses" feed.
  const responses = responsesByList.flat().sort((a, b) => b.date.localeCompare(a.date));
  const r = rollupGuestListSummaries(guestLists.pages);
  // Admin-controlled display order (list weight, then name).
  const orderedLists = [...guestLists.pages].sort((a, b) => (a.weight - b.weight) || a.name.localeCompare(b.name));

  return adminView(views, event.name, 'event-dashboard', {
    eventName: event.name,
    eventsHref: `${ADMIN_BASE}/events`,
    adhocCheckinHref: `${ADMIN_BASE}/events/${eventId}/adhoc-checkin`,
    guestListsHref: `${ADMIN_BASE}/events/${eventId}/lists`,
    allGuestsHref: `${ADMIN_BASE}/events/${eventId}/all-guests`,
    sessionsHref: `${ADMIN_BASE}/events/${eventId}/sessions`,
    importHref: `${ADMIN_BASE}/events/${eventId}/import`,
    exportAllHref: `${ADMIN_BASE}/events/${eventId}/export`,
    labelsHref: `${ADMIN_BASE}/events/${eventId}/labels`,
    editHref: editHrefReturningTo(eventId, `${ADMIN_BASE}/events/${eventId}`),
    reorderAction: `${ADMIN_BASE}/events/${eventId}/reorder-guest-lists`,
    stats: statTiles(r),
    guestLists: orderedLists.map((list) => ({
      id: list.id,
      name: list.name,
      href: `${ADMIN_BASE}/rsvp/${list.id}`,
      summary: list.guest_summary ?? emptyGuestListSummary(),
    })),
    newGuestListHref: `${ADMIN_BASE}/rsvp/new?event_id=${eventId}`,
    // Email Templates section — EDMs belonging to this event.
    edms: edms.pages.map((edm) => ({
      name: edm.name,
      subject: localized(edm.lect, 'subject') || edm.name,
      href: `${ADMIN_BASE}/edm/${edm.id}`,
      previewHref: `${ADMIN_BASE}/edm/${edm.id}/preview`,
      duplicateAction: `${ADMIN_BASE}/edm/${edm.id}/duplicate`,
    })),
    newEdmHref: `${ADMIN_BASE}/edm/new?event_id=${eventId}`,
    // Guest Responses section.
    responses,
    responsesShowCheckin: responses.some((row) => row.checkedIn),
  });
}

/** A guest counts as a "response" once they've confirmed or declined. */
function hasResponded(guest: CmsPage): boolean {
  const status = (attr(guest.lect, 'status') || '').trim().toLowerCase();
  return status === 'confirmed' || status === 'declined';
}

interface ResponseRow {
  date: string;
  dateLabel: string;
  timeLabel: string;
  name: string;
  contact: string;
  status: string;
  checkedIn: boolean;
  href: string;
}

function responseRow(list: CmsPage, guest: CmsPage): ResponseRow {
  const date = latestResponseDate(guest);
  const clean = date.replace('T', ' ').replace('Z', '');
  return {
    date,
    dateLabel: clean.slice(0, 10),
    timeLabel: clean.slice(11, 16),
    name: guest.name || localized(guest.lect, 'name'),
    contact: attr(guest.lect, 'email') || attr(guest.lect, 'phone'),
    status: (attr(guest.lect, 'status') || '').trim().toLowerCase(),
    checkedIn: items(guest.lect, 'checkin').length > 0,
    href: `${ADMIN_BASE}/rsvp/${list.id}/guests/${guest.id}`,
  };
}

/** Most recent `response` item date for a guest, falling back to when the page changed. */
function latestResponseDate(guest: CmsPage): string {
  const dates = items(guest.lect, 'response')
    .map((entry) => String(entry.date ?? ''))
    .filter(Boolean)
    .sort();
  return dates[dates.length - 1] ?? guest.updated_at;
}

async function adhocCheckinForm(cms: CmsClient, views: Fetcher, eventId: number): Promise<Response> {
  const event = await cms.get(eventId);
  return adminView(views, `Adhoc check-in — ${event.name}`, 'adhoc-checkin', {
    eventName: event.name,
    eventHref: `${ADMIN_BASE}/events/${eventId}`,
    fields: [
      { name: 'name', label: 'Name', type: 'text' },
      { name: 'last_name', label: 'Last name', type: 'text' },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'phone', label: 'Phone', type: 'text' },
      { name: 'organization', label: 'Organization', type: 'text' },
      { name: 'job_title', label: 'Job title', type: 'text' },
      { name: 'plus_guests', label: 'Plus guests', type: 'number' },
    ],
  });
}

async function adhocCheckinSubmit(cms: CmsClient, eventId: number, request: Request): Promise<Response> {
  const form = await request.formData();
  const name = String(form.get('name') ?? '').trim();
  if (!name) return redirect(`${ADMIN_BASE}/events/${eventId}/adhoc-checkin`);

  const now = new Date().toISOString();
  const guestList = await ensureAdhocGuestList(cms, eventId);
  // Adhoc guests are confirmed and checked-in immediately, mirroring the legacy
  // Event.action_adhoc_checkin_post flow. Stored in the canonical lect shape so
  // the guest is fully editable in the CMS editor.
  await cms.create({
    page_type: 'guest',
    name,
    page_id: guestList.id,
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
      _pointers: { event: String(eventId), mail_list: String(guestList.id) },
      response: [{ status: 'confirmed', date: now, message: 'adhoc guest added via admin panel' }],
      checkin: [{ status: 'checked-in', date: now, message: 'main attendee checked-in via admin panel' }],
    },
  });

  return redirect(`${ADMIN_BASE}/rsvp/${guestList.id}`);
}
