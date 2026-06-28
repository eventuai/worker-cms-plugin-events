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
  CMS_BATCH_WEIGHT_ACTION,
  PLUGIN_ID,
  attr,
  checkins,
  compareByWeightThenName,
  computeGuestListSummary,
  emptyGuestListSummary,
  items,
  listByEvent,
  localized,
  type CmsPage,
} from './cms';
import { signPayload, verifyPayload } from './crypto';
import { deliverQueuedEmail, dispatchDueMailLists, handleEdmAdmin, handleEdmEditView, type EdmEnv, type EmailDelivery } from './edm';
import { handleLabelsAdmin } from './labels';
import { handlePublicRsvp } from './public-rsvp';
import {
  ensureAdhocGuestList,
  isAdhocList,
  eventGuestImport,
  eventGuestLists,
  eventSessions,
  exportEventGuests,
  flatAllGuests,
  handleGuestEditView,
  handleRsvpAdmin,
  confirmEventGuestImport,
  previewEventGuestImport,
  reorderGuestLists,
  reorderSessions,
} from './rsvp';
import { renderLiquid } from './templates/liquid';
import { adminView } from './templates/views';
// The plugin manifest (content types, blocks, nav, hooks, editViews) is plain
// data, so it lives as a static JSON file served verbatim at /__plugin/manifest
// rather than being assembled from constants here.
import MANIFEST from './manifest.json';

interface PluginEnv extends EdmEnv {
  PLUGIN_SECRET?: string;
  /** Base URL of the CMS Worker (for the F1 write-back API), e.g. https://cms.eventuai.com */
  CMS_URL?: string;
  /** Plugin-owned Liquid templates and other view assets. */
  VIEWS: Fetcher;
}

export default {
  async fetch(request: Request, env: PluginEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    const secretRequired = path.startsWith('/__plugin/hooks/')
      || path.startsWith('/__plugin/publish/')
      || path.startsWith('/__plugin/admin')
      || path === '/__plugin/edit';
    if (secretRequired && env.PLUGIN_SECRET && request.headers.get('x-plugin-secret') !== env.PLUGIN_SECRET) {
      return new Response('forbidden', { status: 403 });
    }

    if (path === '/__plugin/manifest') {
      return Response.json(MANIFEST);
    }

    // Plugin-owned view templates, served to the CMS's composite view resolver
    // (cms/src/plugins/views.ts) so plugin field/block renderers — e.g. the
    // `richtext/md` pagefield — resolve inside the native CMS page editor.
    if (path.startsWith('/__plugin/views/')) {
      const assetPath = path.slice('/__plugin/views'.length) || '/';
      return serveViewAsset(env.VIEWS, assetPath);
    }

    if (path.startsWith('/__plugin/hooks/')) {
      const event = path.split('/').pop();
      const payload = await request.json().catch(() => ({}));
      console.log(`[events-suite] hook ${event}:`, JSON.stringify(payload));
      return new Response('ok');
    }

    // Plugin-rendered page edit view (manifest `editViews`). The CMS POSTs the
    // editor context; we return a bespoke editor as an HTML fragment the CMS
    // wraps in its admin chrome.
    if (path === '/__plugin/edit' && request.method === 'POST') {
      let cms: CmsClient;
      try {
        cms = new CmsClient(env);
      } catch (error) {
        if (error instanceof CmsNotConfiguredError) return new Response('not found', { status: 404 });
        throw error;
      }
      const edmResponse = await handleEdmEditView(request.clone(), cms, env.VIEWS, env);
      if (edmResponse.status !== 404) return edmResponse;
      return handleGuestEditView(request, cms, env.VIEWS);
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
const COLOR_TAGS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;

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
function errorPanel(views: Fetcher, message: string, showConfig = false, jsonOnly = false): Promise<Response> {
  return adminView(views, 'Error', 'error', { message, showConfig }, jsonOnly);
}

function wantsJson(url: URL): boolean {
  const json = url.searchParams.get('json')?.trim().toLowerCase();
  const format = url.searchParams.get('format')?.trim().toLowerCase();
  return format === 'json' || (url.searchParams.has('json') && json !== '0' && json !== 'false');
}

// ── Admin router ──────────────────────────────────────────────────────────────

async function handleAdmin(request: Request, env: PluginEnv, url: URL): Promise<Response> {
  const rest = url.pathname.replace(/^\/__plugin\/admin\/?/, '');
  const segments = rest.split('/').filter(Boolean);
  const section = segments[0] || 'events';
  const jsonOnly = wantsJson(url);

  if (section === 'assets') {
    return serveViewAsset(env.VIEWS, `/assets/${segments.slice(1).join('/')}`);
  }
  if (section === 'views') {
    return serveViewAsset(env.VIEWS, `/${segments.slice(1).join('/')}`);
  }

  let cms: CmsClient;
  try {
    cms = new CmsClient(env);
  } catch (error) {
    if (error instanceof CmsNotConfiguredError) return errorPanel(env.VIEWS, error.message, true, jsonOnly);
    throw error;
  }

  try {
    if (section === 'rsvp') {
      const qr = { secret: env.PLUGIN_SECRET, publicBase: env.PUBLIC_BASE_URL };
      return handleRsvpAdmin(request, cms, env.VIEWS, env, segments.slice(1), url, qr, jsonOnly);
    }
    if (section === 'edm') return handleEdmAdmin(request, cms, env.VIEWS, env, segments.slice(1), url, jsonOnly);

    // section === 'events'
    // /events/:id/...
    const eventId = segments[1] ? Number(segments[1]) : null;
    const sub = segments[2] ?? '';

    if (eventId && sub === 'adhoc-checkin') {
      if (request.method === 'POST') return adhocCheckinSubmit(cms, eventId, request);
      return adhocCheckinForm(cms, env.VIEWS, eventId, jsonOnly);
    }
    if (eventId && sub === 'labels') return handleLabelsAdmin(request, cms, env.VIEWS, eventId, segments.slice(3), url, jsonOnly);
    if (eventId && sub === 'export') return exportEventGuests(cms, eventId);
    if (eventId && sub === 'import') {
      if (segments[3] === 'confirm' && request.method === 'POST') return confirmEventGuestImport(request, cms, eventId);
      if (request.method === 'POST') return previewEventGuestImport(request, cms, env.VIEWS, eventId, jsonOnly);
      return eventGuestImport(cms, env.VIEWS, eventId, jsonOnly);
    }
    if (eventId && sub === 'reorder-guest-lists' && request.method === 'POST') return reorderGuestLists(request, cms, eventId);
    if (eventId && sub === 'reorder-sessions' && request.method === 'POST') return reorderSessions(request, cms, eventId);
    if (eventId && sub === 'sessions') return eventSessions(cms, env.VIEWS, eventId, jsonOnly);
    if (eventId && sub === 'lists') return eventGuestLists(cms, env.VIEWS, eventId, jsonOnly);
    if (eventId && sub === 'all-guests') return flatAllGuests(cms, env.VIEWS, eventId, url, jsonOnly);
    if (eventId) return eventDashboard(cms, env.VIEWS, eventId, url, jsonOnly);
    return eventsList(cms, env.VIEWS, jsonOnly);
  } catch (error) {
    if (error instanceof CmsApiError) {
      const target = error.method && error.path ? ` ${error.method} ${error.path}` : '';
      return errorPanel(env.VIEWS, `CMS responded${target} ${error.status} (${error.code}).`, false, jsonOnly);
    }
    throw error;
  }
}

async function serveViewAsset(views: Fetcher, assetPath: string): Promise<Response> {
  if (!assetPath.startsWith('/') || assetPath.includes('..')) return new Response('not found', { status: 404 });
  const fallbackAssetPath = assetPath.endsWith('.liquid') && assetPath.indexOf('/', 1) === -1
    ? `/snippets${assetPath}`
    : '';
  let response = await views.fetch(new URL(assetPath, 'https://views.local'));
  if (!response.ok && fallbackAssetPath) {
    response = await views.fetch(new URL(fallbackAssetPath, 'https://views.local'));
  }
  if (!response.ok) return new Response('not found', { status: 404 });

  const headers = new Headers(response.headers);
  if (assetPath.endsWith('.js')) {
    headers.set('content-type', 'text/javascript; charset=utf-8');
  } else if (assetPath.endsWith('.json')) {
    headers.set('content-type', 'application/json; charset=utf-8');
  } else if (assetPath.endsWith('.liquid')) {
    headers.set('content-type', 'text/plain; charset=utf-8');
  }
  if (assetPath.startsWith('/assets/')) {
    headers.set('cache-control', 'public, max-age=86400');
  } else if (assetPath.endsWith('.json') || assetPath.endsWith('.liquid')) {
    headers.set('cache-control', 'private, max-age=86400');
  } else {
    headers.set('cache-control', 'no-store');
  }
  return new Response(response.body, { status: response.status, headers });
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

async function eventsList(cms: CmsClient, views: Fetcher, jsonOnly = false): Promise<Response> {
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
  }, jsonOnly);
}

const RESPONSES_PER_PAGE = 25;

async function eventDashboard(cms: CmsClient, views: Fetcher, eventId: number, url: URL, jsonOnly = false): Promise<Response> {
  // `mail_list` and `edm` group under their event by the `event` pointer (their
  // parent page may be a different page type), so filter on the pointer.
  const [event, guestLists, edms] = await Promise.all([
    cms.get(eventId),
    listByEvent(cms, 'mail_list', eventId),
    listByEvent(cms, 'edm', eventId),
  ]);
  if (!guestLists.some(isAdhocList)) guestLists.push(await ensureAdhocGuestList(cms, eventId));
  // The CMS page API is generic, so the plugin tallies each list's guests itself
  // (one fetch per list) rather than asking the CMS for RSVP-specific figures.
  // The same fetch also yields the guests who have responded, so the dashboard's
  // response feed costs no extra subrequests.
  const guestListDetails = await Promise.all(
    guestLists.map(async (list) => {
      const { pages: guests } = await cms.list('guest', { pointer: { key: 'mail_list', value: list.id }, limit: 500 });
      list.guest_summary = computeGuestListSummary(guests);
      return {
        guests,
        responses: guests.filter(hasResponded).map((guest) => responseRow(list, guest)),
      };
    }),
  );
  // Most recent response first, mirroring the legacy event "Guest Responses" feed.
  const responses = guestListDetails.flatMap((detail) => detail.responses).sort((a, b) => b.date.localeCompare(a.date));
  const responsesTotal = responses.length;
  const responsesTotalPages = Math.max(1, Math.ceil(responsesTotal / RESPONSES_PER_PAGE));
  const responsesPage = Math.min(parsePositiveInt(url.searchParams.get('responses_page')) ?? 1, responsesTotalPages);
  const responsesStart = (responsesPage - 1) * RESPONSES_PER_PAGE;
  const pagedResponses = responses.slice(responsesStart, responsesStart + RESPONSES_PER_PAGE);
  const r = rollupGuestListSummaries(guestLists);
  // Admin-controlled display order (list weight, then name).
  const orderedLists = [...guestLists].sort(compareByWeightThenName);

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
    guestSearchHref: `${ADMIN_BASE}/events/${eventId}/all-guests`,
    guestSearchColorOptions: colorTagOptions(),
    statuses: ['to be invited', 'onhold', 'invited', 'confirmed', 'declined', 'unconfirmed'],
    editHref: editHrefReturningTo(eventId, `${ADMIN_BASE}/events/${eventId}`),
    reorderAction: CMS_BATCH_WEIGHT_ACTION,
    reorderEventId: eventId,
    stats: statTiles(r),
    guestLists: orderedLists.map((list) => ({
      id: list.id,
      name: list.name,
      href: `${ADMIN_BASE}/rsvp/${list.id}`,
      summary: list.guest_summary ?? emptyGuestListSummary(),
    })),
    newGuestListHref: `${ADMIN_BASE}/rsvp/new?event_id=${eventId}`,
    // Email Templates section — EDMs belonging to this event.
    edms: edms.map((edm) => ({
      name: edm.name,
      subject: localized(edm.lect, 'subject') || edm.name,
      // Edit directly in the page editor (the plugin renders the EDM edit view),
      // returning to this event dashboard.
      href: `/admin/pages/${edm.id}/edit?return_to=${encodeURIComponent(`${ADMIN_BASE}/events/${eventId}`)}`,
      previewHref: `${ADMIN_BASE}/edm/${edm.id}/preview`,
      duplicateAction: `${ADMIN_BASE}/edm/${edm.id}/duplicate`,
    })),
    newEdmHref: `${ADMIN_BASE}/edm/new?event_id=${eventId}`,
    // Guest Responses section.
    responses: pagedResponses,
    responsesTotal,
    responsesPage,
    responsesTotalPages,
    responsesPerPage: RESPONSES_PER_PAGE,
    responsesRangeStart: responsesTotal > 0 ? responsesStart + 1 : 0,
    responsesRangeEnd: Math.min(responsesStart + RESPONSES_PER_PAGE, responsesTotal),
    responsesPrevHref: responsesPage > 1 ? responsePageHref(eventId, url, responsesPage - 1) : '',
    responsesNextHref: responsesPage < responsesTotalPages ? responsePageHref(eventId, url, responsesPage + 1) : '',
    responsesShowCheckin: responses.some((row) => row.checkedIn),
  }, jsonOnly);
}

function parsePositiveInt(value: string | null): number | null {
  if (!value) return null;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function responsePageHref(eventId: number, url: URL, page: number): string {
  const query = new URLSearchParams(url.searchParams);
  query.delete('json');
  query.delete('format');
  if (page <= 1) query.delete('responses_page');
  else query.set('responses_page', String(page));
  const qs = query.toString();
  return `${ADMIN_BASE}/events/${eventId}${qs ? `?${qs}` : ''}#guest-responses`;
}

function colorTagOptions(): Array<{ value: string; label: string }> {
  return COLOR_TAGS.map((value) => ({ value, label: value }));
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
    checkedIn: checkins(guest.lect).length > 0,
    href: `/admin/pages/${guest.id}/edit?return_to=${encodeURIComponent(`${ADMIN_BASE}/rsvp/${list.id}`)}`,
  };
}

/** Most recent activity date for a guest: latest of checkin or response item dates, falling back to page updated_at. */
function latestResponseDate(guest: CmsPage): string {
  const dates = [
    ...checkins(guest.lect),
    ...items(guest.lect, 'response'),
  ]
    .map((entry) => String(entry.date ?? ''))
    .filter(Boolean)
    .sort();
  return dates[dates.length - 1] ?? guest.updated_at;
}

async function adhocCheckinForm(cms: CmsClient, views: Fetcher, eventId: number, jsonOnly = false): Promise<Response> {
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
  }, jsonOnly);
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
