import { CmsClient, attr, listByEvent, localized, type CmsPage } from './cms';
import { adminView } from './templates/views';

const ADMIN_BASE = '/admin/plugins/events';

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
    return labelForm(cms, views, event, undefined, jsonOnly);
  }

  const labelId = pageId(segments[0]);
  if (!labelId) return new Response('not found', { status: 404 });
  if (segments[1] === 'preview') return labelPreview(cms, event, labelId, url);
  if (request.method === 'POST') return updateLabel(request, cms, event, labelId);
  return labelForm(cms, views, event, labelId, jsonOnly);
}

async function labelsIndex(cms: CmsClient, views: Fetcher, event: CmsPage, jsonOnly = false): Promise<Response> {
  const { pages } = await cms.list('label', { parentId: event.id, limit: 500 });
  return adminView(views, `Labels — ${event.name}`, 'labels', {
    eventName: event.name,
    eventHref: `${ADMIN_BASE}/events/${event.id}`,
    newHref: `${ADMIN_BASE}/events/${event.id}/labels/new`,
    labels: pages.map((label) => ({
      name: label.name,
      href: `${ADMIN_BASE}/events/${event.id}/labels/${label.id}`,
      previewHref: `${ADMIN_BASE}/events/${event.id}/labels/${label.id}/preview`,
      width: frame(label).width,
      height: frame(label).height,
    })),
  }, jsonOnly);
}

async function labelForm(cms: CmsClient, views: Fetcher, event: CmsPage, labelId?: number, jsonOnly = false): Promise<Response> {
  const label = labelId ? await cms.get(labelId) : undefined;
  if (label && (label.page_type !== 'label' || label.page_id !== event.id)) return new Response('not found', { status: 404 });
  const value = label ? labelValues(label) : emptyLabel();
  const guestLists = await listByEvent(cms, 'mail_list', event.id);
  const guestOptions: Array<{ id: number; name: string }> = [];
  for (const list of guestLists.slice(0, 20)) {
    const { pages: guests } = await cms.list('guest', { parentId: list.id, limit: 50 });
    guestOptions.push(...guests.map((guest) => ({ id: guest.id, name: `${guest.name} — ${list.name}` })));
  }
  return adminView(views, label ? `Edit ${label.name}` : 'New label', 'label-form', {
    title: label ? 'Edit label template' : 'New label template',
    eventName: event.name,
    backHref: `${ADMIN_BASE}/events/${event.id}/labels`,
    action: label ? `${ADMIN_BASE}/events/${event.id}/labels/${label.id}` : `${ADMIN_BASE}/events/${event.id}/labels/new`,
    previewHref: label ? `${ADMIN_BASE}/events/${event.id}/labels/${label.id}/preview` : '',
    label: value,
    guests: guestOptions,
  }, jsonOnly);
}

async function createLabel(request: Request, cms: CmsClient, event: CmsPage): Promise<Response> {
  const input = labelInput(await request.formData());
  if (!input.name) return redirect(`${ADMIN_BASE}/events/${event.id}/labels/new`);
  const label = await cms.create({ page_type: 'label', page_id: event.id, name: input.name, lect: input.lect });
  return redirect(`${ADMIN_BASE}/events/${event.id}/labels/${label.id}`);
}

async function updateLabel(request: Request, cms: CmsClient, event: CmsPage, labelId: number): Promise<Response> {
  const label = await cms.get(labelId);
  if (label.page_type !== 'label' || label.page_id !== event.id) return new Response('not found', { status: 404 });
  const input = labelInput(await request.formData(), label);
  if (!input.name) return redirect(`${ADMIN_BASE}/events/${event.id}/labels/${labelId}`);
  await cms.update(labelId, { name: input.name, lect: input.lect });
  return redirect(`${ADMIN_BASE}/events/${event.id}/labels/${labelId}`);
}

async function labelPreview(cms: CmsClient, event: CmsPage, labelId: number, url: URL): Promise<Response> {
  const label = await cms.get(labelId);
  if (label.page_type !== 'label' || label.page_id !== event.id) return new Response('not found', { status: 404 });
  const guestId = pageId(url.searchParams.get('guest_id'));
  const guest = guestId ? await cms.get(guestId) : undefined;
  const values = guest && guest.page_type === 'guest' ? guestTokens(guest) : { name: 'Guest name', organization: 'Organisation', email: 'guest@example.com', qr_code: '' };
  return new Response(renderLabel(frame(label).svg, values), {
    headers: { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' },
  });
}

function labelValues(label: CmsPage): Record<string, string> {
  const value = frame(label);
  return { name: label.name, width: value.width, height: value.height, direction: value.direction, svg: value.svg };
}

function emptyLabel(): Record<string, string> {
  return { name: '', width: '60mm', height: '30mm', direction: 'landscape', svg: defaultSvg() };
}

function frame(label: CmsPage): Record<string, string> {
  const value = label.lect.frame;
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    width: String(record.width ?? '60mm'),
    height: String(record.height ?? '30mm'),
    direction: String(record.direction ?? 'landscape'),
    svg: String(record.svg ?? defaultSvg()),
  };
}

function labelInput(form: FormData, existing?: CmsPage): { name: string; lect: Record<string, unknown> } {
  const name = text(form, 'name');
  return {
    name,
    lect: {
      ...(existing?.lect ?? {}),
      _type: 'label',
      frame: {
        width: text(form, 'width') || '60mm',
        height: text(form, 'height') || '30mm',
        direction: text(form, 'direction') || 'landscape',
        svg: text(form, 'svg') || defaultSvg(),
      },
    },
  };
}

function guestTokens(guest: CmsPage): Record<string, string> {
  return {
    name: guest.name || localized(guest.lect, 'name'),
    organization: attr(guest.lect, 'organization'),
    email: attr(guest.lect, 'email'),
    qr_code: attr(guest.lect, 'qrcode'),
  };
}

function renderLabel(svg: string, values: Record<string, string>): string {
  return safeSvg(svg).replace(/{{\s*([a-z_]+)\s*}}/g, (_all, key: string) => escapeXml(values[key] ?? ''));
}

function safeSvg(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(?:href|xlink:href)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]*)/gi, '');
}

function defaultSvg(): string {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="60mm" height="30mm" viewBox="0 0 600 300"><rect width="600" height="300" fill="#fff"/><text x="32" y="120" font-family="Arial" font-size="44" font-weight="700">{{name}}</text><text x="32" y="180" font-family="Arial" font-size="26">{{organization}}</text><text x="32" y="235" font-family="Arial" font-size="20">{{email}}</text></svg>';
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character] as string));
}

function pageId(value: unknown): number | null {
  const id = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

function redirect(to: string): Response {
  return new Response(null, { status: 302, headers: { Location: to } });
}
