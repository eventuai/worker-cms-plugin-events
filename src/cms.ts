// ============================================================
// F1 client — the Events Suite's channel back into the CMS.
//
// The CMS exposes a PLUGIN_SECRET-authenticated page read/write API at
// `{CMS_URL}/__cms/*` (see the CMS repo, src/routes/cms-api.ts). This module
// wraps it so the plugin can treat events, guests and mail lists as the CMS
// pages they are — the single source of truth — instead of keeping its own
// store. Writes are scoped by the CMS to the page types this plugin declares
// in its manifest (`event`, `guest`, `label`, `edm`, `mail_list`, …).
//
// Identity is carried by two headers on every call:
//   x-plugin-secret : the shared secret (== CMS PLUGIN_SECRET)
//   x-plugin-id     : this plugin's manifest id, which the CMS uses to scope
//                     writes to the content types we own.
// ============================================================

/** Manifest id — must equal MANIFEST.id and the CMS-registered plugin id. */
export const PLUGIN_ID = 'events';

export interface CmsClientEnv {
  /** Base URL of the CMS Worker, e.g. https://cms.eventuai.com (no trailing slash needed). */
  CMS_URL?: string;
  /** Shared secret, identical to the CMS PLUGIN_SECRET. */
  PLUGIN_SECRET?: string;
}

/** A page as returned by the F1 API (lect is the parsed structured content). */
export interface CmsPage {
  id: number;
  uuid: string;
  page_type: string | null;
  name: string;
  slug: string;
  weight: number;
  start: string | null;
  end: string | null;
  /** Native CMS page column (offset like "+0800" or an IANA zone), not part of lect. */
  timezone: string | null;
  page_id: number | null;
  created_at: string;
  updated_at: string;
  lect: Record<string, unknown>;
  tags?: number[];
  /** Attached by the plugin (see computeGuestListSummary) for mail_list pages — not part of the CMS API. */
  guest_summary?: GuestListSummary;
}

export interface GuestListSummary {
  guest_count: number;
  guest_total: number;
  onhold_count: number;
  to_be_invited_count: number;
  invited_count: number;
  confirmed_count: number;
  declined_count: number;
  unconfirmed_count: number;
  checked_in_count: number;
  checked_in_total: number;
}

export interface CmsPageInput {
  id?: number;
  page_type?: string;
  name?: string;
  slug?: string;
  lect?: Record<string, unknown>;
  weight?: number;
  start?: string | null;
  end?: string | null;
  page_id?: number | null;
  tags?: number[];
}

/** Compare admin-ordered pages by `weight`, keeping unweighted pages after weighted ones. */
export function compareByWeightThenName(a: CmsPage, b: CmsPage): number {
  const aw = Number(a.weight);
  const bw = Number(b.weight);
  const aWeight = Number.isFinite(aw) ? aw : Number.MAX_SAFE_INTEGER;
  const bWeight = Number.isFinite(bw) ? bw : Number.MAX_SAFE_INTEGER;
  return (aWeight - bWeight) || a.name.localeCompare(b.name);
}

export class CmsApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public method = '',
    public path = '',
  ) {
    const target = method && path ? ` ${method} ${path}` : '';
    super(`CMS API${target} ${status}: ${code}`);
    this.name = 'CmsApiError';
  }
}

/** Thrown when CMS_URL / PLUGIN_SECRET are not configured — surfaces a clear admin message. */
export class CmsNotConfiguredError extends Error {
  constructor() {
    super('CMS_URL and PLUGIN_SECRET must be set for the events plugin to reach the CMS');
    this.name = 'CmsNotConfiguredError';
  }
}

export class CmsClient {
  private readonly base: string;
  private readonly secret: string;

  constructor(env: CmsClientEnv) {
    if (!env.CMS_URL || !env.PLUGIN_SECRET) throw new CmsNotConfiguredError();
    this.base = env.CMS_URL.replace(/\/+$/, '');
    this.secret = env.PLUGIN_SECRET;
  }

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${this.base}/__cms${path}`, {
      method,
      headers: {
        'x-plugin-secret': this.secret,
        'x-plugin-id': PLUGIN_ID,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  private async json<T>(res: Response, method = '', path = ''): Promise<T> {
    if (!res.ok) {
      const code = await res.text()
        .then((text) => {
          if (!text) return 'error';
          try {
            const body = JSON.parse(text) as { error?: unknown };
            return typeof body.error === 'string' && body.error ? body.error : 'error';
          } catch {
            return text.replace(/\s+/g, ' ').trim().slice(0, 160) || 'error';
          }
        })
        .catch(() => 'error');
      throw new CmsApiError(res.status, code, method, path);
    }
    return res.json() as Promise<T>;
  }

  /** List pages of a type, optionally filtered by parent page id or a lect pointer. */
  async list(
    pageType: string,
    opts: { parentId?: number; pointer?: { key: string; value: number }; q?: string; limit?: number; offset?: number } = {},
  ): Promise<{ pages: CmsPage[]; total: number }> {
    const params = new URLSearchParams({ page_type: pageType });
    if (opts.parentId != null) params.set('page_id', String(opts.parentId));
    if (opts.pointer) {
      params.set('pointer_key', opts.pointer.key);
      params.set('pointer_value', String(opts.pointer.value));
    }
    if (opts.q) params.set('q', opts.q);
    if (opts.limit != null) params.set('limit', String(opts.limit));
    if (opts.offset != null) params.set('offset', String(opts.offset));
    const path = `/pages?${params.toString()}`;
    return this.json(await this.call('GET', path), 'GET', path);
  }

  async get(id: number): Promise<CmsPage> {
    const path = `/pages/${id}`;
    const { page } = await this.json<{ page: CmsPage }>(await this.call('GET', path), 'GET', path);
    return page;
  }

  async create(input: CmsPageInput): Promise<CmsPage> {
    const { page } = await this.json<{ page: CmsPage }>(await this.call('POST', '/pages', input), 'POST', '/pages');
    return page;
  }

  async update(id: number, input: CmsPageInput): Promise<CmsPage> {
    const path = `/pages/${id}`;
    const { page } = await this.json<{ page: CmsPage }>(await this.call('PUT', path, input), 'PUT', path);
    return page;
  }

  async remove(id: number): Promise<void> {
    const path = `/pages/${id}`;
    await this.json(await this.call('DELETE', path), 'DELETE', path);
  }

  /** Batch-create (bulk import / bulk add-to-list); the CMS caps the batch size. */
  async batchCreate(pages: CmsPageInput[]): Promise<{ created: CmsPage[]; errors: Array<{ index: number; error: string }> }> {
    return this.json(await this.call('POST', '/pages/batch', { pages }), 'POST', '/pages/batch');
  }
}

/**
 * Lists the pages of a type that belong to an event. `edm` and `mail_list` pages
 * group under their event by `lect._pointers.event`, not by parent page (their
 * parent may be a different page type). The CMS list API only filters by parent
 * id, so we fetch the type and filter on the pointer here.
 */
export async function listByEvent(
  cms: CmsClient,
  pageType: string,
  eventId: number,
  opts: { limit?: number } = {},
): Promise<CmsPage[]> {
  const { pages } = await cms.list(pageType, { limit: opts.limit ?? 500 });
  const target = String(eventId);
  return pages.filter((page) => pointer(page.lect, 'event') === target);
}

// ── Lect helpers ──────────────────────────────────────────────────────────────
// The CMS lect drops the blueprint markers: `@status` is stored as `status`,
// `name` as a { lang: value } map, and `*event` under `_pointers.event`. These
// helpers read/write that canonical shape so guest pages stay editable in the
// CMS editor.

/** Reads a scalar attribute (an `@field` in the blueprint, stored without the @). */
export function attr(lect: Record<string, unknown>, key: string): string {
  const v = lect[key];
  return v == null ? '' : String(v);
}

/** Reads a localized field (e.g. `name`) for a language, falling back to any value. */
export function localized(lect: Record<string, unknown>, key: string, lang = 'en'): string {
  const v = lect[key];
  if (v == null) return '';
  if (typeof v === 'object' && !Array.isArray(v)) {
    const map = v as Record<string, unknown>;
    return String(map[lang] ?? Object.values(map)[0] ?? '');
  }
  return String(v);
}

/** Reads an item list (e.g. `response`, `checkin`) as an array of records. */
export function items(lect: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const v = lect[key];
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
}

/**
 * Real check-in entries for a guest. The host seeds every blueprint block —
 * including `checkin` — with one empty row when a page is created, so a bare
 * `items(lect, 'checkin').length` reports every new guest as checked in. A row
 * only counts as a check-in once it carries an actual status or date.
 */
export function checkins(lect: Record<string, unknown>): Array<Record<string, unknown>> {
  return items(lect, 'checkin').filter(
    (entry) => String(entry.status ?? '').trim() !== '' || String(entry.date ?? '').trim() !== '',
  );
}

/** Reads a page's content blocks (`_blocks`) sorted by their `_weight`. */
export function blocks(lect: Record<string, unknown>): Array<Record<string, unknown>> {
  const v = lect._blocks;
  if (!Array.isArray(v)) return [];
  return [...(v as Array<Record<string, unknown>>)].sort(
    (a, b) => (Number(a._weight) || 0) - (Number(b._weight) || 0),
  );
}

/** Reads a pointer (e.g. the event a guest/mail_list belongs to). */
export function pointer(lect: Record<string, unknown>, key: string): string {
  const p = lect._pointers;
  if (p && typeof p === 'object') return String((p as Record<string, unknown>)[key] ?? '');
  return '';
}

// ── Guest-list summary (computed by the plugin, not the CMS) ───────────────────
// The CMS page API is deliberately generic — it knows nothing about RSVP status
// or headcounts. The events plugin owns those semantics, so it tallies guest
// pages here rather than asking the CMS to special-case the `guest` type.

export function emptyGuestListSummary(): GuestListSummary {
  return {
    guest_count: 0, guest_total: 0, onhold_count: 0, to_be_invited_count: 0,
    invited_count: 0, confirmed_count: 0, declined_count: 0, unconfirmed_count: 0,
    checked_in_count: 0, checked_in_total: 0,
  };
}

/**
 * Tallies a list's guest pages into the dashboard summary. A guest's headcount
 * is themselves plus any `plus_guests`; any status outside the known set counts
 * as "to be invited" (mirrors the legacy event dashboard tallies).
 */
export function computeGuestListSummary(guests: CmsPage[]): GuestListSummary {
  const summary = emptyGuestListSummary();
  for (const guest of guests) {
    const plus = Number.parseInt(attr(guest.lect, 'plus_guests'), 10);
    const headcount = (Number.isFinite(plus) && plus > 0 ? plus : 0) + 1;
    const status = (attr(guest.lect, 'status') || 'to be invited').trim().toLowerCase();
    const checkedIn = checkins(guest.lect).length > 0;

    summary.guest_count += 1;
    summary.guest_total += headcount;
    if (status === 'onhold') summary.onhold_count += 1;
    else if (status === 'invited') summary.invited_count += 1;
    else if (status === 'confirmed') summary.confirmed_count += 1;
    else if (status === 'declined' || status === 'decline') summary.declined_count += 1;
    else if (status === 'unconfirmed') summary.unconfirmed_count += 1;
    else summary.to_be_invited_count += 1;

    if (checkedIn) {
      summary.checked_in_count += 1;
      summary.checked_in_total += headcount;
    }
  }
  return summary;
}
