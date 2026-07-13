// ============================================================
// Ingested public submissions — apply + review.
//
// worker-rsvp stores public submits as rows in the published DB; worker-cms
// ingests them into the draft DB as pages (`rsvp_response` /
// `rsvp_registration`, uuid preserved) and fires this plugin's `create` hook.
// This module is the other half:
//
//   rsvp_response      — applied to the guest page automatically from the
//                        hook (status, plus_guests, response-log append),
//                        idempotent two ways: the guest's response entry
//                        carries `_ref: <submission uuid>` and the response
//                        page is stamped `applied_at`.
//   rsvp_registration  — waits for admin review (/events/:id/registrations):
//                        convert creates a guest on the event's "Adhoc" list
//                        (dedupe by email, then by prior conversion) or
//                        discard soft-deletes the page (the host refuses to
//                        unpublish submission types, so the original
//                        published row always survives).
// ============================================================

import {
  CmsApiError,
  CmsClient,
  attr,
  guestSlug,
  items,
  type CmsPage,
} from './cms';
import { ensureAdhocGuestList } from './rsvp';
import { adminView } from './templates/views';
import { redirect } from '@lionrockjs/worker-cms-plugin';

const ADMIN_BASE = '/admin/plugins/events';

/** Responses applied per pending-apply pass — keeps one request's CMS calls bounded. */
const APPLY_BATCH = 25;

export type ApplyOutcome = 'applied' | 'already_applied' | 'guest_missing' | 'not_a_response';

/**
 * Applies one ingested rsvp_response page to its guest. Safe to call from the
 * create hook and from the manual pending-apply pass — re-application is a
 * no-op via `applied_at` on the response page and `_ref` in the guest log.
 */
export async function applyResponsePage(cms: CmsClient, response: CmsPage | number): Promise<ApplyOutcome> {
  const page = typeof response === 'number' ? await cms.get(response) : response;
  if (page.page_type !== 'rsvp_response') return 'not_a_response';
  if (attr(page.lect, 'applied_at')) return 'already_applied';

  const now = new Date().toISOString();
  const guestId = page.page_id;
  let guest: CmsPage | null = null;
  if (guestId) {
    try {
      const candidate = await cms.get(guestId);
      guest = candidate.page_type === 'guest' ? candidate : null;
    } catch (error) {
      if (!(error instanceof CmsApiError && error.status === 404)) throw error;
    }
  }
  if (!guest) {
    // Guest never published / since deleted. Stamp the page so it doesn't sit
    // in "pending" forever; the note keeps the reason visible in the editor.
    await cms.update(page.id, { lect: { applied_at: now, applied_guest_id: '', apply_note: 'guest not found' } });
    return 'guest_missing';
  }

  const responseLog = items(guest.lect, 'response');
  const alreadyLogged = responseLog.some((entry) => entry._ref === page.uuid);
  if (!alreadyLogged) {
    const status = attr(page.lect, 'status') || 'confirmed';
    const submittedAt = attr(page.lect, 'submitted_at') || now;
    const answers = responseAnswers(page.lect.answers);
    const edmId = attr(page.lect, 'edm_id').trim();
    const latestResponse = record(guest.lect.latest_response);
    // Match the legacy RSVP contract: keep a complete, EDM-scoped copy of
    // the submitted form on the guest, while exposing RSVP custom fields as
    // flat lect attributes for CMS lists, exports, and the check-in plugin.
    const responseSnapshot: Record<string, unknown> = {
      ...answers,
      status,
      plus_guests: attr(page.lect, 'plus_guests') || '0',
      message: attr(page.lect, 'message'),
      submitted_at: submittedAt,
    };
    const customAnswers = Object.fromEntries(
      Object.entries(answers).filter(([key]) => key.startsWith('rsvp-custom-')),
    );
    await cms.update(guest.id, {
      lect: {
        status,
        plus_guests: attr(page.lect, 'plus_guests') || '0',
        // Refill permission is single-use, matching the legacy RSVP submit.
        allow_refill: '',
        ...customAnswers,
        latest_response: { ...latestResponse, [edmId || 'latest']: responseSnapshot },
        response: [...realEntries(responseLog), {
          status,
          date: submittedAt,
          message: attr(page.lect, 'message'),
          _ref: page.uuid,
        }],
      },
    });
  } else if (attr(guest.lect, 'allow_refill')) {
    // Repair a partial prior application without duplicating its response log.
    await cms.update(guest.id, { lect: { allow_refill: '' } });
  }

  await cms.update(page.id, { lect: { applied_at: now, applied_guest_id: String(guest.id) } });
  return 'applied';
}

/** Drops the blueprint-seeded empty row so applied logs stay clean. */
function realEntries(entries: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return entries.filter(
    (entry) => String(entry.status ?? '').trim() !== '' || String(entry.date ?? '').trim() !== '',
  );
}

/** Only retain public RSVP field names that worker-rsvp is allowed to submit. */
function responseAnswers(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const answers: Record<string, string> = {};
  for (const [key, answer] of Object.entries(value as Record<string, unknown>)) {
    if (!/^(?:rsvp-(?:public|custom|travel-hotel|pickup|plus-one)-|meal-|session-)[a-z0-9][a-z0-9:_-]*$/i.test(key)) continue;
    answers[key] = String(answer ?? '');
  }
  return answers;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export interface ApplyPendingResult {
  pending: number;
  applied: number;
  guestMissing: number;
}

export interface SubmissionRefreshResult {
  ingested: { scanned: number; created: number; more: boolean };
  responses: ApplyPendingResult;
}

/**
 * Fallback for missed create hooks: sweeps unapplied rsvp_response pages and
 * applies up to APPLY_BATCH of them.
 */
export async function applyPendingResponses(cms: CmsClient): Promise<ApplyPendingResult> {
  const { pages } = await cms.list('rsvp_response', { limit: 200 });
  const pending = pages.filter((page) => !attr(page.lect, 'applied_at'));
  let applied = 0;
  let guestMissing = 0;
  for (const page of pending.slice(0, APPLY_BATCH)) {
    const outcome = await applyResponsePage(cms, page);
    if (outcome === 'applied') applied += 1;
    if (outcome === 'guest_missing') guestMissing += 1;
  }
  return { pending: pending.length, applied, guestMissing };
}

/** Pulls the host's latest public RSVP rows and applies response rows to guests. */
export async function refreshSubmissions(cms: CmsClient): Promise<SubmissionRefreshResult> {
  const ingested = await cms.ingestSubmissions();
  const responses = await applyPendingResponses(cms);
  return { ingested, responses };
}

// ── Registration review (admin) ────────────────────────────────────────────────

export async function registrationsView(
  cms: CmsClient,
  views: Fetcher,
  eventId: number,
  url: URL,
  jsonOnly = false,
): Promise<Response> {
  const event = await cms.get(eventId);
  if (event.page_type !== 'event') return new Response('not found', { status: 404 });

  const { pages } = await cms.list('rsvp_registration', { parentId: eventId, limit: 200 });
  const { pages: responses } = await cms.list('rsvp_response', { limit: 200 });
  const pendingResponses = responses.filter((page) => !attr(page.lect, 'applied_at')).length;

  const rows = pages.map((page) => ({
    id: page.id,
    name: attr(page.lect, 'name') || page.name,
    email: attr(page.lect, 'email'),
    organization: attr(page.lect, 'organization'),
    jobTitle: attr(page.lect, 'job_title'),
    plusGuests: attr(page.lect, 'plus_guests') || '0',
    language: attr(page.lect, 'language'),
    submittedAt: attr(page.lect, 'submitted_at') || page.created_at,
    convertedGuestId: attr(page.lect, 'converted_guest_id'),
    editHref: `/admin/pages/${page.id}/edit?return_to=${encodeURIComponent(`${ADMIN_BASE}/events/${eventId}/registrations`)}`,
  }));

  return adminView(views, `Registrations — ${event.name}`, 'event-registrations', {
    event: { id: event.id, name: event.name },
    base: `${ADMIN_BASE}/events/${eventId}/registrations`,
    eventBase: `${ADMIN_BASE}/events/${eventId}`,
    pending: rows.filter((row) => !row.convertedGuestId),
    converted: rows.filter((row) => row.convertedGuestId),
    pendingResponses,
    flash: url.searchParams.get('flash') ?? '',
  }, jsonOnly);
}

/**
 * Pull new submissions from the published DB now (host ingest), then sweep
 * any unapplied responses. The "nothing shows up" debugging button.
 */
export async function pullSubmissions(cms: CmsClient, eventId: number): Promise<Response> {
  const { ingested, responses } = await refreshSubmissions(cms);
  const message = `Pulled ${ingested.created} new submission${ingested.created === 1 ? '' : 's'}`
    + (ingested.more ? ' (more waiting — pull again)' : '')
    + (responses.applied ? `; applied ${responses.applied} response${responses.applied === 1 ? '' : 's'}` : '');
  return redirectBack(eventId, message);
}

export type ConvertOutcome = 'converted' | 'linked_existing' | 'already_converted';

/**
 * Converts a registration into a guest on the event's "Adhoc" list. Dedupe:
 * a guest already converted from this registration (registration_ref), then
 * an email match on the list — either links instead of creating.
 */
export async function convertRegistration(cms: CmsClient, eventId: number, registrationId: number): Promise<Response> {
  const registration = await cms.get(registrationId);
  if (registration.page_type !== 'rsvp_registration' || registration.page_id !== eventId) {
    return new Response('not found', { status: 404 });
  }
  if (attr(registration.lect, 'converted_guest_id')) {
    return redirectBack(eventId, 'Already converted');
  }

  const list = await ensureAdhocGuestList(cms, eventId);
  const guests = await cms.listAll('guest', { pointer: { key: 'mail_list', value: list.id } });
  const email = attr(registration.lect, 'email').trim().toLowerCase();
  const existing = guests.find((guest) => attr(guest.lect, 'registration_ref') === registration.uuid)
    ?? (email ? guests.find((guest) => attr(guest.lect, 'email').trim().toLowerCase() === email) : undefined);
  const answers = responseAnswers(registration.lect.answers);
  const customAnswers = Object.fromEntries(
    Object.entries(answers).filter(([key]) => key.startsWith('rsvp-custom-')),
  );

  let outcome: ConvertOutcome = 'already_converted';
  let guestId: number;
  if (existing) {
    guestId = existing.id;
    outcome = 'linked_existing';
    await cms.update(existing.id, {
      lect: {
        ...customAnswers,
        ...(Object.keys(answers).length > 0 ? { public_registration: answers } : {}),
      },
    });
  } else {
    const name = attr(registration.lect, 'name') || registration.name;
    const submittedAt = attr(registration.lect, 'submitted_at') || new Date().toISOString();
    const created = await cms.create({
      page_type: 'guest',
      page_id: list.id,
      name,
      slug: guestSlug(),
      lect: {
        _type: 'guest',
        prefix: attr(registration.lect, 'salutation'),
        salutation: attr(registration.lect, 'salutation'),
        name: { en: name },
        first_name: { en: attr(registration.lect, 'first_name') },
        last_name: { en: attr(registration.lect, 'last_name') },
        email: attr(registration.lect, 'email'),
        organization: attr(registration.lect, 'organization'),
        job_title: attr(registration.lect, 'job_title'),
        plus_guests: attr(registration.lect, 'plus_guests') || '0',
        prefer_language: attr(registration.lect, 'language'),
        status: 'confirmed',
        type: 'adhoc',
        registration_ref: registration.uuid,
        _pointers: { event: String(eventId), mail_list: String(list.id) },
        response: [{ status: 'confirmed', date: submittedAt, message: 'public registration', _ref: registration.uuid }],
        ...customAnswers,
        ...(Object.keys(answers).length > 0 ? { public_registration: answers } : {}),
      },
    });
    guestId = created.id;
    outcome = 'converted';
  }

  await cms.update(registration.id, {
    lect: { converted_guest_id: String(guestId), converted_at: new Date().toISOString() },
  });
  return redirectBack(
    eventId,
    outcome === 'converted' ? 'Registration converted to a guest' : 'Linked to an existing guest (matched by email)',
  );
}

/**
 * Discards a registration: soft-delete to the CMS trash. The host refuses to
 * unpublish submission page types, so the original published row survives —
 * only the draft review copy goes away.
 */
export async function discardRegistration(cms: CmsClient, eventId: number, registrationId: number): Promise<Response> {
  const registration = await cms.get(registrationId);
  if (registration.page_type !== 'rsvp_registration' || registration.page_id !== eventId) {
    return new Response('not found', { status: 404 });
  }
  await cms.remove(registration.id);
  return redirectBack(eventId, 'Registration discarded');
}

function redirectBack(eventId: number, message: string): Response {
  return redirect(`${ADMIN_BASE}/events/${eventId}/registrations?flash=${encodeURIComponent(message)}`);
}
