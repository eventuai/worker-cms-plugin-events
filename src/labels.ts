import { CmsClient, attr, listByEvent, localized, type CmsPage } from './cms';
import { compactCheckinCode } from './crypto';
import { adminView } from './templates/views';
import { redirect } from '@lionrockjs/worker-cms-plugin';

const ADMIN_BASE = '/admin/plugins/events';

/**
 * Upper bound for a stored design document. Designs embed uploaded images as
 * data URLs, so they can be large — but a runaway document would bloat the
 * page row and slow every list query that deserializes it.
 */
const MAX_DESIGN_BYTES = 1_500_000;

/** Guest search results shown in the editor's preview picker. */
const MAX_SEARCH_RESULTS = 30;

export async function handleLabelsAdmin(
  request: Request,
  cms: CmsClient,
  views: Fetcher,
  eventId: number,
  segments: string[],
  url: URL,
  jsonOnly = false,
): Promise<Response> {
  const event = await cms.get(eventId);
  if (event.page_type !== 'event') return new Response('not found', { status: 404 });

  if (!segments.length) return labelsIndex(cms, views, event, jsonOnly);
  if (segments[0] === 'new') {
    if (request.method === 'POST') return createLabel(request, cms, event);
    return newLabelForm(views, event, url, jsonOnly);
  }

  const labelId = pageId(segments[0]);
  if (!labelId) return new Response('not found', { status: 404 });
  if (segments[1] === 'delete' && request.method === 'POST') return deleteLabel(cms, event, labelId);
  if (request.method === 'POST') return saveLabel(request, cms, event, labelId);
  return labelEditor(cms, views, event, labelId, url, jsonOnly);
}

async function labelsIndex(cms: CmsClient, views: Fetcher, event: CmsPage, jsonOnly = false): Promise<Response> {
  const { pages } = await cms.listWithLiveStatus('label', { parentId: event.id });
  return adminView(views, `Labels — ${event.name}`, 'labels', {
    eventName: event.name,
    eventHref: `${ADMIN_BASE}/events/${event.id}`,
    newHref: `${ADMIN_BASE}/events/${event.id}/labels/new`,
    labels: pages.map((label) => {
      const config = designConfig(label);
      return {
        name: label.name,
        href: `${ADMIN_BASE}/events/${event.id}/labels/${label.id}`,
        isPublished: label.isPublished === true,
        publishAction: `/admin/pages/${label.id}/publish`,
        unpublishAction: `/admin/pages/${label.id}/unpublish`,
        deleteAction: `${ADMIN_BASE}/events/${event.id}/labels/${label.id}/delete`,
        size: `${config.width}mm × ${config.height}mm`,
      };
    }),
  }, jsonOnly);
}

async function newLabelForm(views: Fetcher, event: CmsPage, url: URL, jsonOnly = false): Promise<Response> {
  return adminView(views, 'New label', 'label-form', {
    title: 'New label template',
    eventName: event.name,
    backHref: `${ADMIN_BASE}/events/${event.id}/labels`,
    action: `${ADMIN_BASE}/events/${event.id}/labels/new`,
    flash: url.searchParams.get('flash') ?? '',
    label: { name: '', width: '60', height: '30' },
  }, jsonOnly);
}

async function createLabel(request: Request, cms: CmsClient, event: CmsPage): Promise<Response> {
  const form = await request.formData();
  const name = text(form, 'name');
  if (!name) return redirect(`${ADMIN_BASE}/events/${event.id}/labels/new`);
  const width = clampMm(text(form, 'width'), 60);
  const height = clampMm(text(form, 'height'), 30);
  // An exported legacy design file (label-design-*.json) can seed the new
  // template; its labelConfig then wins over the width/height fields.
  let design = '';
  const file = form.get('design_file');
  if (file && typeof file !== 'string') {
    design = (await file.text()).trim();
  } else if (typeof file === 'string') {
    design = file.trim();
  }
  if (design) {
    const error = validateDesign(design);
    if (error) return redirect(`${ADMIN_BASE}/events/${event.id}/labels/new?flash=${encodeURIComponent(error)}`);
  }
  const label = await cms.create({
    page_type: 'label',
    page_id: event.id,
    name,
    lect: { _type: 'label', design: design || JSON.stringify(defaultDesign(width, height)) },
  });
  return redirect(`${ADMIN_BASE}/events/${event.id}/labels/${label.id}`);
}

async function saveLabel(request: Request, cms: CmsClient, event: CmsPage, labelId: number): Promise<Response> {
  const label = await cms.get(labelId);
  if (label.page_type !== 'label' || label.page_id !== event.id) return new Response('not found', { status: 404 });
  const form = await request.formData();
  const name = text(form, 'name') || label.name;
  const design = text(form, 'design');
  const backTo = `${ADMIN_BASE}/events/${event.id}/labels/${labelId}${labelQuery(form)}`;
  const lect: Record<string, unknown> = {};
  if (design) {
    const error = validateDesign(design);
    if (error) return redirect(`${backTo}${backTo.includes('?') ? '&' : '?'}flash=${encodeURIComponent(error)}`);
    lect.design = design;
  }
  await cms.update(labelId, { name, lect });
  return redirect(`${backTo}${backTo.includes('?') ? '&' : '?'}flash=${encodeURIComponent('Label saved')}`);
}

async function deleteLabel(cms: CmsClient, event: CmsPage, labelId: number): Promise<Response> {
  const label = await cms.get(labelId);
  if (label.page_type !== 'label' || label.page_id !== event.id) return new Response('not found', { status: 404 });
  await cms.remove(labelId);
  return redirect(`${ADMIN_BASE}/events/${event.id}/labels`);
}

async function labelEditor(
  cms: CmsClient,
  views: Fetcher,
  event: CmsPage,
  labelId: number,
  url: URL,
  jsonOnly = false,
): Promise<Response> {
  const label = await cms.getWithLiveStatus(labelId);
  if (label.page_type !== 'label' || label.page_id !== event.id) return new Response('not found', { status: 404 });

  const guestLists = await listByEvent(cms, 'mail_list', event.id);
  const listId = pageId(url.searchParams.get('list'));
  const selectedList = listId ? guestLists.find((list) => list.id === listId) : undefined;
  const q = (url.searchParams.get('q') ?? '').trim();
  const listNames = new Map(guestLists.map((list) => [list.id, list.name]));

  // The guest dropdown is fed either by a text search across the whole event
  // (name/email/organization — the host q matches name, slug and lect) or by
  // browsing one guest list.
  let guests: Array<{ id: number; name: string }> = [];
  if (q) {
    const result = await cms.list('guest', { pointer: { key: 'event', value: event.id }, q, limit: MAX_SEARCH_RESULTS });
    guests = result.pages
      .filter((guest) => listNames.has(guest.page_id ?? -1))
      .map((guest) => ({
        id: guest.id,
        name: `${guest.name} — ${listNames.get(guest.page_id ?? -1)}`,
      }));
  } else if (selectedList) {
    const result = await cms.list('guest', { parentId: selectedList.id, limit: 500 });
    guests = result.pages.map((guest) => ({ id: guest.id, name: guest.name }));
  }

  // Selection is resolved by id (not dropdown membership) so a guest picked
  // from search results keeps working after the query text changes.
  const guestId = pageId(url.searchParams.get('guest'));
  let selectedGuest: CmsPage | undefined;
  let guestList: CmsPage | undefined;
  if (guestId) {
    const guest = await cms.get(guestId);
    const list = guest.page_type === 'guest' ? guestLists.find((candidate) => candidate.id === guest.page_id) : undefined;
    if (list) {
      selectedGuest = guest;
      guestList = list;
    }
  }

  const tokens = selectedGuest && guestList ? guestLabelTokens(selectedGuest, guestList, event) : {};

  const selfHref = `${ADMIN_BASE}/events/${event.id}/labels/${labelId}`;
  return adminView(views, `${label.name} — label editor`, 'label-editor', {
    title: label.name,
    eventName: event.name,
    backHref: `${ADMIN_BASE}/events/${event.id}/labels`,
    action: selfHref,
    // Use the CMS's publish route so its permission check, publish targets,
    // and plugin publish hook all run exactly as they do from the native editor.
    publishAction: `/admin/pages/${labelId}/publish`,
    unpublishAction: `/admin/pages/${labelId}/unpublish`,
    isPublished: label.isPublished === true,
    deleteAction: `${selfHref}/delete`,
    selfHref,
    labelName: label.name,
    designJson: designJson(label),
    tokensJson: JSON.stringify(tokens),
    hasTokens: Boolean(selectedGuest),
    flash: url.searchParams.get('flash') ?? '',
    q,
    guestLists: guestLists.map((list) => ({ id: list.id, name: list.name, selected: list.id === selectedList?.id })),
    guests: guests.map((guest) => ({ ...guest, selected: guest.id === selectedGuest?.id })),
    selectedListId: selectedList ? String(selectedList.id) : '',
    selectedGuestId: selectedGuest ? String(selectedGuest.id) : '',
    selectedGuestName: selectedGuest?.name ?? '',
  }, jsonOnly);
}

/** Preserve the guest-preview selection (and search) across a save round trip. */
function labelQuery(form: FormData): string {
  const params = new URLSearchParams();
  const q = typeof form.get('q') === 'string' ? String(form.get('q')).trim() : '';
  const list = pageId(form.get('list'));
  const guest = pageId(form.get('guest'));
  if (q) params.set('q', q);
  if (list) params.set('list', String(list));
  if (guest) params.set('guest', String(guest));
  const query = params.toString();
  return query ? `?${query}` : '';
}

/**
 * Build the `[@token]` values for a guest, mirroring the legacy admin's
 * `enrichLeadTokens`: every scalar guest attribute becomes a token, plus the
 * id/QR/preferred-language conveniences label designs already rely on.
 */
export function guestLabelTokens(guest: CmsPage, list: CmsPage, event: CmsPage): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const [key, value] of Object.entries(guest.lect)) {
    if (key.startsWith('_')) continue;
    const tokenKey = key.replace(/[^A-Za-z0-9_]/g, '_');
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      tokens[tokenKey] = String(value);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      // Localized maps ({en: ...}) collapse to their first value.
      const localizedValue = localized(guest.lect, key);
      if (localizedValue) tokens[tokenKey] = localizedValue;
    }
  }
  tokens.name = guest.name || localized(guest.lect, 'name');

  tokens.lead_id = String(guest.id);
  tokens.lead_id_short = guest.id.toString(36);
  tokens.mail_list_id = String(list.id);
  tokens.mail_list_id_short = list.id.toString(36);
  tokens.event_id = String(event.id);
  tokens.event_slug = event.slug ?? '';

  try {
    const code = compactCheckinCode(list.id, guest.id);
    tokens.checkin_qrcode = code;
    tokens.checkin_qrcode_text = code;
    tokens.checkin_qr_code_text = code;
  } catch {
    // Guests outside the legacy id scheme simply get no QR token.
  }

  tokens.zh_name = tokens.zh_hans_name || tokens.zh_hant_name || '';
  const preferChinese = (tokens.prefer_language || '').toLowerCase().startsWith('zh');
  tokens.prefer_name = preferChinese
    ? (tokens.zh_name || tokens.name || '')
    : (tokens.name || tokens.zh_name || '');
  tokens.prefer_company = preferChinese
    ? (tokens.zh_company || tokens.organization || '')
    : (tokens.organization || tokens.zh_company || '');

  return tokens;
}

/** The stored legacy-format design document, or a fresh default. */
function designJson(label: CmsPage): string {
  const raw = attr(label.lect, 'design');
  if (raw && !validateDesign(raw)) return raw;
  return JSON.stringify(defaultDesign(60, 30));
}

function designConfig(label: CmsPage): { width: number; height: number } {
  try {
    const parsed = JSON.parse(attr(label.lect, 'design')) as { labelConfig?: { width?: unknown; height?: unknown } };
    return {
      width: Number(parsed?.labelConfig?.width) || 60,
      height: Number(parsed?.labelConfig?.height) || 30,
    };
  } catch {
    return { width: 60, height: 30 };
  }
}

/**
 * Legacy label-maker document shape (see the sample export
 * `label-design-*.json`): labelConfig + per-type element arrays. Only shape
 * is checked — element fields are trusted to the editor, which renders text
 * via textContent and images via <image href>.
 */
export function validateDesign(raw: string): string | null {
  if (raw.length > MAX_DESIGN_BYTES) return 'Design is too large to save';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'Design is not valid JSON';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'Design must be a JSON object';
  const design = parsed as Record<string, unknown>;
  const config = design.labelConfig;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return 'Design is missing labelConfig';
  for (const key of ['textElements', 'imageElements', 'shapeElements', 'qrcodeElements']) {
    if (design[key] !== undefined && !Array.isArray(design[key])) return `Design ${key} must be an array`;
  }
  return null;
}

function defaultDesign(width: number, height: number): Record<string, unknown> {
  return {
    labelConfig: {
      width,
      height,
      backgroundColor: '#ffffff',
      borderColor: '#000000',
      borderWidth: 1,
      borderRadius: 0,
    },
    elementIdCounter: 0,
    textElements: [],
    imageElements: [],
    shapeElements: [],
    qrcodeElements: [],
    rotatePreview: false,
    version: '1.0',
  };
}

function clampMm(value: string, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(210, Math.max(10, Math.round(parsed)));
}

function pageId(value: unknown): number | null {
  const id = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value.trim() : '';
}
