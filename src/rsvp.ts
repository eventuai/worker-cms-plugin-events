import {
  CmsClient,
  CmsApiError,
  attr,
  items,
  localized,
  pointer,
  type CmsPage,
  type CmsPageInput,
} from './cms';
import { adminView } from './templates/views';

const ADMIN_BASE = '/admin/plugins/events';
const GUEST_STATUSES = ['to be invited', 'onhold', 'invited', 'confirmed', 'declined', 'unconfirmed'] as const;

type GuestStatus = typeof GUEST_STATUSES[number];

interface GuestListContext {
  list: CmsPage;
  event: CmsPage | null;
  eventId: number | null;
}

export async function handleRsvpAdmin(
  request: Request,
  cms: CmsClient,
  views: Fetcher,
  segments: string[],
  url: URL,
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
  if (segments[1] === 'export') return exportGuests(cms, listId);
  if (segments[1] === 'import') {
    if (request.method === 'POST') return importGuests(request, cms, listId);
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
    if (request.method === 'POST') return updateGuest(request, cms, listId, guestId);
    return guestForm(cms, views, listId, guestId);
  }

  return guestList(cms, views, listId, url);
}

/** Event dashboard route: lists that event's guest lists instead of a flat guest table. */
export async function eventGuestLists(cms: CmsClient, views: Fetcher, eventId: number): Promise<Response> {
  const event = await cms.get(eventId);
  if (event.page_type !== 'event') return new Response('not found', { status: 404 });
  const { pages } = await cms.list('mail_list', { parentId: eventId, limit: 500 });
  return adminView(views, `Guest lists — ${event.name}`, 'guest-lists', {
    title: `Guest lists — ${event.name}`,
    subtitle: 'Manage invitation lists and the guests in each list.',
    backHref: `${ADMIN_BASE}/events/${eventId}`,
    newHref: `${ADMIN_BASE}/rsvp/new?event_id=${eventId}`,
    lists: pages.map((list) => guestListRow(list, event)),
  });
}

/** Used by adhoc check-in so every guest is part of a first-class list. */
export async function ensureAdhocGuestList(cms: CmsClient, eventId: number): Promise<CmsPage> {
  const event = await cms.get(eventId);
  if (event.page_type !== 'event') throw new Error('Event not found');

  const { pages } = await cms.list('mail_list', { parentId: eventId, limit: 500 });
  const existing = pages.find((list) => list.name.trim().toLowerCase() === 'adhoc');
  if (existing) return existing;

  return cms.create({
    page_type: 'mail_list',
    name: 'Adhoc',
    page_id: eventId,
    lect: {
      _type: 'mail_list',
      name: { en: 'Adhoc' },
      _pointers: { event: String(eventId) },
    },
  });
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
    lists: lists.map((list) => guestListRow(list, eventById.get(list.page_id ?? 0))),
  });
}

async function guestListForm(cms: CmsClient, views: Fetcher, url: URL): Promise<Response> {
  const { pages: events } = await cms.list('event', { limit: 500 });
  const selectedEventId = pageId(url.searchParams.get('event_id'));
  return adminView(views, 'New guest list', 'guest-list-form', {
    action: `${ADMIN_BASE}/rsvp/new`,
    backHref: selectedEventId ? `${ADMIN_BASE}/events/${selectedEventId}` : `${ADMIN_BASE}/rsvp`,
    selectedEventId,
    events: events.map((event) => ({ id: event.id, name: event.name })),
  });
}

async function createGuestList(request: Request, cms: CmsClient): Promise<Response> {
  const form = await request.formData();
  const eventId = pageId(form.get('event_id'));
  const name = formText(form, 'name');
  if (!eventId || !name) return redirect(`${ADMIN_BASE}/rsvp/new`);

  const event = await cms.get(eventId);
  if (event.page_type !== 'event') return new Response('not found', { status: 404 });

  const list = await cms.create({
    page_type: 'mail_list',
    name,
    page_id: eventId,
    lect: {
      _type: 'mail_list',
      name: { en: name },
      _pointers: { event: String(eventId) },
      allow_checkin: formText(form, 'allow_checkin') || 'yes',
    },
  });
  return redirect(`${ADMIN_BASE}/rsvp/${list.id}`);
}

async function guestList(cms: CmsClient, views: Fetcher, listId: number, url: URL): Promise<Response> {
  const context = await guestListContext(cms, listId);
  if (!context) return new Response('not found', { status: 404 });

  const q = url.searchParams.get('q')?.trim() ?? '';
  const selectedStatus = normalizeStatus(url.searchParams.get('status'));
  const { pages, total } = await cms.list('guest', { parentId: listId, q, limit: 500 });
  const guests = selectedStatus ? pages.filter((guest) => guestStatus(guest) === selectedStatus) : pages;

  return adminView(views, `${context.list.name} — RSVP`, 'guest-list', {
    eventName: context.event?.name ?? 'Event',
    eventHref: context.event ? `${ADMIN_BASE}/events/${context.event.id}` : `${ADMIN_BASE}/rsvp`,
    listName: context.list.name,
    listHref: `${ADMIN_BASE}/rsvp/${listId}`,
    listsHref: context.event ? `${ADMIN_BASE}/rsvp?event=${context.event.id}` : `${ADMIN_BASE}/rsvp`,
    newGuestHref: `${ADMIN_BASE}/rsvp/${listId}/guests/new`,
    importHref: `${ADMIN_BASE}/rsvp/${listId}/import`,
    exportHref: `${ADMIN_BASE}/rsvp/${listId}/export`,
    deleteAction: `${ADMIN_BASE}/rsvp/${listId}/delete`,
    q,
    selectedStatus: selectedStatus ?? '',
    statuses: GUEST_STATUSES,
    total: selectedStatus ? guests.length : total,
    guests: guests.map((guest) => guestRow(guest, listId)),
  });
}

async function guestForm(cms: CmsClient, views: Fetcher, listId: number, guestId?: number): Promise<Response> {
  const context = await guestListContext(cms, listId);
  if (!context) return new Response('not found', { status: 404 });

  const guest = guestId ? await cms.get(guestId) : undefined;
  if (guest && (guest.page_type !== 'guest' || guest.page_id !== listId)) return new Response('not found', { status: 404 });
  const values = guest ? guestValues(guest) : emptyGuestValues();
  const action = guest
    ? `${ADMIN_BASE}/rsvp/${listId}/guests/${guest.id}`
    : `${ADMIN_BASE}/rsvp/${listId}/guests/new`;

  // Sibling lists of the same event a guest can be moved into (edit only).
  let moveLists: Array<{ id: number; name: string }> = [];
  if (guest && context.eventId) {
    const { pages } = await cms.list('mail_list', { parentId: context.eventId, limit: 500 });
    moveLists = pages.filter((list) => list.id !== listId).map((list) => ({ id: list.id, name: list.name }));
  }

  return adminView(views, guest ? `Edit ${values.name}` : 'New guest', 'guest-form', {
    title: guest ? 'Edit guest' : 'New guest',
    eventName: context.event?.name ?? 'Event',
    listName: context.list.name,
    listHref: `${ADMIN_BASE}/rsvp/${listId}`,
    action,
    guest: values,
    statuses: GUEST_STATUSES.map((status) => ({ value: status, selected: values.status === status })),
    deleteAction: guest ? `${ADMIN_BASE}/rsvp/${listId}/guests/${guest.id}/delete` : '',
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

  await cms.create({ page_type: 'guest', page_id: listId, name: input.name, lect: input.lect });
  return redirect(`${ADMIN_BASE}/rsvp/${listId}`);
}

async function updateGuest(request: Request, cms: CmsClient, listId: number, guestId: number): Promise<Response> {
  const context = await guestListContext(cms, listId);
  const guest = await cms.get(guestId);
  if (!context || guest.page_type !== 'guest' || guest.page_id !== listId) return new Response('not found', { status: 404 });

  const form = await request.formData();
  const input = guestInput(form, context.eventId, listId, guest);
  if (!input.name) return redirect(`${ADMIN_BASE}/rsvp/${listId}/guests/${guestId}`);
  await cms.update(guestId, { name: input.name, lect: input.lect });
  return redirect(`${ADMIN_BASE}/rsvp/${listId}`);
}

async function deleteGuest(cms: CmsClient, listId: number, guestId: number): Promise<Response> {
  const guest = await cms.get(guestId);
  if (guest.page_type !== 'guest' || guest.page_id !== listId) return new Response('not found', { status: 404 });
  await cms.remove(guestId);
  return redirect(`${ADMIN_BASE}/rsvp/${listId}`);
}

async function deleteGuestList(cms: CmsClient, listId: number): Promise<Response> {
  const context = await guestListContext(cms, listId);
  if (!context) return new Response('not found', { status: 404 });
  await cms.remove(listId);
  return redirect(context.event ? `${ADMIN_BASE}/rsvp?event=${context.event.id}` : `${ADMIN_BASE}/rsvp`);
}

async function updateGuestStatus(request: Request, cms: CmsClient, listId: number, guestId: number): Promise<Response> {
  const guest = await cms.get(guestId);
  if (guest.page_type !== 'guest' || guest.page_id !== listId) return new Response('not found', { status: 404 });
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
  if (guest.page_type !== 'guest' || guest.page_id !== listId) return new Response('not found', { status: 404 });
  if (!items(guest.lect, 'checkin').length) {
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
  if (!context || guest.page_type !== 'guest' || guest.page_id !== listId) return new Response('not found', { status: 404 });

  const form = await request.formData();
  const targetId = pageId(form.get('target_mail_list'));
  if (!targetId || targetId === listId) return redirect(`${ADMIN_BASE}/rsvp/${listId}/guests/${guestId}`);

  const target = await cms.get(targetId);
  // Only allow moves within the same event, so a guest never leaves its event.
  if (target.page_type !== 'mail_list' || (context.eventId && target.page_id !== context.eventId)) {
    return new Response('not found', { status: 404 });
  }

  await cms.update(guestId, {
    page_id: targetId,
    lect: { _pointers: { ...(guest.lect._pointers as Record<string, unknown> ?? {}), mail_list: String(targetId) } },
  });
  return redirect(`${ADMIN_BASE}/rsvp/${targetId}`);
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

async function importGuests(request: Request, cms: CmsClient, listId: number): Promise<Response> {
  const context = await guestListContext(cms, listId);
  if (!context) return new Response('not found', { status: 404 });
  const form = await request.formData();
  const file = form.get('file') as unknown;
  if (!file || typeof (file as { text?: unknown }).text !== 'function') {
    return redirect(`${ADMIN_BASE}/rsvp/${listId}/import`);
  }

  const [headers = [], ...rows] = parseCsv(await (file as { text(): Promise<string> }).text());
  const columns = new Map(headers.map((header, index) => [header.trim().toLowerCase().replaceAll(' ', '_'), index]));
  const value = (row: string[], ...names: string[]): string => {
    for (const name of names) {
      const index = columns.get(name);
      if (index !== undefined) return row[index]?.trim() ?? '';
    }
    return '';
  };

  const inputs: CmsPageInput[] = [];
  for (const row of rows) {
    const name = value(row, 'name', 'first_name') || [value(row, 'first_name'), value(row, 'last_name')].filter(Boolean).join(' ');
    if (!name) continue;
    const fields = new Map<string, string>([
      ['last_name', value(row, 'last_name')],
      ['email', value(row, 'email')],
      ['phone', value(row, 'phone', 'mobile')],
      ['organization', value(row, 'organization', 'company')],
      ['job_title', value(row, 'job_title', 'title')],
      ['plus_guests', value(row, 'plus_guests') || '0'],
      ['status', normalizeStatus(value(row, 'status')) ?? 'to be invited'],
      ['prefer_language', value(row, 'prefer_language', 'language')],
      ['cc', value(row, 'cc')],
      ['remarks', value(row, 'remarks', 'notes')],
    ]);
    inputs.push(guestPageInput(name, fields, context.eventId, listId));
  }

  for (const chunk of chunks(inputs, 200)) await cms.batchCreate(chunk);
  return redirect(`${ADMIN_BASE}/rsvp/${listId}`);
}

async function exportGuests(cms: CmsClient, listId: number): Promise<Response> {
  const context = await guestListContext(cms, listId);
  if (!context) return new Response('not found', { status: 404 });
  const { pages } = await cms.list('guest', { parentId: listId, limit: 500 });
  const headers = ['name', 'last_name', 'email', 'phone', 'organization', 'job_title', 'plus_guests', 'status', 'prefer_language', 'cc', 'remarks', 'checked_in'];
  const rows = pages.map((guest) => {
    const values = guestValues(guest);
    return [
      values.name, values.last_name, values.email, values.phone, values.organization, values.job_title,
      values.plus_guests, values.status, values.prefer_language, values.cc, values.remarks,
      items(guest.lect, 'checkin').length ? 'yes' : 'no',
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

  const { pages: lists } = await cms.list('mail_list', { parentId: eventId, limit: 500 });
  const guestsByList = await Promise.all(
    lists.map((list) => cms.list('guest', { parentId: list.id, limit: 500 }).then((res) => res.pages)),
  );

  const headers = ['mail_list', 'name', 'last_name', 'email', 'phone', 'organization', 'job_title', 'plus_guests', 'status', 'prefer_language', 'cc', 'remarks', 'checked_in'];
  const rows: string[][] = [];
  lists.forEach((list, index) => {
    for (const guest of guestsByList[index] ?? []) {
      const values = guestValues(guest);
      rows.push([
        list.name, values.name, values.last_name, values.email, values.phone, values.organization, values.job_title,
        values.plus_guests, values.status, values.prefer_language, values.cc, values.remarks,
        items(guest.lect, 'checkin').length ? 'yes' : 'no',
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
  const eventId = pageId(list.page_id) ?? pageId(pointer(list.lect, 'event'));
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
    deleteAction: `${ADMIN_BASE}/rsvp/${list.id}/delete`,
    allowCheckin: attr(list.lect, 'allow_checkin') !== 'no',
  };
}

function guestRow(guest: CmsPage, listId: number): Record<string, unknown> {
  const values = guestValues(guest);
  return {
    ...values,
    id: guest.id,
    editHref: `${ADMIN_BASE}/rsvp/${listId}/guests/${guest.id}`,
    statusAction: `${ADMIN_BASE}/rsvp/${listId}/guests/${guest.id}/status`,
    checkinAction: `${ADMIN_BASE}/rsvp/${listId}/guests/${guest.id}/checkin`,
    checkedIn: items(guest.lect, 'checkin').length > 0,
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

function guestInput(
  form: FormData,
  eventId: number | null,
  listId: number,
  existing?: CmsPage,
): { name: string; lect: Record<string, unknown> } {
  const name = formText(form, 'name');
  const fields = new Map<string, string>([
    ['last_name', formText(form, 'last_name')],
    ['email', formText(form, 'email')],
    ['phone', formText(form, 'phone')],
    ['organization', formText(form, 'organization')],
    ['job_title', formText(form, 'job_title')],
    ['plus_guests', formText(form, 'plus_guests') || '0'],
    ['status', normalizeStatus(formText(form, 'status')) ?? 'to be invited'],
    ['prefer_language', formText(form, 'prefer_language')],
    ['cc', formText(form, 'cc')],
    ['remarks', formText(form, 'remarks')],
  ]);
  const input = guestPageInput(name, fields, eventId, listId);
  return { name, lect: { ...(existing?.lect ?? {}), ...input.lect } };
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

function normalizeStatus(value: string | null): GuestStatus | null {
  const normalized = value?.trim().toLowerCase() ?? '';
  return (GUEST_STATUSES as readonly string[]).includes(normalized) ? normalized as GuestStatus : null;
}

function pageId(value: unknown): number | null {
  const id = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function formText(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value.trim() : '';
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
