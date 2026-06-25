import {
  CmsClient,
  CmsApiError,
  attr,
  blocks,
  checkins,
  compareByWeightThenName,
  items,
  listByEvent,
  localized,
  pointer,
  type CmsPage,
  type CmsPageInput,
} from './cms';
import { signPayload } from './crypto';
import { qrSvg } from './qr';
import {
  emailQuality,
  guestWasSentEdm,
  previewEdmForGuest,
  sendEdmToGuest,
  type EdmEnv,
} from './edm';
import { adminView } from './templates/views';

const ADMIN_BASE = '/admin/plugins/events';

/** Guest lists display in admin-controlled order (page weight, then name). */
function sortByWeight(pages: CmsPage[]): CmsPage[] {
  return [...pages].sort(compareByWeightThenName);
}
const GUEST_STATUSES = ['to be invited', 'onhold', 'invited', 'confirmed', 'declined', 'unconfirmed'] as const;

type GuestStatus = typeof GUEST_STATUSES[number];

/**
 * Guests per CMS `/pages/batch` call. The host creates each page through the
 * full versioned CMS pipeline, so this stays intentionally smaller than the
 * CMS's hard max and falls back further if the host reports transient pressure.
 */
const IMPORT_CREATE_BATCH = 5;

/** Guest value fields the import compares and can add/update on an existing guest. */
const IMPORT_FIELDS = [
  'last_name', 'email', 'phone', 'organization', 'job_title',
  'plus_guests', 'status', 'prefer_language', 'cc', 'remarks',
] as const;

const IMPORT_FIELD_LABELS: Record<string, string> = {
  last_name: 'Last name', email: 'Email', phone: 'Phone', organization: 'Organisation',
  job_title: 'Job title', plus_guests: 'Plus guests', status: 'Status',
  prefer_language: 'Language', cc: 'CC', remarks: 'Remarks', checked_in: 'Check-in',
};

interface GuestListContext {
  list: CmsPage;
  event: CmsPage | null;
  eventId: number | null;
}

interface EditViewContext {
  mode: string;
  action: string;
  backHref?: string;
  language?: string;
  pageType: string;
  page: {
    id: number;
    name: string;
    slug?: string;
    weight?: number;
    pageType?: string;
    page_id?: number | null;
    pageId?: number | null;
    lect: string | Record<string, unknown>;
  };
}

interface AdminCustomField {
  key: string;
  name: string;
  label: string;
  type: string;
  required: boolean;
  value: string;
  defaultValue: string;
  options: Array<{ value: string; label: string; selected: boolean }>;
  checked: boolean;
  blockTitle: string;
  source: string;
}

/** Signing context for per-guest check-in QR codes. */
export interface QrOptions {
  secret?: string;
  publicBase?: string;
}

export async function handleRsvpAdmin(
  request: Request,
  cms: CmsClient,
  views: Fetcher,
  env: EdmEnv,
  segments: string[],
  url: URL,
  qr: QrOptions = {},
): Promise<Response> {
  if (!segments.length) return rsvpIndex(cms, views, url);

  if (segments[0] === 'new') {
    if (request.method === 'POST') return createGuestList(request, cms);
    return guestListForm(cms, views, url);
  }

  const listId = pageId(segments[0]);
  if (!listId) return new Response('not found', { status: 404 });

  // Legacy event screens linked guest actions directly to an event id. Keep
  // those links working by routing them through that event's Adhoc list.
  const target = await cms.get(listId);
  if (target.page_type === 'event') {
    const adhocList = await ensureAdhocGuestList(cms, target.id);
    if (segments[1] === 'guests' && segments[2] === 'new' && request.method === 'POST') {
      return createGuest(request, cms, adhocList.id);
    }
    const rest = segments.slice(1).join('/');
    return redirect(`${ADMIN_BASE}/rsvp/${adhocList.id}${rest ? `/${rest}` : ''}`);
  }

  if (segments[1] === 'delete' && request.method === 'POST') return deleteGuestList(cms, listId);
  if (segments[1] === 'edm') {
    if (request.method === 'POST') return setListEdm(request, cms, listId);
    return redirect(`${ADMIN_BASE}/rsvp/${listId}`);
  }
  if (segments[1] === 'send-edm' && request.method === 'POST') return autoSendEdm(request, cms, views, env, listId);
  if (segments[1] === 'update-from-contacts' && request.method === 'POST') return updateAllGuestsFromContacts(cms, listId);
  if (segments[1] === 'export') return exportGuests(cms, listId);
  if (segments[1] === 'import') {
    if (segments[2] === 'confirm' && request.method === 'POST') return confirmImportGuests(request, cms, listId);
    if (request.method === 'POST') return previewImportGuests(request, cms, views, listId);
    return guestImport(cms, views, listId);
  }

  if (segments[1] === 'guests' && segments[2] === 'new') {
    if (request.method === 'POST') return createGuest(request, cms, listId);
    return guestForm(cms, views, listId);
  }

  if (segments[1] === 'guests') {
    const guestId = pageId(segments[2]);
    if (!guestId) return new Response('not found', { status: 404 });
    if (segments[3] === 'delete' && request.method === 'POST') return deleteGuest(cms, listId, guestId);
    if (segments[3] === 'status' && request.method === 'POST') return updateGuestStatus(request, cms, listId, guestId);
    if (segments[3] === 'checkin' && request.method === 'POST') return checkInGuest(cms, listId, guestId);
    if (segments[3] === 'move' && request.method === 'POST') return moveGuest(request, cms, listId, guestId);
    if (segments[3] === 'update-from-contact' && request.method === 'POST') return updateGuestFromContact(cms, listId, guestId);
    if (segments[3] === 'send' && request.method === 'POST') return sendGuestEdm(cms, views, env, listId, guestId);
    if (segments[3] === 'preview') return previewGuestEdm(cms, views, env, listId, guestId);
    if (segments[3] === 'qrcode') return guestQr(cms, views, listId, guestId, qr);
    return new Response('not found', { status: 404 });
  }

  if (segments[1] === 'reorder-guests' && request.method === 'POST') return reorderGuests(request, cms, listId);

  return guestList(cms, views, listId, url);
}

/**
 * Plugin-rendered CMS page editor for guest pages. The CMS opens `/__plugin/edit`
 * for page types in manifest.editViews; for guests we render the same event-aware
 * form the RSVP admin route uses, using native CMS field names so the host page
 * save handler can own the write path.
 */
export async function handleGuestEditView(request: Request, cms: CmsClient, views: Fetcher): Promise<Response> {
  const ctx = (await request.json().catch(() => null)) as EditViewContext | null;
  if (!ctx || ctx.pageType !== 'guest') return new Response('not found', { status: 404 });

  const lect = parseLect(ctx.page.lect);
  const listId = pageId(pointer(lect, 'mail_list')) ?? pageId(ctx.page.page_id) ?? pageId(ctx.page.pageId);
  if (!listId) return new Response('not found', { status: 404 });

  const context = await guestListContext(cms, listId);
  if (!context) return new Response('not found', { status: 404 });

  const guest: CmsPage = {
    id: ctx.page.id,
    uuid: '',
    page_type: 'guest',
    name: ctx.page.name,
    slug: ctx.page.slug ?? '',
    weight: 0,
    start: null,
    end: null,
    timezone: null,
    page_id: listId,
    created_at: '',
    updated_at: '',
    lect: {
      ...lect,
      _pointers: { ...(lect._pointers as Record<string, unknown> ?? {}), mail_list: String(listId) },
    },
  };

  return guestFormView(cms, views, context, listId, guest, {
    title: `Edit ${guestValues(guest).name || 'guest'}`,
    action: ctx.action,
    backHref: ctx.backHref || `${ADMIN_BASE}/rsvp/${listId}`,
    returnTo: ctx.backHref || `${ADMIN_BASE}/rsvp/${listId}`,
    nativePageAction: true,
    slug: ctx.page.slug ?? '',
    weight: ctx.page.weight ?? 0,
    language: ctx.language || 'mis',
  });
}

/** Event dashboard route: lists that event's guest lists instead of a flat guest table. */
export async function eventGuestLists(cms: CmsClient, views: Fetcher, eventId: number): Promise<Response> {
  const event = await cms.get(eventId);
  if (event.page_type !== 'event') return new Response('not found', { status: 404 });
  const pages = await listByEvent(cms, 'mail_list', eventId);
  if (!pages.some(isAdhocList)) pages.push(await createAdhocGuestList(cms, eventId));
  return adminView(views, `Guest lists — ${event.name}`, 'guest-lists', {
    title: `Guest lists — ${event.name}`,
    subtitle: 'Drag a list to reorder it; the order is shared across the event.',
    backHref: `${ADMIN_BASE}/events/${eventId}`,
    newHref: `${ADMIN_BASE}/rsvp/new?event_id=${eventId}`,
    reorderAction: `${ADMIN_BASE}/events/${eventId}/reorder-guest-lists`,
    reorderEventId: eventId,
    lists: sortByWeight(pages).map((list) => ({ ...guestListRow(list, event), id: list.id })),
  });
}

export function isAdhocList(list: CmsPage): boolean {
  return list.name.trim().toLowerCase() === 'adhoc';
}

function createAdhocGuestList(cms: CmsClient, eventId: number): Promise<CmsPage> {
  return cms.create({
    page_type: 'mail_list',
    name: 'Adhoc',
    lect: { _type: 'mail_list', name: { en: 'Adhoc' }, _pointers: { event: String(eventId) } },
  });
}

/** Ensures the event's Adhoc list exists, creating it if needed. */
export async function ensureAdhocGuestList(cms: CmsClient, eventId: number): Promise<CmsPage> {
  const event = await cms.get(eventId);
  if (event.page_type !== 'event') throw new Error('Event not found');
  const pages = await listByEvent(cms, 'mail_list', eventId);
  return pages.find(isAdhocList) ?? createAdhocGuestList(cms, eventId);
}

async function rsvpIndex(cms: CmsClient, views: Fetcher, url: URL): Promise<Response> {
  const eventFilter = pageId(url.searchParams.get('event'));
  if (eventFilter) return eventGuestLists(cms, views, eventFilter);

  const [{ pages: events }, { pages: lists }] = await Promise.all([
    cms.list('event', { limit: 500 }),
    cms.list('mail_list', { limit: 500 }),
  ]);
  const eventById = new Map(events.map((event) => [event.id, event]));

  return adminView(views, 'RSVP guest lists', 'guest-lists', {
    title: 'RSVP guest lists',
    subtitle: 'Each list has its own guests, import/export tools and RSVP delivery state.',
    newHref: `${ADMIN_BASE}/rsvp/new`,
    lists: lists.map((list) => guestListRow(list, eventById.get(pageId(pointer(list.lect, 'event')) ?? 0))),
  });
}

async function guestListForm(cms: CmsClient, views: Fetcher, url: URL): Promise<Response> {
  const { pages } = await cms.list('event', { limit: 500 });
  const selectedEventId = pageId(url.searchParams.get('event_id'));
  const selectedEvent = selectedEventId && !pages.some((event) => event.id === selectedEventId)
    ? await cms.get(selectedEventId).catch(() => null)
    : null;
  const events = selectedEvent?.page_type === 'event' ? [selectedEvent, ...pages] : pages;
  return adminView(views, 'New guest list', 'guest-list-form', {
    action: selectedEventId ? `${ADMIN_BASE}/rsvp/new?event_id=${selectedEventId}` : `${ADMIN_BASE}/rsvp/new`,
    backHref: selectedEventId ? `${ADMIN_BASE}/events/${selectedEventId}` : `${ADMIN_BASE}/rsvp`,
    selectedEventId,
    events: events.map((event) => ({ id: event.id, name: event.name, selected: event.id === selectedEventId })),
  });
}

async function createGuestList(request: Request, cms: CmsClient): Promise<Response> {
  const form = await request.formData();
  const url = new URL(request.url);
  const eventId = pageId(form.get('event_id')) ?? pageId(url.searchParams.get('event_id'));
  const name = formText(form, 'name');
  if (!eventId || !name) {
    return redirect(eventId ? `${ADMIN_BASE}/rsvp/new?event_id=${eventId}` : `${ADMIN_BASE}/rsvp/new`);
  }

  const event = await cms.get(eventId);
  if (event.page_type !== 'event') return new Response('not found', { status: 404 });

  // Grouped to its event by the `event` pointer (not parent page).
  await cms.create({
    page_type: 'mail_list',
    name,
    lect: {
      _type: 'mail_list',
      name: { en: name },
      _pointers: { event: String(eventId) },
      allow_checkin: formText(form, 'allow_checkin') || 'yes',
    },
  });
  // Return to the event the list belongs to. Reading the just-created list back
  // here (to render its page) can 404 on the read-after-write path; the event
  // page is where the new list shows up anyway.
  return redirect(`${ADMIN_BASE}/events/${eventId}`);
}

async function guestList(cms: CmsClient, views: Fetcher, listId: number, url: URL): Promise<Response> {
  const context = await guestListContext(cms, listId);
  if (!context) return new Response('not found', { status: 404 });

  const q = url.searchParams.get('q')?.trim() ?? '';
  const selectedStatus = normalizeStatus(url.searchParams.get('status'));
  const { pages, total } = await cms.list('guest', { pointer: { key: 'mail_list', value: listId }, q, limit: 500 });
  const filteredGuests = selectedStatus ? pages.filter((guest) => guestStatus(guest) === selectedStatus) : pages;
  const noFilter = !q && !selectedStatus;
  const guests = noFilter ? sortByWeight(filteredGuests) : filteredGuests;

  // EDMs of this list's event populate the "select EDM" dropdown; the list's own
  // `*edm` pointer is the current selection. When set, the send/preview controls
  // and the auto-send buttons appear.
  const selectedEdmId = pageId(pointer(context.list.lect, 'edm'));
  const eventEdms = context.eventId
    ? await listByEvent(cms, 'edm', context.eventId)
    : [];
  const selectedEdm = eventEdms.find((edm) => edm.id === selectedEdmId)
    ?? (selectedEdmId ? await cms.get(selectedEdmId).catch(() => null) : null);
  const hasEdm = !!selectedEdm && selectedEdm.page_type === 'edm';

  return adminView(views, `${context.list.name} — RSVP`, 'guest-list', {
    eventName: context.event?.name ?? 'Event',
    eventHref: context.event ? `${ADMIN_BASE}/events/${context.event.id}` : `${ADMIN_BASE}/rsvp`,
    listName: context.list.name,
    listHref: `${ADMIN_BASE}/rsvp/${listId}`,
    listsHref: context.event ? `${ADMIN_BASE}/events/${context.event.id}` : `${ADMIN_BASE}/rsvp`,
    newGuestHref: `${ADMIN_BASE}/rsvp/${listId}/guests/new`,
    editHref: `/admin/pages/${listId}/edit?return_to=${encodeURIComponent(`${ADMIN_BASE}/rsvp/${listId}`)}`,
    importHref: `${ADMIN_BASE}/rsvp/${listId}/import`,
    exportHref: `${ADMIN_BASE}/rsvp/${listId}/export`,
    updateFromContactsAction: `${ADMIN_BASE}/rsvp/${listId}/update-from-contacts`,
    deleteAction: isAdhocList(context.list) ? '' : `${ADMIN_BASE}/rsvp/${listId}/delete`,
    flash: url.searchParams.get('flash') ?? '',
    // EDM controls.
    setEdmAction: `${ADMIN_BASE}/rsvp/${listId}/edm`,
    edmOptions: eventEdms.map((edm) => ({ id: edm.id, name: edm.name, selected: edm.id === selectedEdmId })),
    hasEdmOptions: eventEdms.length > 0,
    hasEdm,
    edmName: hasEdm ? selectedEdm!.name : '',
    edmEditHref: hasEdm ? `/admin/pages/${selectedEdm!.id}/edit?return_to=${encodeURIComponent(`${ADMIN_BASE}/rsvp/${listId}`)}` : '',
    autoSendGoodAction: `${ADMIN_BASE}/rsvp/${listId}/send-edm?quality=good`,
    autoSendRiskyAction: `${ADMIN_BASE}/rsvp/${listId}/send-edm?quality=risky`,
    reorderAction: noFilter ? `${ADMIN_BASE}/rsvp/${listId}/reorder-guests` : '',
    q,
    selectedStatus: selectedStatus ?? '',
    statuses: GUEST_STATUSES,
    total: selectedStatus ? filteredGuests.length : total,
    guests: guests.map((guest) => guestRow(guest, listId, hasEdm ? selectedEdm!.id : null)),
  });
}

async function guestForm(cms: CmsClient, views: Fetcher, listId: number, guestId?: number): Promise<Response> {
  const context = await guestListContext(cms, listId);
  if (!context) return new Response('not found', { status: 404 });

  const guest = guestId ? await cms.get(guestId) : undefined;
  if (guest && (guest.page_type !== 'guest' || pointer(guest.lect, 'mail_list') !== String(listId))) return new Response('not found', { status: 404 });
  return guestFormView(cms, views, context, listId, guest);
}

async function guestFormView(
  cms: CmsClient,
  views: Fetcher,
  context: GuestListContext,
  listId: number,
  guest?: CmsPage,
  options: {
    title?: string;
    action?: string;
    backHref?: string;
    returnTo?: string;
    nativePageAction?: boolean;
    slug?: string;
    weight?: number;
    language?: string;
  } = {},
): Promise<Response> {
  const values = guest ? guestValues(guest) : emptyGuestValues();
  const action = options.action ?? (guest
    ? `${ADMIN_BASE}/rsvp/${listId}/guests/${guest.id}`
    : `${ADMIN_BASE}/rsvp/${listId}/guests/new`);

  // Sibling lists of the same event a guest can be moved into (edit only).
  let moveLists: Array<{ id: number; name: string }> = [];
  if (guest && context.eventId) {
    const pages = await listByEvent(cms, 'mail_list', context.eventId);
    moveLists = pages.filter((list) => list.id !== listId).map((list) => ({ id: list.id, name: list.name }));
  }

  const adminCustomFields = adminCustomFieldsForGuest(context.event, context.list, guest);

  return adminView(views, guest ? `Edit ${values.name}` : 'New guest', 'guest-form', {
    title: options.title ?? (guest ? 'Edit guest' : 'New guest'),
    eventName: context.event?.name ?? 'Event',
    listName: context.list.name,
    listHref: options.backHref ?? `${ADMIN_BASE}/rsvp/${listId}`,
    action,
    returnTo: options.returnTo ?? '',
    nativePageAction: options.nativePageAction ?? false,
    slug: options.slug ?? guest?.slug ?? '',
    weight: options.weight ?? guest?.weight ?? 0,
    pageId: listId,
    eventId: context.eventId ?? '',
    language: options.language ?? 'mis',
    guest: values,
    statuses: GUEST_STATUSES.map((status) => ({ value: status, selected: values.status === status })),
    adminCustomFields,
    hasAdminCustomFields: adminCustomFields.length > 0,
    deleteAction: guest ? `${ADMIN_BASE}/rsvp/${listId}/guests/${guest.id}/delete` : '',
    qrHref: guest ? `${ADMIN_BASE}/rsvp/${listId}/guests/${guest.id}/qrcode` : '',
    updateFromContactAction: guest && attr(guest.lect, 'contact_id')
      ? `${ADMIN_BASE}/rsvp/${listId}/guests/${guest.id}/update-from-contact`
      : '',
    moveAction: guest ? `${ADMIN_BASE}/rsvp/${listId}/guests/${guest.id}/move` : '',
    moveLists,
  });
}

async function createGuest(request: Request, cms: CmsClient, listId: number): Promise<Response> {
  const context = await guestListContext(cms, listId);
  if (!context) return new Response('not found', { status: 404 });
  const form = await request.formData();
  const input = guestInput(form, context.eventId, listId);
  if (!input.name) return redirect(`${ADMIN_BASE}/rsvp/${listId}/guests/new`);

  applyAdminCustomResponse(input.lect, form, adminCustomFieldsForGuest(context.event, context.list));
  await cms.create({ page_type: 'guest', page_id: listId, name: input.name, lect: input.lect });
  return redirect(safeAdminReturn(formText(form, 'return_to')) || `${ADMIN_BASE}/rsvp/${listId}`);
}

async function deleteGuest(cms: CmsClient, listId: number, guestId: number): Promise<Response> {
  const guest = await cms.get(guestId);
  if (guest.page_type !== 'guest' || pointer(guest.lect, 'mail_list') !== String(listId)) return new Response('not found', { status: 404 });
  await cms.remove(guestId);
  return redirect(`${ADMIN_BASE}/rsvp/${listId}`);
}

async function deleteGuestList(cms: CmsClient, listId: number): Promise<Response> {
  const context = await guestListContext(cms, listId);
  if (!context) return new Response('not found', { status: 404 });
  if (isAdhocList(context.list)) return new Response('cannot delete the default Adhoc list', { status: 403 });

  // Fetch guests while they are still in draft_pages (queryable by pointer).
  const { pages: guests } = await cms.list('guest', { pointer: { key: 'mail_list', value: listId }, limit: 500 });

  // Trash guests BEFORE the list. The schema has ON DELETE CASCADE on page_id,
  // so removing the list row would instantly wipe all guest rows — nothing left
  // to copy into trash_pages. Trashing guests first removes them from draft_pages
  // cleanly, then trashing the list has no children left to cascade-delete.
  await cms.batchRemove(guests.map((guest) => guest.id));
  await cms.remove(listId);

  return redirect(context.event ? `${ADMIN_BASE}/rsvp?event=${context.event.id}` : `${ADMIN_BASE}/rsvp`);
}

// ── EDM linking + sending from the guest list ─────────────────────────────────

function lectPointers(page: CmsPage): Record<string, unknown> {
  const value = page.lect._pointers;
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

/** Resolves the EDM a guest list is linked to (its `*edm` pointer), if reachable. */
async function resolveListEdm(cms: CmsClient, list: CmsPage): Promise<CmsPage | null> {
  const edmId = pageId(pointer(list.lect, 'edm'));
  if (!edmId) return null;
  try {
    const edm = await cms.get(edmId);
    return edm.page_type === 'edm' ? edm : null;
  } catch (error) {
    if (error instanceof CmsApiError && error.status === 404) return null;
    throw error;
  }
}

/** Records that a guest has been sent an EDM (lect.sent_edm), so the button shows "Re-send". */
async function recordSentEdm(cms: CmsClient, guest: CmsPage, edmId: number): Promise<void> {
  const sent = Array.isArray(guest.lect.sent_edm) ? guest.lect.sent_edm.map(String) : [];
  if (sent.includes(String(edmId))) return;
  sent.push(String(edmId));
  await cms.update(guest.id, { lect: { ...guest.lect, sent_edm: sent } });
}

function listFlash(listId: number, message: string): Response {
  return redirect(`${ADMIN_BASE}/rsvp/${listId}?flash=${encodeURIComponent(message)}`);
}

/** Links (or clears) the guest list's EDM from the dropdown. */
async function setListEdm(request: Request, cms: CmsClient, listId: number): Promise<Response> {
  const list = await cms.get(listId);
  if (list.page_type !== 'mail_list') return new Response('not found', { status: 404 });
  const form = await request.formData();
  const edmId = pageId(form.get('edm_id'));
  const pointers = lectPointers(list);
  if (edmId) pointers.edm = String(edmId);
  else delete pointers.edm;
  await cms.update(listId, { lect: { ...list.lect, _pointers: pointers } });
  return redirect(`${ADMIN_BASE}/rsvp/${listId}`);
}

/** Sends one guest the list's EDM (per-guest "Send" / "Re-send" button). */
async function sendGuestEdm(cms: CmsClient, views: Fetcher, env: EdmEnv, listId: number, guestId: number): Promise<Response> {
  const context = await guestListContext(cms, listId);
  if (!context) return new Response('not found', { status: 404 });
  const edm = await resolveListEdm(cms, context.list);
  if (!edm) return listFlash(listId, 'Select an EDM for this list first');
  const guest = await cms.get(guestId);
  if (guest.page_type !== 'guest' || pointer(guest.lect, 'mail_list') !== String(listId)) return new Response('not found', { status: 404 });
  try {
    await sendEdmToGuest(views, env, edm, context.eventId, listId, guest);
    await recordSentEdm(cms, guest, edm.id);
  } catch (error) {
    return listFlash(listId, error instanceof Error ? error.message : 'Unable to send email');
  }
  return listFlash(listId, `Email sent to ${attr(guest.lect, 'email')}`);
}

/** Batch-sends the list's EDM to every guest of a given email quality that hasn't
 *  been sent yet and isn't paused. Backs the "Auto Send (Good/Risky)" buttons. */
async function autoSendEdm(request: Request, cms: CmsClient, views: Fetcher, env: EdmEnv, listId: number): Promise<Response> {
  const context = await guestListContext(cms, listId);
  if (!context) return new Response('not found', { status: 404 });
  const edm = await resolveListEdm(cms, context.list);
  if (!edm) return listFlash(listId, 'Select an EDM for this list first');

  const quality = new URL(request.url).searchParams.get('quality') === 'risky' ? 'risky' : 'good';
  const { pages: guests } = await cms.list('guest', { pointer: { key: 'mail_list', value: listId }, limit: 500 });

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const guest of guests) {
    const paused = attr(guest.lect, 'not_send') === 'true';
    const matches = emailQuality(attr(guest.lect, 'email')) === quality;
    // Auto-send never re-sends — the per-guest button does that explicitly.
    if (paused || !matches || guestWasSentEdm(guest, edm.id)) {
      skipped++;
      continue;
    }
    try {
      await sendEdmToGuest(views, env, edm, context.eventId, listId, guest);
      await recordSentEdm(cms, guest, edm.id);
      sent++;
    } catch {
      failed++;
    }
  }
  const detail = [`${sent} sent`, skipped ? `${skipped} skipped` : '', failed ? `${failed} failed` : '']
    .filter(Boolean)
    .join(', ');
  return listFlash(listId, `Auto-send (${quality}): ${detail}`);
}

/** Renders the list's EDM as it would reach this guest (preview, new tab). */
async function previewGuestEdm(cms: CmsClient, views: Fetcher, env: EdmEnv, listId: number, guestId: number): Promise<Response> {
  const context = await guestListContext(cms, listId);
  if (!context) return new Response('not found', { status: 404 });
  const edm = await resolveListEdm(cms, context.list);
  if (!edm) return new Response('No EDM is linked to this guest list.', { status: 404 });
  const guest = await cms.get(guestId);
  if (guest.page_type !== 'guest' || pointer(guest.lect, 'mail_list') !== String(listId)) return new Response('not found', { status: 404 });
  const html = await previewEdmForGuest(views, env, edm, context.eventId, listId, guest);
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'x-cms-frame': '1' },
  });
}

async function updateGuestStatus(request: Request, cms: CmsClient, listId: number, guestId: number): Promise<Response> {
  const guest = await cms.get(guestId);
  if (guest.page_type !== 'guest' || pointer(guest.lect, 'mail_list') !== String(listId)) return new Response('not found', { status: 404 });
  const form = await request.formData();
  const status = normalizeStatus(formText(form, 'status'));
  if (!status) return redirect(`${ADMIN_BASE}/rsvp/${listId}`);

  await cms.update(guestId, {
    lect: {
      status,
      response: [...items(guest.lect, 'response'), {
        status,
        date: new Date().toISOString(),
        message: 'status updated by event admin',
      }],
    },
  });
  return redirect(`${ADMIN_BASE}/rsvp/${listId}`);
}

async function checkInGuest(cms: CmsClient, listId: number, guestId: number): Promise<Response> {
  const guest = await cms.get(guestId);
  if (guest.page_type !== 'guest' || pointer(guest.lect, 'mail_list') !== String(listId)) return new Response('not found', { status: 404 });
  if (!checkins(guest.lect).length) {
    await cms.update(guestId, {
      lect: {
        checkin: [{ status: 'checked-in', date: new Date().toISOString(), message: 'checked in by event admin' }],
      },
    });
  }
  return redirect(`${ADMIN_BASE}/rsvp/${listId}`);
}

/**
 * Moves a guest to another list of the same event. In the page model a guest
 * belongs to its list via `page_id` (+ the `mail_list` pointer), so a move is
 * just re-parenting — unlike the legacy per-list SQLite copy/delete.
 */
async function moveGuest(request: Request, cms: CmsClient, listId: number, guestId: number): Promise<Response> {
  const context = await guestListContext(cms, listId);
  const guest = await cms.get(guestId);
  if (!context || guest.page_type !== 'guest' || pointer(guest.lect, 'mail_list') !== String(listId)) return new Response('not found', { status: 404 });

  const form = await request.formData();
  const targetId = pageId(form.get('target_mail_list'));
  if (!targetId || targetId === listId) return redirect(guestEditHref(guestId, listId));

  const target = await cms.get(targetId);
  // Only allow moves within the same event, so a guest never leaves its event.
  // The list's event is its `event` pointer (not parent page).
  if (target.page_type !== 'mail_list' || (context.eventId && pointer(target.lect, 'event') !== String(context.eventId))) {
    return new Response('not found', { status: 404 });
  }

  await cms.update(guestId, {
    page_id: targetId,
    lect: { _pointers: { ...(guest.lect._pointers as Record<string, unknown> ?? {}), mail_list: String(targetId) } },
  });
  return redirect(`${ADMIN_BASE}/rsvp/${targetId}`);
}

// ── Refresh a guest from its linked contact ───────────────────────────────────

interface ContactFields {
  name: string;
  email: string;
  phone: string;
  cc: string;
  organization: string;
  job_title: string;
  prefix: string;
  nationality: string;
  prefer_language: string;
}

/** First non-empty `key` across an item list (e.g. the primary email of `position[]`). */
function firstItemValue(list: Array<Record<string, unknown>>, key: string): string {
  for (const item of list) {
    const v = attr(item, key);
    if (v) return v;
  }
  return '';
}

/**
 * Maps a contact page's lect onto the guest fields the events suite stores,
 * mirroring the legacy HelperContact precedence (other → work → general).
 */
function contactToGuestFields(contact: CmsPage): ContactFields {
  const lect = contact.lect;
  const position = items(lect, 'position');
  const work = position[0] ?? {};

  const name = [localized(lect, 'first_name'), localized(lect, 'middle_name'), localized(lect, 'last_name')]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ');

  const email = firstItemValue(items(lect, 'email'), 'email') || attr(work, 'email') || attr(work, 'general_email');
  const phone = firstItemValue(items(lect, 'phone'), 'phone') || attr(work, 'direct_phone') || attr(work, 'general_phone');
  // CC = spouse + assistant emails.
  const cc = [...items(lect, 'spouse'), ...items(lect, 'assistant')]
    .map((item) => attr(item, 'email'))
    .filter(Boolean)
    .join(',');

  return {
    name,
    email,
    phone,
    cc,
    organization: localized(work, 'organization_name'),
    job_title: localized(work, 'title'),
    prefix: attr(lect, 'prefix'),
    nationality: attr(lect, 'nationality'),
    prefer_language: attr(lect, 'prefer_language'),
  };
}

/**
 * Re-pulls a single guest's details from its linked `@contact_id` page and logs
 * the refresh to the RSVP response history. No-op (returns false) when the guest
 * has no contact link or the contact can't be read.
 */
async function applyContactToGuest(cms: CmsClient, guest: CmsPage): Promise<boolean> {
  const contactId = pageId(attr(guest.lect, 'contact_id'));
  if (!contactId) return false;

  let contact: CmsPage;
  try {
    contact = await cms.get(contactId);
  } catch (error) {
    if (error instanceof CmsApiError && (error.status === 404 || error.status === 403)) return false;
    throw error;
  }
  if (contact.page_type !== 'contact') return false;

  const fields = contactToGuestFields(contact);
  const name = fields.name || guest.name;
  const log = {
    status: attr(guest.lect, 'status') || 'to be invited',
    date: new Date().toISOString(),
    message: `Updated from contact database (Contact ID: ${contactId})`,
  };

  await cms.update(guest.id, {
    name,
    lect: {
      name: { en: name },
      email: fields.email,
      phone: fields.phone,
      cc: fields.cc,
      organization: fields.organization,
      job_title: fields.job_title,
      prefix: fields.prefix,
      nationality: fields.nationality,
      prefer_language: fields.prefer_language,
      response: [...items(guest.lect, 'response'), log],
    },
  });
  return true;
}

/** POST handler: refresh one guest from its linked contact. */
async function updateGuestFromContact(cms: CmsClient, listId: number, guestId: number): Promise<Response> {
  const guest = await cms.get(guestId);
  if (guest.page_type !== 'guest' || pointer(guest.lect, 'mail_list') !== String(listId)) return new Response('not found', { status: 404 });
  await applyContactToGuest(cms, guest);
  return redirect(guestEditHref(guestId, listId));
}

/** POST handler: refresh every linked guest in a list from its contact. */
async function updateAllGuestsFromContacts(cms: CmsClient, listId: number): Promise<Response> {
  const context = await guestListContext(cms, listId);
  if (!context) return new Response('not found', { status: 404 });
  const { pages } = await cms.list('guest', { pointer: { key: 'mail_list', value: listId }, limit: 500 });
  for (const guest of pages) await applyContactToGuest(cms, guest);
  return redirect(`${ADMIN_BASE}/rsvp/${listId}`);
}

/**
 * Renders a guest's check-in QR. The code carries a PLUGIN_SECRET-signed
 * `listId.guestId.sig` token (as a check-in URL when a public base is set), so a
 * door scanner can identify the guest without trusting the unsigned payload.
 */
async function guestQr(cms: CmsClient, views: Fetcher, listId: number, guestId: number, qr: QrOptions): Promise<Response> {
  const context = await guestListContext(cms, listId);
  const guest = await cms.get(guestId);
  if (!context || guest.page_type !== 'guest' || pointer(guest.lect, 'mail_list') !== String(listId)) return new Response('not found', { status: 404 });

  const token = `${listId}.${guestId}`;
  const sig = qr.secret ? await signPayload(qr.secret, token) : '';
  const payload = qr.publicBase && sig
    ? `${qr.publicBase.replace(/\/+$/, '')}/checkin/${listId}/${guestId}/${sig}`
    : `${token}.${sig}`;
  const values = guestValues(guest);

  return adminView(views, `QR — ${values.name}`, 'guest-qr', {
    guestName: values.name,
    organization: values.organization,
    listName: context.list.name,
    listHref: `${ADMIN_BASE}/rsvp/${listId}`,
    editHref: guestEditHref(guestId, listId),
    checkedIn: checkins(guest.lect).length > 0,
    payload,
    qrSvg: qrSvg(payload, { size: 240 }),
  });
}

/**
 * Reorders an event's guest lists by writing each list's `weight`. Accepts the
 * legacy JSON shape `{ reorder: [{ id, weight }] }` so the drag-and-drop UI can
 * persist a new order in one call.
 */
export async function reorderGuestLists(request: Request, cms: CmsClient, eventId: number): Promise<Response> {
  const body = await request.json().catch(() => null) as { reorder?: Array<{ id?: unknown; weight?: unknown }> } | null;
  if (!body || !Array.isArray(body.reorder)) return Response.json({ success: false, error: 'invalid_request' }, { status: 400 });

  for (const item of body.reorder) {
    const id = pageId(item.id);
    const weight = Number(item.weight);
    if (!id || !Number.isFinite(weight)) continue;
    const list = await cms.get(id);
    if (list.page_type === 'mail_list' && pointer(list.lect, 'event') === String(eventId)) await cms.update(id, { weight });
  }
  return Response.json({ success: true });
}

/** Reorders a guest list's guests by writing each guest's `weight`. */
async function reorderGuests(request: Request, cms: CmsClient, listId: number): Promise<Response> {
  const body = await request.json().catch(() => null) as { reorder?: Array<{ id?: unknown; weight?: unknown }> } | null;
  if (!body || !Array.isArray(body.reorder)) return Response.json({ success: false, error: 'invalid_request' }, { status: 400 });

  for (const item of body.reorder) {
    const id = pageId(item.id);
    const weight = Number(item.weight);
    if (!id || !Number.isFinite(weight)) continue;
    const guest = await cms.get(id);
    if (guest.page_type === 'guest' && pointer(guest.lect, 'mail_list') === String(listId)) await cms.update(id, { weight });
  }
  return Response.json({ success: true });
}

/**
 * Reorders an event's sessions. The body `{ order: [oldIndex, …] }` lists the
 * existing rows in their new sequence. Rather than physically reordering the
 * array — which the CMS would merge index-by-index and cross-contaminate the
 * sessions' nested fields — we write a scalar `_weight` onto each row in place
 * (mirroring the legacy approach) and sort by it when rendering.
 */
export async function reorderSessions(request: Request, cms: CmsClient, eventId: number): Promise<Response> {
  const event = await cms.get(eventId);
  if (event.page_type !== 'event') return Response.json({ success: false, error: 'not_found' }, { status: 404 });

  const body = await request.json().catch(() => null) as { order?: unknown } | null;
  const sessions = items(event.lect, 'session');
  if (!body || !Array.isArray(body.order) || body.order.length !== sessions.length) {
    return Response.json({ success: false, error: 'invalid_request' }, { status: 400 });
  }

  // Map each original index → its new position; reject anything but a full permutation.
  const weightByIndex = new Array<number>(sessions.length).fill(-1);
  body.order.forEach((raw, position) => {
    const index = Number(raw);
    if (Number.isInteger(index) && index >= 0 && index < sessions.length) weightByIndex[index] = position;
  });
  if (weightByIndex.some((w) => w < 0)) {
    return Response.json({ success: false, error: 'invalid_request' }, { status: 400 });
  }

  // Patch only `_weight` per existing row, so index-wise merge leaves the rest intact.
  const patch = weightByIndex.map((weight) => ({ _weight: weight }));
  await cms.update(eventId, { lect: { session: patch } });
  return Response.json({ success: true });
}

function sessionWeight(session: Record<string, unknown>, index: number): number {
  const w = Number(session._weight);
  return Number.isFinite(w) ? w : index;
}

/** Lists an event's sessions in admin-defined order, with drag-to-reorder. */
export async function eventSessions(cms: CmsClient, views: Fetcher, eventId: number): Promise<Response> {
  const event = await cms.get(eventId);
  if (event.page_type !== 'event') return new Response('not found', { status: 404 });
  const sessions = items(event.lect, 'session')
    .map((session, index) => ({ session, index }))
    .sort((a, b) => sessionWeight(a.session, a.index) - sessionWeight(b.session, b.index));
  return adminView(views, `Sessions — ${event.name}`, 'sessions', {
    eventName: event.name,
    backHref: `${ADMIN_BASE}/events/${eventId}`,
    editHref: `/admin/pages/${eventId}/edit?return_to=${encodeURIComponent(`${ADMIN_BASE}/events/${eventId}/sessions`)}`,
    reorderAction: `${ADMIN_BASE}/events/${eventId}/reorder-sessions`,
    // `index` stays the original array index so the reorder POST maps back correctly.
    sessions: sessions.map(({ session, index }, position) => ({
      index,
      name: localized(session, 'name') || `Session ${position + 1}`,
      start: attr(session, 'start'),
      location: localized(session, 'location'),
      capacity: attr(session, 'capacity'),
    })),
  });
}

/**
 * Flat view of every guest across all of an event's lists, with a status
 * filter — the cross-list roll-call the legacy `all_guests` screen provided.
 */
export async function flatAllGuests(cms: CmsClient, views: Fetcher, eventId: number, url: URL): Promise<Response> {
  const event = await cms.get(eventId);
  if (event.page_type !== 'event') return new Response('not found', { status: 404 });

  const lists = await listByEvent(cms, 'mail_list', eventId);
  const ordered = sortByWeight(lists);
  const guestsByList = await Promise.all(
    ordered.map((list) => cms.list('guest', { pointer: { key: 'mail_list', value: list.id }, limit: 500 }).then((res) => res.pages)),
  );

  const selectedStatus = normalizeStatus(url.searchParams.get('status'));
  const rows: Array<Record<string, unknown>> = [];
  ordered.forEach((list, index) => {
    for (const guest of guestsByList[index] ?? []) {
      if (selectedStatus && guestStatus(guest) !== selectedStatus) continue;
      const values = guestValues(guest);
      rows.push({
        ...values,
        listName: list.name,
        editHref: guestEditHref(guest.id, list.id, `${ADMIN_BASE}/events/${eventId}/all-guests`),
        checkedIn: checkins(guest.lect).length > 0,
      });
    }
  });
  const totalCount = guestsByList.reduce((sum, guests) => sum + guests.length, 0);

  return adminView(views, `All guests — ${event.name}`, 'all-guests', {
    eventName: event.name,
    backHref: `${ADMIN_BASE}/events/${eventId}`,
    exportHref: `${ADMIN_BASE}/events/${eventId}/export`,
    listHref: `${ADMIN_BASE}/events/${eventId}/all-guests`,
    statuses: GUEST_STATUSES,
    selectedStatus: selectedStatus ?? '',
    totalCount,
    filteredCount: rows.length,
    guests: rows,
  });
}

/** Import form for adding guests across multiple lists in one upload. */
export async function eventGuestImport(cms: CmsClient, views: Fetcher, eventId: number): Promise<Response> {
  const event = await cms.get(eventId);
  if (event.page_type !== 'event') return new Response('not found', { status: 404 });
  return adminView(views, `Import guests — ${event.name}`, 'event-import', {
    eventName: event.name,
    backHref: `${ADMIN_BASE}/events/${eventId}`,
    action: `${ADMIN_BASE}/events/${eventId}/import`,
  });
}

/**
 * Imports guests from a CSV whose `list` (or `mail_list`) column routes each row
 * to a named list — the flat equivalent of the legacy multi-sheet workbook.
 * Missing lists are created under the event before their guests are added.
 */
export async function previewEventGuestImport(request: Request, cms: CmsClient, views: Fetcher, eventId: number): Promise<Response> {
  const event = await cms.get(eventId);
  if (event.page_type !== 'event') return new Response('not found', { status: 404 });

  const form = await request.formData();
  const file = form.get('file') as unknown;
  if (!file || typeof (file as { text?: unknown }).text !== 'function') {
    return redirect(`${ADMIN_BASE}/events/${eventId}/import`);
  }

  const csv = await (file as { text(): Promise<string> }).text();
  const groups = parseEventImportGroups(csv);
  if (!groups.length) {
    return adminView(views, `Import guests — ${event.name}`, 'event-import', {
      eventName: event.name,
      backHref: `${ADMIN_BASE}/events/${eventId}`,
      action: `${ADMIN_BASE}/events/${eventId}/import`,
      error: 'No guests with a name were found in that file.',
    });
  }

  const preview = await eventImportPreview(cms, eventId, groups);

  return adminView(views, `Preview import — ${event.name}`, 'event-import-preview', {
    eventName: event.name,
    backHref: `${ADMIN_BASE}/events/${eventId}`,
    importHref: `${ADMIN_BASE}/events/${eventId}/import`,
    confirmAction: `${ADMIN_BASE}/events/${eventId}/import/confirm`,
    total: preview.total,
    newCount: preview.newCount,
    updateCount: preview.updateCount,
    unchangedCount: preview.unchangedCount,
    newListCount: preview.newListCount,
    groups: preview.groups,
    csv,
  });
}

export async function confirmEventGuestImport(request: Request, cms: CmsClient, eventId: number): Promise<Response> {
  const event = await cms.get(eventId);
  if (event.page_type !== 'event') return new Response('not found', { status: 404 });

  const form = await request.formData();
  const mode = formText(form, 'mode') || 'new_and_update';
  const groups = parseEventImportGroups(formText(form, 'csv'));
  if (!groups.length) return redirect(`${ADMIN_BASE}/events/${eventId}/import`);

  // Existing lists, keyed by lower-cased name, so repeated rows reuse one list.
  const existing = await listByEvent(cms, 'mail_list', eventId);
  const listByName = new Map(existing.map((list) => [list.name.trim().toLowerCase(), list]));

  for (const group of groups) {
    let list = listByName.get(eventImportListKey(group.listName));
    let existingGuests: CmsPage[] = [];
    if (!list) {
      if (mode === 'update_only') continue;
      const listName = group.listName;
      list = await cms.create({
        page_type: 'mail_list',
        name: listName,
        lect: { _type: 'mail_list', name: { en: listName }, _pointers: { event: String(eventId) } },
      });
      listByName.set(eventImportListKey(group.listName), list);
    } else {
      existingGuests = (await cms.list('guest', { pointer: { key: 'mail_list', value: list.id }, limit: 500 })).pages;
    }

    const plan = classifyImport(group.guests, existingGuests, eventId, list.id);
    if (mode !== 'update_only') await createImportedGuests(cms, plan.create);
    if (mode !== 'new_only') {
      for (const entry of plan.update) await cms.update(entry.id, { lect: entry.lect });
    }
  }

  return redirect(`${ADMIN_BASE}/events/${eventId}/all-guests`);
}

interface EventImportGroup {
  listName: string;
  guests: IncomingGuest[];
}

interface EventImportPreview {
  total: number;
  newCount: number;
  updateCount: number;
  unchangedCount: number;
  newListCount: number;
  groups: Array<{
    listName: string;
    listState: 'new' | 'existing';
    total: number;
    newCount: number;
    updateCount: number;
    unchangedCount: number;
  }>;
}

function eventImportListKey(listName: string): string {
  return listName.trim().toLowerCase();
}

function parseEventImportGroups(text: string): EventImportGroup[] {
  const [headers = [], ...rows] = parseCsv(text);
  const columns = csvColumns(headers);
  const groups = new Map<string, EventImportGroup>();
  for (const row of rows) {
    const value = (...names: string[]) => csvCell(columns, row, ...names);
    const guest = importGuestFromValue(value);
    if (!guest) continue;
    guest.custom = customGuestAttrs(columns, row);
    const listName = value('list', 'mail_list', 'guest_list', 'guest_list_name') || 'Imported';
    const key = eventImportListKey(listName);
    const group = groups.get(key) ?? { listName, guests: [] };
    group.guests.push(guest);
    groups.set(key, group);
  }
  return [...groups.values()];
}

async function eventImportPreview(cms: CmsClient, eventId: number, groups: EventImportGroup[]): Promise<EventImportPreview> {
  const existing = await listByEvent(cms, 'mail_list', eventId);
  const listByName = new Map(existing.map((list) => [eventImportListKey(list.name), list]));
  const preview: EventImportPreview = { total: 0, newCount: 0, updateCount: 0, unchangedCount: 0, newListCount: 0, groups: [] };

  for (const group of groups) {
    const list = listByName.get(eventImportListKey(group.listName));
    let rows: ImportRow[];
    if (list) {
      const { pages: existingGuests } = await cms.list('guest', { pointer: { key: 'mail_list', value: list.id }, limit: 500 });
      rows = classifyImport(group.guests, existingGuests, eventId, list.id).rows;
    } else {
      preview.newListCount += 1;
      rows = group.guests.map((guest) => ({ name: guest.name, email: guest.values.email, state: 'new', changes: [] }));
    }

    const newCount = rows.filter((row) => row.state === 'new').length;
    const updateCount = rows.filter((row) => row.state === 'update').length;
    const unchangedCount = rows.filter((row) => row.state === 'unchanged').length;
    preview.total += rows.length;
    preview.newCount += newCount;
    preview.updateCount += updateCount;
    preview.unchangedCount += unchangedCount;
    preview.groups.push({
      listName: group.listName,
      listState: list ? 'existing' : 'new',
      total: rows.length,
      newCount,
      updateCount,
      unchangedCount,
    });
  }

  return preview;
}

async function guestImport(cms: CmsClient, views: Fetcher, listId: number): Promise<Response> {
  const context = await guestListContext(cms, listId);
  if (!context) return new Response('not found', { status: 404 });
  return adminView(views, `Import guests — ${context.list.name}`, 'guest-import', {
    eventName: context.event?.name ?? 'Event',
    listName: context.list.name,
    listHref: `${ADMIN_BASE}/rsvp/${listId}`,
    action: `${ADMIN_BASE}/rsvp/${listId}/import`,
  });
}

/** A guest parsed from the uploaded CSV, before matching against the list. */
interface IncomingGuest {
  id: number | null; // preserved from csv `id` column when present
  name: string;
  values: Record<string, string>;
  custom: Record<string, string>; // rsvp-custom-* / rsvp_custom_* attrs stored flat in lect
  checkin?: Array<Record<string, string>>;
}

/**
 * Parses an uploaded CSV into incoming guests (no writes). Header lookup is
 * case-insensitive and space/underscore-insensitive, with the same column
 * aliases the legacy export uses. Rows with no name are skipped.
 */
function parseImportRows(text: string): IncomingGuest[] {
  const [headers = [], ...rows] = parseCsv(text);
  const columns = csvColumns(headers);
  const out: IncomingGuest[] = [];
  for (const row of rows) {
    const value = (...names: string[]) => csvCell(columns, row, ...names);
    const guest = importGuestFromValue(value);
    if (!guest) continue;
    guest.custom = customGuestAttrs(columns, row);
    out.push(guest);
  }
  return out;
}

function headerKey(header: string): string {
  return header.replace(/^\uFEFF/, '').trim().toLowerCase().replaceAll(' ', '_');
}

function csvColumns(headers: string[]): Map<string, number> {
  return new Map(headers.map((header, index) => [headerKey(header), index]));
}

function csvCell(columns: Map<string, number>, row: string[], ...names: string[]): string {
  for (const name of names) {
    const index = columns.get(headerKey(name));
    if (index !== undefined) return row[index]?.trim() ?? '';
  }
  return '';
}

/** True for any rsvp-custom-* / rsvp_custom_* column that carries event-specific form data. */
function isCustomKey(key: string): boolean {
  return key.startsWith('rsvp-custom-') || key.startsWith('rsvp_custom_');
}

/** Collects all rsvp-custom-* columns for one CSV row into a flat key→value map. */
function customGuestAttrs(columns: Map<string, number>, row: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, index] of columns) {
    if (!isCustomKey(key)) continue;
    const val = stripExcelFormula((row[index] ?? '').trim()).replace(/\s+/g, ' ');
    if (val) out[key] = val;
  }
  return out;
}

function importGuestFromValue(value: (...names: string[]) => string): IncomingGuest | null {
  // Strip Excel ="..." formula prefix that Excel adds to text cells to prevent
  // them being interpreted as numbers. parseCsv leaves the leading = behind.
  const v = (...names: string[]) => stripExcelFormula(value(...names));
  const name = v('name', 'full_name')
    || [v('first_name', 'rsvp_custom_first_name'), v('last_name', 'rsvp_custom_last_name')].filter(Boolean).join(' ');
  if (!name) return null;
  // Raw values only — an absent/blank column must stay blank so it never counts
  // as a change against an existing guest. Defaults are applied on create.
  const values: Record<string, string> = {
    last_name: v('last_name', 'rsvp_custom_last_name'),
    email: v('email', 'primary_email'),
    phone: v('phone', 'mobile'),
    organization: v('organization', 'company', 'rsvp_custom_referral_organization'),
    job_title: v('job_title', 'title'),
    plus_guests: v('plus_guests'),
    status: normalizeStatus(v('status', 'rsvp_status')) ?? '',
    prefer_language: v('prefer_language', 'language'),
    cc: v('cc', 'cc_email'),
    remarks: v('remarks', 'notes'),
  };
  const checkin = importedCheckin(
    v('checkin_status', 'rsvp_custom_checkin_status'),
    v('checkin_date', 'rsvp_custom_checkin_date'),
    v('checkin_message', 'rsvp_custom_checkin_message'),
  );
  const rawId = parseImportId(value('id')); // parseImportId handles = prefix itself
  return { id: rawId, name, values, custom: {}, checkin: checkin ?? undefined };
}

/** Identity key for matching a guest to an existing one: email if present, else name. */
function guestMatchKey(name: string, email: string): string {
  const normalizedEmail = email.trim().toLowerCase();
  // Collapse internal whitespace (including newlines from multi-line CSV cells) so
  // the key is stable regardless of how the CMS normalises the stored page name.
  const normalizedName = name.trim().replace(/\s+/g, ' ').toLowerCase();
  return normalizedEmail ? `email:${normalizedEmail}` : `name:${normalizedName}`;
}

function incomingToCreateInput(guest: IncomingGuest, eventId: number | null, listId: number): CmsPageInput {
  const fields = new Map(Object.entries(guest.values));
  if (!fields.get('plus_guests')) fields.set('plus_guests', '0');
  if (!fields.get('status')) fields.set('status', 'to be invited');
  const input = guestPageInput(guest.name, fields, eventId, listId);
  if (guest.id) input.id = guest.id;
  if (guest.checkin) input.lect = { ...input.lect, checkin: guest.checkin };
  if (Object.keys(guest.custom).length) input.lect = { ...input.lect, ...guest.custom };
  return input;
}

/** Lect fragment to PUT for one changed field (host partial-merges it). */
function updateLectFragment(field: string, value: string): Record<string, unknown> {
  return field === 'last_name' ? { last_name: { en: value } } : { [field]: value };
}

interface ImportRow {
  name: string;
  email: string;
  state: 'new' | 'update' | 'unchanged';
  changes: Array<{ label: string; from: string; to: string; add: boolean }>;
}

interface ImportPlan {
  create: CmsPageInput[];
  update: Array<{ id: number; lect: Record<string, unknown> }>;
  rows: ImportRow[];
}

/** Fields the import would add/change on `existing` to match `guest`, plus the PUT lect. */
function diffGuest(guest: IncomingGuest, existing: CmsPage): { lect: Record<string, unknown>; changes: ImportRow['changes'] } {
  const current = guestValues(existing);
  const lect: Record<string, unknown> = {};
  const changes: ImportRow['changes'] = [];
  for (const field of IMPORT_FIELDS) {
    const raw = guest.values[field] ?? '';
    if (!raw) continue; // never blank out an existing value
    // Collapse internal whitespace from multi-line CSV cells before comparing and
    // storing, so re-importing the same file never surfaces a phantom change.
    const next = raw.trim().replace(/\s+/g, ' ');
    const prev = (current[field] ?? '').trim().replace(/\s+/g, ' ');
    if (next === prev) continue;
    Object.assign(lect, updateLectFragment(field, next));
    changes.push({ label: IMPORT_FIELD_LABELS[field], from: prev, to: next, add: prev === '' });
  }
  for (const [key, next] of Object.entries(guest.custom)) {
    if (!next) continue;
    const prev = attr(existing.lect, key).trim().replace(/\s+/g, ' ');
    if (next === prev) continue;
    lect[key] = next;
    const label = key.replace(/^(rsvp-custom-|rsvp_custom_)/, '').replace(/[-_]/g, ' ');
    changes.push({ label, from: prev, to: next, add: prev === '' });
  }
  if (guest.checkin && checkins(existing.lect).length === 0) {
    lect.checkin = guest.checkin;
    changes.push({ label: IMPORT_FIELD_LABELS.checked_in, from: '', to: 'checked in', add: true });
  }
  return { lect, changes };
}

/**
 * Matches each incoming guest against the list's current guests (by email, else
 * name) and builds the create/update plan plus per-row diffs. Shared by the
 * preview (display) and the confirm (apply) so both see the same classification.
 *
 * Each existing guest is matched at most once, and within a group sharing a key
 * an exact (zero-diff) guest is preferred — so re-importing the same file is
 * idempotent even when the source has duplicate emails (which create one guest
 * per row on the first import).
 */
function classifyImport(incoming: IncomingGuest[], existingGuests: CmsPage[], eventId: number | null, listId: number): ImportPlan {
  const existingByKey = new Map<string, CmsPage[]>();
  for (const guest of existingGuests) {
    const values = guestValues(guest);
    const key = guestMatchKey(values.name, values.email);
    const bucket = existingByKey.get(key);
    if (bucket) bucket.push(guest);
    else existingByKey.set(key, [guest]);
  }

  const create: CmsPageInput[] = [];
  const update: Array<{ id: number; lect: Record<string, unknown> }> = [];
  const rows = incoming.map((guest): ImportRow => {
    const candidates = existingByKey.get(guestMatchKey(guest.name, guest.values.email));
    if (!candidates || !candidates.length) {
      create.push(incomingToCreateInput(guest, eventId, listId));
      return { name: guest.name, email: guest.values.email, state: 'new', changes: [] };
    }

    // Prefer an existing guest that needs no change; else update the first.
    let index = candidates.findIndex((candidate) => diffGuest(guest, candidate).changes.length === 0);
    if (index === -1) index = 0;
    const [match] = candidates.splice(index, 1); // consume so each existing matches once
    const { lect, changes } = diffGuest(guest, match);
    if (changes.length) update.push({ id: match.id, lect });
    return { name: guest.name, email: guest.values.email, state: changes.length ? 'update' : 'unchanged', changes };
  });

  return { create, update, rows };
}

async function createImportedGuests(cms: CmsClient, inputs: CmsPageInput[]): Promise<void> {
  for (const chunk of chunks(inputs, IMPORT_CREATE_BATCH)) await createImportedGuestBatch(cms, chunk);
}

async function createImportedGuestBatch(cms: CmsClient, inputs: CmsPageInput[]): Promise<void> {
  if (!inputs.length) return;
  if (inputs.length === 1) {
    await cms.create(inputs[0]);
    return;
  }

  try {
    const result = await cms.batchCreate(inputs);
    if (result.errors.length) {
      const first = result.errors[0];
      throw new CmsApiError(400, `batch_item_${first.index}:${first.error}`, 'POST', '/pages/batch');
    }
  } catch (error) {
    if (error instanceof CmsApiError && shouldSplitImportBatch(error)) {
      const midpoint = Math.ceil(inputs.length / 2);
      await createImportedGuestBatch(cms, inputs.slice(0, midpoint));
      await createImportedGuestBatch(cms, inputs.slice(midpoint));
      return;
    }
    throw error;
  }
}

function shouldSplitImportBatch(error: CmsApiError): boolean {
  return error.path === '/pages/batch' && [429, 500, 502, 503, 504].includes(error.status);
}

/**
 * Step 1 of import: parse the CSV, classify each row against the list (new /
 * update-with-diff / unchanged), and render the preview — no writes. The raw CSV
 * (not the expanded plan) rides to confirm in a hidden field so the round-trip
 * body stays small; confirm re-parses and re-classifies it.
 */
async function previewImportGuests(request: Request, cms: CmsClient, views: Fetcher, listId: number): Promise<Response> {
  const context = await guestListContext(cms, listId);
  if (!context) return new Response('not found', { status: 404 });
  const form = await request.formData();
  const file = form.get('file') as unknown;
  if (!file || typeof (file as { text?: unknown }).text !== 'function') {
    return redirect(`${ADMIN_BASE}/rsvp/${listId}/import`);
  }

  const csv = await (file as { text(): Promise<string> }).text();
  const incoming = parseImportRows(csv);
  if (!incoming.length) {
    return adminView(views, `Import guests — ${context.list.name}`, 'guest-import', {
      eventName: context.event?.name ?? 'Event',
      listName: context.list.name,
      listHref: `${ADMIN_BASE}/rsvp/${listId}`,
      action: `${ADMIN_BASE}/rsvp/${listId}/import`,
      error: 'No guests with a name were found in that file.',
    });
  }

  const { pages: existingGuests } = await cms.list('guest', { pointer: { key: 'mail_list', value: listId }, limit: 500 });
  const plan = classifyImport(incoming, existingGuests, context.eventId, listId);

  return adminView(views, `Preview import — ${context.list.name}`, 'guest-import-preview', {
    eventName: context.event?.name ?? 'Event',
    listName: context.list.name,
    listHref: `${ADMIN_BASE}/rsvp/${listId}`,
    importHref: `${ADMIN_BASE}/rsvp/${listId}/import`,
    confirmAction: `${ADMIN_BASE}/rsvp/${listId}/import/confirm`,
    total: plan.rows.length,
    newCount: plan.create.length,
    updateCount: plan.update.length,
    unchangedCount: plan.rows.filter((row) => row.state === 'unchanged').length,
    guests: plan.rows,
    csv,
  });
}

/**
 * Step 2 of import: re-parse the CSV carried from the preview, re-classify it
 * against the list's current guests, and apply per the chosen mode —
 * `new_only`, `update_only`, or `new_and_update`. Creates run in adaptive small
 * batches so normal imports are fast while oversized CMS requests split down on
 * transient host pressure; updates are applied per guest. Re-deriving server-side
 * keeps the round-trip body small and means the client can't smuggle writes to
 * other pages.
 */
async function confirmImportGuests(request: Request, cms: CmsClient, listId: number): Promise<Response> {
  const context = await guestListContext(cms, listId);
  if (!context) return new Response('not found', { status: 404 });
  const form = await request.formData();
  const mode = formText(form, 'mode') || 'new_and_update';
  const incoming = parseImportRows(formText(form, 'csv'));
  if (!incoming.length) return redirect(`${ADMIN_BASE}/rsvp/${listId}/import`);

  const { pages: existingGuests } = await cms.list('guest', { pointer: { key: 'mail_list', value: listId }, limit: 500 });
  const plan = classifyImport(incoming, existingGuests, context.eventId, listId);

  if (mode !== 'update_only') {
    await createImportedGuests(cms, plan.create);
  }
  if (mode !== 'new_only') {
    for (const entry of plan.update) await cms.update(entry.id, { lect: entry.lect });
  }

  return redirect(`${ADMIN_BASE}/rsvp/${listId}`);
}

async function exportGuests(cms: CmsClient, listId: number): Promise<Response> {
  const context = await guestListContext(cms, listId);
  if (!context) return new Response('not found', { status: 404 });
  const { pages } = await cms.list('guest', { pointer: { key: 'mail_list', value: listId }, limit: 500 });
  const headers = ['id', 'name', 'last_name', 'email', 'phone', 'organization', 'job_title', 'plus_guests', 'status', 'prefer_language', 'cc', 'remarks', 'checked_in'];
  const rows = pages.map((guest) => {
    const values = guestValues(guest);
    return [
      String(guest.id),
      values.name, values.last_name, values.email, values.phone, values.organization, values.job_title,
      values.plus_guests, values.status, values.prefer_language, values.cc, values.remarks,
      checkins(guest.lect).length ? 'yes' : 'no',
    ];
  });
  const csv = [headers, ...rows].map((row) => row.map(csvValue).join(',')).join('\n');
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${safeFilename(context.list.name)}-guests.csv"`,
    },
  });
}

/**
 * Exports every guest across all of an event's lists as a single CSV (one row
 * per guest, with the originating list name). The legacy app produced a
 * multi-sheet workbook; a flat CSV with a `mail_list` column is the equivalent.
 */
export async function exportEventGuests(cms: CmsClient, eventId: number): Promise<Response> {
  const event = await cms.get(eventId);
  if (event.page_type !== 'event') return new Response('not found', { status: 404 });

  const lists = await listByEvent(cms, 'mail_list', eventId);
  const guestsByList = await Promise.all(
    lists.map((list) => cms.list('guest', { pointer: { key: 'mail_list', value: list.id }, limit: 500 }).then((res) => res.pages)),
  );

  const headers = ['id', 'mail_list', 'name', 'last_name', 'email', 'phone', 'organization', 'job_title', 'plus_guests', 'status', 'prefer_language', 'cc', 'remarks', 'checked_in'];
  const rows: string[][] = [];
  lists.forEach((list, index) => {
    for (const guest of guestsByList[index] ?? []) {
      const values = guestValues(guest);
      rows.push([
        String(guest.id),
        list.name, values.name, values.last_name, values.email, values.phone, values.organization, values.job_title,
        values.plus_guests, values.status, values.prefer_language, values.cc, values.remarks,
        checkins(guest.lect).length ? 'yes' : 'no',
      ]);
    }
  });

  const csv = [headers, ...rows].map((row) => row.map(csvValue).join(',')).join('\n');
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${safeFilename(event.name)}-all-guests.csv"`,
    },
  });
}

async function guestListContext(cms: CmsClient, listId: number): Promise<GuestListContext | null> {
  const list = await cms.get(listId);
  if (list.page_type !== 'mail_list') return null;
  // A list groups under its event by the `event` pointer, not its parent page.
  const eventId = pageId(pointer(list.lect, 'event'));
  if (!eventId) return { list, event: null, eventId: null };
  try {
    const event = await cms.get(eventId);
    return { list, event: event.page_type === 'event' ? event : null, eventId };
  } catch (error) {
    if (error instanceof CmsApiError && error.status === 404) return { list, event: null, eventId };
    throw error;
  }
}

function guestListRow(list: CmsPage, event?: CmsPage): Record<string, unknown> {
  return {
    name: list.name,
    eventName: event?.name ?? 'Unknown event',
    eventHref: event ? `${ADMIN_BASE}/events/${event.id}` : '',
    href: `${ADMIN_BASE}/rsvp/${list.id}`,
    canDelete: !isAdhocList(list),
    deleteAction: isAdhocList(list) ? '' : `${ADMIN_BASE}/rsvp/${list.id}/delete`,
    allowCheckin: attr(list.lect, 'allow_checkin') !== 'no',
  };
}

function guestEditHref(guestId: number, listId: number, returnTo = `${ADMIN_BASE}/rsvp/${listId}`): string {
  return `/admin/pages/${guestId}/edit?return_to=${encodeURIComponent(returnTo)}`;
}

function guestRow(guest: CmsPage, listId: number, edmId: number | null): Record<string, unknown> {
  const values = guestValues(guest);
  const quality = emailQuality(values.email);
  return {
    ...values,
    id: guest.id,
    editHref: guestEditHref(guest.id, listId),
    qrHref: `${ADMIN_BASE}/rsvp/${listId}/guests/${guest.id}/qrcode`,
    statusAction: `${ADMIN_BASE}/rsvp/${listId}/guests/${guest.id}/status`,
    checkinAction: `${ADMIN_BASE}/rsvp/${listId}/guests/${guest.id}/checkin`,
    checkedIn: checkins(guest.lect).length > 0,
    // EDM send/preview controls (only meaningful when the list has an EDM).
    emailQuality: quality,
    canEmail: quality !== 'invalid',
    isGood: quality === 'good',
    isRisky: quality === 'risky',
    notSend: attr(guest.lect, 'not_send') === 'true',
    sent: edmId ? guestWasSentEdm(guest, edmId) : false,
    sendAction: `${ADMIN_BASE}/rsvp/${listId}/guests/${guest.id}/send`,
    previewHref: `${ADMIN_BASE}/rsvp/${listId}/guests/${guest.id}/preview`,
  };
}

function emptyGuestValues(): Record<string, string> {
  return {
    name: '', last_name: '', email: '', phone: '', organization: '', job_title: '', plus_guests: '0',
    status: 'to be invited', prefer_language: '', cc: '', remarks: '',
  };
}

function guestValues(guest: CmsPage): Record<string, string> {
  return {
    name: guest.name || localized(guest.lect, 'name'),
    last_name: localized(guest.lect, 'last_name'),
    email: attr(guest.lect, 'email'),
    phone: attr(guest.lect, 'phone'),
    organization: attr(guest.lect, 'organization'),
    job_title: attr(guest.lect, 'job_title'),
    plus_guests: attr(guest.lect, 'plus_guests') || '0',
    status: guestStatus(guest),
    prefer_language: attr(guest.lect, 'prefer_language'),
    cc: attr(guest.lect, 'cc'),
    remarks: attr(guest.lect, 'remarks'),
  };
}

function guestStatus(guest: CmsPage): GuestStatus {
  return normalizeStatus(attr(guest.lect, 'status')) ?? 'to be invited';
}

function adminCustomFieldsForGuest(event: CmsPage | null, list: CmsPage, guest?: CmsPage): AdminCustomField[] {
  const fields: AdminCustomField[] = [];
  const seenTypes = new Set<string>();
  for (const source of [
    ...(event ? adminCustomBlocks(event, 'event') : []),
    ...adminCustomBlocks(list, 'guest list'),
  ]) {
    const includeBlockId = seenTypes.has(source.type);
    seenTypes.add(source.type);
    const blockKey = includeBlockId ? `${source.type}-${source.id}` : source.type;

    for (const input of items(source.block, 'custom_input')) {
      const label = localized(input, 'label') || attr(input, 'label') || attr(input, 'name');
      if (!label) continue;
      const labelKey = adminFieldSlug(label);
      const key = `rsvp_custom_${includeBlockId ? `${adminFieldSlug(blockKey)}_` : ''}${labelKey}`;
      const value = attr(guest?.lect ?? {}, key);
      const type = adminInputType(attr(input, 'type'));
      const defaultValue = attr(input, 'default_value');
      fields.push({
        key,
        name: `@${key}`,
        label,
        type,
        required: attr(input, 'required') === 'yes' || attr(input, 'required') === 'true',
        value,
        defaultValue,
        options: adminInputOptions(defaultValue, value),
        checked: value !== '' && value === (defaultValue || 'yes'),
        blockTitle: localized(source.block, 'title') || (source.source === 'event' ? 'Event custom information' : 'Guest list custom information'),
        source: source.source,
      });
    }
  }
  return fields;
}

function adminCustomBlocks(page: CmsPage, source: string): Array<{ type: string; id: string; source: string; block: Record<string, unknown> }> {
  return blocks(page.lect)
    .map((block, index) => ({
      type: attr(block, '_type'),
      id: attr(block, '_id') || String(block._index ?? block._weight ?? index),
      source,
      block,
    }))
    .filter((entry) => entry.type === 'rsvp-custom' && items(entry.block, 'custom_input').length > 0);
}

function applyAdminCustomResponse(lect: Record<string, unknown>, form: FormData, fields: AdminCustomField[]): void {
  for (const field of fields) lect[field.key] = formText(form, field.name);
}

function adminFieldSlug(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function adminInputType(type: string): string {
  const normalized = type.trim().toLowerCase();
  if (['checkbox', 'select', 'radio', 'textarea', 'email', 'tel', 'date', 'time', 'number', 'url'].includes(normalized)) return normalized;
  return 'text';
}

function adminInputOptions(raw: string, selected: string): Array<{ value: string; label: string; selected: boolean }> {
  return raw.split('|')
    .map((entry) => {
      const [value, label] = entry.split(':');
      const cleanValue = value?.trim() ?? '';
      return { value: cleanValue, label: (label ?? value ?? '').trim(), selected: cleanValue === selected };
    })
    .filter((option) => option.value || option.label);
}

function guestInput(
  form: FormData,
  eventId: number | null,
  listId: number,
  existing?: CmsPage,
): { name: string; lect: Record<string, unknown> } {
  const name = formText(form, 'name') || formLocalizedText(form, 'name');
  const fields = new Map<string, string>([
    ['last_name', formText(form, 'last_name') || formLocalizedText(form, 'last_name')],
    ['email', formText(form, 'email') || formText(form, '@email')],
    ['phone', formText(form, 'phone') || formText(form, '@phone')],
    ['organization', formText(form, 'organization') || formText(form, '@organization')],
    ['job_title', formText(form, 'job_title') || formText(form, '@job_title')],
    ['plus_guests', formText(form, 'plus_guests') || formText(form, '@plus_guests') || '0'],
    ['status', normalizeStatus(formText(form, 'status') || formText(form, '@status')) ?? 'to be invited'],
    ['prefer_language', formText(form, 'prefer_language') || formText(form, '@prefer_language')],
    ['cc', formText(form, 'cc') || formText(form, '@cc')],
    ['remarks', formText(form, 'remarks') || formText(form, '@remarks')],
  ]);
  const input = guestPageInput(name, fields, eventId, listId);
  return { name, lect: { ...(existing?.lect ?? {}), ...input.lect, ...nativeCustomGuestFields(form) } };
}

function guestPageInput(name: string, fields: Map<string, string>, eventId: number | null, listId: number): CmsPageInput {
  return {
    page_type: 'guest',
    page_id: listId,
    name,
    lect: {
      _type: 'guest',
      name: { en: name },
      last_name: { en: fields.get('last_name') ?? '' },
      email: fields.get('email') ?? '',
      phone: fields.get('phone') ?? '',
      organization: fields.get('organization') ?? '',
      job_title: fields.get('job_title') ?? '',
      plus_guests: fields.get('plus_guests') ?? '0',
      status: fields.get('status') ?? 'to be invited',
      prefer_language: fields.get('prefer_language') ?? '',
      cc: fields.get('cc') ?? '',
      remarks: fields.get('remarks') ?? '',
      _pointers: { ...(eventId ? { event: String(eventId) } : {}), mail_list: String(listId) },
    },
  };
}

/**
 * Builds a `checkin` lect entry from a legacy export's check-in columns, or
 * null when the row was never checked in. Treats a main (`checked-in`) or
 * session (`session-checked-in`) check-in as checked in and ignores blanks and
 * `undo-*` rows. Repeated check-ins are comma-joined in one cell, so it keeps
 * the first timestamp/message.
 */
function importedCheckin(status: string, date: string, message: string): Array<Record<string, string>> | null {
  const normalized = status.trim().toLowerCase();
  if (normalized !== 'checked-in' && normalized !== 'session-checked-in') return null;
  return [{
    status: 'checked-in',
    date: date.split(',')[0].trim(),
    message: message.split(',')[0].trim() || 'imported check-in',
  }];
}

function normalizeStatus(value: string | null): GuestStatus | null {
  const normalized = value?.trim().toLowerCase() ?? '';
  return (GUEST_STATUSES as readonly string[]).includes(normalized) ? normalized as GuestStatus : null;
}

function pageId(value: unknown): number | null {
  const id = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function parseLect(raw: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof raw !== 'string') return raw && typeof raw === 'object' ? raw : {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

// Excel exports large integers as ="N" to prevent scientific notation.
// parseCsv strips the outer quote delimiters, leaving "=N" in the cell value.
// This helper accepts plain integers, =N, or (if somehow preserved) ="N".
function parseImportId(raw: string): number | null {
  const s = raw.trim();
  const digits = /^="?(\d+)"?$/.exec(s)?.[1] ?? (/^\d+$/.test(s) ? s : null);
  if (!digits) return null;
  const n = Number(digits);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Excel forces text-like cells (phone numbers, long codes) through a ="..." formula
// so they aren't misread as numbers. parseCsv strips the outer CSV quotes, leaving
// the leading = (and any inner quotes). This strips that prefix from string fields.
function stripExcelFormula(raw: string): string {
  const s = raw.trim();
  if (!s.startsWith('=')) return s;
  // Remove leading =, then strip surrounding quotes if present: ="foo" → foo
  const inner = s.slice(1);
  return inner.startsWith('"') && inner.endsWith('"') ? inner.slice(1, -1) : inner;
}

function formText(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

function formLocalizedText(form: FormData, key: string): string {
  for (const [name, value] of form.entries()) {
    if (name.startsWith(`.${key}|`) && typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function nativeCustomGuestFields(form: FormData): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [name, value] of form.entries()) {
    if (typeof value !== 'string') continue;
    if (/^@rsvp_custom_\w+$/.test(name)) fields[name.slice(1)] = value.trim();
    if (name.startsWith('admin-rsvp-custom-')) {
      fields[`rsvp_custom_${adminFieldSlug(name.slice('admin-rsvp-custom-'.length))}`] = value.trim();
    }
  }
  return fields;
}

function safeAdminReturn(value: string): string {
  return value.startsWith('/admin') ? value : '';
}

function redirect(to: string): Response {
  return new Response(null, { status: 302, headers: { Location: to } });
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted && char === '"' && text[index + 1] === '"') {
      cell += '"';
      index++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === ',') {
      row.push(cell);
      cell = '';
    } else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[index + 1] === '\n') index++;
      row.push(cell);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function csvValue(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function safeFilename(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'guest-list';
}
