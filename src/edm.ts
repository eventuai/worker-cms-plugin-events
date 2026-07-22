import { CmsApiError, CmsClient, attr, blocks, chargeCreditAction, items, localized, pointer, type CmsPage } from './cms';
import { compactCheckinCode, signPayload } from './crypto';
import { mjmlToHtml } from './mjml';
import { qrSvg } from './qr';
import { sendViaSes, sesConfigured, type SesEnv } from './ses';
import { renderLiquid } from './templates/liquid';
import { adminView, clientViewResponse, notFoundView } from './templates/views';
import { redirect } from '@lionrockjs/worker-cms-plugin';
import MANIFEST from './manifest.json';

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
  /** Tenant (CMS) this delivery belongs to — the queue consumer re-resolves
   *  the tenant's env (EMAIL_FROM overrides etc.) before sending. */
  tenantId?: string;
}

export interface EdmEnv extends SesEnv {
  EMAIL?: { send(message: OutboundEmail): Promise<unknown> };
  MAIL_QUEUE?: Queue<EmailDelivery>;
  EMAIL_FROM?: string;
  CMS_URL?: string;
  PLUGIN_SECRET?: string;
  /** Tenant public-token signing key (tenantClientEnv overlay); falls back to PLUGIN_SECRET. */
  SIGN_KEY?: string;
  CMS_TENANT_ID?: string;
  CMS_TENANT_REF?: string;
  PUBLIC_BASE_URL?: string;
  /** Public origin of cms-plugin-checkin's guest /checkin/* routes. */
  CHECKIN_BASE_URL?: string;
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
/** Guest-specific QR image swapped after the shared EDM template is compiled. */
const CHECKIN_QR_IMAGE_PLACEHOLDER = 'https://__edm_checkin_qr_image__/';
const CHECKIN_CODE_PLACEHOLDER = '__edm_checkin_code__';
const CHECKIN_URL_PLACEHOLDER = 'https://__edm_checkin_url__/';
const EMAIL_SEND_RATE_LIMIT_KEY = 'send_email_per_second';
const DEFAULT_EMAILS_PER_SECOND = 1;
const emailRateCache = new Map<string, { expiresAt: number; value: number | null }>();
const emailSendChains = new Map<string, Promise<void>>();
const lastEmailSentAt = new Map<string, number>();

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

type BlueprintEntry = string | Record<string, BlueprintEntry[]>;
type BlockFieldSpec = { key: string; label: string; kind: 'attr' | 'value'; type: string; control: 'text' | 'textarea' | 'number' };
type BlockRowSpec = { item: string; label: string; fields: BlockFieldSpec[] };

interface FieldOptionVM {
  value: string;
  label: string;
  selected: boolean;
}

const EDM_BLOCK_DEFINITIONS = manifestBlockDefinitions();
const EDM_BLOCK_FIELDS: Record<string, BlockFieldSpec[]> = Object.fromEntries(
  Object.entries(EDM_BLOCK_DEFINITIONS).map(([type, definition]) => [type, definition.fields]),
);
const EDM_BLOCK_ROWS: Record<string, BlockRowSpec> = Object.fromEntries(
  Object.entries(EDM_BLOCK_DEFINITIONS)
    .filter((entry): entry is [string, { fields: BlockFieldSpec[]; row: BlockRowSpec }] => !!entry[1].row)
    .map(([type, definition]) => [type, definition.row]),
);
const EDM_BLOCK_OPTIONS: Array<{ value: string; label: string }> = ((MANIFEST.contentTypes.blockLists.edm ?? []) as string[])
  .filter((type) => type in EDM_BLOCK_DEFINITIONS)
  .map((type) => ({ value: type, label: labelFor(type) }));

/** Input controls supported by the public RSVP renderer and legacy EDM editor. */
const RSVP_CUSTOM_INPUT_TYPES = ['text', 'textarea', 'select', 'radio', 'checkbox', 'email', 'tel', 'number', 'date', 'time'];

function manifestBlockDefinitions(): Record<string, { fields: BlockFieldSpec[]; row?: BlockRowSpec }> {
  const blocks = MANIFEST.contentTypes.blocks as Record<string, BlueprintEntry[]>;
  const result: Record<string, { fields: BlockFieldSpec[]; row?: BlockRowSpec }> = {};
  for (const [type, entries] of Object.entries(blocks)) {
    result[type] = blockDefinition(entries);
  }
  return result;
}

function blockDefinition(entries: BlueprintEntry[]): { fields: BlockFieldSpec[]; row?: BlockRowSpec } {
  const fields: BlockFieldSpec[] = [];
  let row: BlockRowSpec | undefined;

  for (const entry of entries) {
    if (typeof entry === 'string') {
      fields.push(manifestField(entry));
      continue;
    }
    const [itemName, itemEntries] = Object.entries(entry)[0] ?? [];
    if (itemName && itemEntries) {
      row = {
        item: itemName,
        label: labelFor(itemName),
        fields: itemEntries.filter((item): item is string => typeof item === 'string').map(manifestField),
      };
    }
  }

  return { fields, row };
}

function manifestField(raw: string): BlockFieldSpec {
  const kind = raw.startsWith('@') ? 'attr' : 'value';
  const keyWithType = raw.replace(/^[@*]/, '');
  const [key, type = 'text'] = keyWithType.split(':');
  const normalizedType = pageFieldType(type);
  return {
    key,
    label: labelFor(key),
    kind,
    type: normalizedType,
    control: normalizedType === 'number' ? 'number' : normalizedType === 'textarea' || normalizedType === 'richtext/md' ? 'textarea' : 'text',
  };
}

function labelFor(value: string): string {
  return value
    .replace(/^edm-/, '')
    .replace(/^rsvp-/, 'RSVP ')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

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

interface EditFieldVM {
  control: string;
  label: string;
  name: string;
  inputName: string;
  id: string;
  type: string;
  templateName: string;
  value: string;
  placeholder: string;
  required: boolean;
  options: FieldOptionVM[];
  checked: boolean;
  defaultValue: string;
  blankOption: boolean;
  blankLabel: string;
  span: string;
}
interface EditRowVM {
  label: string;
  weightId: string;
  weightName: string;
  weightValue: number;
  deleteAction: string;
  canDelete: boolean;
  fields: EditFieldVM[];
}
interface EditBlockVM {
  index: number;
  type: string;
  title: string;
  nameName: string;
  nameValue: string;
  nameField: EditFieldVM;
  weightName: string;
  weightValue: number;
  weightField: EditFieldVM;
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
  return editField(name, spec.label, value, spec.type, { control: spec.control, placeholder });
}

/**
 * RSVP custom-input rows have an `@type` attribute that drives public form
 * rendering. Keep it constrained to the types both the legacy editor and the
 * public worker understand; a free-text typo otherwise silently becomes an
 * unusable input on the guest page.
 */
function rowFieldVM(
  row: Record<string, unknown>,
  prefix: string,
  spec: BlockFieldSpec,
  rowItem: string,
  lang: string,
  defaultLang: string,
): EditFieldVM {
  if (['custom_input', 'flight_custom_input', 'hotel_custom_input'].includes(rowItem) && spec.key === 'type') {
    const inputName = `${prefix}@type`;
    const value = attr(row, 'type') || 'text';
    return editField(inputName, 'Input type', value, 'select', {
      options: RSVP_CUSTOM_INPUT_TYPES.map((type) => ({ value: type, label: labelFor(type), selected: type === value })),
    });
  }
  return fieldVM(row, prefix, spec, lang, defaultLang);
}

function localizedField(key: string, label: string, lect: Record<string, unknown>, lang: string, defaultLang: string, type = 'text', required = false): EditFieldVM {
  return editField(`.${key}|${lang}`, label, locExact(lect, key, lang), type, {
    placeholder: lang !== defaultLang ? locExact(lect, key, defaultLang) : '',
    required,
  });
}

function attrField(key: string, label: string, lect: Record<string, unknown>, type = 'text', fallback = ''): EditFieldVM {
  return editField(`@${key}`, label, attr(lect, key) || fallback, type);
}

function switchField(key: string, label: string, lect: Record<string, unknown>, fallback = 'no'): EditFieldVM {
  return editField(`@${key}`, label, attr(lect, key) || fallback, 'switch');
}

function editField(
  inputName: string,
  label: string,
  value: string,
  type = 'text',
  options: Partial<Pick<EditFieldVM, 'control' | 'placeholder' | 'required' | 'options' | 'checked' | 'defaultValue' | 'span' | 'blankOption' | 'blankLabel'>> = {},
): EditFieldVM {
  const normalizedType = pageFieldType(type);
  return {
    control: options.control ?? (normalizedType === 'richtext/md' ? 'textarea' : normalizedType),
    label,
    name: inputName,
    inputName,
    id: fieldId(inputName),
    type: normalizedType,
    templateName: workerPageFieldTemplate(normalizedType),
    value,
    placeholder: options.placeholder ?? '',
    required: options.required ?? false,
    options: options.options ?? [],
    checked: options.checked ?? false,
    defaultValue: options.defaultValue ?? '',
    blankOption: options.blankOption ?? false,
    blankLabel: options.blankLabel ?? '',
    span: options.span ?? '',
  };
}

function pageFieldType(type: string): string {
  const normalized = type.trim().toLowerCase();
  if (['text', 'email', 'tel', 'url', 'number', 'date', 'time', 'textarea', 'select', 'radio', 'checkbox', 'switch', 'boolean', 'color', 'picture', 'richtext/md'].includes(normalized)) return normalized;
  return 'text';
}

function workerPageFieldTemplate(type: string): string {
  if (type === 'richtext/md') return 'snippets/pagefield/richtext/md';
  if ([
    'text',
    'email',
    'tel',
    'url',
    'number',
    'date',
    'time',
    'textarea',
    'select',
    'radio',
    'checkbox',
    'switch',
    'boolean',
    'color',
    'picture',
  ].includes(type)) return `snippets/pagefield/${type}/basic`;
  return '';
}

function fieldId(inputName: string): string {
  return `field_${Array.from(inputName)
    .map((char) => (/^[A-Za-z0-9_-]$/.test(char) ? char : `_${char.charCodeAt(0).toString(16)}_`))
    .join('')}`;
}

/** Projects a page's `_blocks` into editor view-models, preserving array index
 *  (the `#<index>` field names round-trip through the CMS save handler). */
function editBlocks(lect: Record<string, unknown>, lang: string, defaultLang: string): EditBlockVM[] {
  const raw = Array.isArray(lect._blocks) ? (lect._blocks as Array<Record<string, unknown>>) : [];
  const models = raw.map((block, index) => {
    const storedType = attr(block, '_type');
    // Older plugin-rendered EDM forms omitted the hidden block type. The CMS
    // then saved picture blocks as `default`, while retaining their picture
    // value. Recover those blocks in the editor and repair the type on save.
    const type = (!storedType || storedType === 'default') && attr(block, 'picture')
      ? 'picture'
      : storedType || 'paragraph';
    const prefix = `#${index}`;
    const fields = (EDM_BLOCK_FIELDS[type] ?? []).map((spec) => fieldVM(block, prefix, spec, lang, defaultLang));
    const rowSpec = EDM_BLOCK_ROWS[type];
    const rowItems = rowSpec ? items(block, rowSpec.item) : [];
    const rows: EditRowVM[] = rowSpec
      ? rowItems
        .map((row, rowIndex) => ({ row, rowIndex, weight: itemWeight(row, rowIndex) }))
        .sort((left, right) => left.weight - right.weight || left.rowIndex - right.rowIndex)
        .map(({ row, rowIndex, weight }, displayIndex) => ({
          label: `${rowSpec.label} ${displayIndex + 1}`,
          weightId: fieldId(`${prefix}.${rowSpec.item}[${rowIndex}]@_weight`),
          weightName: `${prefix}.${rowSpec.item}[${rowIndex}]@_weight`,
          weightValue: weight,
          deleteAction: `block-item-delete:${index}|${rowSpec.item}|${rowIndex}`,
          // RSVP custom-input blocks always keep one editable input. Other
          // repeaters (attachments, table rows, etc.) may still become empty.
          canDelete: rowSpec.item !== 'custom_input' || rowItems.length > 1,
          fields: rowSpec.fields.map((spec) => rowFieldVM(row, `${prefix}.${rowSpec.item}[${rowIndex}]`, spec, rowSpec.item, lang, defaultLang)),
        }))
      : [];
    return {
      index,
      type,
      title: EDM_BLOCK_OPTIONS.find((option) => option.value === type)?.label ?? type,
      nameName: `${prefix}@_name`,
      nameValue: attr(block, '_name'),
      nameField: editField(`${prefix}@_name`, 'Block label', attr(block, '_name'), 'text', { placeholder: 'optional' }),
      weightName: `${prefix}@_weight`,
      weightValue: Number(block._weight) || index,
      weightField: editField(`${prefix}@_weight`, 'Order', String(Number(block._weight) || index), 'number'),
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

function itemWeight(item: Record<string, unknown>, fallback: number): number {
  const weight = Number(item._weight);
  return Number.isFinite(weight) ? weight : fallback;
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
  void views;
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

  const selfHref = isEdit ? `${ADMIN_BASE}/edm/${ctx.page.id}` : '';

  const title = isEdit ? `Edit ${ctx.page.name}` : 'New EDM';
  void views;
  return clientViewResponse(title, '/sections/edm-edit.liquid', {
    title,
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
    senderFields: [
      attrField('sender', 'Sender email', lect, 'email'),
      attrField('reply_to', 'Reply-to', lect, 'email'),
      attrField('bcc', 'Bcc', lect, 'text'),
    ],
    styleFields: [
      attrField('text_color', 'Text color', lect, 'color', EDM_STYLE_DEFAULTS.text_color),
      attrField('button_color', 'Button color', lect, 'color', EDM_STYLE_DEFAULTS.button_color),
      attrField('button_text_color', 'Button text', lect, 'color', EDM_STYLE_DEFAULTS.button_text_color),
      attrField('line_height', 'Line height', lect, 'text', EDM_STYLE_DEFAULTS.line_height),
    ],
    // Localized content — `.field|<lang>` names.
    subject: localizedField('subject', 'Subject', lect, lang, defaultLang, 'text', lang === defaultLang),
    heading: localizedField('heading', 'Headline', lect, lang, defaultLang),
    featured_image_field: attrField('featured_image', 'Featured image', lect, 'picture'),
    body_field: localizedField('body', 'Body', lect, lang, defaultLang, 'richtext/md'),
    rsvp_button: localizedField('rsvp_button', 'RSVP button text', lect, lang, defaultLang),
    rsvp_form_button: localizedField('rsvp_form_button', 'RSVP form button', lect, lang, defaultLang),
    rsvp_form_decline_button: localizedField('rsvp_form_decline_button', 'RSVP form decline button', lect, lang, defaultLang),
    thankyou_picture_field: attrField('thankyou_picture', 'Thank-you picture', lect, 'picture'),
    thankyou_heading: localizedField('thankyou_heading', 'Thank-you heading', lect, lang, defaultLang),
    thankyou_body: localizedField('thankyou_body', 'Thank-you body', lect, lang, defaultLang, 'richtext/md'),
    decline_heading: localizedField('decline_heading', 'Decline heading', lect, lang, defaultLang),
    decline_body: localizedField('decline_body', 'Decline body', lect, lang, defaultLang, 'richtext/md'),
    rsvpTextFields: [
      localizedField('rsvp_button', 'RSVP button text', lect, lang, defaultLang),
      localizedField('rsvp_form_button', 'RSVP form button', lect, lang, defaultLang),
      localizedField('rsvp_form_decline_button', 'RSVP form decline button', lect, lang, defaultLang),
    ],
    responseSwitchFields: [
      switchField('quick_confirm', 'Quick-confirm RSVP', lect),
      switchField('cc_enable', 'CC assistants & spouse', lect),
    ],
    // Content blocks.
    blocks: editBlocks(lect, lang, defaultLang),
    hasBlocks: Array.isArray(lect._blocks) && (lect._blocks as unknown[]).length > 0,
    blockOptions: EDM_BLOCK_OPTIONS,
    // EDM-specific actions (edit mode only).
    previewHref: isEdit ? `${selfHref}/preview?language=${encodeURIComponent(lang)}` : '',
    previewPublishAction: isEdit ? `${selfHref}/preview?language=${encodeURIComponent(lang)}` : '',
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
}

export async function handleEdmAdmin(
  request: Request,
  cms: CmsClient,
  views: Fetcher,
  env: EdmEnv,
  segments: string[],
  url: URL,
  jsonOnly = false,
): Promise<Response> {
  if (!segments.length) return edmIndex(cms, views, jsonOnly);
  if (segments[0] === 'new') {
    if (request.method === 'POST') return createEdm(request, cms, views, jsonOnly);
    return edmNewForm(cms, views, url, jsonOnly);
  }

  const edmId = pageId(segments[0]);
  if (!edmId) return notFoundView(views, 'EDM not found.', jsonOnly);
  if (segments[1] === 'preview' && request.method === 'POST') {
    return edmPreview(cms, views, env, edmId, url.searchParams.get('language') ?? undefined, true);
  }
  if (segments[1] === 'preview' && request.method === 'GET') {
    return edmPreview(cms, views, env, edmId, url.searchParams.get('language') ?? undefined);
  }
  if (segments[1] === 'duplicate' && request.method === 'POST') return duplicateEdm(cms, views, edmId, jsonOnly);
  if (segments[1] === 'send-test' && request.method === 'POST') return sendTest(request, cms, views, env, edmId, jsonOnly);
  if (segments[1] === 'assign-list' && request.method === 'POST') return assignGuestList(request, cms, views, edmId, jsonOnly);
  if (segments[1] === 'send-list' && request.method === 'POST') return sendGuestList(request, cms, views, env, edmId, jsonOnly);
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

export async function emailSendRate(env: EdmEnv): Promise<number | null> {
  const tenant = env.CMS_TENANT_ID || env.CMS_TENANT_REF || env.CMS_URL || 'default';
  const now = Date.now();
  const cached = emailRateCache.get(tenant);
  if (cached && cached.expiresAt > now) return cached.value;

  let value: number | null = DEFAULT_EMAILS_PER_SECOND;
  try {
    const limit = (await new CmsClient(env).limits()).find((item) => item.key === EMAIL_SEND_RATE_LIMIT_KEY);
    if (limit) value = limit.value;
  } catch (error) {
    console.error('[events-suite] unable to read email send limit; using the safe default', error);
  }
  emailRateCache.set(tenant, { expiresAt: now + 1_000, value });
  return value;
}

async function waitForEmailSendSlot(env: EdmEnv, knownRate?: number | null): Promise<void> {
  const rate = knownRate === undefined ? await emailSendRate(env) : knownRate;
  if (rate === 0) throw new Error('Email sending is disabled under Plugins → Limits.');
  if (rate === null) return;

  const tenant = env.CMS_TENANT_ID || env.CMS_TENANT_REF || env.CMS_URL || 'default';
  const previous = emailSendChains.get(tenant) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    const interval = 1_000 / Math.max(1, rate);
    const delay = Math.max(0, (lastEmailSentAt.get(tenant) ?? 0) + interval - Date.now());
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    lastEmailSentAt.set(tenant, Date.now());
  });
  emailSendChains.set(tenant, current);
  try {
    await current;
  } finally {
    if (emailSendChains.get(tenant) === current) emailSendChains.delete(tenant);
  }
}

export async function deliverQueuedEmail(env: EdmEnv, delivery: EmailDelivery, knownRate?: number | null): Promise<void> {
  await waitForEmailSendSlot(env, knownRate);
  const from = delivery.from || env.EMAIL_FROM;
  if (!from) throw new Error('EMAIL_FROM (or the EDM sender) must be configured before sending EDMs');
  // AWS SES takes precedence over the Cloudflare Email binding: the binding
  // can only send from domains on Cloudflare DNS, so an install that bothers
  // to configure SES credentials means them to be used.
  if (sesConfigured(env)) return sendViaSes(env, { ...delivery, from });
  if (!env.EMAIL) throw new Error('Configure the EMAIL binding or the AWS_SES_* vars before sending EDMs');
  await env.EMAIL.send({ ...delivery, from });
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

async function edmIndex(cms: CmsClient, views: Fetcher, jsonOnly = false): Promise<Response> {
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
  }, jsonOnly);
}

/** Minimal "New EDM" step: pick the event + name, then hand off to the editor. */
async function edmNewForm(cms: CmsClient, views: Fetcher, url: URL, jsonOnly = false): Promise<Response> {
  const { pages: events } = await cms.list('event', { limit: 500 });
  const selectedEventId = pageId(url.searchParams.get('event_id'));
  return adminView(views, 'New EDM', 'edm-form', {
    action: `${ADMIN_BASE}/edm/new`,
    backHref: `${ADMIN_BASE}/edm`,
    events: events.map((event) => ({ id: event.id, name: event.name, selected: event.id === selectedEventId })),
  }, jsonOnly);
}

/**
 * Creates a minimal EDM grouped to its event by the `event` pointer (not parent
 * page), then redirects into the editor so the rest of the blueprint — settings
 * and per-language content — is filled there.
 */
async function createEdm(request: Request, cms: CmsClient, views: Fetcher, jsonOnly = false): Promise<Response> {
  const form = await request.formData();
  const eventId = pageId(form.get('event_id'));
  const name = formText(form, 'name');
  if (!eventId || !name) return redirect(`${ADMIN_BASE}/edm/new`);
  const event = await cms.get(eventId);
  if (event.page_type !== 'event') return notFoundView(views, 'Event not found.', jsonOnly);
  const edm = await cms.create({
    page_type: 'edm',
    name,
    lect: { _type: 'edm', name: { mis: name }, subject: { mis: name }, _pointers: { event: String(eventId) } },
  });
  return redirect(editorHref(edm.id));
}

/** Clones an EDM (content + event pointer) under the same event, then opens the copy. */
async function duplicateEdm(cms: CmsClient, views: Fetcher, edmId: number, jsonOnly = false): Promise<Response> {
  const edm = await cms.get(edmId);
  if (edm.page_type !== 'edm') return notFoundView(views, 'EDM not found.', jsonOnly);
  // The event grouping rides along in the copied lect's `_pointers.event`.
  const copy = await cms.create({
    page_type: 'edm',
    name: `Copy of ${edm.name}`,
    lect: { ...edm.lect },
  });
  return redirect(editorHref(copy.id));
}

async function edmPreview(
  cms: CmsClient,
  views: Fetcher,
  env: EdmEnv,
  edmId: number,
  language?: string,
  publish = false,
): Promise<Response> {
  const edm = await cms.get(edmId);
  if (edm.page_type !== 'edm') return notFoundView(views, 'EDM not found.');
  const eventId = pageId(pointer(edm.lect, 'event')) ?? pageId(edm.page_id);
  let eventSlug = '';
  let validEvent = false;
  if (eventId) {
    try {
      const event = await cms.get(eventId);
      if (event.page_type === 'event') {
        eventSlug = event.slug;
        validEvent = true;
      }
    } catch (error) {
      if (!(error instanceof CmsApiError && error.status === 404)) throw error;
    }
  }
  // Match the RSVP guest Preview workflow: the deliberate button POST makes
  // the public registration context current before opening a preview. The
  // editor's embedded GET preview stays read-only and never publishes on load.
  if (publish) {
    if (!eventId || !validEvent) return new Response('EDM is not linked to a valid event.', { status: 400 });
    await cms.publishMany([eventId, edm.id]);
  }
  const publicBase = env.PUBLIC_BASE_URL?.replace(/\/+$/, '');
  const languagePrefix = language && PUBLIC_RSVP_LANGUAGES.includes(language.toLowerCase()) ? `/${language.toLowerCase()}` : '';
  const registrationHref = publicBase && eventId
    ? `${publicBase}${languagePrefix}/rsvp/${encodeURIComponent(eventSlug || String(eventId))}/${encodeURIComponent(edm.slug || String(edm.id))}`
    : '';
  const emailHtml = await renderEmail(views, edm, env, {
    server: env.PUBLIC_BASE_URL,
    language,
    // Keep the call-to-action visible in local/editor previews even when the
    // public RSVP Worker has not been configured yet.
    rsvpUrl: registrationHref || '#',
    // No recipient in the editor preview — neutralize the per-guest tokens.
    tokenValues: { unsubscribe_url: '#' },
  });
  const registrationLink = registrationHref
    ? ` <a href="${escapeHtml(registrationHref)}" target="_blank" rel="noopener" style="color:inherit;font-weight:700;margin-left:6px;text-decoration:underline;text-underline-offset:2px">Open registration form ↗</a>`
    : '';
  const banner = `<div role="status" style="position:sticky;top:0;z-index:2147483647;padding:7px 12px;background:#fdba74;color:#9a3412;text-align:center;font:600 14px/20px system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;box-sizing:border-box">Preview of EDM: ${escapeHtml(edm.name)}${registrationLink}</div>`;
  const html = /<body(?:\s[^>]*)?>/i.test(emailHtml)
    ? emailHtml.replace(/<body(?:\s[^>]*)?>/i, (body) => `${body}${banner}`)
    : `${banner}${emailHtml}`;
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Opt into being embedded in a same-origin <iframe> (the EDM editor's
      // preview pane). The CMS proxy turns this into X-Frame-Options: SAMEORIGIN.
      'x-cms-frame': '1',
    },
  });
}

async function sendTest(request: Request, cms: CmsClient, views: Fetcher, env: EdmEnv, edmId: number, jsonOnly = false): Promise<Response> {
  const recipient = formText(await request.formData(), 'recipient');
  if (!recipient || !isEmail(recipient)) return mailError(views, 'Enter a valid test-recipient email address.', jsonOnly);
  const edm = await cms.get(edmId);
  if (edm.page_type !== 'edm') return notFoundView(views, 'EDM not found.', jsonOnly);
  await chargeCreditAction(cms, 'send_test_edm', 1, {
    entityType: 'edm',
    entityId: edmId,
    note: recipient,
  });
  try {
    await deliverQueuedEmail(env, {
      ...await emailFor(views, edm, recipient, env, { server: env.PUBLIC_BASE_URL, tokenValues: { unsubscribe_url: '#' } }),
      edmId,
    });
  } catch (error) {
    return mailError(views, error instanceof Error ? error.message : 'Unable to send the test email.', jsonOnly);
  }
  return redirect(editorHref(edmId, { flash: `Test email sent to ${recipient}` }));
}

async function assignGuestList(request: Request, cms: CmsClient, views: Fetcher, edmId: number, jsonOnly = false): Promise<Response> {
  const edm = await cms.get(edmId);
  if (edm.page_type !== 'edm') return notFoundView(views, 'EDM not found.', jsonOnly);
  const listId = pageId(formText(await request.formData(), 'list_id'));
  if (!listId) return redirect(editorHref(edmId));
  const list = await cms.get(listId);
  // The list and EDM must belong to the same event (by their `event` pointer).
  const eventId = pointer(edm.lect, 'event');
  if (list.page_type !== 'mail_list' || pointer(list.lect, 'event') !== eventId) return notFoundView(views, 'Guest list not found.', jsonOnly);
  await chargeCreditAction(cms, 'assign_edm_to_guest_list', 1, {
    entityType: 'mail_list',
    entityId: list.id,
    note: `Assign EDM ${edmId}`,
  });
  await cms.update(list.id, {
    lect: { ...list.lect, _pointers: { ...pointers(list), edm: String(edmId) } },
  });
  return redirect(editorHref(edmId));
}

async function sendGuestList(request: Request, cms: CmsClient, views: Fetcher, env: EdmEnv, edmId: number, jsonOnly = false): Promise<Response> {
  if (!env.MAIL_QUEUE) return mailError(views, 'MAIL_QUEUE must be configured before sending to a guest list.', jsonOnly);
  const listId = pageId(formText(await request.formData(), 'list_id'));
  if (!listId) return redirect(editorHref(edmId));
  const queued = await queueGuestList(cms, views, env, edmId, listId);
  if (queued < 0) return notFoundView(views, 'EDM or guest list not found.', jsonOnly);
  return redirect(editorHref(edmId, { flash: `Queued ${queued} email(s)` }));
}

async function queueGuestList(cms: CmsClient, views: Fetcher, env: EdmEnv, edmId: number, listId: number): Promise<number> {
  if (!env.MAIL_QUEUE) throw new Error('MAIL_QUEUE is not configured');
  const [edm, list] = await Promise.all([cms.get(edmId), cms.get(listId)]);
  if (edm.page_type !== 'edm' || list.page_type !== 'mail_list' || pointer(list.lect, 'edm') !== String(edmId)) return -1;
  const guests = await cms.listAll('guest', { parentId: listId });

  const eventId = pageId(pointer(edm.lect, 'event')) ?? pageId(edm.page_id);
  const recipients = guests.filter((guest) => {
    const recipient = attr(guest.lect, 'email');
    return recipient && isEmail(recipient) && !truthyAttr(guest.lect, 'not_send');
  });
  // Publish before rendering or queueing. If any page or target fails, no
  // delivery is enqueued with a public URL that worker-rsvp cannot resolve.
  await publishRsvpContext(cms, eventId, list, edm, recipients);
  const rsvpEnabled = Boolean(eventId && env.PUBLIC_BASE_URL && env.PLUGIN_SECRET);
  // Render (and MJML-compile) ONCE per blast, leaving a placeholder where each
  // guest's signed RSVP URL goes — then string-swap it per recipient. This keeps
  // a 500-guest send to a single MJML API call instead of 500.
  const htmlTemplate = await renderEmail(views, edm, env, {
    rsvpUrl: rsvpEnabled ? RSVP_URL_PLACEHOLDER : '',
    server: env.PUBLIC_BASE_URL,
    deferGuestQr: true,
  });
  const values = edmValues(edm);
  const text = plainText(values.heading, values.body);
  const headers = deliveryHeaders(values);

  const deliveries: EmailDelivery[] = [];
  for (const guest of recipients) {
    const recipient = attr(guest.lect, 'email');
    const rsvpUrl = rsvpEnabled ? await guestRsvpUrl(env, eventId!, listId, guest, edmId) : '';
    const tokenValues = await guestEmailTokens(env, eventId, listId, guest, rsvpUrl);
    const html = applyGuestEmailTokens(
      rsvpEnabled ? htmlTemplate.replaceAll(RSVP_URL_PLACEHOLDER, rsvpUrl) : htmlTemplate,
      tokenValues,
    );
    deliveries.push({ from: values.sender, to: recipient, subject: values.subject, html, text, edmId, guestId: guest.id, tenantId: env.CMS_TENANT_ID, ...headers });
  }

  // Metered credit charge (manifest key `send_edm`, priced host-side; free
  // until an admin sets a price). Charged before queueing so an insufficient
  // balance blocks the blast — a 402 propagates to the friendly error panel.
  // Any other billing failure (older host, transient error) must never block
  // sending, so it only logs.
  if (deliveries.length && cms.hasActingUser) {
    try {
      await cms.chargeUsage('send_edm', deliveries.length, {
        entityType: 'edm',
        entityId: edmId,
        note: `Send to guest list ${listId}`,
      });
    } catch (error) {
      if (error instanceof CmsApiError && error.status === 402) throw error;
      console.error('[events-suite] send_edm charge failed (non-blocking)', error);
    }
  }

  for (const chunk of chunks(deliveries, 100)) await env.MAIL_QUEUE.sendBatch(chunk.map((body) => ({ body })));
  return deliveries.length;
}

async function emailFor(
  views: Fetcher,
  edm: CmsPage,
  recipient: string,
  env: EdmEnv,
  options: { rsvpUrl?: string; server?: string; language?: string; tokenValues?: Record<string, string> } = {},
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

/**
 * Validates and publishes the complete context worker-rsvp needs before an
 * email link is rendered or delivered. Relationship checks happen in the
 * plugin as well as page-type scoping in the CMS endpoint, so a stale or
 * tampered list pointer cannot be used to publish an unrelated owned page.
 */
export async function publishRsvpContext(
  cms: CmsClient,
  eventId: number | null,
  list: CmsPage,
  edm: CmsPage,
  guests: CmsPage[],
): Promise<void> {
  if (!eventId || list.page_type !== 'mail_list' || pointer(list.lect, 'event') !== String(eventId)) {
    throw new Error('Guest list is not linked to a valid event');
  }
  const edmEventId = pageId(pointer(edm.lect, 'event')) ?? pageId(edm.page_id);
  if (edm.page_type !== 'edm' || edmEventId !== eventId) {
    throw new Error('EDM and guest list must belong to the same event');
  }
  for (const guest of guests) {
    if (
      guest.page_type !== 'guest'
      || guest.page_id !== list.id
      || pointer(guest.lect, 'mail_list') !== String(list.id)
    ) {
      throw new Error(`Guest ${guest.id} does not belong to guest list ${list.id}`);
    }
  }
  await cms.publishMany([eventId, list.id, edm.id, ...guests.map((guest) => guest.id)]);
}

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
  return Array.isArray(sent) && sent.some((entry) => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      return String(record.edm ?? record.edm_id ?? '') === String(edmId);
    }
    return String(entry) === String(edmId);
  });
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
  const rsvpUrl = eventId ? await guestRsvpUrl(env, eventId, listId, guest, edm.id) : '';
  const language = attr(guest.lect, 'prefer_language') || undefined;
  const delivery = {
    ...await emailFor(views, edm, recipient, env, {
      rsvpUrl,
      server: env.PUBLIC_BASE_URL,
      language,
      tokenValues: await guestEmailTokens(env, eventId, listId, guest, rsvpUrl),
    }),
    edmId: edm.id,
    guestId: guest.id,
    tenantId: env.CMS_TENANT_ID,
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
    const rsvpUrl = eventId ? await guestRsvpUrl(env, eventId, listId, guest, edm.id) : '';
    return renderEmail(views, edm, env, {
      // A guest preview should still show the configured RSVP call-to-action
      // when this tenant has no public RSVP origin yet. The real send path
      // keeps requiring a signed URL, so only previews receive this safe link.
      rsvpUrl: rsvpUrl || '#',
      server: env.PUBLIC_BASE_URL,
      language,
      tokenValues: await guestEmailTokens(env, eventId, listId, guest, rsvpUrl),
    });
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
  options: {
    rsvpUrl?: string;
    server?: string;
    language?: string;
    tokenValues?: Record<string, string>;
    /** Keep guest QR placeholders in the one-time template compiled for a blast. */
    deferGuestQr?: boolean;
  } = {},
): Promise<string> {
  const server = options.server ?? '';
  const tokens = edmTokens(edm, options.language, server);
  // The unsubscribe block renders a per-recipient link. Like the RSVP URL, the
  // template carries a {{unsubscribe_url}} token that the per-guest
  // applyTemplateTokens pass fills in (worker-rsvp resolves the link) — only
  // when this Worker can actually mint signed links.
  const unsubscribeUrl = env.PUBLIC_BASE_URL && env.PLUGIN_SECRET ? '{{unsubscribe_url}}' : '';
  // Stage 1 — build the MJML body from the EDM's content blocks.
  const main = await renderLiquid(views, '/templates/edm-mjml.liquid', {
    blocks: edmRenderBlocks(edm, options.language, unsubscribeUrl, Boolean(options.tokenValues || options.deferGuestQr)),
    server,
    rsvpUrl: options.rsvpUrl ?? '',
    rsvp_button: tokens.rsvp_button,
  });
  // Stage 2 — wrap in the MJML document (head attributes from tokens), then compile.
  const mjml = await renderLiquid(views, '/layout/mjml.liquid', { tokens, main });
  const html = await compileMjml(mjml, env);
  return options.tokenValues ? applyGuestEmailTokens(html, options.tokenValues) : html;
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

async function guestEmailTokens(
  env: EdmEnv,
  eventId: number | null,
  listId: number,
  guest: CmsPage,
  rsvpUrl = '',
): Promise<Record<string, string>> {
  const language = attr(guest.lect, 'prefer_language');
  const email = attr(guest.lect, 'email');
  const enName = guest.name || localized(guest.lect, 'name', language);
  const zhHantName = attr(guest.lect, 'zh_hant_name') || attr(guest.lect, 'zh_hans_name') || enName;
  const zhHansName = attr(guest.lect, 'zh_hans_name') || attr(guest.lect, 'zh_hant_name') || enName;
  const preferName = language.toLowerCase().startsWith('zh-hant')
    ? zhHantName
    : language.toLowerCase().startsWith('zh-hans')
      ? zhHansName
      : enName || zhHantName;
  // Public tokens are signed with the tenant's signKey (shared with that
  // tenant's worker-rsvp deployment), so a token minted for one CMS can never
  // verify on another tenant's public site.
  const signKey = env.SIGN_KEY || env.PLUGIN_SECRET;
  const signature = eventId && signKey
    ? await signPayload(signKey, `rsvp:${eventId}:${listId}:${guest.id}`)
    : '';
  const publicBase = (env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
  const unsubscribeUrl = publicBase && signKey
    ? `${publicBase}/unsubscribe/${listId}/${guest.id}/${await signPayload(signKey, `unsub:${listId}:${guest.id}`)}`
    : '';
  const tokens: Record<string, string> = {
    domain: publicBase.replace(/^https?:\/\//, ''),
    landing: publicBase.replace(/^https?:\/\//, ''),
    language,
    view_id: String(guest.id),
    sign: signature,
    rsvp_url: rsvpUrl,
    rsvpUrl,
    unsubscribe_url: unsubscribeUrl,
    contact: email,
    email: email.replaceAll('.', '<span>.</span>'),
    email_url: encodeURIComponent(email),
    name: enName,
    en_name: enName,
    zh_hant_name: zhHantName,
    zh_hans_name: zhHansName,
    prefer_name: preferName,
    salutation: attr(guest.lect, 'prefix'),
    zh_hant_salutation: attr(guest.lect, 'prefix'),
    zh_hans_salutation: attr(guest.lect, 'prefix'),
    company: attr(guest.lect, 'organization'),
    organization: attr(guest.lect, 'organization'),
    title: attr(guest.lect, 'job_title'),
    job_title: attr(guest.lect, 'job_title'),
    ...await checkinQrTokens(env, listId, guest),
  };
  for (const [key, value] of Object.entries(guest.lect)) {
    if ((typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') && tokens[key] === undefined) {
      tokens[key] = String(value);
    }
  }
  return tokens;
}

/**
 * QR data for per-guest EDM rendering. The image always contains the compact
 * Eventuai code; `checkin_url` remains a separate clickable fallback in email.
 */
async function checkinQrTokens(env: EdmEnv, listId: number, guest: CmsPage): Promise<Record<string, string>> {
  const signKey = env.SIGN_KEY || env.PLUGIN_SECRET;
  if (!signKey) return { checkin_code: '', checkin_url: '', checkin_qr_src: '' };

  const token = `${listId}.${guest.id}`;
  const signature = await signPayload(signKey, token);
  const code = compactCheckinCode(listId, guest.id);
  const base = (env.CHECKIN_BASE_URL ?? '').replace(/\/+$/, '');
  const tenantSuffix = env.CMS_TENANT_REF ? `?t=${encodeURIComponent(env.CMS_TENANT_REF)}` : '';
  const url = base ? `${base}/checkin/${listId}/${guest.id}/${signature}${tenantSuffix}` : '';
  return {
    checkin_code: code,
    checkin_url: url,
    checkin_qr_src: svgDataUrl(qrSvg(code, { size: 240, margin: 1 })),
  };
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

/** Applies ordinary legacy tokens plus the placeholders deliberately left in a shared EDM blast. */
function applyGuestEmailTokens(html: string, tokens: Record<string, string>): string {
  return applyTemplateTokens(
    html
      .replaceAll(CHECKIN_QR_IMAGE_PLACEHOLDER, tokens.checkin_qr_src ?? '')
      .replaceAll(CHECKIN_CODE_PLACEHOLDER, tokens.checkin_code ?? '')
      .replaceAll(CHECKIN_URL_PLACEHOLDER, tokens.checkin_url ?? ''),
    tokens,
  );
}

function applyTemplateTokens(html: string, tokens: Record<string, string>): string {
  let result = html;
  for (const [key, value] of Object.entries(tokens)) {
    result = result.replace(new RegExp(`{{@?${escapeRegExp(key)}}}`, 'gi'), () => value);
  }
  return result.replace(/{{@?([\w]+(?:\|\|[\w]+)+)}}/gi, (_match, keys: string) => {
    for (const key of keys.split('||').map((value) => value.trim())) {
      const value = tokens[key];
      if (value !== undefined && value !== '') return value;
    }
    return '';
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char] ?? char);
}

/** Flat token map the MJML layout reads (content + styling), each a string. */
function edmTokens(edm: CmsPage, language?: string, server = ''): Record<string, string> {
  const lect = edm.lect;
  return {
    subject: localized(lect, 'subject', language) || edm.name,
    heading: localized(lect, 'heading', language),
    featured_image: emailAssetUrl(server, attr(lect, 'featured_image')),
    body: safeHtml(localized(lect, 'body', language)),
    // An intentionally blank label disables the generated RSVP CTA.
    rsvp_button: localized(lect, 'rsvp_button', language),
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

/** Resolve uploaded CMS media against the public RSVP origin without mangling absolute image URLs. */
function emailAssetUrl(server: string, value: string): string {
  const src = value.trim();
  if (!src || /^(https?:)?\/\//i.test(src) || src.startsWith('data:')) return src;
  const base = server.replace(/\/+$/, '');
  return base && src.startsWith('/') ? `${base}${src}` : src;
}

/**
 * Projects the EDM's content blocks into the flat, sanitised shapes the MJML
 * block snippets expect (rich-text fields run through safeHtml).
 */
function edmRenderBlocks(
  edm: CmsPage,
  language?: string,
  unsubscribeUrl = '',
  includeGuestQr = false,
): Array<Record<string, unknown>> {
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
        return { _type: type, unsubscribeUrl };
      case 'rsvp-qrcode':
        if (!includeGuestQr) return { _type: type };
        return {
          _type: type,
          title: localized(block, 'title', language),
          message: localized(block, 'message', language),
          size: attr(block, 'size') || '200',
          qrSrc: CHECKIN_QR_IMAGE_PLACEHOLDER,
          code: CHECKIN_CODE_PLACEHOLDER,
          checkinUrl: CHECKIN_URL_PLACEHOLDER,
        };
      default:
        return { _type: type };
    }
  });
}

/** Languages worker-rsvp accepts as a URL prefix (legacy parity — keep in sync with its RSVP_LANGUAGES). */
const PUBLIC_RSVP_LANGUAGES = ['mis', 'en', 'zh-hant', 'zh-hans'];

/**
 * Signed public RSVP link for one guest, resolved by the worker-rsvp site
 * (PUBLIC_BASE_URL). The signature covers only `rsvp:event:list:guest` (so
 * older links keep verifying); the guest's preferred language rides as a path
 * prefix and the sending EDM as `?edm=`, which the form uses to pick its
 * `rsvp-*` blocks.
 */
async function guestRsvpUrl(env: EdmEnv, eventId: number, listId: number, guest: CmsPage, edmId?: number): Promise<string> {
  const signKey = env.SIGN_KEY || env.PLUGIN_SECRET;
  if (!env.PUBLIC_BASE_URL || !signKey) return '';
  const payload = `rsvp:${eventId}:${listId}:${guest.id}`;
  const signature = await signPayload(signKey, payload);
  const language = attr(guest.lect, 'prefer_language').toLowerCase();
  const prefix = PUBLIC_RSVP_LANGUAGES.includes(language) ? `/${language}` : '';
  const suffix = edmId ? `?edm=${edmId}` : '';
  return `${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}${prefix}/rsvp/${eventId}/${listId}/${guest.id}/${signature}${suffix}`;
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

function truthyAttr(lect: Record<string, unknown>, key: string): boolean {
  return ['true', 'yes', '1', 'on'].includes(attr(lect, key).trim().toLowerCase());
}

function mailError(views: Fetcher, message: string, jsonOnly = false): Promise<Response> {
  return adminView(views, 'Email delivery unavailable', 'error', { heading: 'Email delivery unavailable', message }, jsonOnly);
}
