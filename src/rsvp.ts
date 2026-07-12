import {
  CmsClient,
  CmsApiError,
  CMS_BATCH_WEIGHT_ACTION,
  attr,
  blocks,
  chargeCreditAction,
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
import { chineseSearchVariants } from './chinese';
import { forbidden, type EventAdminAccess } from './permissions';
import { adminView } from './templates/views';
import { redirect } from '@lionrockjs/worker-cms-plugin';

const ADMIN_BASE = '/admin/plugins/events';

/** Guest lists display in admin-controlled order (page weight, then name). */
function sortByWeight(pages: CmsPage[]): CmsPage[] {
  return [...pages].sort(compareByWeightThenName);
}
const GUEST_STATUSES = ['to be invited', 'onhold', 'invited', 'confirmed', 'declined', 'unconfirmed'] as const;

type GuestStatus = typeof GUEST_STATUSES[number];

const COLOR_TAGS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'] as const;

/**
 * Guests per CMS `/pages/batch` call. The host creates each page through the
 * full versioned CMS pipeline, so this stays well under the CMS's hard max
 * (200) and falls back further if the host reports transient pressure. Each
 * batch call is one subrequest for this Worker, so bigger batches stretch the
 * per-invocation subrequest cap across more guests.
 */
const IMPORT_CREATE_BATCH = 25;

/**
 * Host write calls one import/confirm pass may spend before handing back a
 * self-resubmitting progress page. Cloudflare caps subrequests per Worker
 * invocation (50 free / 1000 paid); blowing the cap kills the request with an
 * unhandled "Too many subrequests" (Cloudflare error 1101), which used to
 * force users to retry large imports by hand. Kept under the free-plan cap,
 * leaving headroom for the context/classify reads around the writes.
 */
const IMPORT_PASS_WRITE_BUDGET = 40;

/** Guest value fields the import compares and can add/update on an existing guest. */
const IMPORT_FIELDS = [
  'last_name', 'email', 'phone', 'organization', 'job_title',
  'plus_guests', 'status', 'prefer_language', 'cc', 'remarks', 'paired_qrcode',
] as const;

const IMPORT_FIELD_LABELS: Record<string, string> = {
  last_name: 'Last name', email: 'Email', phone: 'Phone', organization: 'Organisation',
  job_title: 'Job title', plus_guests: 'Plus guests', status: 'Status',
  prefer_language: 'Language', cc: 'CC', remarks: 'Remarks', paired_qrcode: 'Paired badge QR code', checked_in: 'Check-in',
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
  legacyKey: string;
  name: string;
  inputName: string;
  id: string;
  label: string;
  type: string;
  templateName: string;
  placeholder: string;
  blankOption: boolean;
  blankLabel: string;
  required: boolean;
  value: string;
  defaultValue: string;
  options: Array<{ value: string; label: string; selected: boolean }>;
  checked: boolean;
  blockTitle: string;
  source: string;
}

interface GuestFormField {
  name: string;
  inputName: string;
  id: string;
  label: string;
  type: string;
  templateName: string;
  value: string;
  placeholder: string;
  blankOption: boolean;
  blankLabel: string;
  required: boolean;
  options: Array<{ value: string; label: string; selected: boolean }>;
  checked: boolean;
  defaultValue: string;
  span: string;
}

interface ActivityItem {
  kind: string;
  label: string;
  status: string;
  date: string;
  message: string;
}

/** Signing context for per-guest check-in QR codes. */
export interface QrOptions {
  secret?: string;
  publicBase?: string;
  /** Tenant ref appended (`?t=`) to minted check-in URLs so the shared
   *  check-in Worker verifies against the right tenant's key. */
  tenantRef?: string;
}

/** `?t=<ref>` suffix for minted public URLs (empty when single-tenant legacy). */
function tenantSuffix(qr: QrOptions): string {
  return qr.tenantRef ? `?t=${qr.tenantRef}` : '';
}

export async function handleRsvpAdmin(
  request: Request,
  cms: CmsClient,
  views: Fetcher,
  env: EdmEnv,
  segments: string[],
  url: URL,
  qr: QrOptions = {},
  jsonOnly = false,
  access?: EventAdminAccess,
): Promise<Response> {
  const canEdit = access?.canEdit ?? true;
  const canDelete = access?.canDelete ?? true;
  const canImportExport = access?.canImportExport ?? true;
  const canCheckIn = access?.canCheckIn ?? true;
  const canManageEmail = access?.canManageEmail ?? true;
  if (!segments.length) return rsvpIndex(cms, views, url, jsonOnly, access);

  if (segments[0] === 'new') {
    if (!canEdit) return forbidden();
    if (request.method === 'POST') return createGuestList(request, cms);
    return guestListForm(cms, views, url, jsonOnly);
  }

  const listId = pageId(segments[0]);
  if (!listId) return new Response('not found', { status: 404 });

  // Legacy event screens linked guest actions directly to an event id. Keep
  // those links working by routing them through that event's Adhoc list.
  const target = await cms.get(listId);
  if (target.page_type === 'event') {
    const adhocList = await ensureAdhocGuestList(cms, target.id);
    if (segments[1] === 'guests' && segments[2] === 'new' && request.method === 'POST') {
      if (!canCheckIn) return forbidden();
      return createGuest(request, cms, adhocList.id);
    }
    const rest = segments.slice(1).join('/');
    return redirect(`${ADMIN_BASE}/rsvp/${adhocList.id}${rest ? `/${rest}` : ''}`);
  }

  if (segments[1] === 'delete' && request.method === 'POST') {
    if (!canDelete) return forbidden();
    return deleteGuestList(cms, listId);
  }
  if (segments[1] === 'edm') {
    if (!canManageEmail) return forbidden();
    if (request.method === 'POST') return setListEdm(request, cms, listId);
    return redirect(`${ADMIN_BASE}/rsvp/${listId}`);
  }
  if (segments[1] === 'send-edm' && request.method === 'POST') {
    if (!canManageEmail) return forbidden();
    return autoSendEdm(request, cms, views, env, listId);
  }
  if (segments[1] === 'update-from-contacts' && request.method === 'POST') {
    if (!canEdit) return forbidden();
    return updateAllGuestsFromContacts(cms, listId);
  }
  if (segments[1] === 'contacts') {
    if (!canEdit) return forbidden();
    if (segments[2] === 'add' && request.method === 'POST') return addContactsToList(request, cms, listId);
    if (segments[2] === 'remove' && request.method === 'POST') return removeContactsFromList(request, cms, listId);
    return listContactsBrowser(cms, views, listId, url, jsonOnly);
  }
  if (segments[1] === 'export') {
    if (!canImportExport) return forbidden();
    return exportGuests(cms, listId);
  }
  if (segments[1] === 'dedupe') {
    if (!canDelete) return forbidden();
    if (request.method === 'POST') return applyGuestDedupe(cms, listId);
    return previewGuestDedupe(cms, views, listId, jsonOnly);
  }
  if (segments[1] === 'import') {
    if (!canImportExport) return forbidden();
    if (segments[2] === 'confirm' && request.method === 'POST') return confirmImportGuests(request, cms, views, listId, jsonOnly);
    if (request.method === 'POST') return previewImportGuests(request, cms, views, listId, jsonOnly);
    return guestImport(cms, views, listId, jsonOnly);
  }

  if (segments[1] === 'guests' && segments[2] === 'new') {
    if (!canEdit) return forbidden();
    if (request.method === 'POST') return createGuest(request, cms, listId);
    return guestForm(cms, views, listId, undefined, jsonOnly);
  }

  if (segments[1] === 'guests') {
    const guestId = pageId(segments[2]);
    if (!guestId) return new Response('not found', { status: 404 });
    if (segments[3] === 'delete' && request.method === 'POST') {
      if (!canDelete) return forbidden();
      return deleteGuest(cms, listId, guestId);
    }
    if (segments[3] === 'status' && request.method === 'POST') {
      if (!canEdit) return forbidden();
      return updateGuestStatus(request, cms, listId, guestId);
    }
    if (segments[3] === 'color' && request.method === 'POST') {
      if (!canEdit) return forbidden();
      return updateGuestColor(request, cms, listId, guestId);
    }
    if (segments[3] === 'checkin' && request.method === 'POST') {
      if (!canCheckIn) return forbidden();
      return checkInGuest(request, cms, listId, guestId);
    }
    if (segments[3] === 'pair-qrcode' && request.method === 'POST') {
      if (!canCheckIn) return forbidden();
      return pairGuestQrCode(request, cms, listId, guestId);
    }
    if (segments[3] === 'move' && request.method === 'POST') {
      if (!canEdit) return forbidden();
      return moveGuest(request, cms, listId, guestId);
    }
    if (segments[3] === 'update-from-contact' && request.method === 'POST') {
      if (!canEdit) return forbidden();
      return updateGuestFromContact(cms, listId, guestId);
    }
    if (segments[3] === 'send' && request.method === 'POST') {
      if (!canManageEmail) return forbidden();
      return sendGuestEdm(request, cms, views, env, listId, guestId);
    }
    if (segments[3] === 'preview') {
      if (!canManageEmail) return forbidden();
      return previewGuestEdm(cms, views, env, listId, guestId);
    }
    if (segments[3] === 'qrcode') {
      if (!canCheckIn) return forbidden();
      return guestQr(cms, views, listId, guestId, qr, jsonOnly, access);
    }
    return new Response('not found', { status: 404 });
  }

  if (segments[1] === 'reorder-guests' && request.method === 'POST') {
    if (!canEdit) return forbidden();
    return reorderGuests(request, cms, listId);
  }

  return guestList(cms, views, listId, url, jsonOnly, access);
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
export async function eventGuestLists(cms: CmsClient, views: Fetcher, eventId: number, jsonOnly = false, access?: EventAdminAccess): Promise<Response> {
  const canEdit = access?.canEdit ?? true;
  const event = await cms.get(eventId);
  if (event.page_type !== 'event') return new Response('not found', { status: 404 });
  const pages = await listByEvent(cms, 'mail_list', eventId);
  if (!pages.some(isAdhocList)) pages.push(await createAdhocGuestList(cms, eventId));
  return adminView(views, `Guest lists — ${event.name}`, 'guest-lists', {
    title: `Guest lists — ${event.name}`,
    subtitle: 'Drag a list to reorder it; the order is shared across the event.',
    backHref: `${ADMIN_BASE}/events/${eventId}`,
    newHref: canEdit ? `${ADMIN_BASE}/rsvp/new?event_id=${eventId}` : '',
    reorderAction: canEdit ? CMS_BATCH_WEIGHT_ACTION : '',
    reorderEventId: eventId,
    lists: sortByWeight(pages).map((list) => ({ ...guestListRow(list, event, access), id: list.id })),
  }, jsonOnly);
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

async function rsvpIndex(cms: CmsClient, views: Fetcher, url: URL, jsonOnly = false, access?: EventAdminAccess): Promise<Response> {
  const eventFilter = pageId(url.searchParams.get('event'));
  if (eventFilter) return eventGuestLists(cms, views, eventFilter, jsonOnly, access);
  const canEdit = access?.canEdit ?? true;

  const [{ pages: events }, { pages: lists }] = await Promise.all([
    cms.list('event', { limit: 500 }),
    cms.list('mail_list', { limit: 500 }),
  ]);
  const eventById = new Map(events.map((event) => [event.id, event]));

  return adminView(views, 'RSVP guest lists', 'guest-lists', {
    title: 'RSVP guest lists',
    subtitle: 'Each list has its own guests, import/export tools and RSVP delivery state.',
    newHref: canEdit ? `${ADMIN_BASE}/rsvp/new` : '',
    lists: lists.map((list) => guestListRow(list, eventById.get(pageId(pointer(list.lect, 'event')) ?? 0), access)),
  }, jsonOnly);
}

async function guestListForm(cms: CmsClient, views: Fetcher, url: URL, jsonOnly = false): Promise<Response> {
  const { pages } = await cms.list('event', { limit: 500 });
  const selectedEventId = pageId(url.searchParams.get('event_id'));
  const listedEvent = selectedEventId ? pages.find((event) => event.id === selectedEventId) : undefined;
  const fetchedEvent = selectedEventId && !listedEvent
    ? await cms.get(selectedEventId).catch(() => null)
    : null;
  const selectedEvent = listedEvent ?? (fetchedEvent?.page_type === 'event' ? fetchedEvent : null);
  const title = selectedEvent ? `New guest list — ${selectedEvent.name}` : 'New guest list';
  return adminView(views, title, 'guest-list-form', {
    title,
    action: selectedEventId ? `${ADMIN_BASE}/rsvp/new?event_id=${selectedEventId}` : `${ADMIN_BASE}/rsvp/new`,
    backHref: selectedEventId ? `${ADMIN_BASE}/events/${selectedEventId}` : `${ADMIN_BASE}/rsvp`,
    selectedEventId,
    selectedEventName: selectedEvent?.name ?? '',
    events: selectedEvent ? [] : pages.map((event) => ({ id: event.id, name: event.name, selected: false })),
  }, jsonOnly);
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
  const list = await cms.create({
    page_type: 'mail_list',
    name,
    lect: {
      _type: 'mail_list',
      name: { en: name },
      _pointers: { event: String(eventId) },
      allow_checkin: 'yes',
    },
  });
  return redirect(`${ADMIN_BASE}/rsvp/${list.id}`);
}

async function guestList(cms: CmsClient, views: Fetcher, listId: number, url: URL, jsonOnly = false, access?: EventAdminAccess): Promise<Response> {
  const canEdit = access?.canEdit ?? true;
  const canDelete = access?.canDelete ?? true;
  const canImportExport = access?.canImportExport ?? true;
  const canManageEmail = access?.canManageEmail ?? true;
  const context = await guestListContext(cms, listId);
  if (!context) return new Response('not found', { status: 404 });

  const q = url.searchParams.get('q')?.trim() ?? '';
  const selectedStatus = normalizeStatus(url.searchParams.get('status'));
  const selectedColor = normalizeColor(url.searchParams.get('color'));
  const pages = await cms.listAll('guest', { pointer: { key: 'mail_list', value: listId }, q });
  const filteredGuests = filterGuests(pages, '', selectedStatus ?? undefined, selectedColor);
  const noFilter = !q && !selectedStatus && !selectedColor;
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
  const customFields = adminCustomFieldsForGuest(context.event, context.list);
  const selectedCustomFieldParam = url.searchParams.get('cf')?.trim() ?? '';
  const selectedCustomField = customFields.find((field) => field.key === selectedCustomFieldParam || field.legacyKey === selectedCustomFieldParam) ?? null;

  return adminView(views, `${context.list.name} — RSVP`, 'guest-list', {
    eventName: context.event?.name ?? 'Event',
    eventHref: context.event ? `${ADMIN_BASE}/events/${context.event.id}` : `${ADMIN_BASE}/rsvp`,
    listName: context.list.name,
    listHref: `${ADMIN_BASE}/rsvp/${listId}`,
    listsHref: context.event ? `${ADMIN_BASE}/events/${context.event.id}` : `${ADMIN_BASE}/rsvp`,
    canEdit,
    canDelete,
    canImportExport,
    canManageEmail,
    newGuestHref: canEdit ? `${ADMIN_BASE}/rsvp/${listId}/guests/new` : '',
    editHref: canEdit ? `/admin/pages/${listId}/edit?return_to=${encodeURIComponent(`${ADMIN_BASE}/rsvp/${listId}`)}` : '',
    importHref: canImportExport ? `${ADMIN_BASE}/rsvp/${listId}/import` : '',
    exportHref: canImportExport ? `${ADMIN_BASE}/rsvp/${listId}/export` : '',
    dedupeHref: canDelete ? `${ADMIN_BASE}/rsvp/${listId}/dedupe` : '',
    contactsHref: canEdit ? `${ADMIN_BASE}/rsvp/${listId}/contacts` : '',
    updateFromContactsAction: canEdit ? `${ADMIN_BASE}/rsvp/${listId}/update-from-contacts` : '',
    deleteAction: canDelete && !isAdhocList(context.list) ? `${ADMIN_BASE}/rsvp/${listId}/delete` : '',
    flash: url.searchParams.get('flash') ?? '',
    // EDM controls.
    setEdmAction: canManageEmail ? `${ADMIN_BASE}/rsvp/${listId}/edm` : '',
    edmOptions: canManageEmail ? eventEdms.map((edm) => ({ id: edm.id, name: edm.name, selected: edm.id === selectedEdmId })) : [],
    hasEdmOptions: canManageEmail && eventEdms.length > 0,
    hasEdm: canManageEmail && hasEdm,
    edmName: hasEdm ? selectedEdm!.name : '',
    edmEditHref: hasEdm ? `/admin/pages/${selectedEdm!.id}/edit?return_to=${encodeURIComponent(`${ADMIN_BASE}/rsvp/${listId}`)}` : '',
    autoSendGoodAction: canManageEmail ? `${ADMIN_BASE}/rsvp/${listId}/send-edm?quality=good` : '',
    autoSendRiskyAction: canManageEmail ? `${ADMIN_BASE}/rsvp/${listId}/send-edm?quality=risky` : '',
    reorderAction: canEdit && noFilter ? CMS_BATCH_WEIGHT_ACTION : '',
    q,
    selectedStatus: selectedStatus ?? '',
    selectedColor,
    colorOptions: colorTagOptions(selectedColor),
    statuses: GUEST_STATUSES,
    customFieldOptions: customFields.map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      selected: selectedCustomField?.key === field.key,
    })),
    hasCustomFields: customFields.length > 0,
    selectedCustomFieldKey: selectedCustomField?.key ?? '',
    total: noFilter ? pages.length : filteredGuests.length,
    guests: guests.map((guest) => guestRow(guest, listId, canManageEmail && hasEdm ? selectedEdm!.id : null, selectedCustomField, '', q, access)),
  }, jsonOnly);
}

async function guestForm(cms: CmsClient, views: Fetcher, listId: number, guestId?: number, jsonOnly = false): Promise<Response> {
  const context = await guestListContext(cms, listId);
  if (!context) return new Response('not found', { status: 404 });

  const guest = guestId ? await cms.get(guestId) : undefined;
  if (guest && (guest.page_type !== 'guest' || pointer(guest.lect, 'mail_list') !== String(listId))) return new Response('not found', { status: 404 });
  return guestFormView(cms, views, context, listId, guest, { jsonOnly });
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
    jsonOnly?: boolean;
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
  const activity = guest ? await guestActivity(cms, guest) : [];

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
    detailFields: guestDetailFields(values, options.language ?? 'mis'),
    contactFields: guestContactFields(values),
    rsvpFields: guestRsvpFields(values),
    noteFields: guestNoteFields(values),
    ticketFields: guestTicketFields(values),
    adminCustomFields,
    hasAdminCustomFields: adminCustomFields.length > 0,
    activity,
    hasActivity: activity.length > 0,
    deleteAction: guest ? `${ADMIN_BASE}/rsvp/${listId}/guests/${guest.id}/delete` : '',
    qrHref: guest ? `${ADMIN_BASE}/rsvp/${listId}/guests/${guest.id}/qrcode` : '',
    updateFromContactAction: guest && guestContactId(guest)
      ? `${ADMIN_BASE}/rsvp/${listId}/guests/${guest.id}/update-from-contact`
      : '',
    moveAction: guest ? `${ADMIN_BASE}/rsvp/${listId}/guests/${guest.id}/move` : '',
    moveLists,
  }, options.jsonOnly ?? false);
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
  await chargeCreditAction(cms, 'delete_guest', 1, { entityType: 'guest', entityId: guestId });
  await cms.remove(guestId);
  return redirect(`${ADMIN_BASE}/rsvp/${listId}`);
}

async function deleteGuestList(cms: CmsClient, listId: number): Promise<Response> {
  const context = await guestListContext(cms, listId);
  if (!context) return new Response('not found', { status: 404 });
  if (isAdhocList(context.list)) return new Response('cannot delete the default Adhoc list', { status: 403 });

  // Count for the audit note without reading any rows (total rides along).
  const { total } = await cms.list('guest', { pointer: { key: 'mail_list', value: listId }, limit: 1 });
  await chargeCreditAction(cms, 'delete_guest_list', 1, {
    entityType: 'mail_list',
    entityId: listId,
    note: `${total} guests`,
  });

  // Trash guests BEFORE the list. The schema has ON DELETE CASCADE on page_id,
  // so removing the list row would instantly wipe all guest rows — nothing left
  // to copy into trash_pages. Trashing guests first removes them from draft_pages
  // cleanly, then trashing the list has no children left to cascade-delete.
  //
  // Server-side children delete (same path the event delete uses): the host
  // trashes bounded slices per call with no per-page unpublish fanout, so a
  // thousands-strong list tears down in a few cheap calls — the old per-100
  // batchRemove made the host unpublish each guest and hung on big lists.
  await cms.deleteChildren({ pointerKey: 'mail_list', pointerValue: String(listId) }, 'guest');
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
  const sent = Array.isArray(guest.lect.sent_edm) ? [...guest.lect.sent_edm] : [];
  if (guestWasSentEdm(guest, edmId)) return;
  sent.push(String(edmId));
  await cms.update(guest.id, { lect: { ...guest.lect, sent_edm: sent } });
}

function listFlash(listId: number, message: string, returnTo = ''): Response {
  const target = safeAdminReturn(returnTo) || `${ADMIN_BASE}/rsvp/${listId}`;
  const separator = target.includes('?') ? '&' : '?';
  return redirect(`${target}${separator}flash=${encodeURIComponent(message)}`);
}

/** Links (or clears) the guest list's EDM from the dropdown. */
async function setListEdm(request: Request, cms: CmsClient, listId: number): Promise<Response> {
  const list = await cms.get(listId);
  if (list.page_type !== 'mail_list') return new Response('not found', { status: 404 });
  const form = await request.formData();
  const edmId = pageId(form.get('edm_id'));
  const pointers = lectPointers(list);
  if (edmId) pointers.edm = String(edmId);
  else pointers.edm = '';
  await chargeCreditAction(cms, 'assign_edm_to_guest_list', 1, {
    entityType: 'mail_list',
    entityId: listId,
    note: edmId ? `Assign EDM ${edmId}` : 'Clear EDM assignment',
  });
  await cms.update(listId, { lect: { ...list.lect, _pointers: pointers } });
  return redirect(`${ADMIN_BASE}/rsvp/${listId}`);
}

/** Sends one guest the list's EDM (per-guest "Send" / "Re-send" button). */
async function sendGuestEdm(request: Request, cms: CmsClient, views: Fetcher, env: EdmEnv, listId: number, guestId: number): Promise<Response> {
  const form = await request.formData().catch(() => new FormData());
  const returnTo = formText(form, 'return_to');
  const context = await guestListContext(cms, listId);
  if (!context) return new Response('not found', { status: 404 });
  const edm = await resolveListEdm(cms, context.list);
  if (!edm) return listFlash(listId, 'Select an EDM for this list first', returnTo);
  const guest = await cms.get(guestId);
  if (guest.page_type !== 'guest' || pointer(guest.lect, 'mail_list') !== String(listId)) return new Response('not found', { status: 404 });
  await chargeCreditAction(cms, 'send_edm', 1, {
    entityType: 'guest',
    entityId: guestId,
    note: `Send EDM ${edm.id}`,
  });
  try {
    await sendEdmToGuest(views, env, edm, context.eventId, listId, guest);
    await recordSentEdm(cms, guest, edm.id);
  } catch (error) {
    return listFlash(listId, error instanceof Error ? error.message : 'Unable to send email', returnTo);
  }
  return listFlash(listId, `Email sent to ${attr(guest.lect, 'email')}`, returnTo);
}

/** Batch-sends the list's EDM to every guest of a given email quality that hasn't
 *  been sent yet and isn't paused. Backs the "Auto Send (Good/Risky)" buttons. */
async function autoSendEdm(request: Request, cms: CmsClient, views: Fetcher, env: EdmEnv, listId: number): Promise<Response> {
  const context = await guestListContext(cms, listId);
  if (!context) return new Response('not found', { status: 404 });
  const edm = await resolveListEdm(cms, context.list);
  if (!edm) return listFlash(listId, 'Select an EDM for this list first');

  const quality = new URL(request.url).searchParams.get('quality') === 'risky' ? 'risky' : 'good';
  const guests = await cms.listAll('guest', { pointer: { key: 'mail_list', value: listId } });
  const candidates = guests.filter((guest) => {
    const paused = truthyAttr(guest.lect, 'not_send');
    const matches = emailQuality(attr(guest.lect, 'email')) === quality;
    return !paused && matches && !guestWasSentEdm(guest, edm.id);
  });

  await chargeCreditAction(cms, 'send_edm', candidates.length, {
    entityType: 'mail_list',
    entityId: listId,
    note: `Auto-send ${quality} EDM ${edm.id}`,
  });

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const guest of guests) {
    const paused = truthyAttr(guest.lect, 'not_send');
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
  const returnTo = safeAdminReturn(formText(form, 'return_to')) || `${ADMIN_BASE}/rsvp/${listId}`;
  const status = normalizeStatus(formText(form, 'status'));
  if (!status) return redirect(returnTo);

  await chargeCreditAction(cms, 'update_guest_status', 1, {
    entityType: 'guest',
    entityId: guestId,
    note: status,
  });
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
  return redirect(returnTo);
}

async function updateGuestColor(request: Request, cms: CmsClient, listId: number, guestId: number): Promise<Response> {
  const guest = await cms.get(guestId);
  if (guest.page_type !== 'guest' || pointer(guest.lect, 'mail_list') !== String(listId)) return new Response('not found', { status: 404 });
  const form = await request.formData();
  const returnTo = safeAdminReturn(formText(form, 'return_to')) || `${ADMIN_BASE}/rsvp/${listId}`;
  const color = normalizeAssignableColor(formText(form, 'color'));

  if (color === null) {
    return wantsJsonResponse(request)
      ? Response.json({ status: 'error', action: 'assign_color', error: 'invalid color' }, { status: 400 })
      : redirect(returnTo);
  }

  await chargeCreditAction(cms, 'assign_guest_color', 1, {
    entityType: 'guest',
    entityId: guestId,
    note: color || 'clear',
  });
  await cms.update(guestId, { lect: { color_tag: color } });
  if (wantsJsonResponse(request)) {
    return Response.json({ status: 'success', action: 'assign_color', payload: { id: guestId, color } });
  }
  return redirect(returnTo);
}

async function checkInGuest(request: Request, cms: CmsClient, listId: number, guestId: number): Promise<Response> {
  const guest = await cms.get(guestId);
  if (guest.page_type !== 'guest' || pointer(guest.lect, 'mail_list') !== String(listId)) return new Response('not found', { status: 404 });
  const form = await request.formData();
  const returnTo = safeAdminReturn(formText(form, 'return_to')) || `${ADMIN_BASE}/rsvp/${listId}`;
  if (checkins(guest.lect).length) return redirect(returnTo);
  await chargeCreditAction(cms, 'check_in_guest', 1, { entityType: 'guest', entityId: guestId });
  await ensureGuestCheckedIn(cms, guest, 'checked in by event admin');
  return redirect(returnTo);
}

async function ensureGuestCheckedIn(cms: CmsClient, guest: CmsPage, message: string): Promise<void> {
  if (checkins(guest.lect).length) return;
  await cms.update(guest.id, {
    lect: {
      checkin: [{ status: 'checked-in', date: new Date().toISOString(), message }],
    },
  });
}

async function pairGuestQrCode(request: Request, cms: CmsClient, listId: number, guestId: number): Promise<Response> {
  const guest = await cms.get(guestId);
  if (guest.page_type !== 'guest' || pointer(guest.lect, 'mail_list') !== String(listId)) return new Response('not found', { status: 404 });
  const form = await request.formData();
  const returnTo = safeAdminReturn(formText(form, 'return_to')) || `${ADMIN_BASE}/rsvp/${listId}/guests/${guestId}/qrcode`;
  const pairedQrCode = firstFormText(form, ['paired_qrcode', 'paired_qr_code', 'badge_qrcode', 'badge_qr_code', 'qrcode', 'code']);
  if (!pairedQrCode) return redirect(returnTo);

  await chargeCreditAction(cms, 'pair_guest_qrcode', 1, {
    entityType: 'guest',
    entityId: guestId,
    note: pairedQrCode,
  });
  const lect: Record<string, unknown> = { paired_qrcode: pairedQrCode };
  if (!checkins(guest.lect).length) {
    lect.checkin = [{ status: 'checked-in', date: new Date().toISOString(), message: 'checked in by badge QR pairing' }];
  }
  await cms.update(guestId, { lect });
  return redirect(returnTo);
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

  await chargeCreditAction(cms, 'move_guest', 1, {
    entityType: 'guest',
    entityId: guestId,
    note: `Move to list ${targetId}`,
  });
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
export function contactToGuestFields(contact: CmsPage): ContactFields {
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
 * Re-pulls a single guest's details from its linked contact page and logs the
 * refresh to the RSVP response history. No-op (returns false) when the guest has
 * no contact link or the contact can't be read.
 */
async function applyContactToGuest(cms: CmsClient, guest: CmsPage): Promise<boolean> {
  const contactId = pageId(guestContactId(guest));
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

// ── Add / remove guests from the contact database (legacy add/remove-contacts) ─

/**
 * Contact browser for a guest list: search the contact pages (readTypes grants
 * the events plugin read access to `contact`), showing which contacts are
 * already on the list — matched by the guest's `contact` pointer, falling back
 * to email — with add/remove bulk actions.
 */
async function listContactsBrowser(
  cms: CmsClient,
  views: Fetcher,
  listId: number,
  url: URL,
  jsonOnly = false,
): Promise<Response> {
  const context = await guestListContext(cms, listId);
  if (!context) return new Response('not found', { status: 404 });
  const q = (url.searchParams.get('q') ?? '').trim();
  const [{ pages: contacts }, membership] = await Promise.all([
    cms.list('contact', { q: q || undefined, limit: 100 }),
    listMembership(cms, listId),
  ]);

  return adminView(views, `Contacts — ${context.list.name}`, 'guest-list-contacts', {
    listName: context.list.name,
    listHref: `${ADMIN_BASE}/rsvp/${listId}`,
    eventName: context.event?.name ?? '',
    q,
    flash: url.searchParams.get('flash') ?? '',
    searchAction: `${ADMIN_BASE}/rsvp/${listId}/contacts`,
    addAction: `${ADMIN_BASE}/rsvp/${listId}/contacts/add`,
    removeAction: `${ADMIN_BASE}/rsvp/${listId}/contacts/remove`,
    rows: contacts.map((contact) => {
      const fields = contactToGuestFields(contact);
      const inList = membership.contactIds.has(String(contact.id))
        || (fields.email !== '' && membership.emails.has(fields.email.toLowerCase()));
      return {
        id: contact.id,
        name: fields.name || contact.name,
        email: fields.email,
        organization: fields.organization,
        title: fields.job_title,
        inList,
      };
    }),
    hasRows: contacts.length > 0,
  }, jsonOnly);
}

/** Contacts already represented on a list: linked contact ids + guest emails. */
async function listMembership(cms: CmsClient, listId: number): Promise<{ contactIds: Set<string>; emails: Set<string> }> {
  const guests = await cms.listAll('guest', { pointer: { key: 'mail_list', value: listId } });
  const contactIds = new Set<string>();
  const emails = new Set<string>();
  for (const guest of guests) {
    const contactId = guestContactId(guest);
    if (contactId) contactIds.add(contactId);
    const email = attr(guest.lect, 'email').trim().toLowerCase();
    if (email) emails.add(email);
  }
  return { contactIds, emails };
}

/** POST: create a guest (canonical lect shape, linked via the `contact` pointer)
 *  for each selected contact not already on the list. */
async function addContactsToList(request: Request, cms: CmsClient, listId: number): Promise<Response> {
  const context = await guestListContext(cms, listId);
  if (!context) return new Response('not found', { status: 404 });
  const form = await request.formData();
  const q = formText(form, 'q');
  const ids = form.getAll('contact_ids').map((value) => pageId(value)).filter((id): id is number => id !== null).slice(0, 200);
  const membership = await listMembership(cms, listId);

  const creates: CmsPageInput[] = [];
  let skipped = 0;
  for (const contactId of ids) {
    if (membership.contactIds.has(String(contactId))) {
      skipped += 1;
      continue;
    }
    let contact: CmsPage;
    try {
      contact = await cms.get(contactId);
    } catch (error) {
      if (error instanceof CmsApiError && (error.status === 404 || error.status === 403)) continue;
      throw error;
    }
    if (contact.page_type !== 'contact') continue;
    const contactFields = contactToGuestFields(contact);
    if (contactFields.email && membership.emails.has(contactFields.email.toLowerCase())) {
      skipped += 1;
      continue;
    }
    const fields = new Map<string, string>([
      ['contact', String(contact.id)],
      ['email', contactFields.email],
      ['phone', contactFields.phone],
      ['cc', contactFields.cc],
      ['organization', contactFields.organization],
      ['job_title', contactFields.job_title],
      ['prefix', contactFields.prefix],
      ['nationality', contactFields.nationality],
      ['prefer_language', contactFields.prefer_language],
      ['status', 'to be invited'],
      ['plus_guests', '0'],
    ]);
    creates.push(guestPageInput(contactFields.name || contact.name, fields, context.eventId, listId));
  }

  // Same chunking as the CSV import: keep each CMS batch light on subrequests.
  for (const chunk of chunks(creates, IMPORT_CREATE_BATCH)) await cms.batchCreate(chunk);

  const detail = `Added ${creates.length} guest(s)${skipped ? `, ${skipped} already on the list` : ''}`;
  return redirect(`${ADMIN_BASE}/rsvp/${listId}/contacts?q=${encodeURIComponent(q)}&flash=${encodeURIComponent(detail)}`);
}

/** POST: remove the guests linked (by `contact` pointer) to the selected contacts. */
async function removeContactsFromList(request: Request, cms: CmsClient, listId: number): Promise<Response> {
  const context = await guestListContext(cms, listId);
  if (!context) return new Response('not found', { status: 404 });
  const form = await request.formData();
  const q = formText(form, 'q');
  const ids = new Set(form.getAll('contact_ids').map((value) => String(value)));
  const guests = await cms.listAll('guest', { pointer: { key: 'mail_list', value: listId } });
  const removable = guests.filter((guest) => {
    const contactId = guestContactId(guest);
    return contactId && ids.has(contactId);
  });

  await chargeCreditAction(cms, 'remove_contact_guests', removable.length, {
    entityType: 'mail_list',
    entityId: listId,
  });
  let removed = 0;
  for (const guest of removable) {
    await cms.remove(guest.id);
    removed += 1;
  }
  const detail = `Removed ${removed} guest(s)`;
  return redirect(`${ADMIN_BASE}/rsvp/${listId}/contacts?q=${encodeURIComponent(q)}&flash=${encodeURIComponent(detail)}`);
}

/** POST handler: refresh one guest from its linked contact. */
async function updateGuestFromContact(cms: CmsClient, listId: number, guestId: number): Promise<Response> {
  const guest = await cms.get(guestId);
  if (guest.page_type !== 'guest' || pointer(guest.lect, 'mail_list') !== String(listId)) return new Response('not found', { status: 404 });
  await chargeCreditAction(cms, 'sync_guest_from_contact', 1, { entityType: 'guest', entityId: guestId });
  await applyContactToGuest(cms, guest);
  return redirect(guestEditHref(guestId, listId));
}

/** POST handler: refresh every linked guest in a list from its contact. */
async function updateAllGuestsFromContacts(cms: CmsClient, listId: number): Promise<Response> {
  const context = await guestListContext(cms, listId);
  if (!context) return new Response('not found', { status: 404 });
  const pages = await cms.listAll('guest', { pointer: { key: 'mail_list', value: listId } });
  const linkedGuests = pages.filter((guest) => guestContactId(guest));
  await chargeCreditAction(cms, 'sync_guest_from_contact', linkedGuests.length, {
    entityType: 'mail_list',
    entityId: listId,
    note: 'Bulk contact refresh',
  });
  for (const guest of linkedGuests) await applyContactToGuest(cms, guest);
  return redirect(`${ADMIN_BASE}/rsvp/${listId}`);
}

/**
 * Renders a guest's check-in QR. The code carries a PLUGIN_SECRET-signed
 * `listId.guestId.sig` token (as a check-in URL when a public base is set), so a
 * door scanner can identify the guest without trusting the unsigned payload.
 */
async function guestQr(cms: CmsClient, views: Fetcher, listId: number, guestId: number, qr: QrOptions, jsonOnly = false, access?: EventAdminAccess): Promise<Response> {
  const context = await guestListContext(cms, listId);
  const guest = await cms.get(guestId);
  if (!context || guest.page_type !== 'guest' || pointer(guest.lect, 'mail_list') !== String(listId)) return new Response('not found', { status: 404 });

  const token = `${listId}.${guestId}`;
  const sig = qr.secret ? await signPayload(qr.secret, token) : '';
  const payload = qr.publicBase && sig
    ? `${qr.publicBase.replace(/\/+$/, '')}/checkin/${listId}/${guestId}/${sig}${tenantSuffix(qr)}`
    : `${token}.${sig}`;
  const values = guestValues(guest);
  const plusGuestQrs = await plusGuestQrCodes(listId, guestId, values.plus_guests, qr);

  return adminView(views, `QR — ${values.name}`, 'guest-qr', {
    guestName: values.name,
    organization: values.organization,
    listName: context.list.name,
    listHref: `${ADMIN_BASE}/rsvp/${listId}`,
    editHref: access?.canEdit === false ? '' : guestEditHref(guestId, listId),
    checkedIn: checkins(guest.lect).length > 0,
    pairedQrCode: values.paired_qrcode,
    pairAction: access?.canCheckIn === false ? '' : `${ADMIN_BASE}/rsvp/${listId}/guests/${guestId}/pair-qrcode`,
    payload,
    qrSvg: qrSvg(payload, { size: 240 }),
    plusGuestQrs,
    hasPlusGuestQrs: plusGuestQrs.length > 0,
  }, jsonOnly);
}

async function plusGuestQrCodes(
  listId: number,
  guestId: number,
  rawCount: string,
  qr: QrOptions,
): Promise<Array<{ label: string; payload: string; qrSvg: string }>> {
  const count = Math.max(0, Number.parseInt(rawCount, 10) || 0);
  const rows: Array<{ label: string; payload: string; qrSvg: string }> = [];
  for (let index = 0; index < count; index += 1) {
    const token = `${listId}.${guestId}.${index}`;
    const sig = qr.secret ? await signPayload(qr.secret, token) : '';
    const payload = qr.publicBase && sig
      ? `${qr.publicBase.replace(/\/+$/, '')}/checkin/${listId}/${guestId}/${index}/${sig}${tenantSuffix(qr)}`
      : `${token}.${sig}`;
    rows.push({
      label: `Plus guest ${index + 1}`,
      payload,
      qrSvg: qrSvg(payload, { size: 180 }),
    });
  }
  return rows;
}

/**
 * Reorders an event's guest lists by writing each list's `weight`. Accepts the
 * legacy JSON shape `{ reorder: [{ id, weight }] }` so the drag-and-drop UI can
 * persist a new order in one call.
 */
export async function reorderGuestLists(request: Request, cms: CmsClient, eventId: number): Promise<Response> {
  const body = await request.json().catch(() => null) as { reorder?: Array<{ id?: unknown; weight?: unknown }> } | null;
  if (!body || !Array.isArray(body.reorder)) return Response.json({ success: false, error: 'invalid_request' }, { status: 400 });

  await chargeCreditAction(cms, 'reorder_event_guest_lists', 1, { entityType: 'event', entityId: eventId });
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

  await chargeCreditAction(cms, 'reorder_guest_list_guests', 1, { entityType: 'mail_list', entityId: listId });
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
  await chargeCreditAction(cms, 'reorder_event_sessions', 1, { entityType: 'event', entityId: eventId });
  await cms.update(eventId, { lect: { session: patch } });
  return Response.json({ success: true });
}

function sessionWeight(session: Record<string, unknown>, index: number): number {
  const w = Number(session._weight);
  return Number.isFinite(w) ? w : index;
}

/** Lists an event's sessions in admin-defined order, with drag-to-reorder. */
export async function eventSessions(cms: CmsClient, views: Fetcher, eventId: number, jsonOnly = false): Promise<Response> {
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
  }, jsonOnly);
}

/**
 * Flat view of every guest across all of an event's lists, with a status
 * filter — the cross-list roll-call the legacy `all_guests` screen provided.
 */
export async function flatAllGuests(cms: CmsClient, views: Fetcher, eventId: number, url: URL, jsonOnly = false, access?: EventAdminAccess): Promise<Response> {
  const canImportExport = access?.canImportExport ?? true;
  const event = await cms.get(eventId);
  if (event.page_type !== 'event') return new Response('not found', { status: 404 });

  const selectedStatus = normalizeStatus(url.searchParams.get('status'));
  const q = url.searchParams.get('q')?.trim() ?? '';
  const selectedColor = normalizeColor(url.searchParams.get('color'));
  const lists = await listByEvent(cms, 'mail_list', eventId);
  const ordered = sortByWeight(lists);
  const guestsByList = await Promise.all(
    ordered.map((list) => cms.listAll('guest', { pointer: { key: 'mail_list', value: list.id }, q })),
  );

  const colorOptions = colorTagOptions(selectedColor);
  const customFields = uniqueAdminCustomFields(ordered.flatMap((list) => adminCustomFieldsForGuest(event, list)));
  const selectedCustomFieldParam = url.searchParams.get('cf')?.trim() ?? '';
  const selectedCustomField = customFields.find((field) => field.key === selectedCustomFieldParam || field.legacyKey === selectedCustomFieldParam) ?? null;
  const returnTo = `${ADMIN_BASE}/events/${eventId}/all-guests${url.search}`;
  const rows: Array<Record<string, unknown>> = [];
  ordered.forEach((list, index) => {
    for (const guest of guestsByList[index] ?? []) {
      if (!guestMatchesFilters(guest, '', selectedStatus ?? undefined, selectedColor)) continue;
      rows.push({
        // No EDM id here: email sending lives on the per-list guest list, not this cross-list view.
        ...guestRow(guest, list.id, null, selectedCustomField, returnTo, q, access),
        listName: list.name,
        editHref: access?.canEdit === false ? '' : guestEditHref(guest.id, list.id, returnTo),
        // No check-in action here either: checking guests in happens on the per-list guest list (status still shows).
        checkinAction: '',
      });
    }
  });
  const totalCount = guestsByList.reduce((sum, guests) => sum + guests.length, 0);

  return adminView(views, `All guests — ${event.name}`, 'all-guests', {
    eventName: event.name,
    backHref: `${ADMIN_BASE}/events/${eventId}`,
    canImportExport,
    exportHref: canImportExport ? `${ADMIN_BASE}/events/${eventId}/export` : '',
    listHref: `${ADMIN_BASE}/events/${eventId}/all-guests`,
    flash: url.searchParams.get('flash') ?? '',
    statuses: GUEST_STATUSES,
    selectedStatus: selectedStatus ?? '',
    q,
    selectedColor,
    colorOptions,
    hasEdm: false,
    customFieldOptions: customFields.map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      selected: selectedCustomField?.key === field.key,
    })),
    hasCustomFields: customFields.length > 0,
    selectedCustomFieldKey: selectedCustomField?.key ?? '',
    totalCount,
    filteredCount: rows.length,
    guests: rows,
  }, jsonOnly);
}

/** Import form for adding guests across multiple lists in one upload. */
export async function eventGuestImport(cms: CmsClient, views: Fetcher, eventId: number, jsonOnly = false): Promise<Response> {
  const event = await cms.get(eventId);
  if (event.page_type !== 'event') return new Response('not found', { status: 404 });
  return adminView(views, `Import guests — ${event.name}`, 'event-import', {
    eventName: event.name,
    backHref: `${ADMIN_BASE}/events/${eventId}`,
    action: `${ADMIN_BASE}/events/${eventId}/import`,
  }, jsonOnly);
}

/**
 * Imports guests from a CSV whose `list` (or `mail_list`) column routes each row
 * to a named list — the flat equivalent of the legacy multi-sheet workbook.
 * Missing lists are created under the event before their guests are added.
 */
export async function previewEventGuestImport(request: Request, cms: CmsClient, views: Fetcher, eventId: number, jsonOnly = false): Promise<Response> {
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
    }, jsonOnly);
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
  }, jsonOnly);
}

export async function confirmEventGuestImport(request: Request, cms: CmsClient, views: Fetcher, eventId: number, jsonOnly = false): Promise<Response> {
  const event = await cms.get(eventId);
  if (event.page_type !== 'event') return new Response('not found', { status: 404 });

  const form = await request.formData();
  const mode = formText(form, 'mode') || 'new_and_update';
  const csv = formText(form, 'csv');
  const assignNewIds = formText(form, 'assign_new_ids') === '1';
  const groups = parseEventImportGroups(csv);
  if (!groups.length) return redirect(`${ADMIN_BASE}/events/${eventId}/import`);

  // Existing lists, keyed by lower-cased name, so repeated rows reuse one list.
  const existing = await listByEvent(cms, 'mail_list', eventId);
  const listByName = new Map(existing.map((list) => [list.name.trim().toLowerCase(), list]));

  const heading = event.name;
  const confirmAction = `${ADMIN_BASE}/events/${eventId}/import/confirm`;
  const backHref = `${ADMIN_BASE}/events/${eventId}/all-guests`;

  const pass = new ImportPass();
  let remaining = 0; // rows with pending writes in groups this pass classified
  let pendingGroups = 0; // groups this pass never got to (no reads spent on them)
  for (const group of groups) {
    if (pass.done) {
      pendingGroups += 1;
      continue;
    }

    let list: CmsPage | undefined;
    let existingGuests: CmsPage[] = [];
    try {
      list = listByName.get(eventImportListKey(group.listName));
      if (!list) {
        if (mode === 'update_only') continue;
        const listName = group.listName;
        pass.spent += 1;
        list = await cms.create({
          page_type: 'mail_list',
          name: listName,
          lect: { _type: 'mail_list', name: { en: listName }, _pointers: { event: String(eventId) } },
        });
        pass.listsCreated += 1;
        listByName.set(eventImportListKey(group.listName), list);
      } else {
        pass.spent += 1;
        existingGuests = await cms.listAll('guest', { pointer: { key: 'mail_list', value: list.id } });
      }
    } catch (error) {
      if (!isSubrequestLimitError(error)) throw error;
      pass.capped = true;
      pendingGroups += 1;
      continue;
    }

    const plan = classifyImport(group.guests, existingGuests, eventId, list.id);
    const creates = mode !== 'update_only' ? plan.create : [];
    const updates = mode !== 'new_only' ? plan.update : [];
    let applied;
    try {
      applied = await applyImportPlan(cms, pass, creates, updates, assignNewIds);
    } catch (error) {
      if (!(error instanceof ImportIdConflictError)) throw error;
      return importIdConflictView(views, jsonOnly, error, { heading, confirmAction, backHref, csv, mode });
    }
    remaining += creates.length - applied.created + (updates.length - applied.updated);
  }

  if (!remaining && !pendingGroups) return redirect(backHref);

  const remainingParts = [];
  if (remaining) remainingParts.push(`${remaining} record(s)`);
  if (pendingGroups) remainingParts.push(`${pendingGroups} list(s)`);
  return importProgressView(views, jsonOnly, {
    heading,
    confirmAction,
    backHref,
    csv,
    mode,
    assignNewIds,
    pass,
    remainingLabel: `${remainingParts.join(' and ')} left`,
  });
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
      const existingGuests = await cms.listAll('guest', { pointer: { key: 'mail_list', value: list.id } });
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

async function guestImport(cms: CmsClient, views: Fetcher, listId: number, jsonOnly = false): Promise<Response> {
  const context = await guestListContext(cms, listId);
  if (!context) return new Response('not found', { status: 404 });
  return adminView(views, `Import guests — ${context.list.name}`, 'guest-import', {
    eventName: context.event?.name ?? 'Event',
    listName: context.list.name,
    listHref: `${ADMIN_BASE}/rsvp/${listId}`,
    action: `${ADMIN_BASE}/rsvp/${listId}/import`,
  }, jsonOnly);
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
    paired_qrcode: v('paired_qrcode', 'paired_qr_code', 'badge_qrcode', 'badge_qr_code', 'rfid_badge_qrcode'),
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

/**
 * A create carried a CSV `id` that is already taken in the CMS (or repeated in
 * the file). Surfaced as its own type so the confirm handlers can offer
 * "assign new IDs" instead of dumping the raw batch error in the error panel.
 */
class ImportIdConflictError extends Error {
  constructor(public readonly guestName: string, public readonly requestedId: number | undefined) {
    super(`id_conflict${requestedId ? `:${requestedId}` : ''}`);
  }
}

async function createImportedGuestBatch(cms: CmsClient, inputs: CmsPageInput[], assignNewIds = false): Promise<void> {
  if (!inputs.length) return;
  if (inputs.length === 1) {
    try {
      await cms.create(inputs[0]);
    } catch (error) {
      if (!(error instanceof CmsApiError) || error.code !== 'id_conflict' || inputs[0].id === undefined) throw error;
      if (!assignNewIds) throw new ImportIdConflictError(inputs[0].name ?? '', inputs[0].id);
      await cms.create({ ...inputs[0], id: undefined });
    }
    return;
  }

  try {
    const result = await cms.batchCreate(inputs);
    if (result.errors.length) {
      // Rows the host did not reject were created by the call above; only the
      // errored ones are outstanding.
      const conflicts = result.errors.filter((entry) => entry.error === 'id_conflict');
      const other = result.errors.find((entry) => entry.error !== 'id_conflict');
      if (other) throw new CmsApiError(400, `batch_item_${other.index}:${other.error}`, 'POST', '/pages/batch');
      if (!assignNewIds) {
        const first = inputs[conflicts[0].index];
        throw new ImportIdConflictError(first?.name ?? '', first?.id);
      }
      await createImportedGuestBatch(cms, conflicts.map((entry) => ({ ...inputs[entry.index], id: undefined })));
    }
  } catch (error) {
    if (error instanceof CmsApiError && shouldSplitImportBatch(error)) {
      const midpoint = Math.ceil(inputs.length / 2);
      await createImportedGuestBatch(cms, inputs.slice(0, midpoint), assignNewIds);
      await createImportedGuestBatch(cms, inputs.slice(midpoint), assignNewIds);
      return;
    }
    throw error;
  }
}

function shouldSplitImportBatch(error: CmsApiError): boolean {
  return error.path === '/pages/batch' && [429, 500, 502, 503, 504].includes(error.status);
}

/**
 * One confirm pass over an import plan. Confirm re-parses and re-classifies
 * the CSV every pass, and classify is idempotent (rows already applied come
 * back as `unchanged`), so a pass that stops early loses nothing: the progress
 * page resubmits the same CSV and the next pass continues from wherever this
 * one stopped. `capped` flips when the runtime subrequest cap fired before the
 * budget estimate did — after that no further host call can succeed, but a
 * redirect/progress response needs none.
 */
class ImportPass {
  created = 0;
  updated = 0;
  listsCreated = 0;
  spent = 0;
  capped = false;

  get done(): boolean {
    return this.capped || this.spent >= IMPORT_PASS_WRITE_BUDGET;
  }

  get progressed(): boolean {
    return this.created + this.updated + this.listsCreated > 0;
  }
}

/** The runtime's per-invocation subrequest cap; thrown by fetch itself, so no request went out. */
function isSubrequestLimitError(error: unknown): boolean {
  return error instanceof Error && /too many subrequests/i.test(error.message);
}

/**
 * Applies as much of one classify plan as the pass budget allows — creates
 * first (batched), then per-guest updates — and reports what this call
 * actually wrote. Hitting the runtime subrequest cap marks the pass capped
 * instead of crashing the request; everything already written stays written.
 */
async function applyImportPlan(
  cms: CmsClient,
  pass: ImportPass,
  creates: CmsPageInput[],
  updates: ImportPlan['update'],
  assignNewIds = false,
): Promise<{ created: number; updated: number }> {
  const result = { created: 0, updated: 0 };
  try {
    for (const chunk of chunks(creates, IMPORT_CREATE_BATCH)) {
      if (pass.done) return result;
      pass.spent += 1;
      await createImportedGuestBatch(cms, chunk, assignNewIds);
      result.created += chunk.length;
      pass.created += chunk.length;
    }
    for (const entry of updates) {
      if (pass.done) return result;
      pass.spent += 1;
      await cms.update(entry.id, { lect: entry.lect });
      result.updated += 1;
      pass.updated += 1;
    }
  } catch (error) {
    if (!isSubrequestLimitError(error)) throw error;
    pass.capped = true;
  }
  return result;
}

/**
 * Shown when a confirm pass ran out of budget with work left. Carries the raw
 * CSV + mode back in a form that auto-resubmits to the same confirm URL while
 * the pass is making progress; a pass that wrote nothing (e.g. the overhead
 * reads alone exhausted the runtime cap) renders a manual retry instead, so a
 * stuck import can never auto-loop.
 */
function importProgressView(views: Fetcher, jsonOnly: boolean, data: {
  heading: string;
  confirmAction: string;
  backHref: string;
  csv: string;
  mode: string;
  pass: ImportPass;
  remainingLabel: string;
  assignNewIds: boolean;
}): Promise<Response> {
  return adminView(views, 'Importing guests…', 'guest-import-progress', {
    heading: data.heading,
    confirmAction: data.confirmAction,
    backHref: data.backHref,
    csv: data.csv,
    mode: data.mode,
    assignNewIds: data.assignNewIds ? '1' : '',
    createdCount: data.pass.created,
    updatedCount: data.pass.updated,
    remainingLabel: data.remainingLabel,
    auto: data.pass.progressed,
  }, jsonOnly);
}

/**
 * Shown when a create asked for a CSV `id` the CMS already uses. The retry
 * button resubmits the same CSV with `assign_new_ids=1`, which lets the host
 * generate fresh ids for just the conflicting rows (rows whose id is free
 * still keep it).
 */
function importIdConflictView(views: Fetcher, jsonOnly: boolean, error: ImportIdConflictError, data: {
  heading: string;
  confirmAction: string;
  backHref: string;
  csv: string;
  mode: string;
}): Promise<Response> {
  return adminView(views, 'Import ID conflict', 'guest-import-conflict', {
    heading: data.heading,
    confirmAction: data.confirmAction,
    backHref: data.backHref,
    csv: data.csv,
    mode: data.mode,
    guestName: error.guestName,
    requestedId: error.requestedId ? String(error.requestedId) : '',
  }, jsonOnly);
}

/**
 * Step 1 of import: parse the CSV, classify each row against the list (new /
 * update-with-diff / unchanged), and render the preview — no writes. The raw CSV
 * (not the expanded plan) rides to confirm in a hidden field so the round-trip
 * body stays small; confirm re-parses and re-classifies it.
 */
async function previewImportGuests(request: Request, cms: CmsClient, views: Fetcher, listId: number, jsonOnly = false): Promise<Response> {
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
    }, jsonOnly);
  }

  const existingGuests = await cms.listAll('guest', { pointer: { key: 'mail_list', value: listId } });
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
    limitWarning: await importLimitWarning(cms, listId, plan.create.length),
    creditWarning: await importCreditWarning(cms, plan.create.length),
  }, jsonOnly);
}

/**
 * Pre-confirm warning when the planned creates would cost more credits than
 * the acting user has (guests are priced by the host via the manifest
 * `import_guest` cost — free unless an admin sets a price). Best-effort UX:
 * the host charges/rejects on confirm regardless.
 */
async function importCreditWarning(cms: CmsClient, toCreate: number): Promise<string> {
  if (!toCreate || !cms.hasActingUser) return '';
  try {
    const info = await cms.credits();
    const price = info.credits.find((credit) => credit.key === 'import_guest')?.value ?? 0;
    if (price > 0 && info.balance !== null && price * toCreate > info.balance) {
      return `Importing ${toCreate} new guests costs ${price * toCreate} credits but you have ${info.balance}. Confirming will fail — reduce the file or ask an administrator to top up your credits.`;
    }
  } catch {
    // Billing display is optional; the host still charges on confirm.
  }
  return '';
}

/**
 * Pre-confirm warning when the planned creates would cross a host-configured
 * guest quota (Plugins → Limits). Best-effort UX only: the host enforces on
 * confirm regardless, rejecting the whole batch — so warn here, before the
 * user clicks through. A failed lookup never blocks the preview.
 */
async function importLimitWarning(cms: CmsClient, listId: number, toCreate: number): Promise<string> {
  if (!toCreate) return '';
  try {
    for (const limit of await cms.limits({ pointerValue: listId })) {
      if (limit.page_type !== 'guest' || limit.value === null || limit.usage === null) continue;
      if (limit.usage + toCreate > limit.value) {
        const room = Math.max(limit.value - limit.usage, 0);
        return `${limit.label}: ${limit.usage} of ${limit.value} in use, but this import adds ${toCreate} new guests and only ${room} more fit. Confirming will fail — reduce the file or ask an administrator to raise the limit.`;
      }
    }
  } catch {
    // Quota display is optional; enforcement stays host-side.
  }
  return '';
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
async function confirmImportGuests(request: Request, cms: CmsClient, views: Fetcher, listId: number, jsonOnly = false): Promise<Response> {
  const context = await guestListContext(cms, listId);
  if (!context) return new Response('not found', { status: 404 });
  const form = await request.formData();
  const mode = formText(form, 'mode') || 'new_and_update';
  const csv = formText(form, 'csv');
  const assignNewIds = formText(form, 'assign_new_ids') === '1';
  const incoming = parseImportRows(csv);
  if (!incoming.length) return redirect(`${ADMIN_BASE}/rsvp/${listId}/import`);

  const existingGuests = await cms.listAll('guest', { pointer: { key: 'mail_list', value: listId } });
  const plan = classifyImport(incoming, existingGuests, context.eventId, listId);
  const creates = mode !== 'update_only' ? plan.create : [];
  const updates = mode !== 'new_only' ? plan.update : [];

  const heading = `${context.list.name} · ${context.event?.name ?? 'Event'}`;
  const confirmAction = `${ADMIN_BASE}/rsvp/${listId}/import/confirm`;
  const backHref = `${ADMIN_BASE}/rsvp/${listId}`;

  const pass = new ImportPass();
  let applied;
  try {
    applied = await applyImportPlan(cms, pass, creates, updates, assignNewIds);
  } catch (error) {
    if (!(error instanceof ImportIdConflictError)) throw error;
    return importIdConflictView(views, jsonOnly, error, { heading, confirmAction, backHref, csv, mode });
  }
  const remaining = creates.length - applied.created + (updates.length - applied.updated);
  if (!remaining) return redirect(backHref);

  return importProgressView(views, jsonOnly, {
    heading,
    confirmAction,
    backHref,
    csv,
    mode,
    assignNewIds,
    pass,
    remainingLabel: `${remaining} record(s) left`,
  });
}

/**
 * Identical-copy duplicate groups. Only rows that agree on the name AND every
 * imported + custom field group together — legitimate same-email guests with
 * different names (or any real difference) never match. Within a group, rows
 * with activity (a check-in, a response, or a registration link) are always
 * kept — that id was used in the field (QR scans, signed RSVP links); with no
 * activity anywhere the lowest id (the original) survives.
 */
function findDuplicateGuests(guests: CmsPage[]): { total: number; groups: Array<{ name: string; email: string; copies: number; remove: CmsPage[] }> } {
  const byFingerprint = new Map<string, CmsPage[]>();
  for (const guest of guests) {
    const values = guestValues(guest);
    const custom = Object.keys(guest.lect)
      .filter((key) => /^(rsvp-custom-|rsvp_custom_)/.test(key))
      .sort()
      .map((key) => [key, attr(guest.lect, key)]);
    const fingerprint = JSON.stringify([
      values.name.trim().toLowerCase(),
      ...IMPORT_FIELDS.map((field) => values[field] ?? ''),
      custom,
    ]);
    const bucket = byFingerprint.get(fingerprint);
    if (bucket) bucket.push(guest);
    else byFingerprint.set(fingerprint, [guest]);
  }

  const groups: Array<{ name: string; email: string; copies: number; remove: CmsPage[] }> = [];
  let total = 0;
  for (const bucket of byFingerprint.values()) {
    if (bucket.length < 2) continue;
    const sorted = [...bucket].sort((a, b) => a.id - b.id);
    const active = sorted.filter((guest) =>
      checkins(guest.lect).length > 0
      || items(guest.lect, 'response').length > 0
      || attr(guest.lect, 'registration_ref') !== '');
    const keepIds = new Set((active.length ? active : [sorted[0]]).map((guest) => guest.id));
    const remove = sorted.filter((guest) => !keepIds.has(guest.id));
    if (!remove.length) continue;
    total += remove.length;
    const values = guestValues(sorted[0]);
    groups.push({ name: values.name, email: values.email, copies: sorted.length, remove });
  }
  return { total, groups };
}

/**
 * GET /rsvp/:id/dedupe — shows what a cleanup would remove before touching
 * anything. Exists because the pre-pagination import re-created the unfetched
 * tail of >500-guest lists on every pass, mass-producing identical copies.
 */
async function previewGuestDedupe(cms: CmsClient, views: Fetcher, listId: number, jsonOnly = false): Promise<Response> {
  const context = await guestListContext(cms, listId);
  if (!context) return new Response('not found', { status: 404 });
  const guests = await cms.listAll('guest', { pointer: { key: 'mail_list', value: listId } });
  const { total, groups } = findDuplicateGuests(guests);
  return adminView(views, `Remove duplicates — ${context.list.name}`, 'guest-dedupe', {
    eventName: context.event?.name ?? 'Event',
    listName: context.list.name,
    listHref: `${ADMIN_BASE}/rsvp/${listId}`,
    action: `${ADMIN_BASE}/rsvp/${listId}/dedupe`,
    guestCount: guests.length,
    duplicateCount: total,
    groupCount: groups.length,
    groups: groups.slice(0, 200).map((group) => ({
      name: group.name,
      email: group.email,
      copies: group.copies,
      removing: group.remove.length,
    })),
    moreGroups: Math.max(0, groups.length - 200),
  }, jsonOnly);
}

/**
 * POST: soft-deletes the identical copies (host batch delete moves them to
 * trash, so this is recoverable) in budgeted batches; a huge cleanup that
 * outruns the pass budget reports how many are left for another click.
 */
async function applyGuestDedupe(cms: CmsClient, listId: number): Promise<Response> {
  const context = await guestListContext(cms, listId);
  if (!context) return new Response('not found', { status: 404 });
  const guests = await cms.listAll('guest', { pointer: { key: 'mail_list', value: listId } });
  const { total, groups } = findDuplicateGuests(guests);
  const ids = groups.flatMap((group) => group.remove.map((guest) => guest.id));

  let removed = 0;
  let spent = 0;
  try {
    for (const chunk of chunks(ids, 100)) {
      if (spent >= IMPORT_PASS_WRITE_BUDGET) break;
      spent += 1;
      await cms.batchRemove(chunk);
      removed += chunk.length;
    }
  } catch (error) {
    if (!isSubrequestLimitError(error)) throw error;
  }

  const remaining = total - removed;
  const message = remaining > 0
    ? `Removed ${removed} duplicate guest(s); ${remaining} left — run Remove duplicates again`
    : `Removed ${removed} duplicate guest(s)`;
  return redirect(`${ADMIN_BASE}/rsvp/${listId}?flash=${encodeURIComponent(message)}`);
}

async function exportGuests(cms: CmsClient, listId: number): Promise<Response> {
  const context = await guestListContext(cms, listId);
  if (!context) return new Response('not found', { status: 404 });
  await chargeCreditAction(cms, 'export_guests', 1, { entityType: 'mail_list', entityId: listId });
  const pages = await cms.listAll('guest', { pointer: { key: 'mail_list', value: listId } });
  const headers = ['id', 'name', 'last_name', 'email', 'phone', 'organization', 'job_title', 'plus_guests', 'status', 'prefer_language', 'cc', 'remarks', 'paired_qrcode', 'checked_in'];
  const rows = pages.map((guest) => {
    const values = guestValues(guest);
    return [
      String(guest.id),
      values.name, values.last_name, values.email, values.phone, values.organization, values.job_title,
      values.plus_guests, values.status, values.prefer_language, values.cc, values.remarks, values.paired_qrcode,
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
  await chargeCreditAction(cms, 'export_guests', 1, { entityType: 'event', entityId: eventId });

  const lists = await listByEvent(cms, 'mail_list', eventId);
  const guestsByList = await Promise.all(
    lists.map((list) => cms.listAll('guest', { pointer: { key: 'mail_list', value: list.id } })),
  );

  const headers = ['id', 'mail_list', 'name', 'last_name', 'email', 'phone', 'organization', 'job_title', 'plus_guests', 'status', 'prefer_language', 'cc', 'remarks', 'paired_qrcode', 'checked_in'];
  const rows: string[][] = [];
  lists.forEach((list, index) => {
    for (const guest of guestsByList[index] ?? []) {
      const values = guestValues(guest);
      rows.push([
        String(guest.id),
        list.name, values.name, values.last_name, values.email, values.phone, values.organization, values.job_title,
        values.plus_guests, values.status, values.prefer_language, values.cc, values.remarks, values.paired_qrcode,
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

function guestListRow(list: CmsPage, event?: CmsPage, access?: EventAdminAccess): Record<string, unknown> {
  const canDelete = access?.canDelete ?? true;
  return {
    name: list.name,
    eventName: event?.name ?? 'Unknown event',
    eventHref: event ? `${ADMIN_BASE}/events/${event.id}` : '',
    href: `${ADMIN_BASE}/rsvp/${list.id}`,
    canDelete: canDelete && !isAdhocList(list),
    deleteAction: canDelete && !isAdhocList(list) ? `${ADMIN_BASE}/rsvp/${list.id}/delete` : '',
    allowCheckin: attr(list.lect, 'allow_checkin') !== 'no',
  };
}

function guestEditHref(guestId: number, listId: number, returnTo = `${ADMIN_BASE}/rsvp/${listId}`): string {
  return `/admin/pages/${guestId}/edit?return_to=${encodeURIComponent(returnTo)}`;
}

function guestRow(guest: CmsPage, listId: number, edmId: number | null, customField?: AdminCustomField | null, returnTo = '', searchQuery = '', access?: EventAdminAccess): Record<string, unknown> {
  const canEdit = access?.canEdit ?? true;
  const canCheckIn = access?.canCheckIn ?? true;
  const canManageEmail = access?.canManageEmail ?? true;
  const values = guestValues(guest);
  const quality = emailQuality(values.email);
  const searchTextParts = [String(guest.id), values.name, values.last_name, values.email, values.phone];
  if (values.paired_qrcode) searchTextParts.push(values.paired_qrcode);
  searchTextParts.push(searchQuery);
  return {
    ...values,
    id: guest.id,
    hasEdm: edmId !== null,
    returnTo,
    canEdit,
    canCheckIn,
    canManageEmail,
    editHref: canEdit ? guestEditHref(guest.id, listId) : '',
    qrHref: canCheckIn ? `${ADMIN_BASE}/rsvp/${listId}/guests/${guest.id}/qrcode` : '',
    statusAction: canEdit ? `${ADMIN_BASE}/rsvp/${listId}/guests/${guest.id}/status` : '',
    colorAction: canEdit ? `${ADMIN_BASE}/rsvp/${listId}/guests/${guest.id}/color` : '',
    statusClass: statusClass(values.status),
    statusColor: statusColor(values.status),
    searchText: searchTextVariants(searchTextParts),
    customFieldValue: customField ? guestCustomFieldValue(guest, customField) : '',
    checkinAction: canCheckIn ? `${ADMIN_BASE}/rsvp/${listId}/guests/${guest.id}/checkin` : '',
    checkedIn: checkins(guest.lect).length > 0,
    // EDM send/preview controls (only meaningful when the list has an EDM).
    emailQuality: quality,
    canEmail: quality !== 'invalid',
    isGood: quality === 'good',
    isRisky: quality === 'risky',
    notSend: truthyAttr(guest.lect, 'not_send'),
    sent: edmId ? guestWasSentEdm(guest, edmId) : false,
    sendAction: canManageEmail ? `${ADMIN_BASE}/rsvp/${listId}/guests/${guest.id}/send` : '',
    previewHref: canManageEmail ? `${ADMIN_BASE}/rsvp/${listId}/guests/${guest.id}/preview` : '',
  };
}

function searchTextVariants(parts: string[]): string {
  const variants = new Set<string>();
  for (const part of parts) {
    for (const variant of chineseSearchVariants(part)) {
      variants.add(variant);
    }
  }
  return [...variants].join(' ');
}

function emptyGuestValues(): Record<string, string> {
  return {
    name: '', first_name: '', last_name: '', prefix: '', zh_hant_name: '', zh_hans_name: '',
    picture: '', contact: '', email: '', phone: '', cc: '', organization: '', job_title: '', wechat: '',
    nationality: '', parent: '', allow_refill: '', primary_guest: '', not_send: '', plus_guests: '0',
    total_guests: '', max_main_checkin: '', status: 'to be invited', prefer_language: '', color_tag: '',
    remarks: '', checkin_remark: '', qrcode_remark: '', rsvp_code: '', qrcode: '', paired_qrcode: '', barcode: '', no: '',
  };
}

function guestValues(guest: CmsPage): Record<string, string> {
  return {
    name: guest.name || localized(guest.lect, 'name'),
    first_name: localized(guest.lect, 'first_name'),
    last_name: localized(guest.lect, 'last_name'),
    prefix: attr(guest.lect, 'prefix'),
    zh_hant_name: attr(guest.lect, 'zh_hant_name'),
    zh_hans_name: attr(guest.lect, 'zh_hans_name'),
    picture: attr(guest.lect, 'picture'),
    contact: guestContactId(guest),
    email: attr(guest.lect, 'email'),
    phone: attr(guest.lect, 'phone'),
    cc: attr(guest.lect, 'cc'),
    organization: attr(guest.lect, 'organization'),
    job_title: attr(guest.lect, 'job_title'),
    wechat: attr(guest.lect, 'wechat'),
    nationality: attr(guest.lect, 'nationality'),
    parent: attr(guest.lect, 'parent'),
    allow_refill: switchValue(guest.lect, 'allow_refill'),
    primary_guest: switchValue(guest.lect, 'primary_guest'),
    not_send: switchValue(guest.lect, 'not_send'),
    plus_guests: attr(guest.lect, 'plus_guests') || '0',
    total_guests: attr(guest.lect, 'total_guests'),
    max_main_checkin: attr(guest.lect, 'max_main_checkin'),
    status: guestStatus(guest),
    prefer_language: attr(guest.lect, 'prefer_language'),
    color_tag: guestColorTag(guest),
    remarks: attr(guest.lect, 'remarks'),
    checkin_remark: attr(guest.lect, 'checkin_remark'),
    qrcode_remark: attr(guest.lect, 'qrcode_remark'),
    rsvp_code: attr(guest.lect, 'rsvp_code'),
    qrcode: attr(guest.lect, 'qrcode'),
    paired_qrcode: attr(guest.lect, 'paired_qrcode') || attr(guest.lect, 'paired_qr_code'),
    barcode: attr(guest.lect, 'barcode'),
    no: attr(guest.lect, 'no'),
  };
}

export function guestContactId(guest: CmsPage): string {
  return String(pointer(guest.lect, 'contact') || attr(guest.lect, 'contact_id') || '').trim();
}

function truthyAttr(lect: Record<string, unknown>, key: string): boolean {
  return ['true', 'yes', '1', 'on'].includes(attr(lect, key).trim().toLowerCase());
}

function switchValue(lect: Record<string, unknown>, key: string): string {
  const value = attr(lect, key).trim().toLowerCase();
  if (['true', 'yes', '1', 'on'].includes(value)) return 'yes';
  if (['false', 'no', '0', 'off'].includes(value)) return 'no';
  return '';
}

function guestDetailFields(values: Record<string, string>, language: string): GuestFormField[] {
  return [
    guestFormField('name', 'Display name', values.name, 'textarea', { required: true }),
    guestFormField('@picture', 'Picture', values.picture, 'picture', { span: 'md:col-span-2' }),
    guestFormField('@prefix', 'Prefix', values.prefix),
    guestFormField('@prefer_language', 'Preferred language', values.prefer_language, 'select', {
      blankOption: true,
      blankLabel: 'Not set',
      options: [
        { value: 'en', label: 'English', selected: values.prefer_language === 'en' },
        { value: 'zh-hant', label: '繁體中文', selected: values.prefer_language === 'zh-hant' },
        { value: 'zh-hans', label: '简体中文', selected: values.prefer_language === 'zh-hans' },
      ],
    }),
    guestFormField('@nationality', 'Nationality', values.nationality),
    guestFormField('@organization', 'Organisation', values.organization),
    guestFormField('@job_title', 'Job title', values.job_title),
    guestFormField(`.first_name|${language}`, 'First name', values.first_name),
    guestFormField(`.last_name|${language}`, 'Last name', values.last_name),
    guestFormField('@zh_hant_name', 'Traditional Chinese name', values.zh_hant_name),
    guestFormField('@zh_hans_name', 'Simplified Chinese name', values.zh_hans_name),
  ];
}

function guestContactFields(values: Record<string, string>): GuestFormField[] {
  return [
//    guestFormField('*contact', 'Source Contact ID', values.contact, 'page'),
    guestFormField('@email', 'Email', values.email, 'email'),
    guestFormField('@cc', 'CC email', values.cc),
    guestFormField('@phone', 'Phone', values.phone),
    guestFormField('@wechat', 'WeChat', values.wechat),
  ];
}

function guestRsvpFields(values: Record<string, string>): GuestFormField[] {
  return [
    guestFormField('@status', 'Status', values.status, 'select', {
      options: GUEST_STATUSES.map((status) => ({ value: status, label: status, selected: values.status === status })),
    }),
    guestFormField('@allow_refill', 'Allow refill', values.allow_refill, 'switch'),
    guestFormField('@primary_guest', 'Primary guest', values.primary_guest, 'switch'),
    guestFormField('@parent', 'Primary guest', values.parent),
    guestFormField('@not_send', 'Pause email sends', values.not_send, 'switch'),
    guestFormField('@plus_guests', 'Plus guests', values.plus_guests, 'number'),
    guestFormField('@total_guests', 'Total guests', values.total_guests, 'number'),
    guestFormField('@max_main_checkin', 'Max main check-ins', values.max_main_checkin, 'number'),
    guestFormField('@color_tag', 'Color tag', values.color_tag, 'select', {
      blankOption: true,
      blankLabel: 'No color tag',
      options: COLOR_TAGS.map((color) => ({ value: color, label: color, selected: values.color_tag === color })),
    }),
  ];
}

function guestNoteFields(values: Record<string, string>): GuestFormField[] {
  return [
    guestFormField('@remarks', 'Remarks', values.remarks, 'textarea', { span: 'md:col-span-2' }),
    guestFormField('@checkin_remark', 'Check-in remark', values.checkin_remark, 'textarea', { span: 'md:col-span-2' }),
    guestFormField('@qrcode_remark', 'QR code remark', values.qrcode_remark, 'textarea', { span: 'md:col-span-2' }),
  ];
}

function guestTicketFields(values: Record<string, string>): GuestFormField[] {
  return [
    guestFormField('@rsvp_code', 'RSVP code', values.rsvp_code),
    guestFormField('@qrcode', 'Ticket QR code', values.qrcode, 'text', { placeholder: 'Third-party QR code text' }),
    guestFormField('@paired_qrcode', 'Paired badge QR code', values.paired_qrcode, 'text', { placeholder: 'RFID badge QR code text' }),
    guestFormField('@barcode', 'Ticket barcode', values.barcode, 'text', { placeholder: 'Third-party Code128 barcode number' }),
    guestFormField('@no', 'Guest number', values.no),
  ];
}

function guestFormField(
  inputName: string,
  label: string,
  value: string,
  type = 'text',
  options: Partial<Pick<GuestFormField, 'placeholder' | 'required' | 'options' | 'checked' | 'defaultValue' | 'span' | 'blankOption' | 'blankLabel'>> = {},
): GuestFormField {
  const normalizedType = pageFieldType(type);
  return {
    name: inputName.replace(/^[@*.]/, '').split('|')[0],
    inputName,
    id: fieldId(inputName),
    label,
    type: normalizedType,
    templateName: workerPageFieldTemplate(normalizedType),
    value,
    placeholder: options.placeholder ?? '',
    blankOption: options.blankOption ?? false,
    blankLabel: options.blankLabel ?? '',
    required: options.required ?? false,
    options: options.options ?? [],
    checked: options.checked ?? false,
    defaultValue: options.defaultValue ?? '',
    span: options.span ?? '',
  };
}

function pageFieldType(type: string): string {
  const normalized = type.trim().toLowerCase();
  if (['checkbox', 'select', 'radio', 'textarea', 'email', 'tel', 'date', 'time', 'number', 'url', 'switch', 'boolean', 'picture', 'page'].includes(normalized)) return normalized;
  return 'text';
}

function workerPageFieldTemplate(type: string): string {
  if ([
    'text',
    'email',
    'tel',
    'url',
    'number',
    'date',
    'time',
    'textarea',
    'select',
    'radio',
    'checkbox',
    'switch',
    'boolean',
    'picture',
    'page',
  ].includes(type)) return `snippets/pagefield/${type}/basic`;
  return '';
}

function fieldId(inputName: string): string {
  return `field_${Array.from(inputName)
    .map((char) => (/^[A-Za-z0-9_-]$/.test(char) ? char : `_${char.charCodeAt(0).toString(16)}_`))
    .join('')}`;
}

function filterGuests(guests: CmsPage[], q: string, status?: GuestStatus, color = ''): CmsPage[] {
  return guests.filter((guest) => guestMatchesFilters(guest, q, status, color));
}

function guestMatchesFilters(guest: CmsPage, q: string, status?: GuestStatus, color = ''): boolean {
  if (status && guestStatus(guest) !== status) return false;
  if (color && !guestMatchesColor(guest, color)) return false;
  if (q && !guestMatchesSearch(guest, q)) return false;
  return true;
}

function guestMatchesSearch(guest: CmsPage, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const values = guestValues(guest);
  return [
    String(guest.id),
    values.name,
    values.last_name,
    values.email,
    values.phone,
    values.paired_qrcode,
  ].some((value) => value.toLowerCase().includes(needle));
}

function guestMatchesColor(guest: CmsPage, color: string): boolean {
  const tag = guestColorTag(guest);
  return color === 'none' ? !tag : tag === color;
}

function normalizeColor(value: string | null): string {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === 'none') return normalized;
  return isColorTag(normalized) ? normalized : '';
}

function guestColorTag(guest: CmsPage): string {
  return attr(guest.lect, 'color_tag').trim();
}

function normalizeAssignableColor(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return '';
  return isColorTag(normalized) ? normalized : null;
}

function isColorTag(value: string): boolean {
  return (COLOR_TAGS as readonly string[]).includes(value);
}

function colorTagOptions(selectedColor: string): Array<{ value: string; label: string; selected: boolean }> {
  return COLOR_TAGS.map((value) => ({
    value,
    label: value,
    selected: value === selectedColor,
  }));
}

async function guestActivity(cms: CmsClient, guest: CmsPage): Promise<ActivityItem[]> {
  const responseActivity = items(guest.lect, 'response')
    .filter(hasActivityContent)
    .map((entry) => ({
      kind: 'response',
      label: 'Response',
      status: String(entry.status ?? ''),
      date: String(entry.date ?? ''),
      message: String(entry.message ?? ''),
    }));

  const checkinActivity = checkins(guest.lect).map((entry) => ({
    kind: 'checkin',
    label: 'Check-in',
    status: String(entry.status ?? 'checked-in') || 'checked-in',
    date: String(entry.date ?? ''),
    message: String(entry.message ?? ''),
  }));

  const sentActivity = await sentEdmActivity(cms, guest);

  return [...responseActivity, ...checkinActivity, ...sentActivity].sort((a, b) => {
    const aTime = Date.parse(a.date);
    const bTime = Date.parse(b.date);
    if (Number.isNaN(aTime) && Number.isNaN(bTime)) return 0;
    if (Number.isNaN(aTime)) return 1;
    if (Number.isNaN(bTime)) return -1;
    return bTime - aTime;
  });
}

function hasActivityContent(entry: Record<string, unknown>): boolean {
  return ['status', 'date', 'message'].some((key) => String(entry[key] ?? '').trim() !== '');
}

async function sentEdmActivity(cms: CmsClient, guest: CmsPage): Promise<ActivityItem[]> {
  const sent = Array.isArray(guest.lect.sent_edm) ? guest.lect.sent_edm : [];
  if (!sent.length) return [];

  const edmNames = new Map<string, string>();
  const ids = [...new Set(sent.map(sentEdmId).filter(Boolean))];
  await Promise.all(ids.map(async (id) => {
    try {
      const edm = await cms.get(Number(id));
      if (edm.page_type === 'edm') edmNames.set(id, edm.name);
    } catch (error) {
      if (!(error instanceof CmsApiError && error.status === 404)) throw error;
    }
  }));

  return sent
    .map((entry) => {
      const id = sentEdmId(entry);
      if (!id) return null;
      const record = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
      const name = edmNames.get(id) ?? `EDM ${id}`;
      return {
        kind: 'edm',
        label: 'Sent eDM',
        status: name,
        date: String(record.date ?? record.sent_at ?? ''),
        message: String(record.message ?? record.subject ?? ''),
      };
    })
    .filter((entry): entry is ActivityItem => entry !== null);
}

function sentEdmId(entry: unknown): string {
  if (entry == null) return '';
  if (typeof entry === 'object' && !Array.isArray(entry)) {
    const record = entry as Record<string, unknown>;
    return String(record.edm ?? record.edm_id ?? record.id ?? '').trim();
  }
  return String(entry).trim();
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
      const legacyLabelKey = adminLegacyFieldSlug(label);
      const key = `rsvp_custom_${includeBlockId ? `${adminFieldSlug(blockKey)}_` : ''}${labelKey}`;
      const legacyKey = `rsvp-custom-${includeBlockId ? `${source.id}-` : ''}${legacyLabelKey}`;
      const value = attr(guest?.lect ?? {}, key);
      const type = adminInputType(attr(input, 'type'));
      const defaultValue = attr(input, 'default_value');
      fields.push({
        key,
        legacyKey,
        name: `@${key}`,
        inputName: `@${key}`,
        id: fieldId(`@${key}`),
        label,
        type,
        templateName: workerPageFieldTemplate(type),
        placeholder: '',
        blankOption: type === 'select',
        blankLabel: '',
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

function uniqueAdminCustomFields(fields: AdminCustomField[]): AdminCustomField[] {
  const seen = new Set<string>();
  return fields.filter((field) => {
    if (seen.has(field.key)) return false;
    seen.add(field.key);
    return true;
  });
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

function adminLegacyFieldSlug(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, '-').replace(/[\/()]/g, '');
}

function guestCustomFieldValue(guest: CmsPage, field: AdminCustomField): string {
  const direct = attr(guest.lect, field.key) || attr(guest.lect, field.legacyKey);
  if (direct) return direct;
  const latest = guest.lect.latest_response;
  if (!latest || typeof latest !== 'object' || Array.isArray(latest)) return '';
  const admin = (latest as Record<string, unknown>).admin;
  if (!admin || typeof admin !== 'object' || Array.isArray(admin)) return '';
  const values = admin as Record<string, unknown>;
  return String(values[field.key] ?? values[field.legacyKey] ?? '').trim();
}

export function statusClass(status: string): string {
  return `response-state-${status.trim().toLowerCase().replace(/\s+/g, '-')}`;
}

export function statusColor(status: string): string {
  switch (normalizeStatus(status)) {
    case 'confirmed': return '#22c55e';
    case 'invited': return '#2563eb';
    case 'to be invited': return '#facc15';
    case 'declined': return '#ef4444';
    case 'onhold': return '';
    case 'unconfirmed': return '#6b7280';
    default: return '#374151';
  }
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
    ['first_name', formText(form, 'first_name') || formLocalizedText(form, 'first_name')],
    ['last_name', formText(form, 'last_name') || formLocalizedText(form, 'last_name')],
    ['prefix', formText(form, 'prefix') || formText(form, '@prefix')],
    ['zh_hant_name', formText(form, 'zh_hant_name') || formText(form, '@zh_hant_name')],
    ['zh_hans_name', formText(form, 'zh_hans_name') || formText(form, '@zh_hans_name')],
    ['picture', formText(form, 'picture') || formText(form, '@picture')],
    ['contact', formText(form, 'contact') || formText(form, '*contact') || formText(form, 'contact_id') || formText(form, '@contact_id')],
    ['email', formText(form, 'email') || formText(form, '@email')],
    ['phone', formText(form, 'phone') || formText(form, '@phone')],
    ['cc', formText(form, 'cc') || formText(form, '@cc')],
    ['organization', formText(form, 'organization') || formText(form, '@organization')],
    ['job_title', formText(form, 'job_title') || formText(form, '@job_title')],
    ['wechat', formText(form, 'wechat') || formText(form, '@wechat')],
    ['nationality', formText(form, 'nationality') || formText(form, '@nationality')],
    ['parent', formText(form, 'parent') || formText(form, '@parent')],
    ['allow_refill', formText(form, 'allow_refill') || formText(form, '@allow_refill')],
    ['primary_guest', formText(form, 'primary_guest') || formText(form, '@primary_guest')],
    ['not_send', formText(form, 'not_send') || formText(form, '@not_send')],
    ['plus_guests', formText(form, 'plus_guests') || formText(form, '@plus_guests') || '0'],
    ['total_guests', formText(form, 'total_guests') || formText(form, '@total_guests')],
    ['max_main_checkin', formText(form, 'max_main_checkin') || formText(form, '@max_main_checkin')],
    ['status', normalizeStatus(formText(form, 'status') || formText(form, '@status')) ?? 'to be invited'],
    ['prefer_language', formText(form, 'prefer_language') || formText(form, '@prefer_language')],
    ['color_tag', formText(form, 'color_tag') || formText(form, '@color_tag')],
    ['remarks', formText(form, 'remarks') || formText(form, '@remarks')],
    ['checkin_remark', formText(form, 'checkin_remark') || formText(form, '@checkin_remark')],
    ['qrcode_remark', formText(form, 'qrcode_remark') || formText(form, '@qrcode_remark')],
    ['rsvp_code', formText(form, 'rsvp_code') || formText(form, '@rsvp_code')],
    ['qrcode', formText(form, 'qrcode') || formText(form, '@qrcode')],
    ['paired_qrcode', formText(form, 'paired_qrcode') || formText(form, '@paired_qrcode') || formText(form, 'paired_qr_code') || formText(form, '@paired_qr_code')],
    ['barcode', formText(form, 'barcode') || formText(form, '@barcode')],
    ['no', formText(form, 'no') || formText(form, '@no')],
  ]);
  const input = guestPageInput(name, fields, eventId, listId);
  return { name, lect: { ...(existing?.lect ?? {}), ...input.lect, ...nativeCustomGuestFields(form) } };
}

function guestPageInput(name: string, fields: Map<string, string>, eventId: number | null, listId: number): CmsPageInput {
  const contactId = fields.get('contact') ?? '';
  return {
    page_type: 'guest',
    page_id: listId,
    name,
    lect: {
      _type: 'guest',
      name: { en: name },
      first_name: { en: fields.get('first_name') ?? '' },
      last_name: { en: fields.get('last_name') ?? '' },
      prefix: fields.get('prefix') ?? '',
      zh_hant_name: fields.get('zh_hant_name') ?? '',
      zh_hans_name: fields.get('zh_hans_name') ?? '',
      picture: fields.get('picture') ?? '',
      contact_id: contactId,
      email: fields.get('email') ?? '',
      phone: fields.get('phone') ?? '',
      cc: fields.get('cc') ?? '',
      organization: fields.get('organization') ?? '',
      job_title: fields.get('job_title') ?? '',
      wechat: fields.get('wechat') ?? '',
      nationality: fields.get('nationality') ?? '',
      parent: fields.get('parent') ?? '',
      allow_refill: fields.get('allow_refill') ?? '',
      primary_guest: fields.get('primary_guest') ?? '',
      not_send: fields.get('not_send') ?? '',
      plus_guests: fields.get('plus_guests') ?? '0',
      total_guests: fields.get('total_guests') ?? '',
      max_main_checkin: fields.get('max_main_checkin') ?? '',
      status: fields.get('status') ?? 'to be invited',
      prefer_language: fields.get('prefer_language') ?? '',
      color_tag: fields.get('color_tag') ?? '',
      remarks: fields.get('remarks') ?? '',
      checkin_remark: fields.get('checkin_remark') ?? '',
      qrcode_remark: fields.get('qrcode_remark') ?? '',
      rsvp_code: fields.get('rsvp_code') ?? '',
      qrcode: fields.get('qrcode') ?? '',
      paired_qrcode: fields.get('paired_qrcode') ?? '',
      barcode: fields.get('barcode') ?? '',
      no: fields.get('no') ?? '',
      _pointers: { ...(eventId ? { event: String(eventId) } : {}), mail_list: String(listId), ...(contactId ? { contact: contactId } : {}) },
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

function firstFormText(form: FormData, keys: string[]): string {
  for (const key of keys) {
    const value = formText(form, key);
    if (value) return value;
  }
  return '';
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

function wantsJsonResponse(request: Request): boolean {
  return request.headers.get('Accept')?.includes('application/json') === true
    || request.headers.get('X-Requested-With') === 'fetch';
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
