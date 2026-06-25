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
      return env.VIEWS.fetch(new URL(assetPath, 'https://views.local'));
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
function errorPanel(views: Fetcher, message: string, showConfig = false): Promise<Response> {
  return adminView(views, 'Error', 'error', { message, showConfig });
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
    if (error instanceof CmsNotConfiguredError) return errorPanel(env.VIEWS, error.message, true);
    throw error;
  }

  try {
    if (section === 'rsvp') {
      const qr = { secret: env.PLUGIN_SECRET, publicBase: env.PUBLIC_BASE_URL };
      return handleRsvpAdmin(request, cms, env.VIEWS, env, segments.slice(1), url, qr);
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
      if (segments[3] === 'confirm' && request.method === 'POST') return confirmEventGuestImport(request, cms, eventId);
      if (request.method === 'POST') return previewEventGuestImport(request, cms, env.VIEWS, eventId);
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
    if (error instanceof CmsApiError) {
      const target = error.method && error.path ? ` ${error.method} ${error.path}` : '';
      return errorPanel(env.VIEWS, `CMS responded${target} ${error.status} (${error.code}).`);
    }
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
  const responsesByList = await Promise.all(
    guestLists.map(async (list) => {
      const { pages: guests } = await cms.list('guest', { pointer: { key: 'mail_list', value: list.id }, limit: 500 });
      list.guest_summary = computeGuestListSummary(guests);
      return guests.filter(hasResponded).map((guest) => responseRow(list, guest));
    }),
  );
  // Most recent response first, mirroring the legacy event "Guest Responses" feed.
  const responses = responsesByList.flat().sort((a, b) => b.date.localeCompare(a.date));
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
    editHref: editHrefReturningTo(eventId, `${ADMIN_BASE}/events/${eventId}`),
    reorderAction: `${ADMIN_BASE}/events/${eventId}/reorder-guest-lists`,
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
