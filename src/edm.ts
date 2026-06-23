import { CmsClient, attr, blocks, items, localized, pointer, type CmsPage } from './cms';
import { signPayload } from './crypto';
import { mjmlToHtml } from './mjml';
import { renderLiquid } from './templates/liquid';
import { adminView } from './templates/views';

const ADMIN_BASE = '/admin/plugins/events';

export interface OutboundEmail {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
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
}

/** Placeholder swapped for each guest's signed RSVP URL after a single MJML render. */
const RSVP_URL_PLACEHOLDER = 'https://__edm_rsvp_url__/';

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
    if (request.method === 'POST') return createEdm(request, cms);
    return edmForm(cms, views, url);
  }

  const edmId = pageId(segments[0]);
  if (!edmId) return new Response('not found', { status: 404 });
  if (segments[1] === 'preview') return edmPreview(cms, views, env, edmId);
  if (segments[1] === 'send-test' && request.method === 'POST') return sendTest(request, cms, views, env, edmId);
  if (segments[1] === 'assign-list' && request.method === 'POST') return assignGuestList(request, cms, edmId);
  if (segments[1] === 'send-list' && request.method === 'POST') return sendGuestList(request, cms, views, env, edmId);
  if (request.method === 'POST') return updateEdm(request, cms, edmId);
  return edmForm(cms, views, url, edmId);
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
      const event = eventsById.get(edm.page_id ?? pageId(pointer(edm.lect, 'event')) ?? 0);
      return {
        name: edm.name,
        subject: localized(edm.lect, 'subject') || edm.name,
        eventName: event?.name ?? 'Unknown event',
        href: `${ADMIN_BASE}/edm/${edm.id}`,
        previewHref: `${ADMIN_BASE}/edm/${edm.id}/preview`,
      };
    }),
  });
}

async function edmForm(cms: CmsClient, views: Fetcher, url: URL, edmId?: number): Promise<Response> {
  const { pages: events } = await cms.list('event', { limit: 500 });
  const edm = edmId ? await cms.get(edmId) : undefined;
  if (edm && edm.page_type !== 'edm') return new Response('not found', { status: 404 });
  const selectedEventId = edm
    ? edm.page_id ?? pageId(pointer(edm.lect, 'event'))
    : pageId(url.searchParams.get('event_id'));
  const guestLists = selectedEventId
    ? (await cms.list('mail_list', { parentId: selectedEventId, limit: 500 })).pages
    : [];
  const values = edm ? edmValues(edm) : emptyEdmValues();

  return adminView(views, edm ? `Edit ${edm.name}` : 'New EDM', 'edm-form', {
    title: edm ? 'Edit EDM' : 'New EDM',
    action: edm ? `${ADMIN_BASE}/edm/${edm.id}` : `${ADMIN_BASE}/edm/new`,
    backHref: `${ADMIN_BASE}/edm`,
    isNew: !edm,
    edm: values,
    events: events.map((event) => ({ id: event.id, name: event.name, selected: event.id === selectedEventId })),
    previewHref: edm ? `${ADMIN_BASE}/edm/${edm.id}/preview` : '',
    testAction: edm ? `${ADMIN_BASE}/edm/${edm.id}/send-test` : '',
    listAction: edm ? `${ADMIN_BASE}/edm/${edm.id}/assign-list` : '',
    sendListAction: edm ? `${ADMIN_BASE}/edm/${edm.id}/send-list` : '',
    guestLists: guestLists.map((list) => ({ id: list.id, name: list.name, selected: pointer(list.lect, 'edm') === String(edm?.id ?? '') })),
  });
}

async function createEdm(request: Request, cms: CmsClient): Promise<Response> {
  const form = await request.formData();
  const eventId = pageId(form.get('event_id'));
  const input = edmInput(form, eventId);
  if (!eventId || !input.name) return redirect(`${ADMIN_BASE}/edm/new`);
  const event = await cms.get(eventId);
  if (event.page_type !== 'event') return new Response('not found', { status: 404 });
  const edm = await cms.create({ page_type: 'edm', page_id: eventId, name: input.name, lect: input.lect });
  return redirect(`${ADMIN_BASE}/edm/${edm.id}`);
}

async function updateEdm(request: Request, cms: CmsClient, edmId: number): Promise<Response> {
  const edm = await cms.get(edmId);
  if (edm.page_type !== 'edm') return new Response('not found', { status: 404 });
  const form = await request.formData();
  const eventId = pageId(form.get('event_id')) ?? edm.page_id ?? pageId(pointer(edm.lect, 'event'));
  const input = edmInput(form, eventId, edm);
  if (!eventId || !input.name) return redirect(`${ADMIN_BASE}/edm/${edmId}`);
  await cms.update(edmId, { name: input.name, page_id: eventId, lect: input.lect });
  return redirect(`${ADMIN_BASE}/edm/${edmId}`);
}

async function edmPreview(cms: CmsClient, views: Fetcher, env: EdmEnv, edmId: number): Promise<Response> {
  const edm = await cms.get(edmId);
  if (edm.page_type !== 'edm') return new Response('not found', { status: 404 });
  const html = await renderEmail(views, edm, env, { server: env.PUBLIC_BASE_URL });
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

async function sendTest(request: Request, cms: CmsClient, views: Fetcher, env: EdmEnv, edmId: number): Promise<Response> {
  const recipient = formText(await request.formData(), 'recipient');
  if (!recipient || !isEmail(recipient)) return mailError(views, 'Enter a valid test-recipient email address.');
  const edm = await cms.get(edmId);
  if (edm.page_type !== 'edm') return new Response('not found', { status: 404 });
  try {
    await deliverQueuedEmail(env, { ...await emailFor(views, edm, recipient, env, { server: env.PUBLIC_BASE_URL }), edmId });
  } catch (error) {
    return mailError(views, error instanceof Error ? error.message : 'Unable to send the test email.');
  }
  return redirect(`${ADMIN_BASE}/edm/${edmId}?test=sent`);
}

async function assignGuestList(request: Request, cms: CmsClient, edmId: number): Promise<Response> {
  const edm = await cms.get(edmId);
  if (edm.page_type !== 'edm') return new Response('not found', { status: 404 });
  const listId = pageId(formText(await request.formData(), 'list_id'));
  if (!listId) return redirect(`${ADMIN_BASE}/edm/${edmId}`);
  const list = await cms.get(listId);
  const eventId = edm.page_id ?? pageId(pointer(edm.lect, 'event'));
  if (list.page_type !== 'mail_list' || list.page_id !== eventId) return new Response('not found', { status: 404 });
  await cms.update(list.id, {
    lect: { ...list.lect, _pointers: { ...pointers(list), edm: String(edmId) } },
  });
  return redirect(`${ADMIN_BASE}/edm/${edmId}`);
}

async function sendGuestList(request: Request, cms: CmsClient, views: Fetcher, env: EdmEnv, edmId: number): Promise<Response> {
  if (!env.MAIL_QUEUE) return mailError(views, 'MAIL_QUEUE must be configured before sending to a guest list.');
  const listId = pageId(formText(await request.formData(), 'list_id'));
  if (!listId) return redirect(`${ADMIN_BASE}/edm/${edmId}`);
  const queued = await queueGuestList(cms, views, env, edmId, listId);
  if (queued < 0) return new Response('not found', { status: 404 });
  return redirect(`${ADMIN_BASE}/edm/${edmId}?queued=${queued}`);
}

async function queueGuestList(cms: CmsClient, views: Fetcher, env: EdmEnv, edmId: number, listId: number): Promise<number> {
  if (!env.MAIL_QUEUE) throw new Error('MAIL_QUEUE is not configured');
  const [edm, list] = await Promise.all([cms.get(edmId), cms.get(listId)]);
  if (edm.page_type !== 'edm' || list.page_type !== 'mail_list' || pointer(list.lect, 'edm') !== String(edmId)) return -1;
  const { pages: guests } = await cms.list('guest', { parentId: listId, limit: 500 });

  const eventId = edm.page_id ?? pageId(pointer(edm.lect, 'event'));
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

  const deliveries: EmailDelivery[] = [];
  for (const guest of guests) {
    const recipient = attr(guest.lect, 'email');
    if (!recipient || !isEmail(recipient) || attr(guest.lect, 'not_send') === 'true') continue;
    const html = rsvpEnabled
      ? htmlTemplate.replaceAll(RSVP_URL_PLACEHOLDER, await guestRsvpUrl(env, eventId!, listId, guest.id))
      : htmlTemplate;
    deliveries.push({ from: values.sender, to: recipient, subject: values.subject, html, text, edmId, guestId: guest.id });
  }
  for (const chunk of chunks(deliveries, 100)) await env.MAIL_QUEUE.sendBatch(chunk.map((body) => ({ body })));
  return deliveries.length;
}

async function emailFor(
  views: Fetcher,
  edm: CmsPage,
  recipient: string,
  env: EdmEnv,
  options: { rsvpUrl?: string; server?: string } = {},
): Promise<OutboundEmail> {
  const values = edmValues(edm);
  return {
    from: values.sender,
    to: recipient,
    subject: values.subject,
    html: await renderEmail(views, edm, env, options),
    text: plainText(values.heading, values.body),
  };
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
  options: { rsvpUrl?: string; server?: string } = {},
): Promise<string> {
  const tokens = edmTokens(edm);
  const server = options.server ?? '';
  // Stage 1 — build the MJML body from the EDM's content blocks.
  const main = await renderLiquid(views, '/templates/edm-mjml.liquid', {
    blocks: edmRenderBlocks(edm),
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
 * minimal compiler can't. Falls back to the built-in compiler when credentials
 * are absent (dev/tests) or the API call fails, so a render never hard-fails.
 */
async function compileMjml(mjml: string, env: EdmEnv): Promise<string> {
  if (env.MJML_APP_ID && env.MJML_SECRET_KEY) {
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
        if (typeof data.html === 'string' && data.html) return data.html;
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

/** Flat token map the MJML layout reads (content + styling), each a string. */
function edmTokens(edm: CmsPage): Record<string, string> {
  const lect = edm.lect;
  return {
    subject: localized(lect, 'subject') || edm.name,
    heading: localized(lect, 'heading'),
    body: safeHtml(localized(lect, 'body')),
    rsvp_button: localized(lect, 'rsvp_button') || 'RSVP',
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
function edmRenderBlocks(edm: CmsPage): Array<Record<string, unknown>> {
  return blocks(edm.lect).map((block) => {
    const type = attr(block, '_type');
    switch (type) {
      case 'paragraph':
        return { _type: type, subject: localized(block, 'subject'), body: safeHtml(localized(block, 'body')) };
      case 'picture':
        return { _type: type, picture: attr(block, 'picture'), width: attr(block, 'width'), align: attr(block, 'align') };
      case 'button':
        return { _type: type, label: localized(block, 'label') || attr(block, 'label'), url: localized(block, 'url') || attr(block, 'url') };
      case 'table':
        return {
          _type: type,
          title: safeHtml(localized(block, 'title')),
          first_column_width: attr(block, 'first_column_width'),
          row: items(block, 'row').map((row) => ({
            name: safeHtml(localized(row, 'name')),
            description: safeHtml(localized(row, 'description')),
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

function edmValues(edm: CmsPage): Record<string, string> {
  return {
    name: edm.name,
    sender: attr(edm.lect, 'sender'),
    subject: localized(edm.lect, 'subject') || edm.name,
    heading: localized(edm.lect, 'heading'),
    body: localized(edm.lect, 'body'),
    rsvp_button: localized(edm.lect, 'rsvp_button') || 'RSVP',
  };
}

function emptyEdmValues(): Record<string, string> {
  return { name: '', sender: '', subject: '', heading: '', body: '', rsvp_button: 'RSVP' };
}

function edmInput(form: FormData, eventId: number | null, existing?: CmsPage): { name: string; lect: Record<string, unknown> } {
  const subject = formText(form, 'subject');
  const name = formText(form, 'name') || subject;
  return {
    name,
    lect: {
      ...(existing?.lect ?? {}),
      _type: 'edm',
      _pointers: { ...pointers(existing), ...(eventId ? { event: String(eventId) } : {}) },
      sender: formText(form, 'sender'),
      subject: { en: subject },
      heading: { en: formText(form, 'heading') },
      body: { en: formText(form, 'body') },
      rsvp_button: { en: formText(form, 'rsvp_button') || 'RSVP' },
    },
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
