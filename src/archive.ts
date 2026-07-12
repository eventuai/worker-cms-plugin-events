// ============================================================
// Event archive — close an event out into the contact database.
//
// GET  /events/:id/archive           — preview: every guest on the event
//   classified against the contact database (all guests / duplicated guests /
//   new contacts / duplicated contacts (contact ID matched) / likely
//   duplicated contacts). No writes.
// POST /events/:id/archive           — apply (action=apply), archive without
//   merging (action=skip), or restore (action=unarchive).
// POST /events/:id/archive/continue  — next bounded pass of a running apply.
//
// Applying merges each guest's event activity into a contact `event_history`
// entry (creating contacts for unmatched guests — requires the manifest's
// `writeTypes: ["contact"]` to be admin-approved), stamps the guest with the
// contact pointer + `contact_merged_at`, then moves the event's ingested
// `rsvp_response` / `rsvp_registration` pages to trash (the host refuses to
// unpublish submission types, so worker-rsvp's published rows survive) and
// finally marks the event `archived: yes`.
//
// Every step is idempotent — guests are skipped once stamped, history entries
// carry `_ref: <guest uuid>` — so the apply runs as resumable passes under the
// per-invocation subrequest cap, mirroring the event-delete flow.
// ============================================================

import {
  CmsApiError,
  CmsClient,
  attr,
  chargeCreditAction,
  checkins,
  items,
  listByEvent,
  localized,
  type CmsPage,
  type CmsPageInput,
} from './cms';
import { contactToGuestFields, guestContactId, guestMatchKey } from './rsvp';
import { adminView } from './templates/views';
import { redirect } from '@lionrockjs/worker-cms-plugin';

const ADMIN_BASE = '/admin/plugins/events';

/** Contact reconciliation cap — large CRMs match against the first slice only. */
const CONTACT_CAP = 2000;

/** Approximate subrequests (reads + writes) per apply pass, with headroom under
 *  Cloudflare's free-plan cap of 50 for auth, rendering and the final update. */
const ARCHIVE_PASS_BUDGET = 40;

/** Ids per DELETE /pages/batch call when trashing submission pages. */
const TRASH_BATCH = 100;

export function isArchived(lect: Record<string, unknown>): boolean {
  return attr(lect, 'archived').trim().toLowerCase() === 'yes';
}

export function isArchiving(lect: Record<string, unknown>): boolean {
  return attr(lect, 'archiving').trim().toLowerCase() === 'yes';
}

// ── Contact index ─────────────────────────────────────────────────────────────

interface ContactIndex {
  byId: Map<string, CmsPage>;
  byEmail: Map<string, CmsPage>;
  /** Normalized full name → contact; `null` marks an ambiguous name (2+ contacts). */
  byName: Map<string, CmsPage | null>;
  requests: number;
  capped: boolean;
}

function normalizedName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

async function loadContactIndex(cms: CmsClient): Promise<ContactIndex> {
  const byId = new Map<string, CmsPage>();
  const byEmail = new Map<string, CmsPage>();
  const byName = new Map<string, CmsPage | null>();
  let total = 0;
  let requests = 0;
  for (let offset = 0; offset < CONTACT_CAP; offset += 500) {
    const { pages, total: reported } = await cms.list('contact', { limit: 500, offset });
    requests += 1;
    total = reported;
    for (const contact of pages) {
      byId.set(String(contact.id), contact);
      const fields = contactToGuestFields(contact);
      const email = fields.email.trim().toLowerCase();
      if (email && !byEmail.has(email)) byEmail.set(email, contact);
      const name = normalizedName(fields.name);
      if (name) byName.set(name, byName.has(name) ? null : contact);
    }
    if (offset + pages.length >= total || pages.length === 0) break;
  }
  return { byId, byEmail, byName, requests, capped: total > CONTACT_CAP };
}

// ── Classification (shared by preview and apply) ──────────────────────────────

export type ArchiveCategory = 'merged' | 'duplicate' | 'linked' | 'likely' | 'new';

interface ArchiveRow {
  guest: CmsPage;
  listName: string;
  /** Identity within the event: email if present, else normalized full name. */
  matchKey: string;
  category: ArchiveCategory;
  /** Merge target when already resolved (linked / likely / merged). */
  contactId: string;
  contact: CmsPage | null;
  detail: string;
}

interface ArchivePlan {
  rows: ArchiveRow[];
  contacts: ContactIndex;
  /** Host requests spent building the plan (contact pages + list + guest fetches). */
  readRequests: number;
}

function guestFullName(guest: CmsPage): string {
  const first = localized(guest.lect, 'name') || guest.name;
  const last = localized(guest.lect, 'last_name');
  return [first, last].map((part) => part.trim()).filter(Boolean).join(' ');
}

/** Field drift between a guest and its linked contact, for the preview detail. */
function driftDetail(guest: CmsPage, contact: CmsPage): string {
  const fields = contactToGuestFields(contact);
  const diffs: string[] = [];
  for (const [label, guestValue, contactValue] of [
    ['email', attr(guest.lect, 'email').toLowerCase(), fields.email.toLowerCase()],
    ['organization', attr(guest.lect, 'organization'), fields.organization],
    ['job title', attr(guest.lect, 'job_title'), fields.job_title],
  ] as Array<[string, string, string]>) {
    if (guestValue && contactValue && guestValue.trim() !== contactValue.trim()) {
      diffs.push(`${label}: ${guestValue} ≠ ${contactValue}`);
    }
  }
  return diffs.join(' · ');
}

function classifyGuest(
  guest: CmsPage,
  listName: string,
  contacts: ContactIndex,
  byKey: Map<string, ArchiveRow>,
): ArchiveRow {
  const email = attr(guest.lect, 'email').trim().toLowerCase();
  const fullName = guestFullName(guest);
  const matchKey = guestMatchKey(fullName, email);
  const base = { guest, listName, matchKey, contactId: '', contact: null as CmsPage | null, detail: '' };

  // Already stamped by an earlier pass — skip on apply, but still claim the
  // match key so duplicates of this guest resolve to the same contact.
  if (attr(guest.lect, 'contact_merged_at').trim()) {
    const contactId = guestContactId(guest);
    const row: ArchiveRow = {
      ...base,
      category: 'merged',
      contactId,
      detail: contactId ? `already merged into contact #${contactId}` : 'already merged',
    };
    if (!byKey.has(matchKey)) byKey.set(matchKey, row);
    return row;
  }

  const primary = byKey.get(matchKey);
  if (primary) {
    return {
      ...base,
      category: 'duplicate',
      detail: `same person as ${primary.guest.name || 'guest'} (${primary.listName})`,
    };
  }

  let row: ArchiveRow;
  const linkedId = guestContactId(guest);
  if (linkedId) {
    const linked = contacts.byId.get(linkedId);
    // A pointer beyond the contact cap (or to a missing page) still counts as
    // linked; apply verifies it with a direct read and falls back to create.
    row = {
      ...base,
      category: 'linked',
      contactId: linkedId,
      contact: linked ?? null,
      detail: linked ? (driftDetail(guest, linked) || `contact #${linkedId}`) : `contact #${linkedId} (not verified)`,
    };
  } else {
    const byEmail = email ? contacts.byEmail.get(email) : undefined;
    const byName = byEmail ? undefined : contacts.byName.get(normalizedName(fullName));
    if (byEmail) {
      row = { ...base, category: 'likely', contactId: String(byEmail.id), contact: byEmail, detail: `contact #${byEmail.id} shares this email` };
    } else if (byName) {
      row = { ...base, category: 'likely', contactId: String(byName.id), contact: byName, detail: `contact #${byName.id} has the same name` };
    } else {
      row = { ...base, category: 'new', detail: 'a new contact will be created' };
    }
  }
  byKey.set(matchKey, row);
  return row;
}

async function buildArchivePlan(cms: CmsClient, eventId: number): Promise<ArchivePlan> {
  const contacts = await loadContactIndex(cms);
  const lists = await listByEvent(cms, 'mail_list', eventId);
  let readRequests = contacts.requests + 1;

  const rows: ArchiveRow[] = [];
  const byKey = new Map<string, ArchiveRow>();
  for (const list of lists) {
    const guests = await cms.listAll('guest', { pointer: { key: 'mail_list', value: list.id } });
    readRequests += Math.max(1, Math.ceil(guests.length / 500));
    for (const guest of guests) rows.push(classifyGuest(guest, list.name, contacts, byKey));
  }
  return { rows, contacts, readRequests };
}

// ── Preview ───────────────────────────────────────────────────────────────────

/** Rows rendered per preview section; the rest collapse into a "+N more" line. */
const PREVIEW_ROW_CAP = 300;

export async function archiveReview(cms: CmsClient, views: Fetcher, eventId: number, jsonOnly = false): Promise<Response> {
  const event = await cms.get(eventId);
  if (event.page_type !== 'event') return errorPanel(views, 'Event not found.', jsonOnly);
  if (isArchiving(event.lect)) {
    return archiveProgressView(views, eventId, event.name, false, 'Archiving is ready to continue.', jsonOnly);
  }

  const plan = await buildArchivePlan(cms, eventId);
  const byCategory = (category: ArchiveCategory) => plan.rows.filter((row) => row.category === category);
  const duplicates = byCategory('duplicate');
  const linked = byCategory('linked');
  const likely = byCategory('likely');
  const fresh = byCategory('new');
  const merged = byCategory('merged');

  const section = (key: string, label: string, hint: string, rows: ArchiveRow[]) => ({
    key,
    label,
    hint,
    count: rows.length,
    rows: rows.slice(0, PREVIEW_ROW_CAP).map((row) => ({
      name: row.guest.name,
      listName: row.listName,
      email: attr(row.guest.lect, 'email'),
      detail: row.detail,
    })),
    moreCount: Math.max(0, rows.length - PREVIEW_ROW_CAP),
  });

  return adminView(views, `Archive — ${event.name}`, 'event-archive', {
    eventName: event.name,
    backHref: `${ADMIN_BASE}/events/${eventId}`,
    action: `${ADMIN_BASE}/events/${eventId}/archive`,
    archived: isArchived(event.lect),
    guestTotal: plan.rows.length,
    pendingTotal: plan.rows.length - merged.length,
    contactsCapped: plan.contacts.capped,
    tiles: [
      { label: 'All guests', value: plan.rows.length },
      { label: 'Duplicated guests', value: duplicates.length },
      { label: 'Duplicated contacts', value: linked.length },
      { label: 'Likely duplicates', value: likely.length },
      { label: 'New contacts', value: fresh.length },
      ...(merged.length ? [{ label: 'Already merged', value: merged.length }] : []),
    ],
    sections: [
      section('duplicates', 'Duplicated guests', 'The same person appears more than once on this event — every copy\'s activity merges into one contact.', duplicates),
      section('linked', 'Duplicated contacts (contact ID matched)', 'Guests linked to a contact record — event activity is added to that contact.', linked),
      section('likely', 'Likely duplicated contacts', 'Not linked, but a contact shares the guest\'s email or exact name — activity merges into the matched contact.', likely),
      section('new', 'New contacts', 'No contact matched — a contact record is created from the guest.', fresh),
      ...(merged.length ? [section('merged', 'Already merged', 'Stamped by an earlier archive run — skipped when applying.', merged)] : []),
    ],
  }, jsonOnly);
}

// ── Apply (resumable passes) ──────────────────────────────────────────────────

class ArchivePass {
  spent = 0;
  merged = 0;
  contactsCreated = 0;
  historyAppended = 0;
  responsesTrashed = 0;
  registrationsTrashed = 0;
  capped = false;

  get done(): boolean {
    return this.capped || this.spent >= ARCHIVE_PASS_BUDGET;
  }

  get progressed(): boolean {
    return this.merged + this.contactsCreated + this.responsesTrashed + this.registrationsTrashed > 0;
  }

  spend(requests = 1): void {
    this.spent += requests;
  }
}

/** The runtime's per-invocation subrequest cap; thrown by fetch itself. */
function isSubrequestLimitError(error: unknown): boolean {
  return error instanceof Error && /too many subrequests/i.test(error.message);
}

/** POST /events/:id/archive — apply, archive-only, or restore. */
export async function archiveEvent(request: Request, cms: CmsClient, views: Fetcher, eventId: number, jsonOnly = false): Promise<Response> {
  const event = await cms.get(eventId);
  if (event.page_type !== 'event') return new Response('not found', { status: 404 });
  const form = await request.formData();
  const action = String(form.get('action') ?? 'apply');

  if (action === 'unarchive') {
    await chargeCreditAction(cms, 'archive_event', 1, { entityType: 'event', entityId: eventId, note: 'Restore event' });
    await cms.update(eventId, { lect: { archived: '', archiving: '' } });
    return redirect(withFlash(`${ADMIN_BASE}/events`, `Event “${event.name}” restored`));
  }

  if (action === 'skip') {
    // Legacy behavior: hide the event without touching contacts or submissions.
    await chargeCreditAction(cms, 'archive_event', 1, { entityType: 'event', entityId: eventId, note: 'Archive event (no merge)' });
    await cms.update(eventId, { lect: { archived: 'yes', archiving: '' } });
    return redirect(withFlash(`${ADMIN_BASE}/events?archived=1`, `Event “${event.name}” archived`));
  }

  if (!isArchiving(event.lect)) {
    await chargeCreditAction(cms, 'archive_event', 1, { entityType: 'event', entityId: eventId, note: 'Archive event (merge into contacts)' });
    await cms.update(eventId, { lect: { archiving: 'yes', archiving_at: new Date().toISOString() } });
  }
  return runArchivePass(cms, views, eventId, event.name, jsonOnly);
}

/** POST /events/:id/archive/continue — next pass of a running apply. */
export async function continueEventArchive(cms: CmsClient, views: Fetcher, eventId: number, jsonOnly = false): Promise<Response> {
  const event = await cms.get(eventId);
  if (event.page_type !== 'event') return new Response('not found', { status: 404 });
  if (!isArchiving(event.lect)) {
    if (isArchived(event.lect)) return redirect(withFlash(`${ADMIN_BASE}/events?archived=1`, `Event “${event.name}” archived`));
    return redirect(`${ADMIN_BASE}/events/${eventId}/archive`);
  }
  return runArchivePass(cms, views, eventId, event.name, jsonOnly);
}

async function runArchivePass(cms: CmsClient, views: Fetcher, eventId: number, eventName: string, jsonOnly: boolean): Promise<Response> {
  const pass = new ArchivePass();
  let done: boolean;
  try {
    done = await archivePass(cms, eventId, pass);
  } catch (error) {
    if (error instanceof CmsApiError && error.code === 'forbidden_page_type') {
      return errorPanel(
        views,
        'The events plugin is not approved to write contact pages, so nothing was merged. '
        + 'Ask an administrator to approve the "contact" page type under Plugins → events → Page types, then continue archiving.',
        jsonOnly,
      );
    }
    if (!isSubrequestLimitError(error)) throw error;
    return archiveProgressView(views, eventId, eventName, false, 'This pass reached the runtime limit before it could continue.', jsonOnly);
  }

  if (done) {
    await cms.update(eventId, { lect: { archived: 'yes', archiving: '', archived_at: new Date().toISOString() } });
    return redirect(withFlash(`${ADMIN_BASE}/events?archived=1`, `Event “${eventName}” archived — guests merged into contacts and submissions moved to trash.`));
  }

  const summary = [
    pass.contactsCreated ? `${pass.contactsCreated} contact(s) created` : '',
    pass.merged ? `${pass.merged} guest(s) merged` : '',
    pass.responsesTrashed ? `${pass.responsesTrashed} response(s) moved to trash` : '',
    pass.registrationsTrashed ? `${pass.registrationsTrashed} registration(s) moved to trash` : '',
  ].filter(Boolean).join(', ') || 'No items processed this pass';
  return archiveProgressView(views, eventId, eventName, pass.progressed, `${summary}.`, jsonOnly);
}

/** One bounded pass. Returns true when nothing is left to do. */
async function archivePass(cms: CmsClient, eventId: number, pass: ArchivePass): Promise<boolean> {
  const event = await cms.get(eventId);
  pass.spend(1);
  const plan = await buildArchivePlan(cms, eventId);
  pass.spend(plan.readRequests);

  // Contacts resolved for a match key — seeded from already-merged guests so
  // duplicates stamped across passes land on the same contact.
  const contactByKey = new Map<string, string>();
  for (const row of plan.rows) {
    if (row.category === 'merged' && row.contactId) contactByKey.set(row.matchKey, row.contactId);
  }

  const pending = plan.rows.filter((row) => row.category !== 'merged');
  try {
    for (const [index, row] of pending.entries()) {
      // Always process at least one guest so a plan whose reads alone exhaust
      // the estimate still makes progress; the runtime cap is the hard stop.
      if (index > 0 && pass.done) return false;
      await mergeGuest(cms, event, row, contactByKey, plan.contacts, pass);
    }
    const trashed = await trashSubmissions(cms, eventId, pass);
    return trashed;
  } catch (error) {
    if (!isSubrequestLimitError(error)) throw error;
    pass.capped = true;
    return false;
  }
}

/**
 * Merges one guest into the contact database: resolve or create the target
 * contact, append the guest's event activity to its `event_history` (guarded
 * by `_ref`), and stamp the guest with the pointer + `contact_merged_at`.
 */
async function mergeGuest(
  cms: CmsClient,
  event: CmsPage,
  row: ArchiveRow,
  contactByKey: Map<string, string>,
  contacts: ContactIndex,
  pass: ArchivePass,
): Promise<void> {
  // Resolve the target: a contact another copy of this person already got,
  // then the row's own match, then a fresh create.
  let contactId = contactByKey.get(row.matchKey) ?? row.contactId;
  let contact = (contactId ? contacts.byId.get(contactId) : undefined) ?? row.contact;

  if (contactId && (!contact || String(contact.id) !== contactId)) {
    // Pointer beyond the loaded contact slice — verify it before writing.
    pass.spend(1);
    try {
      const fetched = await cms.get(Number(contactId));
      contact = fetched.page_type === 'contact' ? fetched : null;
    } catch (error) {
      if (!(error instanceof CmsApiError && (error.status === 404 || error.status === 403))) throw error;
      contact = null;
    }
    if (!contact) contactId = '';
  }

  if (!contact || !contactId) {
    pass.spend(1);
    contact = await cms.create(contactInputFromGuest(event, row));
    contactId = String(contact.id);
    pass.contactsCreated += 1;
    contacts.byId.set(contactId, contact);
  } else if (!historyEntries(contact).some((entry) => entry._ref === row.guest.uuid)) {
    pass.spend(1);
    const history = [...historyEntries(contact), eventHistoryEntry(event, row)];
    await cms.update(contact.id, { lect: { event_history: history } });
    // Keep the in-memory copy current so more guests merging into this contact
    // within the same pass see the appended entry.
    contact.lect = { ...contact.lect, event_history: history };
    pass.historyAppended += 1;
  }

  pass.spend(1);
  await cms.update(row.guest.id, {
    lect: {
      contact_merged_at: new Date().toISOString(),
      _pointers: { ...(row.guest.lect._pointers as Record<string, unknown> ?? {}), contact: contactId },
    },
  });
  pass.merged += 1;
  contactByKey.set(row.matchKey, contactId);
}

/** Real (non-blueprint-seeded) event_history entries on a contact. */
function historyEntries(contact: CmsPage): Array<Record<string, unknown>> {
  return items(contact.lect, 'event_history').filter(
    (entry) => attr(entry, 'event_name').trim() !== '' || attr(entry, 'date').trim() !== '',
  );
}

/** The guest's event activity condensed to one contact event_history entry. */
function eventHistoryEntry(event: CmsPage, row: ArchiveRow): Record<string, unknown> {
  const guest = row.guest;
  const checkinEntries = checkins(guest.lect);
  const sessions = [...new Set(
    checkinEntries
      .filter((entry) => attr(entry, 'status') === 'session-checked-in')
      .map((entry) => attr(entry, 'message').trim())
      .filter(Boolean),
  )];
  const checkedIn = checkinEntries.some((entry) => ['checked-in', 'session-checked-in'].includes(attr(entry, 'status')));
  const responses = items(guest.lect, 'response').filter(
    (entry) => attr(entry, 'status').trim() !== '' || attr(entry, 'date').trim() !== '',
  );
  const remark = [
    `List: ${row.listName}`,
    checkedIn ? 'checked in' : '',
    responses.length ? `${responses.length} RSVP response(s)` : '',
  ].filter(Boolean).join(' · ');
  return {
    date: (event.start ?? '').slice(0, 10) || new Date().toISOString().slice(0, 10),
    event_name: event.name,
    role: attr(guest.lect, 'type') === 'adhoc' ? 'adhoc' : 'guest',
    session: sessions.join(', '),
    rsvp: attr(guest.lect, 'status') || 'to be invited',
    group_rsvp: attr(guest.lect, 'plus_guests') || '0',
    remark,
    _ref: guest.uuid,
  };
}

/** Contact record created from an unmatched guest, with the history entry inline. */
function contactInputFromGuest(event: CmsPage, row: ArchiveRow): CmsPageInput {
  const lect = row.guest.lect;
  const first = (localized(lect, 'name') || row.guest.name).trim();
  const last = localized(lect, 'last_name').trim();
  const fullName = [first, last].filter(Boolean).join(' ');
  const email = attr(lect, 'email').trim();
  const phone = attr(lect, 'phone').trim();
  const organization = attr(lect, 'organization').trim();
  const jobTitle = attr(lect, 'job_title').trim();
  return {
    page_type: 'contact',
    name: fullName || row.guest.name,
    lect: {
      _type: 'contact',
      source: 'events-archive',
      prefix: attr(lect, 'prefix'),
      nationality: attr(lect, 'nationality'),
      prefer_language: attr(lect, 'prefer_language'),
      first_name: first ? { en: first } : '',
      last_name: last ? { en: last } : '',
      full_name: fullName ? { en: fullName } : '',
      ...(email ? { email: [{ type: 'other', email }] } : {}),
      ...(phone ? { phone: [{ type: 'mobile', phone }] } : {}),
      ...(organization || jobTitle
        ? { position: [{ type: 'work', organization_name: { en: organization }, title: { en: jobTitle } }] }
        : {}),
      event_history: [eventHistoryEntry(event, row)],
    },
  };
}

/**
 * Moves the event's ingested submission pages to the CMS trash. The host
 * refuses to unpublish submission types, so worker-rsvp's published rows (its
 * already-responded checks) are untouched — only the draft copies go away.
 * Returns true when none remain.
 */
async function trashSubmissions(cms: CmsClient, eventId: number, pass: ArchivePass): Promise<boolean> {
  // Responses carry the event only as a lect attribute (no pointer index), so
  // list them all and filter; trashed rows leave the listing, making each pass
  // pick up where the last stopped.
  pass.spend(1);
  const responses = await cms.listAll('rsvp_response', {});
  pass.spend(Math.floor(responses.length / 500));
  const responseIds = responses
    .filter((page) => attr(page.lect, 'event_id') === String(eventId))
    .map((page) => page.id);
  for (let start = 0; start < responseIds.length; start += TRASH_BATCH) {
    if (pass.done) return false;
    pass.spend(1);
    const chunk = responseIds.slice(start, start + TRASH_BATCH);
    await cms.batchRemove(chunk);
    pass.responsesTrashed += chunk.length;
  }

  // Registrations are children of the event page (page_id = event id).
  for (;;) {
    if (pass.done) return false;
    pass.spend(1);
    const { ids, more } = await cms.listIdsPage('rsvp_registration', { parentId: eventId }, TRASH_BATCH);
    if (!ids.length) return true;
    if (pass.done) return false;
    pass.spend(1);
    await cms.batchRemove(ids);
    pass.registrationsTrashed += ids.length;
    if (!more) return true;
  }
}

// ── Views ─────────────────────────────────────────────────────────────────────

function archiveProgressView(
  views: Fetcher,
  eventId: number,
  eventName: string,
  auto: boolean,
  summary: string,
  jsonOnly: boolean,
): Promise<Response> {
  return adminView(views, 'Archiving event…', 'event-archive-progress', {
    eventName,
    summary,
    auto,
    action: `${ADMIN_BASE}/events/${eventId}/archive/continue`,
    backHref: `${ADMIN_BASE}/events/${eventId}`,
  }, jsonOnly);
}

function errorPanel(views: Fetcher, message: string, jsonOnly: boolean): Promise<Response> {
  return adminView(views, 'Error', 'error', { message, showConfig: false }, jsonOnly);
}

function withFlash(path: string, message: string): string {
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}flash=${encodeURIComponent(message)}`;
}
