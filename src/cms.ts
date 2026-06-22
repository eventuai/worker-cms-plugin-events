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
  page_id: number | null;
  created_at: string;
  updated_at: string;
  lect: Record<string, unknown>;
  tags?: number[];
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

export class CmsApiError extends Error {
  constructor(public status: number, public code: string) {
    super(`CMS API ${status}: ${code}`);
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

  private async json<T>(res: Response): Promise<T> {
    if (!res.ok) {
      const code = await res.json().then((b) => (b as { error?: string }).error ?? 'error').catch(() => 'error');
      throw new CmsApiError(res.status, code);
    }
    return res.json() as Promise<T>;
  }

  /** List pages of a type, optionally filtered by parent page id (e.g. guests of an event). */
  async list(
    pageType: string,
    opts: { parentId?: number; q?: string; limit?: number; offset?: number; includeGuestSummary?: boolean } = {},
  ): Promise<{ pages: CmsPage[]; total: number }> {
    const params = new URLSearchParams({ page_type: pageType });
    if (opts.parentId != null) params.set('page_id', String(opts.parentId));
    if (opts.q) params.set('q', opts.q);
    if (opts.limit != null) params.set('limit', String(opts.limit));
    if (opts.offset != null) params.set('offset', String(opts.offset));
    if (opts.includeGuestSummary) params.set('include', 'guest_summary');
    return this.json(await this.call('GET', `/pages?${params.toString()}`));
  }

  async get(id: number): Promise<CmsPage> {
    const { page } = await this.json<{ page: CmsPage }>(await this.call('GET', `/pages/${id}`));
    return page;
  }

  async create(input: CmsPageInput): Promise<CmsPage> {
    const { page } = await this.json<{ page: CmsPage }>(await this.call('POST', '/pages', input));
    return page;
  }

  async update(id: number, input: CmsPageInput): Promise<CmsPage> {
    const { page } = await this.json<{ page: CmsPage }>(await this.call('PUT', `/pages/${id}`, input));
    return page;
  }

  async remove(id: number): Promise<void> {
    await this.json(await this.call('DELETE', `/pages/${id}`));
  }

  /** Batch-create (bulk import / bulk add-to-list); the CMS caps the batch size. */
  async batchCreate(pages: CmsPageInput[]): Promise<{ created: CmsPage[]; errors: Array<{ index: number; error: string }> }> {
    return this.json(await this.call('POST', '/pages/batch', { pages }));
  }
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

/** Reads a pointer (e.g. the event a guest/mail_list belongs to). */
export function pointer(lect: Record<string, unknown>, key: string): string {
  const p = lect._pointers;
  if (p && typeof p === 'object') return String((p as Record<string, unknown>)[key] ?? '');
  return '';
}
