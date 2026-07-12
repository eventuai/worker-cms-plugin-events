// ============================================================
// Worker CMS plugin — "events" suite.
//
// One Worker covering the whole event side of the system, to stay within the
// Cloudflare Free plan's per-request subrequest cap (50) and daily request
// budget (100k): events + RSVP + EDM (email) + QR codes.
//
// Exposes three admin nav items (Events / RSVP / EDM) under a single manifest
// id, plus public QR signing routes on its own domain. The guest-facing RSVP
// site is the standalone worker-rsvp Worker, which reads the published D1 and
// resolves the signed links this plugin mints (PUBLIC_BASE_URL points there).
// Content types ported from the legacy Eventuai config/cms.mjs.
// ============================================================

import {
  CmsClient,
  CmsApiError,
  CmsNotConfiguredError,
  CMS_BATCH_WEIGHT_ACTION,
  PLUGIN_ID,
  attr,
  chargeCreditAction,
  checkins,
  compareByWeightThenName,
  computeGuestListSummary,
  emptyGuestListSummary,
  items,
  listByEvent,
  localized,
  type CmsPage,
  type GuestListSummary,
} from './cms';
import { signPayload, verifyPayload } from './crypto';
import { deliverQueuedEmail, dispatchDueMailLists, handleEdmAdmin, handleEdmEditView, type EdmEnv, type EmailDelivery } from './edm';
import { handleLabelsAdmin } from './labels';
import { cmsUserId, eventAdminAccessForRequest, forbidden, type EventAdminAccess } from './permissions';
import { archiveEvent, archiveReview, continueEventArchive, isArchived } from './archive';
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
  statusClass,
  statusColor,
} from './rsvp';
import { renderLiquid } from './templates/liquid';
import { adminView } from './templates/views';
import { createEventFromForm, createSampleEdmsForEvent, handleEventEditView } from './event';
import {
  applyResponsePage,
  convertRegistration,
  discardRegistration,
  pullSubmissions,
  refreshSubmissions,
  registrationsView,
} from './submissions';
import {
  allTenants,
  redirect,
  requireTenant,
  serveViewAsset,
  soleTenant,
  tenantById,
  tenantByRef,
  tenantClientEnv,
} from '@lionrockjs/worker-cms-plugin';
// The plugin manifest (content types, blocks, nav, hooks, page-view overrides)
// is plain data, so it lives as a static JSON file served verbatim at
// /__plugin/manifest rather than being assembled from constants here.
import MANIFEST from './manifest.json';

interface PluginEnv extends EdmEnv {
  PLUGIN_SECRET?: string;
  /** Base URL of the CMS Worker (for the Plugin API write-back API), e.g. https://cms.eventuai.com */
  CMS_URL?: string;
  /** Multi-tenant registry: `tenant:<cms origin>` → TenantConfig JSON. When
   *  unbound, CMS_URL + PLUGIN_SECRET form the single legacy tenant. */
  TENANTS?: KVNamespace;
  /** Plugin-owned Liquid templates and other view assets. */
  VIEWS: Fetcher;
  /** Deploy identifier exposed in the manifest to invalidate cached views. */
  CF_VERSION_METADATA?: WorkerVersionMetadata;
}

export default {
  async fetch(request: Request, baseEnv: PluginEnv, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Secret-authenticated host calls resolve their tenant (x-cms-tenant +
    // x-plugin-secret verified against the SAME registry row), then all
    // downstream code runs against a tenant-scoped env: CMS_URL/PLUGIN_SECRET
    // become that tenant's pair, so every CmsClient built from `env` is bound
    // to the calling CMS and cannot touch another tenant's data.
    let env = baseEnv;
    const secretRequired = path.startsWith('/__plugin/hooks/')
      || path.startsWith('/__plugin/publish/')
      || path.startsWith('/__plugin/admin')
      || path === '/__plugin/edit';
    if (secretRequired) {
      const tenant = await requireTenant(request, baseEnv);
      if (tenant instanceof Response) return tenant;
      env = tenantClientEnv(baseEnv, tenant);
    }

    if (path === '/__plugin/manifest') {
      return Response.json({
        ...MANIFEST,
        ...(baseEnv.CF_VERSION_METADATA ? { workerVersion: baseEnv.CF_VERSION_METADATA } : {}),
      });
    }

    // Plugin-owned view templates, served to the CMS's composite view resolver
    // (cms/src/plugins/views.ts) so plugin field/block renderers — e.g. the
    // `richtext/md` pagefield — resolve inside the native CMS page editor.
    if (path.startsWith('/__plugin/views/')) {
      const assetPath = path.slice('/__plugin/views'.length) || '/';
      return serveViewAsset(env.VIEWS, assetPath);
    }

    // Static assets declared in the plugin manifest. The CMS proxies these
    // through its admin-approved, hash-pinned plugin asset endpoint before
    // allowing them to run under CMS chrome.
    if (path.startsWith('/assets/')) {
      return serveViewAsset(env.VIEWS, path);
    }

    if (path.startsWith('/__plugin/hooks/')) {
      const hookEvent = path.split('/').pop();
      const payload = await request.json().catch(() => ({})) as { page?: unknown; pages?: unknown[] };
      // Bulk deliveries (host batch create/delete) carry the chunk in `pages`;
      // single deliveries only set `page`. Don't stringify the payload — a
      // 100-page delete chunk is real CPU for a log line nobody reads.
      const pages = Array.isArray(payload.pages) ? payload.pages : payload.page !== undefined ? [payload.page] : [];
      console.log(`[events-suite] hook ${hookEvent}: ${pages.length} page(s)`);
      if (hookEvent === 'create') {
        for (const page of pages) await handleCreateHook({ ...payload, page }, env);
      }
      return new Response('ok');
    }

    // Plugin-rendered page views (manifest `editViews` / `newViews`). The CMS
    // POSTs the editor context; we return a bespoke editor as an HTML fragment
    // the CMS wraps in its admin chrome.
    if (path === '/__plugin/edit' && request.method === 'POST') {
      const access = eventAdminAccessForRequest(request);
      if (!access.canEdit) return forbidden();
      let cms: CmsClient;
      try {
        cms = new CmsClient(env).actAs(cmsUserId(request));
      } catch (error) {
        if (error instanceof CmsNotConfiguredError) return new Response('not found', { status: 404 });
        throw error;
      }
      const edmResponse = await handleEdmEditView(request.clone(), cms, env.VIEWS, env);
      if (edmResponse.status !== 404) return edmResponse;
      const guestResponse = await handleGuestEditView(request.clone(), cms, env.VIEWS);
      if (guestResponse.status !== 404) return guestResponse;
      return handleEventEditView(request, cms);
    }

    if (path.startsWith('/__plugin/admin')) {
      return handleAdmin(request, env, url, ctx);
    }

    // ── Public guest-facing routes (own domain) ────────────────────────────
    // The RSVP form itself lives in the standalone worker-rsvp Worker (this
    // plugin's PUBLIC_BASE_URL points there); only QR signing stays here.

    // QR codes — signed with the tenant's signKey so they can't be forged.
    // Public endpoint shared by every tenant: `t=<ref>` picks the verification
    // key; changing `t` just makes the signature check fail under the other
    // tenant's key, so refs are routing hints, not authority.
    if (path === '/qr') {
      const data = url.searchParams.get('data') ?? '';
      const sig = url.searchParams.get('sig') ?? '';
      if (!data || !sig) return new Response('missing data/sig', { status: 400 });
      const ref = url.searchParams.get('t') ?? '';
      const tenant = ref ? await tenantByRef(baseEnv, ref) : await soleTenant(baseEnv);
      if (!tenant) return new Response('server misconfigured', { status: ref ? 403 : 500 });
      if (!(await verifyPayload(tenant.signKey, data, sig))) return new Response('bad signature', { status: 403 });
      return new Response(await placeholderQrSvg(baseEnv.VIEWS, data), {
        headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' },
      });
    }
    if (path === '/sign') {
      const tenant = await requireTenant(request, baseEnv);
      if (tenant instanceof Response) return tenant;
      const data = url.searchParams.get('data') ?? '';
      if (!data) return new Response('missing data', { status: 400 });
      const sig = await signPayload(tenant.signKey, data);
      return Response.json({ data, sig, url: `/qr?data=${encodeURIComponent(data)}&sig=${sig}&t=${tenant.ref}` });
    }

    // TODO public: event check-in (/checkin/...) and EDM unsubscribe (/unsubscribe/:token).

    return new Response('not found', { status: 404 });
  },

  async queue(batch: MessageBatch<EmailDelivery>, env: PluginEnv): Promise<void> {
    for (const message of batch.messages) {
      // Re-scope each delivery to its tenant so per-tenant vars (EMAIL_FROM,
      // …) apply. Legacy messages without a tenantId use the sole tenant.
      const tenant = message.body.tenantId
        ? await tenantById(env, message.body.tenantId)
        : await soleTenant(env);
      if (!tenant && message.body.tenantId) {
        // A queued delivery for a tenant that no longer exists must not fall
        // back to another tenant's sender configuration.
        console.error(`[events-suite] dropping queued email for unknown tenant ${message.body.tenantId}`);
        continue;
      }
      await deliverQueuedEmail(tenant ? tenantClientEnv(env, tenant) : env, message.body);
    }
  },

  async scheduled(_controller: ScheduledController, env: PluginEnv, ctx: ExecutionContext): Promise<void> {
    if (!env.MAIL_QUEUE) return;
    ctx.waitUntil((async () => {
      for (const tenant of await allTenants(env)) {
        const tenantEnv = tenantClientEnv(env, tenant);
        try {
          await dispatchDueMailLists(new CmsClient(tenantEnv), env.VIEWS, tenantEnv);
        } catch (error) {
          // One tenant's failure must not starve the others' scheduled blasts.
          console.error(`[events-suite] scheduled dispatch failed for tenant ${tenant.id}`, error);
        }
      }
    })());
  },
};

interface CmsHookPayload {
  page?: {
    id?: number | string;
    page_type?: string | null;
  };
}

async function handleCreateHook(payload: unknown, env: PluginEnv): Promise<void> {
  const hook = payload as CmsHookPayload;
  const pageId = parseHookPageId(hook?.page?.id);
  if (pageId == null) return;

  // Ingested public RSVP response (worker-rsvp row pulled into draft by the
  // host) — apply it to the guest page. Idempotent, so a re-fired hook or an
  // overlapping manual sweep can't double-log.
  if (hook?.page?.page_type === 'rsvp_response') {
    try {
      await applyResponsePage(new CmsClient(env), pageId);
    } catch (error) {
      console.error('[events-suite] create hook response apply failed', error);
    }
    return;
  }

  if (hook?.page?.page_type !== 'event') return;
  try {
    await createSampleEdmsForEvent(new CmsClient(env), pageId);
  } catch (error) {
    console.error('[events-suite] create hook sample EDM creation failed', error);
  }
}

function parseHookPageId(value: number | string | undefined): number | null {
  const id = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function placeholderQrSvg(views: Fetcher, data: string): Promise<string> {
  return renderLiquid(views, '/templates/qr.liquid', { label: data.slice(0, 40) });
}

const ADMIN_BASE = `/admin/plugins/${PLUGIN_ID}`;
const COLOR_TAGS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'] as const;

/**
 * Edit link into the CMS page editor that carries a `return_to` so the editor's
 * back arrow / Cancel button return to this plugin dashboard instead of the CMS
 * home (the CMS validates the path and only honours `/admin*` targets).
 */
function editHrefReturningTo(pageId: number | string, returnTo: string): string {
  return `/admin/pages/${pageId}/edit?return_to=${encodeURIComponent(returnTo)}`;
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

function withFlash(path: string, message: string): string {
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}flash=${encodeURIComponent(message)}`;
}

function runBackground(ctx: ExecutionContext | undefined, label: string, task: () => Promise<unknown>): Promise<void> | void {
  const promise = Promise.resolve().then(task);
  if (ctx) {
    ctx.waitUntil(promise.catch((error) => console.error(`[events-suite] ${label} failed`, error)));
    return;
  }
  return promise.then(() => undefined);
}

// ── Admin router ──────────────────────────────────────────────────────────────

async function handleAdmin(request: Request, env: PluginEnv, url: URL, ctx?: ExecutionContext): Promise<Response> {
  const rest = url.pathname.replace(/^\/__plugin\/admin\/?/, '');
  const segments = rest.split('/').filter(Boolean);
  const section = segments[0] || 'events';
  const jsonOnly = wantsJson(url);

  if (section === 'assets') {
    return serveViewAsset(env.VIEWS, `/assets/${segments.slice(1).join('/')}`);
  }
  if (section === 'views') {
    const viewPath = `/${segments.slice(1).join('/')}`;
    if (
      viewPath === '/color-tag-picker.liquid' ||
      viewPath === '/snippets/color-tag-picker.liquid' ||
      viewPath === '/sections/color-tag-picker.liquid'
    ) {
      return redirect(`/admin/views/snippets/color-tag-picker.liquid${url.search}`);
    }
    if (viewPath.startsWith('/snippets/pagefield/')) {
      return redirect(`/admin/views${viewPath}${url.search}`);
    }
    return serveViewAsset(env.VIEWS, viewPath, { bareLiquidSnippets: true });
  }

  let cms: CmsClient;
  try {
    // Attribute all CMS writes in this request to the signed-in admin, so
    // host-side credit costs land on their balance.
    cms = new CmsClient(env).actAs(cmsUserId(request));
  } catch (error) {
    if (error instanceof CmsNotConfiguredError) return errorPanel(env.VIEWS, error.message, true, jsonOnly);
    throw error;
  }

  const access = eventAdminAccessForRequest(request);
  if (!access.canView) return forbidden();

  // Each handler is `await`ed (not bare-returned) so a CmsApiError it throws is
  // caught below and rendered as an error panel rather than escaping this
  // function as an unhandled 500.
  try {
    if (section === 'rsvp') {
      const qr = {
        secret: env.SIGN_KEY || env.PLUGIN_SECRET,
        // RSVP and check-in are separate public Workers. Preserve the legacy
        // fallback, but prefer the explicit check-in origin for QR links.
        publicBase: env.CHECKIN_BASE_URL || env.PUBLIC_BASE_URL,
        tenantRef: env.CMS_TENANT_REF,
      };
      return await handleRsvpAdmin(request, cms, env.VIEWS, env, segments.slice(1), url, qr, jsonOnly, access);
    }
    if (section === 'edm') {
      if (!access.canManageEmail) return forbidden();
      return await handleEdmAdmin(request, cms, env.VIEWS, env, segments.slice(1), url, jsonOnly);
    }

    // section === 'events'
    // /events/:id/...
    if (segments[1] === 'new' && request.method === 'POST') {
      if (!access.canEdit) return forbidden();
      return await createEventFromForm(request, cms);
    }

    const eventId = segments[1] ? Number(segments[1]) : null;
    const sub = segments[2] ?? '';

    if (eventId && sub === 'adhoc-checkin') {
      if (!access.canCheckIn) return forbidden();
      if (request.method === 'POST') return await adhocCheckinSubmit(cms, eventId, request);
      return await adhocCheckinForm(cms, env.VIEWS, eventId, jsonOnly);
    }
    if (eventId && sub === 'duplicate') {
      if (!access.canEdit) return forbidden();
      if (request.method === 'POST') return await duplicateEvent(request, cms, eventId, ctx);
      return await duplicateEventForm(cms, env.VIEWS, eventId, jsonOnly);
    }
    if (eventId && sub === 'delete') {
      if (!access.canDelete) return forbidden();
      if (request.method === 'POST' && segments[3] === 'start') return await startEventDeletion(cms, env.VIEWS, eventId, jsonOnly);
      if (request.method === 'POST') return await continueEventDeletion(cms, env.VIEWS, eventId, jsonOnly);
      return await deleteEventForm(cms, env.VIEWS, eventId, jsonOnly);
    }
    if (eventId && sub === 'labels') {
      if (!access.canEdit) return forbidden();
      return await handleLabelsAdmin(request, cms, env.VIEWS, eventId, segments.slice(3), url, jsonOnly);
    }
    if (eventId && sub === 'export') {
      if (!access.canImportExport) return forbidden();
      return await exportEventGuests(cms, eventId);
    }
    if (eventId && sub === 'import') {
      if (!access.canImportExport) return forbidden();
      if (segments[3] === 'confirm' && request.method === 'POST') return await confirmEventGuestImport(request, cms, env.VIEWS, eventId, jsonOnly);
      if (request.method === 'POST') return await previewEventGuestImport(request, cms, env.VIEWS, eventId, jsonOnly);
      return await eventGuestImport(cms, env.VIEWS, eventId, jsonOnly);
    }
    if (eventId && sub === 'reorder-guest-lists' && request.method === 'POST') {
      if (!access.canEdit) return forbidden();
      return await reorderGuestLists(request, cms, eventId);
    }
    if (eventId && sub === 'reorder-sessions' && request.method === 'POST') {
      if (!access.canEdit) return forbidden();
      return await reorderSessions(request, cms, eventId);
    }
    if (eventId && sub === 'archive') {
      if (!access.canEdit) return forbidden();
      if (segments[3] === 'continue' && request.method === 'POST') return await continueEventArchive(cms, env.VIEWS, eventId, jsonOnly);
      if (request.method === 'POST') return await archiveEvent(request, cms, env.VIEWS, eventId, jsonOnly);
      return await archiveReview(cms, env.VIEWS, eventId, jsonOnly);
    }
    if (eventId && sub === 'registrations') {
      if (request.method === 'POST') {
        if (!access.canEdit) return forbidden();
        if (segments[3] === 'pull') return await pullSubmissions(cms, eventId);
        const registrationId = segments[3] ? Number(segments[3]) : null;
        if (registrationId && segments[4] === 'convert') return await convertRegistration(cms, eventId, registrationId);
        if (registrationId && segments[4] === 'discard') return await discardRegistration(cms, eventId, registrationId);
        return new Response('not found', { status: 404 });
      }
      return await registrationsView(cms, env.VIEWS, eventId, url, jsonOnly);
    }
    if (eventId && sub === 'sessions') {
      if (!access.canEdit) return forbidden();
      return await eventSessions(cms, env.VIEWS, eventId, jsonOnly);
    }
    if (eventId && sub === 'lists') return await eventGuestLists(cms, env.VIEWS, eventId, jsonOnly, access);
    if (eventId && sub === 'all-guests') return await flatAllGuests(cms, env.VIEWS, eventId, url, jsonOnly, access);
    if (eventId) return await eventDashboard(cms, env.VIEWS, eventId, url, jsonOnly, access);
    return await eventsList(cms, env.VIEWS, url, jsonOnly, access);
  } catch (error) {
    if (error instanceof CmsApiError) {
      // The host rejects creates that would cross an admin-configured quota
      // (Plugins → Limits) with 409 limit_exceeded. Nothing was written.
      if (error.code === 'limit_exceeded') {
        return errorPanel(
          env.VIEWS,
          'A configured limit has been reached, so nothing was created. Remove existing items, or ask an administrator to raise the limit under Plugins → Limits.',
          false,
          jsonOnly,
        );
      }
      if (error.code === 'insufficient_credits') {
        return errorPanel(
          env.VIEWS,
          'You do not have enough credits for this action, so nothing was changed. Check your balance on your profile page, or ask an administrator to top it up.',
          false,
          jsonOnly,
        );
      }
      const target = error.method && error.path ? ` ${error.method} ${error.path}` : '';
      return errorPanel(env.VIEWS, `CMS responded${target} ${error.status} (${error.code}).`, false, jsonOnly);
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
  if(r.guests === 0) return [];

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

interface StatusCount {
  label: string;
  value: number;
  statusClass: string;
  statusColor: string;
}

function statusCount(label: string, status: string, value: number): StatusCount {
  return {
    label,
    value,
    statusClass: statusClass(status),
    statusColor: statusColor(status),
  };
}

function invitationStatusCounts(summary: GuestListSummary): StatusCount[] {
  return [
    statusCount('On hold', 'onhold', summary.onhold_count),
    statusCount('To invite', 'to be invited', summary.to_be_invited_count),
    statusCount('Invited', 'invited', summary.invited_count),
  ];
}

function rsvpStatusCounts(summary: GuestListSummary): StatusCount[] {
  const counts = [
    statusCount('Confirmed', 'confirmed', summary.confirmed_count),
    statusCount('Declined', 'declined', summary.declined_count),
  ];
  if (summary.unconfirmed_count > 0) counts.push(statusCount('Unconfirmed', 'unconfirmed', summary.unconfirmed_count));
  return counts;
}

// ── Events section views ──────────────────────────────────────────────────────

async function eventsList(cms: CmsClient, views: Fetcher, url: URL, jsonOnly = false, access?: EventAdminAccess): Promise<Response> {
  const canEdit = access?.canEdit ?? true;
  const canDelete = access?.canDelete ?? true;
  // Archived events (lect.archived = yes) are hidden by default, mirroring the
  // legacy archive behavior; ?archived=1 shows them instead.
  const showArchived = url.searchParams.get('archived') === '1';
  const { pages } = await cms.list('event', { limit: 200 });
  const visible = pages.filter((event) => isArchived(event.lect) === showArchived);
  return adminView(views, 'Events', 'events', {
    flash: url.searchParams.get('flash') ?? '',
    canEdit,
    canDelete,
    showArchived,
    archivedHref: `${ADMIN_BASE}/events?archived=1`,
    activeHref: `${ADMIN_BASE}/events`,
    events: visible.map((event) => {
      const deleting = isDeleting(event.lect);
      return {
        name: event.name,
        // `start` and `timezone` are native CMS page columns (the Plugin API returns
        // them top-level, not in lect). Timezone is an offset like "+0800", so we
        // show the raw values rather than reformatting against an IANA zone.
        start: [(event.start ?? '').replace('T', ' '), event.timezone ?? ''].filter(Boolean).join(' '),
        archived: isArchived(event.lect),
        deleting,
        dashboardHref: `${ADMIN_BASE}/events/${event.id}`,
        editHref: canEdit && !deleting ? editHrefReturningTo(event.id, `${ADMIN_BASE}/events`) : '',
        duplicateHref: canEdit && !deleting ? `${ADMIN_BASE}/events/${event.id}/duplicate` : '',
        deleteHref: canDelete && !deleting ? `${ADMIN_BASE}/events/${event.id}/delete` : '',
      };
    }),
  }, jsonOnly);
}

function isDeleting(lect: Record<string, unknown>): boolean {
  return attr(lect, 'deleting').trim().toLowerCase() === 'yes';
}

// ── Event duplication ─────────────────────────────────────────────────────────

/** Duplicate scopes, narrowing what gets copied alongside the event page. */
const DUPLICATE_SCOPES = ['event', 'lists', 'guests'] as const;
type DuplicateScope = (typeof DUPLICATE_SCOPES)[number];

async function duplicateEventForm(cms: CmsClient, views: Fetcher, eventId: number, jsonOnly = false): Promise<Response> {
  const event = await cms.get(eventId);
  if (event.page_type !== 'event') return errorPanel(views, 'Event not found.', false, jsonOnly);
  return adminView(views, `Duplicate — ${event.name}`, 'event-duplicate', {
    eventName: event.name,
    backHref: `${ADMIN_BASE}/events/${eventId}`,
    action: `${ADMIN_BASE}/events/${eventId}/duplicate`,
    options: [
      { value: 'event', label: 'Event only', hint: 'Copy the event and its settings. No guest lists or guests.' },
      { value: 'lists', label: 'Event + guest lists', hint: 'Also copy each guest list (empty — no guests).' },
      { value: 'guests', label: 'Event + all guests', hint: 'Also copy every guest. Statuses reset to “to be invited”; check-ins and responses are not carried over.' },
    ],
  }, jsonOnly);
}

async function duplicateEvent(request: Request, cms: CmsClient, eventId: number, ctx?: ExecutionContext): Promise<Response> {
  const form = await request.formData();
  const scope: DuplicateScope = DUPLICATE_SCOPES.includes(form.get('scope') as DuplicateScope)
    ? (form.get('scope') as DuplicateScope)
    : 'event';

  const event = await cms.get(eventId);
  if (event.page_type !== 'event') return new Response('not found', { status: 404 });

  await chargeCreditAction(cms, 'duplicate_event', 1, {
    entityType: 'event',
    entityId: eventId,
    note: `Duplicate event (${scope})`,
  });

  // The event's native date columns and full lect (sessions, kiosk settings, …)
  // ride along so the copy is a faithful starting point the admin can edit.
  const copy = await cms.create({
    page_type: 'event',
    name: `Copy of ${event.name}`,
    // Only carry a real parent; a top-level event has page_id null, and sending
    // null would be coerced to parent 0 and violate the page self-FK.
    ...(event.page_id != null ? { page_id: event.page_id } : {}),
    start: event.start,
    end: event.end,
    timezone: event.timezone,
    lect: { ...event.lect },
  });

  if (scope === 'event') {
    return redirect(withFlash(`${ADMIN_BASE}/events/${copy.id}`, 'Event duplicated.'));
  }

  if (request.headers.get('x-cms-background-job') === '1') {
    await duplicateEventRelations(cms, eventId, copy.id, scope);
  } else {
    const pending = runBackground(ctx, `duplicate event ${eventId}`, () => duplicateEventRelations(cms, eventId, copy.id, scope));
    if (pending) await pending;
  }

  const message = scope === 'guests'
    ? 'Event duplicated. Guest lists and guests are copying in the background.'
    : 'Event duplicated. Guest lists are copying in the background.';
  return redirect(withFlash(`${ADMIN_BASE}/events/${copy.id}`, message));
}

async function duplicateEventRelations(cms: CmsClient, eventId: number, copyId: number, scope: DuplicateScope): Promise<void> {
  if (scope === 'event') return;

  // Skip the auto-managed adhoc list — the copy grows its own on first view.
  const lists = (await listByEvent(cms, 'mail_list', eventId)).filter((list) => !isAdhocList(list));
  for (const list of lists) {
    // Re-point the copied list at the new event and drop its EDM assignment
    // (that EDM belongs to the source event and is not duplicated).
    const newList = await cms.create({
      page_type: 'mail_list',
      name: list.name,
      weight: list.weight,
      lect: { ...list.lect, _pointers: { event: String(copyId) } },
    });
    if (scope === 'guests') {
      // Clone the source list's guests server-side (they are its children via
      // page_id) as "fresh invites": identity/contact carry over, but status
      // resets and the occurrence-specific checkin/response blocks drop. Done
      // in the CMS Worker so a large list doesn't stream every guest out and
      // back — which is what risked a timeout / subrequest exhaustion.
      await cms.duplicateChildren({
        // Guests reference their list by the `mail_list` lect pointer (the
        // canonical link), not by parent page, so select on the pointer.
        source: { pointerKey: 'mail_list', pointerValue: String(list.id) },
        sourcePageType: 'guest',
        targetPageId: newList.id,
        lect: {
          status: 'to be invited',
          _pointers: { event: String(copyId), mail_list: String(newList.id) },
        },
        dropLect: ['checkin', 'response'],
      });
    }
  }
}

// ── Event deletion ────────────────────────────────────────────────────────────

// Leave room below Cloudflare's free-plan subrequest cap for authentication,
// event/list discovery, rendering, and a final list/event delete.
const EVENT_DELETE_PASS_BUDGET = 30;

async function deleteEventForm(cms: CmsClient, views: Fetcher, eventId: number, jsonOnly = false): Promise<Response> {
  const event = await cms.get(eventId);
  if (event.page_type !== 'event') return errorPanel(views, 'Event not found.', false, jsonOnly);
  if (isDeleting(event.lect)) {
    return eventDeleteProgressView(views, eventId, event.name, false, 'Deletion is ready to continue.', jsonOnly);
  }
  // Counts for the confirmation copy. Guest lists and EDMs group under the event
  // by the `event` pointer, so we count them with a cheap list-and-filter rather
  // than tallying every guest (which would cost a fetch per list on a GET).
  const [guestLists, edms] = await Promise.all([
    listByEvent(cms, 'mail_list', eventId),
    listByEvent(cms, 'edm', eventId),
  ]);
  return adminView(views, `Delete — ${event.name}`, 'event-delete', {
    eventName: event.name,
    backHref: `${ADMIN_BASE}/events/${eventId}`,
    // The CMS queues exact /events/:id/delete posts before proxying them. This
    // start URL lets us mark the event as deleting before the redirect renders.
    action: `${ADMIN_BASE}/events/${eventId}/delete/start`,
    listCount: guestLists.length,
    edmCount: edms.length,
  }, jsonOnly);
}

async function startEventDeletion(cms: CmsClient, views: Fetcher, eventId: number, jsonOnly = false): Promise<Response> {
  const event = await cms.get(eventId);
  if (event.page_type !== 'event') return new Response('not found', { status: 404 });
  if (isDeleting(event.lect)) {
    return eventDeleteProgressView(views, eventId, event.name, false, 'Deletion is already in progress.', jsonOnly);
  }
  await chargeCreditAction(cms, 'delete_event', 1, {
    entityType: 'event',
    entityId: eventId,
    note: 'Delete event cascade',
  });
  await cms.update(eventId, { lect: { ...event.lect, deleting: 'yes', deleting_at: new Date().toISOString() } });
  return runEventDeletionPass(cms, views, eventId, event.name, jsonOnly);
}

async function continueEventDeletion(cms: CmsClient, views: Fetcher, eventId: number, jsonOnly = false): Promise<Response> {
  const event = await cms.get(eventId);
  if (event.page_type !== 'event') return new Response('not found', { status: 404 });
  // Compatibility for an exact delete POST already queued by an older plugin
  // version: initialize it once, then enter the same bounded pass flow.
  if (!isDeleting(event.lect)) {
    await chargeCreditAction(cms, 'delete_event', 1, {
      entityType: 'event',
      entityId: eventId,
      note: 'Delete event cascade',
    });
    await cms.update(eventId, { lect: { ...event.lect, deleting: 'yes', deleting_at: new Date().toISOString() } });
  }
  return runEventDeletionPass(cms, views, eventId, event.name, jsonOnly);
}

async function runEventDeletionPass(cms: CmsClient, views: Fetcher, eventId: number, eventName: string, jsonOnly: boolean): Promise<Response> {
  let result: EventDeletePass;
  try {
    result = await deleteEventCascadePass(cms, eventId);
  } catch (error) {
    if (!isSubrequestLimitError(error)) throw error;
    return eventDeleteProgressView(views, eventId, eventName, false, 'This pass reached the runtime limit before it could continue.', jsonOnly);
  }
  if (result.done) return redirect(withFlash(`${ADMIN_BASE}/events`, 'Event deleted.'));

  const summary = [
    result.guests ? `${result.guests} guest(s) moved to trash` : '',
    result.lists ? `${result.lists} guest list(s) moved to trash` : '',
    result.edms ? `${result.edms} email template(s) moved to trash` : '',
  ].filter(Boolean).join(', ') || 'No items moved this pass';
  return eventDeleteProgressView(views, eventId, eventName, result.progressed, `${summary}. ${result.remainingLists} guest list(s) remain.`, jsonOnly);
}

interface EventDeletePass {
  done: boolean;
  progressed: boolean;
  guests: number;
  lists: number;
  edms: number;
  remainingLists: number;
}

async function deleteEventCascadePass(cms: CmsClient, eventId: number): Promise<EventDeletePass> {
  // Guest lists and EDMs group under the event by the `event` pointer — they are
  // not children of the event page, so deleting it would orphan them rather than
  // cascade. Remove them explicitly. (The Adhoc list is included here; the
  // individual-delete guard does not apply when tearing down the whole event.)
  // Only the ids are needed to tear down, so skip fetching the pages themselves.
  const [guestListPage, edmPage] = await Promise.all([
    cms.listIdsPage('mail_list', { pointer: { key: 'event', value: eventId } }, 25),
    cms.listIdsPage('edm', { pointer: { key: 'event', value: eventId } }, 100),
  ]);
  const guestListIds = guestListPage.ids;
  const edmIds = edmPage.ids;

  let spent = 2;
  let guests = 0;
  let lists = 0;
  for (const listId of guestListIds) {
    // Trash a list's guests before the list itself: the schema cascades on the
    // list's page_id, so removing the list first would wipe guest rows before
    // they could be copied into trash. Guests reference their list by the
    // `mail_list` lect pointer (the canonical link, not parent page), so the CMS
    // trashes them by that pointer server-side — no streaming every guest back
    // here, which is what risked a timeout on a large list.
    const childPass = await cms.deleteChildrenPass(
      { pointerKey: 'mail_list', pointerValue: String(listId) },
      'guest',
      Math.max(1, EVENT_DELETE_PASS_BUDGET - spent),
    );
    spent += childPass.requests;
    guests += childPass.trashed;
    if (!childPass.done || spent >= EVENT_DELETE_PASS_BUDGET) {
      return { done: false, progressed: guests + lists > 0, guests, lists, edms: 0, remainingLists: guestListIds.length - lists };
    }
    await cms.remove(listId);
    spent += 1;
    lists += 1;
    if (spent >= EVENT_DELETE_PASS_BUDGET) {
      return { done: false, progressed: true, guests, lists, edms: 0, remainingLists: guestListIds.length - lists };
    }
  }
  if (guestListPage.more) {
    return { done: false, progressed: lists > 0, guests, lists, edms: 0, remainingLists: guestListPage.total - lists };
  }
  // EDMs group by the event pointer (not children), and are few — a single
  // bounded id-batch is fine. A later pass rediscovers any remaining page.
  await cms.batchRemove(edmIds);
  if (edmPage.more) {
    return { done: false, progressed: edmIds.length > 0, guests, lists, edms: edmIds.length, remainingLists: 0 };
  }
  await cms.remove(eventId);
  return { done: true, progressed: true, guests, lists, edms: edmIds.length, remainingLists: 0 };
}

function eventDeleteProgressView(
  views: Fetcher,
  eventId: number,
  eventName: string,
  auto: boolean,
  summary: string,
  jsonOnly: boolean,
): Promise<Response> {
  return adminView(views, 'Deleting event…', 'event-delete-progress', {
    eventName,
    summary,
    auto,
    action: `${ADMIN_BASE}/events/${eventId}/delete/continue`,
    backHref: `${ADMIN_BASE}/events`,
  }, jsonOnly);
}

function isSubrequestLimitError(error: unknown): boolean {
  return error instanceof Error && /too many subrequests/i.test(error.message);
}

const RESPONSES_PER_PAGE = 25;

async function eventDashboard(cms: CmsClient, views: Fetcher, eventId: number, url: URL, jsonOnly = false, access?: EventAdminAccess): Promise<Response> {
  const canEdit = access?.canEdit ?? true;
  const canDelete = access?.canDelete ?? true;
  const canImportExport = access?.canImportExport ?? true;
  const canCheckIn = access?.canCheckIn ?? true;
  const canManageEmail = access?.canManageEmail ?? true;
  const event = await cms.get(eventId);
  const deleting = isDeleting(event.lect);
  // Public RSVP submissions live in worker-rsvp's published database. Pull and
  // apply them before reading guest lists so every dashboard visit reflects the
  // latest response. Keep this best-effort: an unavailable ingest endpoint must
  // not make an otherwise readable event dashboard fail.
  if (!deleting) {
    try {
      await refreshSubmissions(cms);
    } catch (error) {
      console.error('[events-suite] dashboard submission refresh failed', error);
    }
  }
  // `mail_list` and `edm` group under their event by the `event` pointer (their
  // parent page may be a different page type), so filter on the pointer.
  const [guestLists, edms] = await Promise.all([
    listByEvent(cms, 'mail_list', eventId),
    listByEvent(cms, 'edm', eventId),
  ]);
  if (!deleting && !guestLists.some(isAdhocList)) guestLists.push(await ensureAdhocGuestList(cms, eventId));
  // The CMS page API is generic, so the plugin tallies each list's guests itself
  // (one fetch per list) rather than asking the CMS for RSVP-specific figures.
  // The same fetch also yields the guests who have responded, so the dashboard's
  // response feed costs no extra subrequests.
  const guestListDetails = await Promise.all(
    guestLists.map(async (list) => {
      const guests = await cms.listAll('guest', { pointer: { key: 'mail_list', value: list.id } });
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
    flash: url.searchParams.get('flash') ?? '',
    eventName: event.name,
    deleting,
    eventsHref: `${ADMIN_BASE}/events`,
    canEdit,
    canDelete,
    canImportExport,
    canCheckIn,
    canManageEmail,
    adhocCheckinHref: canCheckIn ? `${ADMIN_BASE}/events/${eventId}/adhoc-checkin` : '',
    guestListsHref: `${ADMIN_BASE}/events/${eventId}/lists`,
    allGuestsHref: `${ADMIN_BASE}/events/${eventId}/all-guests`,
    sessionsHref: canEdit ? `${ADMIN_BASE}/events/${eventId}/sessions` : '',
    importHref: canImportExport ? `${ADMIN_BASE}/events/${eventId}/import` : '',
    exportAllHref: canImportExport ? `${ADMIN_BASE}/events/${eventId}/export` : '',
    labelsHref: canEdit ? `${ADMIN_BASE}/events/${eventId}/labels` : '',
    guestSearchHref: `${ADMIN_BASE}/events/${eventId}/all-guests`,
    hasGuests: r.guests > 0,
    guestSearchColorOptions: colorTagOptions(),
    statuses: ['to be invited', 'onhold', 'invited', 'confirmed', 'declined', 'unconfirmed'],
    editHref: canEdit && !deleting ? editHrefReturningTo(eventId, `${ADMIN_BASE}/events/${eventId}`) : '',
    duplicateHref: canEdit && !deleting ? `${ADMIN_BASE}/events/${eventId}/duplicate` : '',
    registrationsHref: `${ADMIN_BASE}/events/${eventId}/registrations`,
    archiveHref: canEdit && !deleting ? `${ADMIN_BASE}/events/${eventId}/archive` : '',
    deleteHref: canDelete && !deleting ? `${ADMIN_BASE}/events/${eventId}/delete` : '',
    reorderAction: canEdit && !deleting ? CMS_BATCH_WEIGHT_ACTION : '',
    reorderEventId: eventId,
    stats: statTiles(r),
    guestLists: orderedLists.map((list) => {
      const summary = list.guest_summary ?? emptyGuestListSummary();
      return {
        id: list.id,
        name: list.name,
        href: `${ADMIN_BASE}/rsvp/${list.id}`,
        summary,
        invitationStatusCounts: invitationStatusCounts(summary),
        rsvpStatusCounts: rsvpStatusCounts(summary),
      };
    }),
    newGuestListHref: canEdit ? `${ADMIN_BASE}/rsvp/new?event_id=${eventId}` : '',
    // Email Templates section — EDMs belonging to this event.
    edms: edms.map((edm) => ({
      name: edm.name,
      subject: localized(edm.lect, 'subject') || edm.name,
      // Edit directly in the page editor (the plugin renders the EDM edit view),
      // returning to this event dashboard.
      href: canManageEmail ? `/admin/pages/${edm.id}/edit?return_to=${encodeURIComponent(`${ADMIN_BASE}/events/${eventId}`)}` : '',
      previewHref: `${ADMIN_BASE}/edm/${edm.id}/preview`,
      duplicateAction: canManageEmail ? `${ADMIN_BASE}/edm/${edm.id}/duplicate` : '',
    })),
    newEdmHref: canManageEmail ? `${ADMIN_BASE}/edm/new?event_id=${eventId}` : '',
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
