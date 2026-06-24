import { CmsClient, attr, items, localized, pointer, type CmsPage } from './cms';
import { verifyPayload } from './crypto';
import { renderLiquid } from './templates/liquid';

export interface PublicRsvpEnv {
  CMS_URL?: string;
  PLUGIN_SECRET?: string;
  VIEWS: Fetcher;
}

const RESPONSES = new Set(['confirmed', 'declined']);

export async function handlePublicRsvp(request: Request, env: PublicRsvpEnv, url: URL): Promise<Response | null> {
  const path = url.pathname.split('/').filter(Boolean);
  if (['en', 'zh-hant', 'zh-hans', 'mis'].includes(path[0])) path.shift();
  if (path[0] !== 'rsvp') return null;
  if (path[1] === 'thank-you') return thankYou(env.VIEWS, url.searchParams.get('status') ?? 'confirmed');

  const eventId = pageId(path[1]);
  const listId = pageId(path[2]);
  const guestId = pageId(path[3]);
  const signature = path[4] ?? '';
  if (!eventId || !listId || !guestId || !signature || !env.PLUGIN_SECRET) return new Response('not found', { status: 404 });
  const payload = `rsvp:${eventId}:${listId}:${guestId}`;
  if (!(await verifyPayload(env.PLUGIN_SECRET, payload, signature))) return new Response('not found', { status: 404 });

  const cms = new CmsClient(env);
  const [event, list, guest] = await Promise.all([cms.get(eventId), cms.get(listId), cms.get(guestId)]);
  if (!validContext(event, list, guest, eventId, listId)) return new Response('not found', { status: 404 });

  if (request.method === 'POST') return submitRsvp(request, cms, url, guest, payload);
  return rsvpForm(env.VIEWS, url.pathname, guest, event, list);
}

async function submitRsvp(request: Request, cms: CmsClient, url: URL, guest: CmsPage, payload: string): Promise<Response> {
  const form = await request.formData();
  const status = String(form.get('status') ?? '').trim().toLowerCase();
  if (!RESPONSES.has(status)) return new Response('Choose a response', { status: 400 });
  const plusGuestValue = (form.get('plus_guests') ?? attr(guest.lect, 'plus_guests')) || '0';
  const plusGuests = Math.max(0, Number(plusGuestValue));
  const message = String(form.get('message') ?? '').trim();
  await cms.update(guest.id, {
    lect: {
      status,
      plus_guests: String(Number.isFinite(plusGuests) ? plusGuests : 0),
      response: [...items(guest.lect, 'response'), {
        status,
        date: new Date().toISOString(),
        message,
      }],
    },
  });
  const thankYou = new URL('/rsvp/thank-you', url.origin);
  thankYou.searchParams.set('status', status);
  thankYou.searchParams.set('token', payload);
  return new Response(null, { status: 303, headers: { Location: thankYou.toString() } });
}

async function rsvpForm(views: Fetcher, action: string, guest: CmsPage, event: CmsPage, list: CmsPage): Promise<Response> {
  const html = await renderLiquid(views, '/templates/public-rsvp.liquid', {
    action,
    eventName: event.name,
    listName: list.name,
    guestName: guest.name || localized(guest.lect, 'name'),
    status: attr(guest.lect, 'status'),
    plusGuests: attr(guest.lect, 'plus_guests') || '0',
  });
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

async function thankYou(views: Fetcher, status: string): Promise<Response> {
  const html = await renderLiquid(views, '/templates/public-thank-you.liquid', { declined: status === 'declined' });
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

function validContext(event: CmsPage, list: CmsPage, guest: CmsPage, eventId: number, listId: number): boolean {
  return event.page_type === 'event'
    // The list belongs to the event via its `event` pointer (not parent page).
    && list.page_type === 'mail_list' && pointer(list.lect, 'event') === String(eventId)
    && guest.page_type === 'guest' && guest.page_id === listId;
}

function pageId(value: unknown): number | null {
  const id = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}
