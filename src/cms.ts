// ============================================================
// Events Suite CMS bridge.
//
// Shared F1 client/types and neutral lect readers live in @lionrockjs/worker-cms-plugin.
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

/** Expands a selector into the CMS request fields, e.g. prefix 'source_' → source_pointer_key. */
function selectorFields(selector: CollectionSelector, prefix: 'source_' | ''): Record<string, unknown> {
  return 'pointerKey' in selector
    ? { [`${prefix}pointer_key`]: selector.pointerKey, [`${prefix}pointer_value`]: selector.pointerValue }
    : { [`${prefix}${prefix ? 'page_id' : 'parent_page_id'}`]: selector.parentPageId };
}

export class CmsClient extends BaseCmsClient {
  /** The base `call`/`json` are private, so duplicateChildren keeps its own copy of the link config. */
  private readonly link: { base: string; secret: string };

  constructor(env: CmsClientEnv) {
    super({
      cmsUrl: env.CMS_URL,
      pluginSecret: env.PLUGIN_SECRET,
      pluginId: PLUGIN_ID,
      fetcher: (input, init) => globalThis.fetch(input, init),
    });
    this.link = { base: (env.CMS_URL ?? '').replace(/\/+$/, ''), secret: env.PLUGIN_SECRET ?? '' };
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
        headers: {
          'content-type': 'application/json',
          'x-plugin-secret': this.link.secret,
          'x-plugin-id': PLUGIN_ID,
        },
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
        headers: {
          'content-type': 'application/json',
          'x-plugin-secret': this.link.secret,
          'x-plugin-id': PLUGIN_ID,
        },
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
}

/**
 * Lists the pages of a type that belong to an event. `edm` and `mail_list` pages
 * group under their event by `lect._pointers.event`, not by parent page.
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
