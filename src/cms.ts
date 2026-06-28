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

export class CmsClient extends BaseCmsClient {
  constructor(env: CmsClientEnv) {
    super(env, PLUGIN_ID);
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
