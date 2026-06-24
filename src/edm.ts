import { CmsApiError, CmsClient, attr, blocks, items, localized, pointer, type CmsPage } from './cms';
import { signPayload } from './crypto';
import { mjmlToHtml } from './mjml';
import { renderLiquid } from './templates/liquid';
import { adminView, notFoundView } from './templates/views';

const ADMIN_BASE = '/admin/plugins/events';

export interface OutboundEmail {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Optional Reply-To address (the EDM's `reply_to`). Omitted when unset. */
  replyTo?: string;
  /** Optional Bcc recipients (the EDM's `bcc`, parsed into a list). Omitted when empty. */
  bcc?: string[];
}

export interface EmailDelivery extends OutboundEmail {
  edmId: number;
  guestId?: number;
}

export interface EdmEnv {
  EMAIL?: { send(message: OutboundEmail): Promise<unknown> };
  MAIL_QUEUE?: Queue<EmailDelivery>;
  EMAIL_FROM?: string;
  PLUGIN_SECRET?: string;
  PUBLIC_BASE_URL?: string;
  /** MJML render API (https://api.mjml.io). When set, used in place of the
   *  built-in compiler for production-grade, Outlook-safe email HTML. */
  MJML_APP_ID?: string;
  MJML_SECRET_KEY?: string;
  /** Override the MJML API endpoint (defaults to https://api.mjml.io/v1/render). */
  MJML_API_URL?: string;
  /** Optional KV namespace caching MJML-API output (keyed by MJML hash) so
   *  repeated renders of unchanged EDMs don't spend API quota. */
  MAIL_TRACKING?: KVNamespace;
}

/** Days an MJML-API render stays cached (a content edit changes the key anyway). */
const MJML_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Placeholder swapped for each guest's signed RSVP URL after a single MJML render. */
const RSVP_URL_PLACEHOLDER = 'https://__edm_rsvp_url__/';

// ── Plugin edit view (manifest `editViews: ['edm']`) ───────────────────────────
// The CMS hands the whole edit/new view for `edm` pages to this plugin: it POSTs
// the editor context to /__plugin/edit, and we return an HTML fragment (the
// bespoke EDM editor, ported from the legacy Eventuai admin) that the CMS wraps
// in its admin chrome. The editor's form posts back to the CMS's normal save
// handler (`ctx.action`) using the CMS field-name conventions (@attr, .field|lang,
// *pointer, #<block>… , block-add/block-delete/… actions), so save / version /
// publish all flow through the CMS unchanged.

/** Editor context the CMS POSTs to /__plugin/edit. Mirrors the CMS EditViewContext. */
interface EditViewContext {
  mode: 'new' | 'edit';
  action: string;
  backHref: string;
  language: string;
  pageType: string;
  page: {
    id: number | string;
    name: string;
    slug: string;
    pageType: string;
    weight: number;
    start: string | null;
    end: string | null;
    timezone: string | null;
    editors: string | null;
    lect: string;
  };
  versions: Array<{ id: number; created_at: string; action: string | null }>;
  flash?: string;
  errors?: string[];
}

/** Languages the EDM editor offers (must be a subset of the CMS `languages`). */
const EDM_LANGUAGES: Array<{ value: string; label: string }> = [
  { value: 'mis', label: 'Default' },
  { value: 'en', label: 'EN' },
  { value: 'zh-hant', label: '繁' },
  { value: 'zh-hans', label: '简' },
];

/** Content blocks offered in the EDM editor's "add block" picker, with labels. */
const EDM_BLOCK_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'paragraph', label: 'Paragraph' },
  { value: 'picture', label: 'Picture' },
  { value: 'button', label: 'Button' },
  { value: 'table', label: 'Table' },
  { value: 'spacer', label: 'Spacer' },
  { value: 'edm-attachments', label: 'Attachments' },
  { value: 'edm-unsubscribe', label: 'Unsubscribe footer' },
];

type BlockFieldSpec = { key: string; label: string; kind: 'attr' | 'value'; control: 'text' | 'textarea' | 'number' };

/** Per-block-type scalar fields, mirroring the EDM block blueprints in index.ts. */
const EDM_BLOCK_FIELDS: Record<string, BlockFieldSpec[]> = {
  paragraph: [
    { key: 'subject', label: 'Subject', kind: 'value', control: 'text' },
    { key: 'body', label: 'Body', kind: 'value', control: 'textarea' },
  ],
  picture: [
    { key: 'picture', label: 'Image URL', kind: 'attr', control: 'text' },
    { key: 'caption', label: 'Caption', kind: 'value', control: 'text' },
    { key: 'width', label: 'Width', kind: 'attr', control: 'text' },
    { key: 'align', label: 'Align (left/center/right)', kind: 'attr', control: 'text' },
  ],
  button: [
    { key: 'label', label: 'Label', kind: 'value', control: 'text' },
    { key: 'url', label: 'URL', kind: 'value', control: 'text' },
  ],
  spacer: [
    { key: 'lines', label: 'Blank lines', kind: 'attr', control: 'number' },
  ],
  table: [
    { key: 'title', label: 'Title', kind: 'value', control: 'textarea' },
    { key: 'first_column_width', label: 'First column width', kind: 'attr', control: 'text' },
  ],
};

/** Per-block-type repeatable item groups (nested items), mirroring the blueprints. */
const EDM_BLOCK_ROWS: Record<string, { item: string; label: string; fields: BlockFieldSpec[] }> = {
  table: {
    item: 'row',
    label: 'Row',
    fields: [
      { key: 'name', label: 'Name', kind: 'value', control: 'textarea' },
      { key: 'description', label: 'Description', kind: 'value', control: 'textarea' },
    ],
  },
  'edm-attachments': {
    item: 'attachment',
    label: 'Attachment',
    fields: [
      { key: 'file', label: 'File URL', kind: 'attr', control: 'text' },
      { key: 'name', label: 'Display name', kind: 'attr', control: 'text' },
    ],
  },
};

/** Parses the stringified lect the CMS sends; tolerant of malformed input. */
function parseLect(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Exact per-language value (no cross-language fallback), for editor inputs. */
function locExact(lect: Record<string, unknown>, key: string, lang: string): string {
  const value = lect[key];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const map = value as Record<string, unknown>;
    return map[lang] == null ? '' : String(map[lang]);
  }
  return value == null ? '' : String(value);
}

interface EditFieldVM { control: string; label: string; name: string; value: string; placeholder: string; }
interface EditRowVM { label: string; deleteAction: string; fields: EditFieldVM[]; }
interface EditBlockVM {
  index: number;
  type: string;
  title: string;
  nameName: string;
  nameValue: string;
  weightName: string;
  weightValue: number;
  deleteAction: string;
  fields: EditFieldVM[];
  hasRows: boolean;
  rowLabel: string;
  addRowAction: string;
  rows: EditRowVM[];
}

/** One scalar field's view-model (input name + current value + cross-language placeholder). */
function fieldVM(
  lect: Record<string, unknown>,
  prefix: string,
  spec: BlockFieldSpec,
  lang: string,
  defaultLang: string,
): EditFieldVM {
  const name = spec.kind === 'attr' ? `${prefix}@${spec.key}` : `${prefix}.${spec.key}|${lang}`;
  const value = spec.kind === 'attr' ? attr(lect, spec.key) : locExact(lect, spec.key, lang);
  const placeholder = spec.kind === 'value' && lang !== defaultLang ? locExact(lect, spec.key, defaultLang) : '';
  return { control: spec.control, label: spec.label, name, value, placeholder };
}

/** Projects a page's `_blocks` into editor view-models, preserving array index
 *  (the `#<index>` field names round-trip through the CMS save handler). */
function editBlocks(lect: Record<string, unknown>, lang: string, defaultLang: string): EditBlockVM[] {
  const raw = Array.isArray(lect._blocks) ? (lect._blocks as Array<Record<string, unknown>>) : [];
  const models = raw.map((block, index) => {
    const type = attr(block, '_type') || 'paragraph';
    const prefix = `#${index}`;
    const fields = (EDM_BLOCK_FIELDS[type] ?? []).map((spec) => fieldVM(block, prefix, spec, lang, defaultLang));
    const rowSpec = EDM_BLOCK_ROWS[type];
    const rows: EditRowVM[] = rowSpec
      ? items(block, rowSpec.item).map((row, rowIndex) => ({
          label: `${rowSpec.label} ${rowIndex + 1}`,
          deleteAction: `block-item-delete:${index}|${rowSpec.item}|${rowIndex}`,
          fields: rowSpec.fields.map((spec) => fieldVM(row, `${prefix}.${rowSpec.item}[${rowIndex}]`, spec, lang, defaultLang)),
        }))
      : [];
    return {
      index,
      type,
      title: EDM_BLOCK_OPTIONS.find((option) => option.value === type)?.label ?? type,
      nameName: `${prefix}@_name`,
      nameValue: attr(block, '_name'),
      weightName: `${prefix}@_weight`,
      weightValue: Number(block._weight) || index,
      deleteAction: `block-delete:${index}`,
      fields,
      hasRows: !!rowSpec,
      rowLabel: rowSpec?.label ?? '',
      addRowAction: rowSpec ? `block-item-add:${index}|${rowSpec.item}` : '',
      rows,
    };
  });
  // Display in weight order, but the field names keep the original array index.
  return models.sort((a, b) => a.weightValue - b.weightValue);
}

/**
 * Renders the bespoke EDM editor for an `edm` page. Returns 404 for any other
 * page type so the CMS falls back to its built-in editor.
 */
export async function handleEdmEditView(
  request: Request,
  cms: CmsClient,
  views: Fetcher,
  env: EdmEnv,
): Promise<Response> {
  const ctx = (await request.json().catch(() => null)) as EditViewContext | null;
  if (!ctx || ctx.pageType !== 'edm') return new Response('not found', { status: 404 });

  const lect = parseLect(ctx.page.lect);
  const lang = ctx.language || 'mis';
  const defaultLang = 'mis';
  const isEdit = ctx.mode === 'edit';

  // Resolve the parent event (for the header + preview) from the page's pointer.
  const eventId = pageId(pointer(lect, 'event'));
  let eventName = '';
  if (eventId) {
    try {
      const event = await cms.get(eventId);
      if (event.page_type === 'event') eventName = event.name;
    } catch (error) {
      if (!(error instanceof CmsApiError && error.status === 404)) throw error;
    }
  }
  // Offer an event picker when the EDM has no event yet (e.g. a bare new page).
  const events = eventId ? [] : (await cms.list('event', { limit: 500 })).pages;

  const valueField = (key: string) => ({ name: `.${key}|${lang}`, value: locExact(lect, key, lang), placeholder: lang !== defaultLang ? locExact(lect, key, defaultLang) : '' });
  const selfHref = isEdit ? `${ADMIN_BASE}/edm/${ctx.page.id}` : '';

  const body = await renderLiquid(views, '/sections/edm-edit.liquid', {
    title: isEdit ? `Edit ${ctx.page.name}` : 'New EDM',
    action: ctx.action,
    backHref: ctx.backHref || `${ADMIN_BASE}/edm`,
    isEdit,
    language: lang,
    languageOptions: EDM_LANGUAGES.map((option) => ({ ...option, selected: option.value === lang })),
    name: ctx.page.name,
    slug: ctx.page.slug,
    weight: ctx.page.weight,
    eventName,
    eventId: eventId ?? '',
    hasEvent: !!eventId,
    events: events.map((event) => ({ id: event.id, name: event.name })),
    flash: ctx.flash ?? '',
    errors: ctx.errors ?? [],
    // Attributes (sender / styling) — `@field` names.
    sender: attr(lect, 'sender'),
    reply_to: attr(lect, 'reply_to'),
    bcc: attr(lect, 'bcc'),
    text_color: attr(lect, 'text_color') || EDM_STYLE_DEFAULTS.text_color,
    button_color: attr(lect, 'button_color') || EDM_STYLE_DEFAULTS.button_color,
    button_text_color: attr(lect, 'button_text_color') || EDM_STYLE_DEFAULTS.button_text_color,
    line_height: attr(lect, 'line_height') || EDM_STYLE_DEFAULTS.line_height,
    cc_enable: attr(lect, 'cc_enable') || 'no',
    quick_confirm: attr(lect, 'quick_confirm') || 'no',
    thankyou_picture: attr(lect, 'thankyou_picture'),
    // Localized content — `.field|<lang>` names.
    subject: valueField('subject'),
    heading: valueField('heading'),
    body_field: valueField('body'),
    rsvp_button: valueField('rsvp_button'),
    rsvp_form_button: valueField('rsvp_form_button'),
    rsvp_form_decline_button: valueField('rsvp_form_decline_button'),
    thankyou_heading: valueField('thankyou_heading'),
    thankyou_body: valueField('thankyou_body'),
    decline_heading: valueField('decline_heading'),
    decline_body: valueField('decline_body'),
    // Content blocks.
    blocks: editBlocks(lect, lang, defaultLang),
    hasBlocks: Array.isArray(lect._blocks) && (lect._blocks as unknown[]).length > 0,
    blockOptions: EDM_BLOCK_OPTIONS,
    // EDM-specific actions (edit mode only).
    previewHref: isEdit ? `${selfHref}/preview?language=${encodeURIComponent(lang)}` : '',
    // Language tabs for the preview pane — each loads the iframe in that language
    // (anchors targeting the iframe by name, so no client JS is needed).
    previewLangs: isEdit
      ? EDM_LANGUAGES.map((option) => ({
          label: option.label,
          href: `${selfHref}/preview?language=${encodeURIComponent(option.value)}`,
          active: option.value === lang,
        }))
      : [],
    testAction: isEdit ? `${selfHref}/send-test` : '',
    deleteAction: isEdit ? `/admin/pages/${ctx.page.id}/delete` : '',
    senderSet: attr(lect, 'sender') !== '',
  });

  return new Response(body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'x-cms-chrome': '1',
      'x-cms-title': encodeURIComponent(isEdit ? `Edit ${ctx.page.name}` : 'New EDM'),
    },
  });
}

export async function handleEdmAdmin(
  request: Request,
  cms: CmsClient,
  views: Fetcher,
  env: EdmEnv,
  segments: string[],
  url: URL,
): Promise<Response> {
  if (!segments.length) return edmIndex(cms, views);
  if (segments[0] === 'new') {
    if (request.method === 'POST') return createEdm(request, cms, views);
    return edmNewForm(cms, views, url);
  }

  const edmId = pageId(segments[0]);
  if (!edmId) return notFoundView(views, 'EDM not found.');
  if (segments[1] === 'preview') return edmPreview(cms, views, env, edmId, url.searchParams.get('language') ?? undefined);
  if (segments[1] === 'duplicate' && request.method === 'POST') return duplicateEdm(cms, views, edmId);
  if (segments[1] === 'send-test' && request.method === 'POST') return sendTest(request, cms, views, env, edmId);
  if (segments[1] === 'assign-list' && request.method === 'POST') return assignGuestList(request, cms, views, edmId);
  if (segments[1] === 'send-list' && request.method === 'POST') return sendGuestList(request, cms, views, env, edmId);
  // The EDM is edited directly in the page editor (the plugin renders that view —
  // see handleEdmEditView). The old standalone EDM landing page is gone, so a bare
  // /edm/:id just forwards there; stale bookmarks keep working.
  return redirect(editorHref(edmId));
}

/** Link into the EDM page editor (the plugin-rendered edit view), returning to
 *  the EDM list. Extra query params (e.g. a `flash` message) are appended. */
function editorHref(edmId: number, params: Record<string, string> = {}): string {
  const query = new URLSearchParams({ return_to: `${ADMIN_BASE}/edm`, ...params });
  return `/admin/pages/${edmId}/edit?${query.toString()}`;
}

export async function deliverQueuedEmail(env: EdmEnv, delivery: EmailDelivery): Promise<void> {
  if (!env.EMAIL || !env.EMAIL_FROM) throw new Error('EMAIL and EMAIL_FROM must be configured before sending EDMs');
  await env.EMAIL.send({ ...delivery, from: delivery.from || env.EMAIL_FROM });
}

/** Queues every due mail-list blast once; invoked by the optional Cron Trigger. */
export async function dispatchDueMailLists(cms: CmsClient, views: Fetcher, env: EdmEnv): Promise<number> {
  if (!env.MAIL_QUEUE) return 0;
  const { pages: lists } = await cms.list('mail_list', { limit: 500 });
  const now = Date.now();
  let queued = 0;

  for (const list of lists) {
    const scheduledAt = Date.parse(attr(list.lect, 'blast_datetime'));
    const edmId = pageId(pointer(list.lect, 'edm'));
    if (!edmId || Number.isNaN(scheduledAt) || scheduledAt > now || attr(list.lect, 'blasted_at')) continue;
    try {
      const count = await queueGuestList(cms, views, env, edmId, list.id);
      if (count < 0) continue;
      queued += count;
      await cms.update(list.id, { lect: { ...list.lect, blasted_at: new Date().toISOString() } });
    } catch (error) {
      console.error(`Unable to queue scheduled blast for mail list ${list.id}`, error);
    }
  }
  return queued;
}

async function edmIndex(cms: CmsClient, views: Fetcher): Promise<Response> {
  const [{ pages: edms }, { pages: events }] = await Promise.all([
    cms.list('edm', { limit: 500 }),
    cms.list('event', { limit: 500 }),
  ]);
  const eventsById = new Map(events.map((event) => [event.id, event]));
  return adminView(views, 'EDMs', 'edm-list', {
    newHref: `${ADMIN_BASE}/edm/new`,
    edms: edms.map((edm) => {
      const event = eventsById.get(pageId(pointer(edm.lect, 'event')) ?? 0);
      return {
        name: edm.name,
        subject: localized(edm.lect, 'subject') || edm.name,
        eventName: event?.name ?? 'Unknown event',
        href: editorHref(edm.id),
        previewHref: `${ADMIN_BASE}/edm/${edm.id}/preview`,
      };
    }),
  });
}

/** Minimal "New EDM" step: pick the event + name, then hand off to the editor. */
async function edmNewForm(cms: CmsClient, views: Fetcher, url: URL): Promise<Response> {
  const { pages: events } = await cms.list('event', { limit: 500 });
  const selectedEventId = pageId(url.searchParams.get('event_id'));
  return adminView(views, 'New EDM', 'edm-form', {
    action: `${ADMIN_BASE}/edm/new`,
    backHref: `${ADMIN_BASE}/edm`,
    events: events.map((event) => ({ id: event.id, name: event.name, selected: event.id === selectedEventId })),
  });
}

/**
 * Creates a minimal EDM grouped to its event by the `event` pointer (not parent
 * page), then redirects into the editor so the rest of the blueprint — settings
 * and per-language content — is filled there.
 */
async function createEdm(request: Request, cms: CmsClient, views: Fetcher): Promise<Response> {
  const form = await request.formData();
  const eventId = pageId(form.get('event_id'));
  const name = formText(form, 'name');
  if (!eventId || !name) return redirect(`${ADMIN_BASE}/edm/new`);
  const event = await cms.get(eventId);
  if (event.page_type !== 'event') return notFoundView(views, 'Event not found.');
  const edm = await cms.create({
    page_type: 'edm',
    name,
    lect: { _type: 'edm', name: { en: name }, subject: { en: name }, _pointers: { event: String(eventId) } },
  });
  return redirect(editorHref(edm.id));
}

/** Clones an EDM (content + event pointer) under the same event, then opens the copy. */
async function duplicateEdm(cms: CmsClient, views: Fetcher, edmId: number): Promise<Response> {
  const edm = await cms.get(edmId);
  if (edm.page_type !== 'edm') return notFoundView(views, 'EDM not found.');
  // The event grouping rides along in the copied lect's `_pointers.event`.
  const copy = await cms.create({
    page_type: 'edm',
    name: `Copy of ${edm.name}`,
    lect: { ...edm.lect },
  });
  return redirect(editorHref(copy.id));
}

async function edmPreview(cms: CmsClient, views: Fetcher, env: EdmEnv, edmId: number, language?: string): Promise<Response> {
  const edm = await cms.get(edmId);
  if (edm.page_type !== 'edm') return notFoundView(views, 'EDM not found.');
  const html = await renderEmail(views, edm, env, { server: env.PUBLIC_BASE_URL, language });
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Opt into being embedded in a same-origin <iframe> (the EDM editor's
      // preview pane). The CMS proxy turns this into X-Frame-Options: SAMEORIGIN.
      'x-cms-frame': '1',
    },
  });
}

async function sendTest(request: Request, cms: CmsClient, views: Fetcher, env: EdmEnv, edmId: number): Promise<Response> {
  const recipient = formText(await request.formData(), 'recipient');
  if (!recipient || !isEmail(recipient)) return mailError(views, 'Enter a valid test-recipient email address.');
  const edm = await cms.get(edmId);
  if (edm.page_type !== 'edm') return notFoundView(views, 'EDM not found.');
  try {
    await deliverQueuedEmail(env, { ...await emailFor(views, edm, recipient, env, { server: env.PUBLIC_BASE_URL }), edmId });
  } catch (error) {
    return mailError(views, error instanceof Error ? error.message : 'Unable to send the test email.');
  }
  return redirect(editorHref(edmId, { flash: `Test email sent to ${recipient}` }));
}

async function assignGuestList(request: Request, cms: CmsClient, views: Fetcher, edmId: number): Promise<Response> {
  const edm = await cms.get(edmId);
  if (edm.page_type !== 'edm') return notFoundView(views, 'EDM not found.');
  const listId = pageId(formText(await request.formData(), 'list_id'));
  if (!listId) return redirect(editorHref(edmId));
  const list = await cms.get(listId);
  // The list and EDM must belong to the same event (by their `event` pointer).
  const eventId = pointer(edm.lect, 'event');
  if (list.page_type !== 'mail_list' || pointer(list.lect, 'event') !== eventId) return notFoundView(views, 'Guest list not found.');
  await cms.update(list.id, {
    lect: { ...list.lect, _pointers: { ...pointers(list), edm: String(edmId) } },
  });
  return redirect(editorHref(edmId));
}

async function sendGuestList(request: Request, cms: CmsClient, views: Fetcher, env: EdmEnv, edmId: number): Promise<Response> {
  if (!env.MAIL_QUEUE) return mailError(views, 'MAIL_QUEUE must be configured before sending to a guest list.');
  const listId = pageId(formText(await request.formData(), 'list_id'));
  if (!listId) return redirect(editorHref(edmId));
  const queued = await queueGuestList(cms, views, env, edmId, listId);
  if (queued < 0) return notFoundView(views, 'EDM or guest list not found.');
  return redirect(editorHref(edmId, { flash: `Queued ${queued} email(s)` }));
}

async function queueGuestList(cms: CmsClient, views: Fetcher, env: EdmEnv, edmId: number, listId: number): Promise<number> {
  if (!env.MAIL_QUEUE) throw new Error('MAIL_QUEUE is not configured');
  const [edm, list] = await Promise.all([cms.get(edmId), cms.get(listId)]);
  if (edm.page_type !== 'edm' || list.page_type !== 'mail_list' || pointer(list.lect, 'edm') !== String(edmId)) return -1;
  const { pages: guests } = await cms.list('guest', { parentId: listId, limit: 500 });

  const eventId = pageId(pointer(edm.lect, 'event'));
  const rsvpEnabled = Boolean(eventId && env.PUBLIC_BASE_URL && env.PLUGIN_SECRET);
  // Render (and MJML-compile) ONCE per blast, leaving a placeholder where each
  // guest's signed RSVP URL goes — then string-swap it per recipient. This keeps
  // a 500-guest send to a single MJML API call instead of 500.
  const htmlTemplate = await renderEmail(views, edm, env, {
    rsvpUrl: rsvpEnabled ? RSVP_URL_PLACEHOLDER : '',
    server: env.PUBLIC_BASE_URL,
  });
  const values = edmValues(edm);
  const text = plainText(values.heading, values.body);
  const headers = deliveryHeaders(values);

  const deliveries: EmailDelivery[] = [];
  for (const guest of guests) {
    const recipient = attr(guest.lect, 'email');
    if (!recipient || !isEmail(recipient) || attr(guest.lect, 'not_send') === 'true') continue;
    const html = rsvpEnabled
      ? htmlTemplate.replaceAll(RSVP_URL_PLACEHOLDER, await guestRsvpUrl(env, eventId!, listId, guest.id))
      : htmlTemplate;
    deliveries.push({ from: values.sender, to: recipient, subject: values.subject, html, text, edmId, guestId: guest.id, ...headers });
  }
  for (const chunk of chunks(deliveries, 100)) await env.MAIL_QUEUE.sendBatch(chunk.map((body) => ({ body })));
  return deliveries.length;
}

async function emailFor(
  views: Fetcher,
  edm: CmsPage,
  recipient: string,
  env: EdmEnv,
  options: { rsvpUrl?: string; server?: string; language?: string } = {},
): Promise<OutboundEmail> {
  const values = edmValues(edm);
  return {
    from: values.sender,
    to: recipient,
    subject: values.subject,
    html: await renderEmail(views, edm, env, options),
    text: plainText(values.heading, values.body),
    ...deliveryHeaders(values),
  };
}

// ── Per-guest send / preview (RSVP guest-list buttons) ─────────────────────────

/** Role mailboxes treated as lower-confidence by the deliverability heuristic. */
const ROLE_MAILBOXES = new Set([
  'info', 'admin', 'administrator', 'sales', 'contact', 'hello', 'support', 'office',
  'enquiry', 'enquiries', 'hr', 'marketing', 'noreply', 'no-reply', 'donotreply',
  'do-not-reply', 'mailer-daemon', 'postmaster', 'webmaster', 'team',
]);

/**
 * Lightweight deliverability heuristic for the "Auto Send (Good/Risky)" split.
 * This is NOT real email verification — it just separates clearly-addressable
 * mailboxes ("good") from syntactically-valid-but-flagged ones ("risky", e.g.
 * role addresses, tagged addresses, single-label domains). No email → "invalid".
 */
export function emailQuality(email: string): 'good' | 'risky' | 'invalid' {
  const value = (email || '').trim().toLowerCase();
  if (!isEmail(value)) return 'invalid';
  const at = value.lastIndexOf('@');
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!domain.includes('.')) return 'risky';
  if (local.includes('+')) return 'risky';
  if (ROLE_MAILBOXES.has(local)) return 'risky';
  return 'good';
}

/** Has this guest already been sent the given EDM? (recorded in lect.sent_edm). */
export function guestWasSentEdm(guest: CmsPage, edmId: number): boolean {
  const sent = guest.lect.sent_edm;
  return Array.isArray(sent) && sent.some((id) => String(id) === String(edmId));
}

/** Sends one EDM to one guest immediately (or via the queue when bound). The
 *  caller records `sent_edm`. Throws when the guest has no valid email. */
export async function sendEdmToGuest(
  views: Fetcher,
  env: EdmEnv,
  edm: CmsPage,
  eventId: number | null,
  listId: number,
  guest: CmsPage,
): Promise<void> {
  const recipient = attr(guest.lect, 'email');
  if (!recipient || !isEmail(recipient)) throw new Error('Guest has no valid email address');
  const rsvpUrl = eventId ? await guestRsvpUrl(env, eventId, listId, guest.id) : '';
  const language = attr(guest.lect, 'prefer_language') || undefined;
  const delivery = {
    ...await emailFor(views, edm, recipient, env, { rsvpUrl, server: env.PUBLIC_BASE_URL, language }),
    edmId: edm.id,
    guestId: guest.id,
  };
  if (env.MAIL_QUEUE) await env.MAIL_QUEUE.send(delivery);
  else await deliverQueuedEmail(env, delivery);
}

/** Renders the EDM email HTML for one guest (preview), with their signed RSVP link. */
export function previewEdmForGuest(
  views: Fetcher,
  env: EdmEnv,
  edm: CmsPage,
  eventId: number | null,
  listId: number,
  guest: CmsPage,
): Promise<string> {
  const language = attr(guest.lect, 'prefer_language') || undefined;
  return (async () => {
    const rsvpUrl = eventId ? await guestRsvpUrl(env, eventId, listId, guest.id) : '';
    return renderEmail(views, edm, env, { rsvpUrl, server: env.PUBLIC_BASE_URL, language });
  })();
}

/**
 * Renders an EDM page to email HTML through the legacy two-stage pipeline:
 * Liquid emits MJML (head styling from the EDM's tokens + a body built from its
 * content blocks), then the MJML is compiled — via the MJML API when configured,
 * otherwise the built-in compiler — to email-safe HTML.
 */
async function renderEmail(
  views: Fetcher,
  edm: CmsPage,
  env: EdmEnv,
  options: { rsvpUrl?: string; server?: string; language?: string } = {},
): Promise<string> {
  const tokens = edmTokens(edm, options.language);
  const server = options.server ?? '';
  // Stage 1 — build the MJML body from the EDM's content blocks.
  const main = await renderLiquid(views, '/templates/edm-mjml.liquid', {
    blocks: edmRenderBlocks(edm, options.language),
    server,
    rsvpUrl: options.rsvpUrl ?? '',
    rsvp_button: tokens.rsvp_button,
  });
  // Stage 2 — wrap in the MJML document (head attributes from tokens), then compile.
  const mjml = await renderLiquid(views, '/layout/mjml.liquid', { tokens, main });
  return compileMjml(mjml, env);
}

/**
 * Compiles MJML to HTML via the MJML render API (https://api.mjml.io) when
 * credentials are configured — it produces the Outlook/ghost-table markup a
 * minimal compiler can't. Identical MJML yields identical HTML, so API output is
 * cached in KV (keyed by the MJML hash) to spare quota on repeated renders.
 * Falls back to the built-in compiler when credentials are absent (dev/tests) or
 * the API call fails, so a render never hard-fails.
 */
async function compileMjml(mjml: string, env: EdmEnv): Promise<string> {
  if (env.MJML_APP_ID && env.MJML_SECRET_KEY) {
    const cache = env.MAIL_TRACKING;
    const cacheKey = cache ? await mjmlCacheKey(mjml) : '';
    if (cache && cacheKey) {
      try {
        const hit = await cache.get(cacheKey);
        if (hit) return hit;
      } catch (error) {
        console.error('MJML cache read failed', error);
      }
    }
    try {
      const res = await fetch(env.MJML_API_URL ?? 'https://api.mjml.io/v1/render', {
        method: 'POST',
        headers: {
          authorization: `Basic ${btoa(`${env.MJML_APP_ID}:${env.MJML_SECRET_KEY}`)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ mjml }),
      });
      if (res.ok) {
        const data = await res.json() as { html?: string; errors?: unknown[] };
        if (typeof data.html === 'string' && data.html) {
          if (cache && cacheKey) {
            try {
              await cache.put(cacheKey, data.html, { expirationTtl: MJML_CACHE_TTL_SECONDS });
            } catch (error) {
              console.error('MJML cache write failed', error);
            }
          }
          return data.html;
        }
        console.error('MJML API returned no html', data.errors);
      } else {
        console.error(`MJML API responded ${res.status}; falling back to built-in compiler`);
      }
    } catch (error) {
      console.error('MJML API request failed; falling back to built-in compiler', error);
    }
  }
  return mjmlToHtml(mjml);
}

/** Cache key for an MJML document: a SHA-256 hex digest under a versioned prefix. */
async function mjmlCacheKey(mjml: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(mjml));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `mjml:v1:${hex}`;
}

/** Flat token map the MJML layout reads (content + styling), each a string. */
function edmTokens(edm: CmsPage, language?: string): Record<string, string> {
  const lect = edm.lect;
  return {
    subject: localized(lect, 'subject', language) || edm.name,
    heading: localized(lect, 'heading', language),
    body: safeHtml(localized(lect, 'body', language)),
    rsvp_button: localized(lect, 'rsvp_button', language) || 'RSVP',
    text_color: attr(lect, 'text_color'),
    font_size: attr(lect, 'font_size'),
    font_family: attr(lect, 'font_family'),
    bg_color: attr(lect, 'bg_color'),
    image_padding: attr(lect, 'image_padding'),
    button_color: attr(lect, 'button_color'),
    button_text_color: attr(lect, 'button_text_color'),
    headline_font_size: attr(lect, 'headline_font_size'),
    headline_padding: attr(lect, 'headline_padding'),
    table_padding: attr(lect, 'table_padding'),
    line_height: attr(lect, 'line_height'),
  };
}

/**
 * Projects the EDM's content blocks into the flat, sanitised shapes the MJML
 * block snippets expect (rich-text fields run through safeHtml).
 */
function edmRenderBlocks(edm: CmsPage, language?: string): Array<Record<string, unknown>> {
  return blocks(edm.lect).map((block) => {
    const type = attr(block, '_type');
    switch (type) {
      case 'paragraph':
        return { _type: type, subject: localized(block, 'subject', language), body: safeHtml(localized(block, 'body', language)) };
      case 'picture':
        return { _type: type, picture: attr(block, 'picture'), width: attr(block, 'width'), align: attr(block, 'align') };
      case 'button':
        return { _type: type, label: localized(block, 'label', language) || attr(block, 'label'), url: localized(block, 'url', language) || attr(block, 'url') };
      case 'table':
        return {
          _type: type,
          title: safeHtml(localized(block, 'title', language)),
          first_column_width: attr(block, 'first_column_width'),
          row: items(block, 'row').map((row) => ({
            name: safeHtml(localized(row, 'name', language)),
            description: safeHtml(localized(row, 'description', language)),
          })),
        };
      case 'spacer':
        return { _type: type, lines: attr(block, 'lines') };
      case 'edm-unsubscribe':
        return { _type: type };
      default:
        return { _type: type };
    }
  });
}

async function guestRsvpUrl(env: EdmEnv, eventId: number, listId: number, guestId: number): Promise<string> {
  if (!env.PUBLIC_BASE_URL || !env.PLUGIN_SECRET) return '';
  const payload = `rsvp:${eventId}:${listId}:${guestId}`;
  const signature = await signPayload(env.PLUGIN_SECRET, payload);
  return `${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/rsvp/${eventId}/${listId}/${guestId}/${signature}`;
}

/** EDM styling/line-height defaults — kept in sync with the MJML layout's own
 *  `| default:` fallbacks so the editor shows the colour that will actually render. */
const EDM_STYLE_DEFAULTS = {
  text_color: '#555555',
  button_color: '#333333',
  button_text_color: '#FFFFFF',
  line_height: '1.5',
} as const;

function edmValues(edm: CmsPage): Record<string, string> {
  return {
    name: edm.name,
    sender: attr(edm.lect, 'sender'),
    reply_to: attr(edm.lect, 'reply_to'),
    bcc: attr(edm.lect, 'bcc'),
    subject: localized(edm.lect, 'subject') || edm.name,
    heading: localized(edm.lect, 'heading'),
    body: localized(edm.lect, 'body'),
    rsvp_button: localized(edm.lect, 'rsvp_button') || 'RSVP',
    rsvp_form_button: localized(edm.lect, 'rsvp_form_button'),
    rsvp_form_decline_button: localized(edm.lect, 'rsvp_form_decline_button'),
    cc_enable: attr(edm.lect, 'cc_enable'),
    quick_confirm: attr(edm.lect, 'quick_confirm'),
    thankyou_picture: attr(edm.lect, 'thankyou_picture'),
    thankyou_heading: localized(edm.lect, 'thankyou_heading'),
    thankyou_body: localized(edm.lect, 'thankyou_body'),
    decline_heading: localized(edm.lect, 'decline_heading'),
    decline_body: localized(edm.lect, 'decline_body'),
    text_color: attr(edm.lect, 'text_color') || EDM_STYLE_DEFAULTS.text_color,
    button_color: attr(edm.lect, 'button_color') || EDM_STYLE_DEFAULTS.button_color,
    button_text_color: attr(edm.lect, 'button_text_color') || EDM_STYLE_DEFAULTS.button_text_color,
    line_height: attr(edm.lect, 'line_height') || EDM_STYLE_DEFAULTS.line_height,
  };
}

function pointers(page?: CmsPage): Record<string, unknown> {
  const value = page?.lect._pointers;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function pageId(value: unknown): number | null {
  const id = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function formText(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** Splits the EDM's free-text `bcc` field (comma/semicolon separated) into valid addresses. */
function bccList(value: string): string[] {
  return value.split(/[,;]/).map((address) => address.trim()).filter(isEmail);
}

/**
 * Builds the optional Reply-To / Bcc fields the Cloudflare Email binding accepts,
 * omitting each when unset so a blank EDM field doesn't send an empty header.
 */
function deliveryHeaders(values: Record<string, string>): { replyTo?: string; bcc?: string[] } {
  const headers: { replyTo?: string; bcc?: string[] } = {};
  const replyTo = (values.reply_to ?? '').trim();
  if (isEmail(replyTo)) headers.replyTo = replyTo;
  const bcc = bccList(values.bcc ?? '');
  if (bcc.length) headers.bcc = bcc;
  return headers;
}

function plainText(heading: string, body: string): string {
  return `${heading}\n\n${body.replace(/<[^>]*>/g, ' ')}`.replace(/\n{3,}/g, '\n\n').trim();
}

function safeHtml(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href|src)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]*)/gi, ' $1="#"');
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function redirect(to: string): Response {
  return new Response(null, { status: 302, headers: { Location: to } });
}

function mailError(views: Fetcher, message: string): Promise<Response> {
  return adminView(views, 'Email delivery unavailable', 'error', { heading: 'Email delivery unavailable', message });
}
