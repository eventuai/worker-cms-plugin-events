// ============================================================
// Events Suite CMS bridge.
//
// Shared Plugin API client/types and neutral lect readers live in @lionrockjs/worker-cms-plugin.
// This file keeps the events plugin's existing imports stable and adds only the
// event-specific helpers that do not belong in the generic SDK.
// ============================================================

import {
  CmsClient as BaseCmsClient,
  attr,
  compareByWeightThenName,
  items,
  localized,
  pointer,
  type CmsClientEnv,
  type CmsListPointer,
  type CmsPage as BaseCmsPage,
  type CmsPageInput,
  CmsApiError,
  CmsNotConfiguredError,
  blocks,
} from '@lionrockjs/worker-cms-plugin';

/** Manifest id — must equal MANIFEST.id and the CMS-registered plugin id. */
export const PLUGIN_ID = 'events';

/** Native CMS admin endpoint used by drag-sort tables to persist page weights in one request. */
export const CMS_BATCH_WEIGHT_ACTION = '/admin/pages/batch-weight';

export {
  CmsApiError,
  CmsNotConfiguredError,
  attr,
  blocks,
  compareByWeightThenName,
  items,
  localized,
  pointer,
  type CmsClientEnv,
  type CmsPageInput,
};

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

export type CmsPage = BaseCmsPage & {
  /** Attached by the events plugin for mail_list pages — not part of the CMS API. */
  guest_summary?: GuestListSummary;
  /** Returned by GET /__cms/pages?include_live_status=1. */
  isPublished?: boolean;
};

/**
 * Selects a related collection of pages for the bulk clone/delete operations.
 * Prefer the lect pointer — the canonical reference (e.g. a guest's list is
 * `_pointers.mail_list`, NOT its parent page) — over the parent page id.
 */
export type CollectionSelector =
  | { pointerKey: string; pointerValue: string }
  | { parentPageId: number };

export interface DuplicateChildrenInput {
  /** Which source pages to clone (by lect pointer or parent page). */
  source: CollectionSelector;
  /** Page type of the pages to clone (e.g. 'guest'). */
  sourcePageType: string;
  /** Parent assigned to the clones. */
  targetPageId: number | null;
  /** Lect fields merged over each clone (e.g. status reset, repointed pointers). */
  lect?: Record<string, unknown>;
  /** Top-level lect keys stripped from each clone before the merge. */
  dropLect?: string[];
}

export interface CmsBatchUpdateInput {
  id: number;
  lect: Record<string, unknown>;
  versionAction?: string;
}

/** One limit from the host's `GET /__cms/limits` — declared in this plugin's
 *  manifest and configured (or defaulted) host-side. Page quotas are enforced
 *  by the host; operational limits are enforced by the plugin. `value: null`
 *  means unlimited; scoped `usage` is only present when the matching query
 *  param (pointer_value / page_id) was sent. */
export interface CmsLimit {
  key: string;
  label: string;
  description: string;
  page_type: string | null;
  scope: 'total' | 'per_parent' | 'per_pointer' | 'per_second';
  pointer_key: string | null;
  value: number | null;
  configured: boolean;
  usage: number | null;
}

/** One cost from the host's `GET /__cms/credits` — declared in this plugin's
 *  manifest, priced host-side. `value` is credits per page create / per unit. */
export interface CmsCredit {
  key: string;
  label: string;
  description: string;
  charge: 'page_create' | 'metered';
  page_type: string | null;
  unit: string;
  value: number;
  configured: boolean;
}

export interface CmsCreditsInfo {
  /** Acting user's balance, or null when no acting user is set. */
  balance: number | null;
  credits: CmsCredit[];
}

export interface CmsCreditQuote {
  key: string;
  unit_cost: number;
  quantity: number;
  total: number;
  balance: number | null;
  affordable: boolean;
}

/** Expands a selector into the CMS request fields, e.g. prefix 'source_' → source_pointer_key. */
function selectorFields(selector: CollectionSelector, prefix: 'source_' | ''): Record<string, unknown> {
  return 'pointerKey' in selector
    ? { [`${prefix}pointer_key`]: selector.pointerKey, [`${prefix}pointer_value`]: selector.pointerValue }
    : { [`${prefix}${prefix ? 'page_id' : 'parent_page_id'}`]: selector.parentPageId };
}

export class CmsClient extends BaseCmsClient {
  /** The base `call`/`json` are private, so duplicateChildren keeps its own copy of the link config. */
  private readonly link: { base: string; secret: string };
  private actingUserId: string | null = null;

  constructor(env: CmsClientEnv) {
    super({
      cmsUrl: env.CMS_URL,
      pluginSecret: env.PLUGIN_SECRET,
      pluginId: PLUGIN_ID,
      // The wrapper adds x-acting-user-id (when set) to every base-client
      // call, so the host can charge credit costs to the signed-in admin.
      fetcher: (input, init) => globalThis.fetch(input, this.withActingUser(init)),
    });
    this.link = { base: (env.CMS_URL ?? '').replace(/\/+$/, ''), secret: env.PLUGIN_SECRET ?? '' };
  }

  /**
   * Attributes subsequent CMS calls to the signed-in admin (from the
   * `x-cms-user` summary the host forwards), so host-side credit costs are
   * charged to them. Flows with no user (public RSVP, kiosk) stay unset and
   * uncharged.
   */
  actAs(userId: string | number | null | undefined): this {
    this.actingUserId = userId === null || userId === undefined || userId === '' ? null : String(userId);
    return this;
  }

  get hasActingUser(): boolean {
    return this.actingUserId !== null;
  }

  /**
   * Every page matching the query. The host clamps `/__cms/pages` to 500 rows
   * per call no matter what `limit` asks, so a plain `list()` silently
   * truncates collections past 500 (large guest lists) — this pages by offset
   * until the set is exhausted. Costs one extra subrequest per page.
   *
   * Serializing 500 fat rows (guests carry response logs and check-ins) can
   * blow the host's per-request CPU budget on big lists (Cloudflare 1102,
   * surfaced as a 503) — on a transient host failure the page size halves
   * (500 → 250 → … → 50) and the same offset retries, trading more calls for
   * lighter ones. Only a failure at the 50-row floor propagates. Follow-up
   * pages send `count=0` so the host skips re-counting the filtered set.
   */
  async listAll(
    pageType: string,
    opts: { parentId?: number; pointer?: CmsListPointer; q?: string; fields?: string[] } = {},
  ): Promise<CmsPage[]> {
    const pages: CmsPage[] = [];
    let pageSize = 500;
    let total: number | null = null; // fetched with the first page only
    for (;;) {
      let chunk: CmsPage[];
      try {
        const result = await this.listPage(pageType, opts, pageSize, pages.length, total === null);
        if (total === null) total = result.total;
        chunk = result.pages;
      } catch (error) {
        const transient = error instanceof CmsApiError && [429, 500, 502, 503, 504].includes(error.status);
        if (!transient || pageSize <= 50) throw error;
        pageSize = Math.max(50, Math.floor(pageSize / 2));
        continue;
      }
      pages.push(...chunk);
      if (!chunk.length || chunk.length < pageSize || (total >= 0 && pages.length >= total)) return pages;
    }
  }

  /**
   * Ids of every page matching the query. Same pagination/backoff as listAll
   * but projected to `fields=id`, so the host never reads or JSON-serializes
   * lect — use this wherever only ids are needed (bulk deletes, membership
   * checks), where a full listAll of fat guest rows costs real host CPU.
   */
  async listAllIds(pageType: string, opts: { parentId?: number; pointer?: CmsListPointer; q?: string } = {}): Promise<number[]> {
    const pages = await this.listAll(pageType, { ...opts, fields: ['id'] });
    return pages.map((page) => page.id);
  }

  /** One bounded id-only page for resumable jobs that rediscover remaining work. */
  async listIdsPage(
    pageType: string,
    opts: { parentId?: number; pointer?: CmsListPointer; q?: string } = {},
    limit = 100,
  ): Promise<{ ids: number[]; total: number; more: boolean }> {
    const result = await this.listPage(pageType, { ...opts, fields: ['id'] }, limit, 0, true);
    return { ids: result.pages.map((page) => page.id), total: result.total, more: result.pages.length < result.total };
  }

  /** One page-list response annotated with its current CMS publish state. */
  async listWithLiveStatus(
    pageType: string,
    opts: { parentId?: number; pointer?: CmsListPointer; q?: string } = {},
    limit = 500,
  ): Promise<{ pages: CmsPage[]; total: number }> {
    return this.listPage(pageType, { ...opts, includeLiveStatus: true }, limit, 0, true);
  }

  /** One page annotated with its current CMS publish state. */
  async getWithLiveStatus(id: number): Promise<CmsPage> {
    const path = `/pages/${id}?include_live_status=1`;
    const response = await globalThis.fetch(`${this.link.base}/__cms${path}`, { headers: this.linkHeaders() });
    if (!response.ok) {
      const code = await response.text().then((text) => text.trim().slice(0, 160) || 'error').catch(() => 'error');
      throw new CmsApiError(response.status, code, 'GET', path);
    }
    return (await response.json() as { page: CmsPage }).page;
  }

  /**
   * One raw GET /__cms/pages call. Exists because the SDK's `list()` cannot
   * send `count=0` (skip the host's COUNT(*) — itself a scan of the filtered
   * set) on follow-up pages; mirrors its parameter encoding.
   */
  private async listPage(
    pageType: string,
    opts: { parentId?: number; pointer?: CmsListPointer; q?: string; fields?: string[]; includeLiveStatus?: boolean },
    limit: number,
    offset: number,
    wantCount: boolean,
  ): Promise<{ pages: CmsPage[]; total: number }> {
    const params = new URLSearchParams({ page_type: pageType });
    if (opts.parentId != null) params.set('page_id', String(opts.parentId));
    if (opts.pointer) {
      params.set('pointer_key', opts.pointer.key);
      if ('values' in opts.pointer) params.set('pointer_values', opts.pointer.values.map(String).join(','));
      else params.set('pointer_value', String(opts.pointer.value));
    }
    if (opts.q) params.set('q', opts.q);
    if (opts.includeLiveStatus) params.set('include_live_status', '1');
    // Column projection: returned pages carry ONLY these fields (the host
    // whitelists the names). `fields: ['id']` skips reading/serializing lect
    // entirely — the dominant cost of listing fat guest rows.
    if (opts.fields?.length) params.set('fields', opts.fields.join(','));
    params.set('limit', String(limit));
    params.set('offset', String(offset));
    if (!wantCount) params.set('count', '0');

    const path = `/pages?${params}`;
    const response = await globalThis.fetch(`${this.link.base}/__cms${path}`, { headers: this.linkHeaders() });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let code = 'error';
      if (text) {
        try {
          const parsed = JSON.parse(text) as { error?: unknown };
          code = typeof parsed.error === 'string' && parsed.error ? parsed.error : 'error';
        } catch {
          code = text.replace(/\s+/g, ' ').trim().slice(0, 160) || 'error';
        }
      }
      throw new CmsApiError(response.status, code, 'GET', path);
    }
    return response.json();
  }

  private withActingUser(init?: RequestInit): RequestInit {
    if (!this.actingUserId) return init ?? {};
    const headers = new Headers(init?.headers);
    headers.set('x-acting-user-id', this.actingUserId);
    // Plain object (not a Headers instance) so callers and tests that inspect
    // init.headers by key keep working.
    return { ...init, headers: Object.fromEntries(headers.entries()) };
  }

  /** Auth + attribution headers for this class's own raw /__cms fetches. */
  private linkHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'x-plugin-secret': this.link.secret,
      'x-plugin-id': PLUGIN_ID,
      ...(this.actingUserId ? { 'x-acting-user-id': this.actingUserId } : {}),
      ...extra,
    };
  }

  /**
   * This plugin's declared limits with effective values and current usage
   * (CMS `GET /__cms/limits`). Pass `pointerValue` to get per_pointer usage
   * (e.g. a guest list id for max_guests_per_list) or `pageId` for per_parent
   * usage. Read-only UX helper — the host enforces regardless.
   */
  async limits(opts: { pointerValue?: string | number; pageId?: number } = {}): Promise<CmsLimit[]> {
    const params = new URLSearchParams();
    if (opts.pointerValue !== undefined) params.set('pointer_value', String(opts.pointerValue));
    if (opts.pageId !== undefined) params.set('page_id', String(opts.pageId));
    const query = params.size ? `?${params}` : '';
    const response = await globalThis.fetch(`${this.link.base}/__cms/limits${query}`, {
      headers: this.linkHeaders(),
    });
    if (!response.ok) {
      const code = await response.text().then((text) => text.trim().slice(0, 160) || 'error').catch(() => 'error');
      throw new CmsApiError(response.status, code, 'GET', '/limits');
    }
    const result = await response.json() as { limits: CmsLimit[] };
    return result.limits;
  }

  /**
   * Asks the host to pull live-only submission rows (published DB → draft
   * pages) NOW instead of waiting for its cron tick (CMS
   * `POST /__cms/ingest/submissions`). Idempotent and bounded per call; each
   * created page fires this plugin's `submission` hook.
   */
  async ingestSubmissions(): Promise<{ scanned: number; created: number; more: boolean }> {
    const response = await globalThis.fetch(`${this.link.base}/__cms/ingest/submissions`, {
      method: 'POST',
      headers: this.linkHeaders(),
    });
    if (!response.ok) {
      const code = await response.text().then((text) => text.trim().slice(0, 160) || 'error').catch(() => 'error');
      throw new CmsApiError(response.status, code, 'POST', '/ingest/submissions');
    }
    return await response.json() as { scanned: number; created: number; more: boolean };
  }

  /** Bulk partial-lect update through CMS `PATCH /__cms/pages/batch`. The host
   * merges every patch, versions every page, and commits the chunk atomically. */
  async batchUpdate(inputs: CmsBatchUpdateInput[]): Promise<CmsPage[]> {
    if (!inputs.length) return [];
    const response = await globalThis.fetch(`${this.link.base}/__cms/pages/batch`, {
      method: 'PATCH',
      headers: this.linkHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        pages: inputs.map((input) => ({
          id: input.id,
          lect: input.lect,
          version_action: input.versionAction,
        })),
      }),
    });
    if (!response.ok) {
      const code = await response.text()
        .then((text) => {
          try { return (JSON.parse(text) as { error?: string }).error || 'error'; } catch { return text.trim().slice(0, 160) || 'error'; }
        })
        .catch(() => 'error');
      throw new CmsApiError(response.status, code, 'PATCH', '/pages/batch');
    }
    const result = await response.json() as {
      updated: CmsPage[];
      errors: Array<{ index: number; error: string }>;
    };
    if (result.errors.length) {
      const first = result.errors[0];
      throw new CmsApiError(400, first.error, 'PATCH', `/pages/batch[${first.index}]`);
    }
    return result.updated;
  }

  /**
   * This plugin's declared credit costs with effective prices, plus the acting
   * user's balance when one is set (CMS `GET /__cms/credits`). Read-only UX
   * helper — the host charges regardless.
   */
  async credits(): Promise<CmsCreditsInfo> {
    const response = await globalThis.fetch(`${this.link.base}/__cms/credits`, {
      headers: this.linkHeaders(),
    });
    if (!response.ok) {
      const code = await response.text().then((text) => text.trim().slice(0, 160) || 'error').catch(() => 'error');
      throw new CmsApiError(response.status, code, 'GET', '/credits');
    }
    return await response.json() as CmsCreditsInfo;
  }

  /**
   * Affordability pre-check for a declared cost (CMS `GET /__cms/credits/quote`)
   * — verify a long job fits the balance BEFORE starting it. Deducts nothing.
   */
  async creditQuote(key: string, quantity: number): Promise<CmsCreditQuote> {
    const params = new URLSearchParams({ key, quantity: String(quantity) });
    const response = await globalThis.fetch(`${this.link.base}/__cms/credits/quote?${params}`, {
      headers: this.linkHeaders(),
    });
    if (!response.ok) {
      const code = await response.text().then((text) => text.trim().slice(0, 160) || 'error').catch(() => 'error');
      throw new CmsApiError(response.status, code, 'GET', '/credits/quote');
    }
    return await response.json() as CmsCreditQuote;
  }

  /**
   * Reports metered usage for a manifest-declared cost (CMS `POST
   * /__cms/credits/charge`). The host prices it from its own configuration and
   * deducts from the acting user; throws CmsApiError 402 (insufficient_credits)
   * when the balance is short.
   */
  async chargeUsage(
    key: string,
    quantity: number,
    opts: { entityType?: string; entityId?: string | number; note?: string } = {},
  ): Promise<{ charged: number; balance: number | null }> {
    const response = await globalThis.fetch(`${this.link.base}/__cms/credits/charge`, {
      method: 'POST',
      headers: this.linkHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        key,
        quantity,
        entity_type: opts.entityType,
        entity_id: opts.entityId,
        note: opts.note,
      }),
    });
    if (!response.ok) {
      const code = await response.text()
        .then((text) => {
          try { return (JSON.parse(text) as { error?: string }).error || 'error'; } catch { return text.trim().slice(0, 160) || 'error'; }
        })
        .catch(() => 'error');
      throw new CmsApiError(response.status, code, 'POST', '/credits/charge');
    }
    const result = await response.json() as { charged: number; balance: number | null };
    return result;
  }

  /**
   * Server-side bulk clone of a parent's children (CMS `POST /pages/duplicate`).
   * Pushes the copy work to the CMS Worker — no page data streams out and back —
   * and follows the host's `next_cursor` until done, so an arbitrarily large
   * guest list duplicates across several bounded requests instead of one that
   * would exhaust the subrequest budget / time out. Returns the total cloned.
   */
  async duplicateChildren(input: DuplicateChildrenInput): Promise<number> {
    let cursor = 0;
    let total = 0;
    // Bounded loop: the host caps each call, so iterations ≈ children / 1000.
    for (;;) {
      const response = await globalThis.fetch(`${this.link.base}/__cms/pages/duplicate`, {
        method: 'POST',
        headers: this.linkHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          ...selectorFields(input.source, 'source_'),
          source_page_type: input.sourcePageType,
          target_page_id: input.targetPageId,
          lect: input.lect ?? {},
          drop_lect: input.dropLect ?? [],
          cursor,
        }),
      });
      if (!response.ok) {
        const code = await response.text().then((text) => text.trim().slice(0, 160) || 'error').catch(() => 'error');
        throw new CmsApiError(response.status, code, 'POST', '/pages/duplicate');
      }
      const result = await response.json() as { count: number; next_cursor: number | null; done: boolean };
      total += result.count;
      if (result.done || result.next_cursor == null) break;
      cursor = result.next_cursor;
    }
    return total;
  }

  /**
   * Server-side bulk soft-delete of a related collection (CMS `DELETE
   * /pages/children`). Trashes the work in the CMS Worker — no child ids stream
   * back to the plugin — and repeats while the host reports more remain, so a
   * list with thousands of guests is torn down across bounded requests instead
   * of one that times out. Returns the total trashed.
   */
  async deleteChildren(selector: CollectionSelector, pageType: string): Promise<number> {
    let total = 0;
    // Trashed rows leave draft_pages, so each call drains the next slice; loop
    // until the host reports it is done.
    for (;;) {
      const response = await globalThis.fetch(`${this.link.base}/__cms/pages/children`, {
        method: 'DELETE',
        headers: this.linkHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ ...selectorFields(selector, ''), page_type: pageType }),
      });
      if (!response.ok) {
        const code = await response.text().then((text) => text.trim().slice(0, 160) || 'error').catch(() => 'error');
        throw new CmsApiError(response.status, code, 'DELETE', '/pages/children');
      }
      const result = await response.json() as { trashed: number; done: boolean };
      total += result.trashed;
      // Guard against a non-progressing response (nothing trashed yet not done).
      if (result.done || result.trashed === 0) break;
    }
    return total;
  }

  /**
   * Performs at most `maxRequests` slices of the server-side children delete.
   * The selector is stable and trashed rows leave the source collection, so a
   * later Worker invocation can call this again to resume without a cursor.
   */
  async deleteChildrenPass(
    selector: CollectionSelector,
    pageType: string,
    maxRequests: number,
  ): Promise<{ trashed: number; done: boolean; requests: number }> {
    let trashed = 0;
    let requests = 0;
    while (requests < maxRequests) {
      const response = await globalThis.fetch(`${this.link.base}/__cms/pages/children`, {
        method: 'DELETE',
        headers: this.linkHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ ...selectorFields(selector, ''), page_type: pageType }),
      });
      if (!response.ok) {
        const code = await response.text().then((text) => text.trim().slice(0, 160) || 'error').catch(() => 'error');
        throw new CmsApiError(response.status, code, 'DELETE', '/pages/children');
      }
      const result = await response.json() as { trashed: number; done: boolean };
      requests += 1;
      trashed += result.trashed;
      if (result.done) return { trashed, done: true, requests };
      // Do not burn the rest of an invocation on a host operation that cannot
      // currently make progress. The progress page will require a manual retry.
      if (result.trashed === 0) return { trashed, done: false, requests };
    }
    return { trashed, done: false, requests };
  }
}

export async function chargeCreditAction(
  cms: CmsClient,
  key: string,
  quantity = 1,
  opts: { entityType?: string; entityId?: string | number; note?: string } = {},
): Promise<void> {
  if (!cms.hasActingUser || quantity <= 0) return;
  try {
    await cms.chargeUsage(key, quantity, opts);
  } catch (error) {
    if (error instanceof CmsApiError && error.status === 402) throw error;
    console.error(`[events-suite] ${key} charge failed (non-blocking)`, error);
  }
}

/**
 * Lists the pages of a type that belong to an event. `edm` and `mail_list` pages
 * group under their event by `lect._pointers.event`, not by parent page. The
 * pointer is filtered host-side (expression-indexed since migration 0011), so
 * this no longer fetches every page of the type to filter here — which also
 * silently capped the old version at the host's 500-row clamp.
 */
export async function listByEvent(
  cms: CmsClient,
  pageType: string,
  eventId: number,
): Promise<CmsPage[]> {
  return cms.listAll(pageType, { pointer: { key: 'event', value: eventId } });
}

/**
 * Pseudonymous slug for a new guest page. Without an explicit slug the host
 * derives one from the page NAME — for guests that puts the person's real
 * name in a public identifier (guest pages are auto-published, and slugs
 * surface in URLs, sitemaps, and the published DB even where rendering is
 * blocked). Every guest create must pass this instead.
 */
export function guestSlug(): string {
  return `g-${crypto.randomUUID()}`;
}

/**
 * Real check-in entries for a guest. The host seeds every blueprint block,
 * including `checkin`, with one empty row when a page is created. A row counts
 * only once it carries an actual status or date.
 */
export function checkins(lect: Record<string, unknown>): Array<Record<string, unknown>> {
  return items(lect, 'checkin').filter(
    (entry) => String(entry.status ?? '').trim() !== '' || String(entry.date ?? '').trim() !== '',
  );
}

export function emptyGuestListSummary(): GuestListSummary {
  return {
    guest_count: 0,
    guest_total: 0,
    onhold_count: 0,
    to_be_invited_count: 0,
    invited_count: 0,
    confirmed_count: 0,
    declined_count: 0,
    unconfirmed_count: 0,
    checked_in_count: 0,
    checked_in_total: 0,
  };
}

/**
 * Tallies a list's guest pages into the dashboard summary. A guest's headcount
 * is themselves plus any `plus_guests`; any unknown status counts as "to be
 * invited", mirroring the legacy event dashboard tallies.
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
