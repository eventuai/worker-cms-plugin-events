import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkins } from '../src/cms';
import { signPayload } from '../src/crypto';
import worker from '../src/index';

interface PluginEnv {
  CMS_URL?: string;
  PLUGIN_SECRET?: string;
  PUBLIC_BASE_URL?: string;
  MJML_APP_ID?: string;
  MJML_SECRET_KEY?: string;
  MJML_API_URL?: string;
  MAIL_TRACKING?: KVNamespace;
  EMAIL?: { send(message: Record<string, unknown>): Promise<unknown> };
  EMAIL_FROM?: string;
  VIEWS: Fetcher;
}

interface SignedQr {
  url: string;
}

const plugin = worker as { fetch(request: Request, env: PluginEnv): Promise<Response> };

function views(): Fetcher {
  return {
    async fetch(input: RequestInfo | URL): Promise<Response> {
      const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
      try {
        return new Response(await readFile(new URL(`../views${url.pathname}`, import.meta.url), 'utf8'));
      } catch {
        return new Response('not found', { status: 404 });
      }
    },
  } as Fetcher;
}

function env(overrides: Partial<PluginEnv> = {}): PluginEnv {
  return { VIEWS: views(), ...overrides };
}

function throwingViews(): Fetcher {
  return {
    async fetch(_input: RequestInfo | URL): Promise<Response> {
      throw new Error('views should not be fetched for json-only admin responses');
    },
  } as unknown as Fetcher;
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://events.test${path}`, init);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('plugin contract', () => {
  it('exposes the Events Suite manifest without a secret', async () => {
    const response = await plugin.fetch(request('/__plugin/manifest'), env({ PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: 'events',
      nav: [
        { label: 'Events', href: 'events' },
        { label: 'RSVP', href: 'rsvp' },
        { label: 'EDM', href: 'edm' },
      ],
      contentTypes: {
        blueprint: { event: expect.any(Array), guest: expect.any(Array) },
      },
    });
  });

  it('requires the shared secret for admin routes and renders RSVP guest lists when authorized', async () => {
    const cmsFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      const pageType = url.searchParams.get('page_type');
      if (url.pathname === '/__cms/pages' && pageType === 'event') {
        return Response.json({ pages: [{ id: 7, name: 'Launch', lect: {} }], total: 1 });
      }
      if (url.pathname === '/__cms/pages' && pageType === 'mail_list') {
        return Response.json({ pages: [{ id: 8, name: 'VIP', page_id: 7, lect: {} }], total: 1 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);
    const testEnv = env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' });

    const forbidden = await plugin.fetch(request('/__plugin/admin/rsvp'), testEnv);
    expect(forbidden.status).toBe(403);

    const response = await plugin.fetch(request('/__plugin/admin/rsvp', {
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), testEnv);

    expect(response.status).toBe(200);
    expect(response.headers.get('x-cms-chrome')).toBe('1');
    expect(response.headers.get('x-cms-title')).toBe('RSVP%20guest%20lists');
    const html = await response.text();
    expect(html).toContain('RSVP guest lists');
    expect(html).toContain('VIP');
  });

  it('signs QR data and renders the escaped Liquid SVG', async () => {
    const testEnv = env({ PLUGIN_SECRET: 'shared-secret' });
    const data = '<launch>&';
    const signing = await plugin.fetch(request(`/sign?data=${encodeURIComponent(data)}`, {
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), testEnv);

    expect(signing.status).toBe(200);
    const signed = await signing.json() as SignedQr;
    const qr = await plugin.fetch(request(signed.url), testEnv);

    expect(qr.status).toBe(200);
    expect(qr.headers.get('content-type')).toContain('image/svg+xml');
    await expect(qr.text()).resolves.toContain('&lt;launch&gt;&amp;');
  });
});

describe('events admin', () => {
  it('returns admin view data as JSON without fetching Liquid templates when requested', async () => {
    const cmsFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      expect(url.pathname).toBe('/__cms/pages');
      expect(url.searchParams.get('page_type')).toBe('event');
      return Response.json({
        pages: [{ id: 12, name: 'Town & Country', start: '2026-10-12T09:00', timezone: '+0800', lect: {} }],
        total: 1,
      });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request('/__plugin/admin/events?json', {
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret', VIEWS: throwingViews() }));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('x-cms-chrome')).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      title: 'Events',
      template: 'events',
      data: {
        events: [
          {
            name: 'Town & Country',
            start: '2026-10-12 09:00 +0800',
            dashboardHref: '/admin/plugins/events/events/12',
          },
        ],
      },
    });
  });

  it('renders CMS event data through the Liquid view', async () => {
    const cmsFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      expect(url.pathname).toBe('/__cms/pages');
      expect(url.searchParams.get('page_type')).toBe('event');
      return Response.json({
        pages: [{ id: 12, name: 'Town & Country', start: '2026-10-12T09:00', timezone: '+0800', lect: {} }],
        total: 1,
      });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request('/__plugin/admin/events', {
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Town &amp; Country');
    expect(html).toContain('/admin/plugins/events/events/12');
    expect(html).toContain('2026-10-12 09:00 +0800');
    expect(cmsFetch).toHaveBeenCalledTimes(1);
  });

  it('shows every event guest list with its RSVP summary', async () => {
    const cmsFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/12') {
        return Response.json({ page: { id: 12, page_type: 'event', name: 'Town & Country', lect: {} } });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'mail_list') {
        // mail_list / edm group under their event by the `event` pointer, so the
        // plugin lists the type and filters client-side (no page_id filter).
        return Response.json({
          pages: [{ id: 34, page_type: 'mail_list', name: 'VIP', lect: { _pointers: { event: '12' } } }],
          total: 1,
        });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'edm') {
        return Response.json({
          pages: [{ id: 50, page_type: 'edm', name: 'Save the date', lect: { subject: { en: 'You are invited' }, _pointers: { event: '12' } } }],
          total: 1,
        });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'guest') {
        expect(url.searchParams.get('page_id')).toBe('34');
        // 4 groups → 6 people; one confirmed+checked-in (2 people), one invited,
        // one on hold, one unknown status (counted "to be invited").
        return Response.json({
          pages: [
            { id: 1, page_type: 'guest', name: 'Ada', lect: { status: 'confirmed', plus_guests: '1', checkin: [{ status: 'checked-in' }], response: [{ status: 'confirmed', date: '2026-09-01T10:30:00Z', message: 'guest response' }] } },
            { id: 2, page_type: 'guest', name: 'Grace', lect: { status: 'invited' } },
            { id: 3, page_type: 'guest', name: 'Edith', lect: { status: 'onhold' } },
            { id: 4, page_type: 'guest', name: 'Lin', lect: { status: 'mystery', plus_guests: '1' } },
          ],
          total: 4,
        });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request('/__plugin/admin/events/12', {
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Guest lists');
    expect(html).toContain('VIP');
    expect(html).toContain('6 people');
    expect(html).toContain('Confirmed 1');
    expect(html).toContain('Checked-in');
    // Email templates section: the event's EDM is listed.
    expect(html).toContain('Email templates');
    expect(html).toContain('Save the date');
    expect(html).toContain('You are invited');
    // Guest responses section: the confirmed guest appears, with her date.
    expect(html).toContain('Guest responses');
    expect(html).toContain('Ada');
    expect(html).toContain('2026-09-01');
  });

  it('renders event guest lists in saved weight order with drag handles', async () => {
    const cmsFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/7') {
        return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch', lect: {} } });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'mail_list') {
        return Response.json({
          pages: [
            { id: 10, page_type: 'mail_list', name: 'Adhoc', weight: 0, lect: { _pointers: { event: '7' } } },
            { id: 8, page_type: 'mail_list', name: 'VIP', weight: 2, lect: { _pointers: { event: '7' } } },
            { id: 9, page_type: 'mail_list', name: 'General', weight: 1, lect: { _pointers: { event: '7' } } },
          ],
          total: 2,
        });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'edm') {
        return Response.json({ pages: [], total: 0 });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'guest') {
        return Response.json({ pages: [], total: 0 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request('/__plugin/admin/events/7', {
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html.indexOf('General')).toBeLessThan(html.indexOf('VIP'));
    expect(html).toContain('data-reorder="/admin/pages/batch-weight"');
    expect(html).toContain('data-reorder-key="updates"');
    expect(html).toContain('data-reorder-event-id="7"');
    expect(html).toContain('data-reorder-handle-only');
    expect(html).toContain('data-reorder-handle');
  });

  it('creates and checks in an adhoc guest through the CMS write-back API', async () => {
    const cmsRequests: Array<{ url: URL; init?: RequestInit }> = [];
    const cmsFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      cmsRequests.push({ url, init });
      if (url.pathname === '/__cms/pages/7') {
        return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch', lect: {} } });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'mail_list') {
        return Response.json({ pages: [], total: 0 });
      }
      if (url.pathname === '/__cms/pages' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { page_type: string };
        return Response.json({ page: { id: body.page_type === 'mail_list' ? 8 : 99 } });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request('/__plugin/admin/events/7/adhoc-checkin', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-plugin-secret': 'shared-secret',
      },
      body: new URLSearchParams({ name: 'Ada', plus_guests: '2' }),
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/plugins/events/rsvp/8');
    expect(cmsRequests).toHaveLength(4);
    const guestCreate = cmsRequests.at(-1)?.init;
    expect(guestCreate?.method).toBe('POST');
    expect(new Headers(guestCreate?.headers).get('x-plugin-id')).toBe('events');
    expect(JSON.parse(String(guestCreate?.body))).toMatchObject({
      page_type: 'guest',
      name: 'Ada',
      page_id: 8,
      lect: {
        plus_guests: '2',
        status: 'confirmed',
        _pointers: { event: '7', mail_list: '8' },
        checkin: [{ status: 'checked-in' }],
      },
    });
  });

  it('creates a list under its selected event', async () => {
    let createRequest: RequestInit | undefined;
    const cmsFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/7') {
        return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch', lect: {} } });
      }
      if (url.pathname === '/__cms/pages' && init?.method === 'POST') {
        createRequest = init;
        return Response.json({ page: { id: 8 } });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request('/__plugin/admin/rsvp/new?event_id=7', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-plugin-secret': 'shared-secret' },
      body: new URLSearchParams({ name: 'VIP guests', allow_checkin: 'yes' }),
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(302);
    // Returns to the event the list belongs to (not the freshly created list,
    // whose read-back can 404 on the read-after-write path).
    expect(response.headers.get('location')).toBe('/admin/plugins/events/events/7');
    // Grouped to the event by the pointer, not a parent page.
    expect(JSON.parse(String(createRequest?.body))).toMatchObject({
      page_type: 'mail_list', name: 'VIP guests',
      lect: { _pointers: { event: '7' }, allow_checkin: 'yes' },
    });
  });

  it('keeps the selected event in the new guest list form', async () => {
    const eventId = 21862006647168;
    const cmsFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'event') {
        return Response.json({ pages: [{ id: 7, page_type: 'event', name: 'Other event', lect: {} }], total: 1 });
      }
      if (url.pathname === `/__cms/pages/${eventId}`) {
        return Response.json({ page: { id: eventId, page_type: 'event', name: 'Launch', lect: {} } });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request(`/__plugin/admin/rsvp/new?event_id=${eventId}`, {
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`action="/admin/plugins/events/rsvp/new?event_id=${eventId}"`);
    expect(html).toContain(`<option value="${eventId}" selected>Launch</option>`);
    expect(html).toContain(`/admin/plugins/events/events/${eventId}`);
  });

  it('groups a guest list under its event by the `event` pointer, not its parent page', async () => {
    const cmsFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/7') return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch', lect: {} } });
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'mail_list') {
        // The list's parent page (page_id 555) is a *different* page type; its
        // event is carried only by `_pointers.event`. It must still be listed.
        return Response.json({ pages: [{ id: 8, page_type: 'mail_list', page_id: 555, name: 'VIP', lect: { _pointers: { event: '7' } } }], total: 1 });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'guest') {
        return Response.json({ pages: [], total: 0 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request('/__plugin/admin/events/7/lists', {
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('VIP'); // grouped by pointer despite the foreign parent page
    // The plugin never filters the list call by parent page id.
    const listCall = cmsFetch.mock.calls.find(([input]) => {
      const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input : (input as Request).url);
      return u.pathname === '/__cms/pages' && u.searchParams.get('page_type') === 'mail_list';
    });
    expect(new URL(String(listCall?.[0])).searchParams.get('page_id')).toBeNull();
  });

  it('filters a guest list by name, email, phone, guest id and color tag in plugin code', async () => {
    const cmsFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/8') {
        return Response.json({ page: { id: 8, page_type: 'mail_list', name: 'VIP', lect: { _pointers: { event: '7' } } } });
      }
      if (url.pathname === '/__cms/pages/7') return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch', lect: {} } });
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'guest') {
        expect(url.searchParams.get('q')).toBeNull();
        return Response.json({
          pages: [
            { id: 55, page_type: 'guest', name: 'Ada', weight: 2, lect: { email: 'ada@example.com', phone: '+852 5555 0000', status: 'confirmed', color_tag: 'blue' } },
            { id: 56, page_type: 'guest', name: 'Grace', weight: 1, lect: { email: 'grace@example.com', phone: '+852 5555 9999', status: 'confirmed', color_tag: 'red' } },
            { id: 57, page_type: 'guest', name: 'Lin', weight: 3, lect: { email: 'lin@example.com', phone: '+852 1234 0000', status: 'confirmed' } },
          ],
          total: 3,
        });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'edm') {
        return Response.json({ pages: [], total: 0 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request('/__plugin/admin/rsvp/8?q=5555&color=blue&status=confirmed', {
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Ada');
    expect(html).not.toContain('Grace');
    expect(html).not.toContain('Lin');
    expect(html).toContain('value="5555"');
    expect(html).toContain('<option value="blue" selected>blue</option>');
    expect(html).toContain('<option value="orange"');
    expect(html).toContain('<option value="purple"');
    expect(html).toContain('1 guest');
  });

  it('renders the selected RSVP custom field column on a guest list', async () => {
    const cmsFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/8') {
        return Response.json({ page: { id: 8, page_type: 'mail_list', name: 'VIP', lect: { _pointers: { event: '7' } } } });
      }
      if (url.pathname === '/__cms/pages/7') {
        return Response.json({ page: {
          id: 7,
          page_type: 'event',
          name: 'Launch',
          lect: {
            _blocks: [
              {
                _type: 'rsvp-custom',
                _id: 'diet-block',
                custom_input: [
                  { type: 'select', label: { mis: 'Diet' }, default_value: 'vegan:Vegan|meat:Meat' },
                ],
              },
            ],
          },
        } });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'guest') {
        return Response.json({
          pages: [
            { id: 55, page_type: 'guest', name: 'Ada', weight: 1, lect: { email: 'ada@example.com', status: 'confirmed', rsvp_custom_diet: 'vegan', _pointers: { mail_list: '8' } } },
            { id: 56, page_type: 'guest', name: 'Grace', weight: 2, lect: { email: 'grace@example.com', status: 'invited', latest_response: { admin: { 'rsvp-custom-diet': 'meat' } }, _pointers: { mail_list: '8' } } },
          ],
          total: 2,
        });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'edm') {
        return Response.json({ pages: [], total: 0 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request('/__plugin/admin/rsvp/8?cf=rsvp-custom-diet', {
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('id="custom-field-selector"');
    expect(html).toContain('<option value="rsvp_custom_diet" selected>Diet</option>');
    expect(html).toContain('vegan');
    expect(html).toContain('meat');
    expect(html).toContain('response-state-confirmed');
    expect(html).toContain('style="color:#22c55e"');
  });

  it('deletes a guest list and returns to its event lists', async () => {
    const cmsFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/8' && init?.method === 'DELETE') return Response.json({ ok: true, id: 8 });
      if (url.pathname === '/__cms/pages/8') {
        return Response.json({ page: { id: 8, page_type: 'mail_list', name: 'VIP', lect: { _pointers: { event: '7' } } } });
      }
      if (url.pathname === '/__cms/pages/7') {
        return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch', lect: {} } });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request('/__plugin/admin/rsvp/8/delete', {
      method: 'POST',
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/plugins/events/rsvp?event=7');
    expect(cmsFetch).toHaveBeenLastCalledWith(
      'https://cms.test/__cms/pages/8',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('exports every guest across an event as one CSV', async () => {
    const cmsFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/7') {
        return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch', lect: {} } });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'mail_list') {
        return Response.json({ pages: [
          { id: 8, name: 'VIP', lect: { _pointers: { event: '7' } } },
          { id: 9, name: 'General', lect: { _pointers: { event: '7' } } },
        ], total: 2 });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'guest') {
        const listId = url.searchParams.get('page_id') ?? url.searchParams.get('pointer_value');
        if (listId === '8') return Response.json({ pages: [{ id: 1, name: 'Ada', lect: { status: 'confirmed', email: 'ada@x.io' } }], total: 1 });
        return Response.json({ pages: [{ id: 2, name: 'Grace', lect: { status: 'invited' } }], total: 1 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request('/__plugin/admin/events/7/export', {
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(response.headers.get('content-disposition')).toContain('launch-all-guests.csv');
    const csv = await response.text();
    expect(csv).toContain('"mail_list","name"');
    expect(csv).toContain('"VIP","Ada"');
    expect(csv).toContain('"General","Grace"');
    expect(csv).toContain('"ada@x.io"');
  });

  it('moves a guest into another list of the same event', async () => {
    let updateRequest: RequestInit | undefined;
    const cmsFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/8') {
        return Response.json({ page: { id: 8, page_type: 'mail_list', page_id: 7, name: 'VIP', lect: {} } });
      }
      if (url.pathname === '/__cms/pages/9') {
        return Response.json({ page: { id: 9, page_type: 'mail_list', page_id: 7, name: 'General', lect: {} } });
      }
      if (url.pathname === '/__cms/pages/7') {
        return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch', lect: {} } });
      }
      if (url.pathname === '/__cms/pages/55' && init?.method === 'PUT') {
        updateRequest = init;
        return Response.json({ page: { id: 55 } });
      }
      if (url.pathname === '/__cms/pages/55') {
        return Response.json({ page: { id: 55, page_type: 'guest', page_id: 8, name: 'Ada', lect: { _pointers: { event: '7', mail_list: '8' } } } });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request('/__plugin/admin/rsvp/8/guests/55/move', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-plugin-secret': 'shared-secret' },
      body: new URLSearchParams({ target_mail_list: '9' }),
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/plugins/events/rsvp/9');
    expect(JSON.parse(String(updateRequest?.body))).toMatchObject({
      page_id: 9,
      lect: { _pointers: { event: '7', mail_list: '9' } },
    });
  });

  it('rejects moving a guest into a list of a different event', async () => {
    const cmsFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/8') {
        return Response.json({ page: { id: 8, page_type: 'mail_list', name: 'VIP', lect: { _pointers: { event: '7' } } } });
      }
      if (url.pathname === '/__cms/pages/7') {
        return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch', lect: {} } });
      }
      if (url.pathname === '/__cms/pages/99') {
        // A list belonging to a different event (event pointer 70).
        return Response.json({ page: { id: 99, page_type: 'mail_list', name: 'Other', lect: { _pointers: { event: '70' } } } });
      }
      if (url.pathname === '/__cms/pages/55') {
        return Response.json({ page: { id: 55, page_type: 'guest', page_id: 8, name: 'Ada', lect: {} } });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request('/__plugin/admin/rsvp/8/guests/55/move', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-plugin-secret': 'shared-secret' },
      body: new URLSearchParams({ target_mail_list: '99' }),
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(404);
    // No PUT was issued.
    expect(cmsFetch).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: 'PUT' }));
  });

  it('keeps a valid guest list usable when its parent event can no longer be read', async () => {
    const listId = 21841367058779;
    const cmsFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === `/__cms/pages/${listId}`) {
        return Response.json({ page: { id: listId, page_type: 'mail_list', page_id: 7, name: 'Recovered list', lect: {} } });
      }
      if (url.pathname === '/__cms/pages/7') return Response.json({ error: 'not_found' }, { status: 404 });
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request(`/__plugin/admin/rsvp/${listId}/guests/new`, {
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('New guest');
  });

  it('redirects legacy event-based guest URLs to the event Adhoc list', async () => {
    const eventId = 21841367058779;
    const cmsFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === `/__cms/pages/${eventId}`) {
        return Response.json({ page: { id: eventId, page_type: 'event', name: 'Launch', lect: {} } });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'mail_list') {
        return Response.json({ pages: [{ id: 222, page_type: 'mail_list', name: 'Adhoc', lect: { _pointers: { event: String(eventId) } } }], total: 1 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request(`/__plugin/admin/rsvp/${eventId}/guests/new`, {
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/plugins/events/rsvp/222/guests/new');
  });
});

describe('EDM and labels', () => {
  it('creates a minimal EDM under its event, then hands off to the page editor', async () => {
    let createRequest: RequestInit | undefined;
    const cmsFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/7') {
        return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch', lect: {} } });
      }
      if (url.pathname === '/__cms/pages' && init?.method === 'POST') {
        createRequest = init;
        return Response.json({ page: { id: 12 } });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request('/__plugin/admin/edm/new', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-plugin-secret': 'shared-secret' },
      body: new URLSearchParams({ event_id: '7', name: 'Launch invitation' }),
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(302);
    // Hands off to the page editor (plugin-rendered EDM edit view), returning to the EDM list.
    expect(response.headers.get('location'))
      .toBe('/admin/pages/12/edit?return_to=%2Fadmin%2Fplugins%2Fevents%2Fedm');
    // Grouped to the event by the pointer, not a parent page.
    expect(JSON.parse(String(createRequest?.body))).toMatchObject({
      page_type: 'edm', name: 'Launch invitation',
      lect: { _type: 'edm', name: { en: 'Launch invitation' }, subject: { en: 'Launch invitation' }, _pointers: { event: '7' } },
    });
  });

  it('duplicates an EDM under the same event and opens the copy', async () => {
    let createRequest: RequestInit | undefined;
    const cmsFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/12') {
        return Response.json({ page: {
          id: 12, page_type: 'edm', name: 'Invite', page_id: 7,
          lect: { subject: { en: 'You are invited' }, _pointers: { event: '7' } },
        } });
      }
      if (url.pathname === '/__cms/pages' && init?.method === 'POST') {
        createRequest = init;
        return Response.json({ page: { id: 88 } });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request('/__plugin/admin/edm/12/duplicate', {
      method: 'POST',
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(302);
    // Duplicating opens the copy directly in the page editor (no intermediate page).
    expect(response.headers.get('location')).toBe('/admin/pages/88/edit?return_to=%2Fadmin%2Fplugins%2Fevents%2Fedm');
    // The copy keeps the event via the cloned `event` pointer.
    expect(JSON.parse(String(createRequest?.body))).toMatchObject({
      page_type: 'edm', name: 'Copy of Invite',
      lect: { subject: { en: 'You are invited' }, _pointers: { event: '7' } },
    });
  });

  it('renders an EDM preview through the Liquid → MJML → HTML pipeline', async () => {
    const cmsFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/12') {
        return Response.json({ page: {
          id: 12, page_type: 'edm', name: 'Invite', page_id: 7,
          lect: {
            subject: { en: 'You are invited' },
            heading: { en: 'Join us in October' },
            body: { en: '<p>We would love to see you.</p>' },
            bg_color: '#0f172a', text_color: '#e2e8f0', button_color: '#4f46e5',
            _blocks: [
              { _type: 'paragraph', _weight: 0, subject: { en: 'Agenda' }, body: { en: '<p>Talks &amp; dinner.</p>' } },
              { _type: 'button', _weight: 1, label: { en: 'Directions' }, url: { en: 'https://maps.example/x' } },
              { _type: 'table', _weight: 2, first_column_width: '120', row: [{ name: { en: 'Date' }, description: { en: '12 Oct' } }] },
            ],
          },
        } });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request('/__plugin/admin/edm/12/preview', {
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    // Opts into same-origin framing so the editor's preview pane can embed it.
    expect(response.headers.get('x-cms-frame')).toBe('1');
    const html = await response.text();
    // Compiled to real HTML — no MJML tags survive.
    expect(html).toContain('<!doctype html>');
    expect(html).not.toContain('<mjml');
    expect(html).not.toContain('<mj-');
    // Tokens and blocks rendered.
    expect(html).toContain('Join us in October');
    expect(html).toContain('<p>We would love to see you.</p>');
    expect(html).toContain('Talks &amp; dinner.');
    expect(html).toContain('href="https://maps.example/x"');
    expect(html).toContain('Directions');
    expect(html).toContain('12 Oct');
    // Styling tokens applied.
    expect(html).toContain('#0f172a'); // bg color
    expect(html).toContain('#4f46e5'); // button color
  });

  it('renders the EDM preview in the requested language', async () => {
    const cmsFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/12') {
        return Response.json({ page: {
          id: 12, page_type: 'edm', name: 'Invite', page_id: 7,
          lect: {
            subject: { en: 'You are invited', 'zh-hant': '誠邀閣下' },
            heading: { en: 'Join us', 'zh-hant': '誠摯邀請' },
            body: { en: '<p>English body</p>', 'zh-hant': '<p>中文內容</p>' },
          },
        } });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request('/__plugin/admin/edm/12/preview?language=zh-hant', {
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('誠摯邀請');     // zh-hant heading
    expect(html).toContain('中文內容');     // zh-hant body
    expect(html).not.toContain('Join us');  // not the English heading
  });

  it('compiles EDM MJML via the MJML API when credentials are set', async () => {
    let mjmlAuth: string | null = null;
    let mjmlBody = '';
    const cmsFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.hostname === 'api.mjml.io') {
        mjmlAuth = new Headers(init?.headers).get('authorization');
        mjmlBody = String(init?.body);
        return Response.json({ html: '<html><body>FROM_MJML_API</body></html>', errors: [] });
      }
      if (url.pathname === '/__cms/pages/12') {
        return Response.json({ page: { id: 12, page_type: 'edm', name: 'Invite', page_id: 7, lect: { subject: { en: 'Hi' }, heading: { en: 'Join us' } } } });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request('/__plugin/admin/edm/12/preview', {
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret', MJML_APP_ID: 'app-1', MJML_SECRET_KEY: 'secret-2' }));

    expect(response.status).toBe(200);
    const html = await response.text();
    // The API's HTML is returned verbatim — the built-in compiler was bypassed.
    expect(html).toBe('<html><body>FROM_MJML_API</body></html>');
    // Basic auth uses APP_ID:SECRET_KEY and the body carries the rendered MJML.
    expect(mjmlAuth).toBe(`Basic ${btoa('app-1:secret-2')}`);
    expect(JSON.parse(mjmlBody).mjml).toContain('<mjml>');
    expect(JSON.parse(mjmlBody).mjml).toContain('Join us');
  });

  it('sends a test email with the EDM reply-to and bcc applied', async () => {
    let sent: Record<string, unknown> | undefined;
    const cmsFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/12') {
        return Response.json({ page: {
          id: 12, page_type: 'edm', name: 'Invite', page_id: 7,
          lect: { subject: { en: 'Hi' }, heading: { en: 'Join us' }, sender: 'events@example.com', reply_to: 'rsvp@example.com', bcc: 'archive@example.com, log@example.com' },
        } });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const EMAIL = { send: vi.fn(async (message: Record<string, unknown>) => { sent = message; }) };
    const response = await plugin.fetch(request('/__plugin/admin/edm/12/send-test', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-plugin-secret': 'shared-secret' },
      body: new URLSearchParams({ recipient: 'guest@example.com' }),
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret', EMAIL, EMAIL_FROM: 'noreply@example.com' }));

    expect(response.status).toBe(302);
    expect(EMAIL.send).toHaveBeenCalledTimes(1);
    expect(sent).toMatchObject({
      from: 'events@example.com',
      to: 'guest@example.com',
      replyTo: 'rsvp@example.com',
      bcc: ['archive@example.com', 'log@example.com'],
    });
  });

  it('caches MJML API output in KV and reuses it on the next render', async () => {
    const store = new Map<string, string>();
    const kv = {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => { store.set(key, value); },
    } as unknown as KVNamespace;
    let apiCalls = 0;
    const cmsFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.hostname === 'api.mjml.io') {
        apiCalls++;
        return Response.json({ html: '<html><body>CACHED_OUTPUT</body></html>', errors: [] });
      }
      if (url.pathname === '/__cms/pages/12') {
        return Response.json({ page: { id: 12, page_type: 'edm', name: 'Invite', page_id: 7, lect: { subject: { en: 'Hi' }, heading: { en: 'Join us' } } } });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const e = env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret', MJML_APP_ID: 'app-1', MJML_SECRET_KEY: 'secret-2', MAIL_TRACKING: kv });
    const preview = () => plugin.fetch(request('/__plugin/admin/edm/12/preview', { headers: { 'x-plugin-secret': 'shared-secret' } }), e);

    const first = await preview();
    expect(await first.text()).toBe('<html><body>CACHED_OUTPUT</body></html>');
    expect(apiCalls).toBe(1);
    expect(store.size).toBe(1);

    const second = await preview();
    expect(await second.text()).toBe('<html><body>CACHED_OUTPUT</body></html>');
    // Served from KV — the API was not hit again.
    expect(apiCalls).toBe(1);
  });

  it('falls back to the built-in compiler when the MJML API errors', async () => {
    const cmsFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.hostname === 'api.mjml.io') return new Response('rate limited', { status: 429 });
      if (url.pathname === '/__cms/pages/12') {
        return Response.json({ page: { id: 12, page_type: 'edm', name: 'Invite', page_id: 7, lect: { subject: { en: 'Hi' }, heading: { en: 'Join us' } } } });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request('/__plugin/admin/edm/12/preview', {
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret', MJML_APP_ID: 'app-1', MJML_SECRET_KEY: 'secret-2' }));

    expect(response.status).toBe(200);
    const html = await response.text();
    // Built-in compiler output: real HTML, no MJML tags, with the heading.
    expect(html).toContain('<!doctype html>');
    expect(html).not.toContain('<mj-');
    expect(html).toContain('Join us');
  });

  it('renders label guest tokens as escaped SVG text', async () => {
    const cmsFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/7') return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch', lect: {} } });
      if (url.pathname === '/__cms/pages/8') {
        return Response.json({ page: {
          id: 8, page_type: 'label', page_id: 7, name: 'Badge',
          lect: { frame: { svg: '<svg><text>{{name}}</text><text>{{organization}}</text></svg>' } },
        } });
      }
      if (url.pathname === '/__cms/pages/9') {
        return Response.json({ page: { id: 9, page_type: 'guest', name: 'Ada & Co', lect: { organization: '<Launch>' } } });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request('/__plugin/admin/events/7/labels/8/preview?guest_id=9', {
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('image/svg+xml');
    const svg = await response.text();
    expect(svg).toContain('Ada &amp; Co');
    expect(svg).toContain('&lt;Launch&gt;');
  });
});

describe('EDM edit view (plugin-rendered page editor)', () => {
  it('declares the plugin-rendered edit views in the manifest', async () => {
    const response = await plugin.fetch(request('/__plugin/manifest'), env({ PLUGIN_SECRET: 'shared-secret' }));
    await expect(response.json()).resolves.toMatchObject({ editViews: ['edm', 'guest'] });
  });

  it('links the EDM list straight to the page editor (no intermediate page)', async () => {
    const cmsFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'edm') {
        return Response.json({ pages: [{ id: 50, page_type: 'edm', name: 'Save the date', page_id: 12, lect: { subject: { en: 'Hi' } } }], total: 1 });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'event') {
        return Response.json({ pages: [{ id: 12, page_type: 'event', name: 'Gala', lect: {} }], total: 1 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request('/__plugin/admin/edm', {
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('href="/admin/pages/50/edit?return_to=%2Fadmin%2Fplugins%2Fevents%2Fedm"');
    // The old standalone landing page (/edm/50 with no sub-route) is not linked.
    expect(html).not.toContain('href="/admin/plugins/events/edm/50"');
  });

  it('forwards a bare /edm/:id to the page editor', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    const response = await plugin.fetch(request('/__plugin/admin/edm/50', {
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/pages/50/edit?return_to=%2Fadmin%2Fplugins%2Fevents%2Fedm');
  });

  function editContext(overrides: Record<string, unknown> = {}) {
    return {
      mode: 'edit',
      action: '/admin/pages/50',
      backHref: '/admin/plugins/events/edm/50',
      language: 'mis',
      pageType: 'edm',
      page: {
        id: 50,
        name: 'Save the date',
        slug: 'save-the-date',
        pageType: 'edm',
        weight: 5,
        start: null,
        end: null,
        timezone: null,
        editors: null,
        lect: JSON.stringify({
          _type: 'edm',
          _pointers: { event: '12' },
          sender: 'events@example.com',
          subject: { mis: 'You are invited' },
          _blocks: [
            { _type: 'paragraph', _weight: 0, subject: { mis: 'Welcome' }, body: { mis: 'See you there' } },
          ],
        }),
      },
      versions: [],
      ...overrides,
    };
  }

  it('renders the bespoke EDM editor and wraps it in CMS chrome', async () => {
    const cmsFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/12') {
        return Response.json({ page: { id: 12, page_type: 'event', name: 'Town & Country', lect: {} } });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request('/__plugin/edit', {
      method: 'POST',
      headers: { 'x-plugin-secret': 'shared-secret', 'content-type': 'application/json' },
      body: JSON.stringify(editContext()),
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-cms-chrome')).toBe('1');
    const html = await response.text();
    // Form posts back to the CMS save handler.
    expect(html).toContain('action="/admin/pages/50"');
    // Page-basics carried as hidden fields + the event pointer.
    expect(html).toContain('name="page_type" value="edm"');
    expect(html).toContain('name="*event" value="12"');
    // Template name, sender attribute (@field) and subject value (.field|lang).
    expect(html).toContain('value="Save the date"');
    expect(html).toContain('name="@sender"');
    expect(html).toContain('name=".subject|mis"');
    expect(html).toContain('You are invited');
    // Language selector lives in the form and auto-reloads on change (CSP-safe
    // via the CMS layout's data-autosubmit handler).
    expect(html).toContain('name="_language" form="main-form" data-autosubmit');
    // The paragraph block is rendered with #<index> field names + a delete action.
    expect(html).toContain('name="#0.subject|mis"');
    expect(html).toContain('value="block-delete:0"');
    // The parent event name appears in the header.
    expect(html).toContain('Town &amp; Country');
    // The preview pane is embedded as a same-origin iframe, scoped to the language,
    // with per-language tabs that retarget it.
    expect(html).toContain('name="edm-preview" src="/admin/plugins/events/edm/50/preview?language=mis"');
    expect(html).toContain('href="/admin/plugins/events/edm/50/preview?language=en" target="edm-preview"');
  });

  it('renders the bespoke guest editor with RSVP custom fields from the event', async () => {
    const cmsFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/8') {
        return Response.json({ page: { id: 8, page_type: 'mail_list', name: 'VIP', lect: { _pointers: { event: '7' } } } });
      }
      if (url.pathname === '/__cms/pages/7') {
        return Response.json({ page: {
          id: 7,
          page_type: 'event',
          name: 'Town & Country',
          lect: {
            _blocks: [
              {
                _type: 'rsvp-custom',
                _id: 'diet-block',
                title: { mis: 'RSVP Details' },
                custom_input: [
                  { type: 'select', required: 'yes', label: { mis: 'Diet' }, default_value: 'vegan:Vegan|meat:Meat' },
                ],
              },
            ],
          },
        } });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'mail_list') {
        return Response.json({ pages: [{ id: 8, page_type: 'mail_list', name: 'VIP', lect: { _pointers: { event: '7' } } }], total: 1 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request('/__plugin/edit', {
      method: 'POST',
      headers: { 'x-plugin-secret': 'shared-secret', 'content-type': 'application/json' },
      body: JSON.stringify(editContext({
        action: '/admin/pages/9',
        backHref: '/admin/plugins/events/rsvp/8',
        pageType: 'guest',
        page: {
          id: 9,
          name: 'Ada Lovelace',
          slug: 'ada-lovelace',
          pageType: 'guest',
          page_id: 8,
          lect: JSON.stringify({
            _type: 'guest',
            name: { mis: 'Ada Lovelace' },
            email: 'ada@example.com',
            phone: '+85290001000',
            status: 'confirmed',
            _pointers: { event: '7', mail_list: '8' },
            rsvp_custom_diet: 'vegan',
          }),
        },
      })),
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-cms-chrome')).toBe('1');
    const html = await response.text();
    expect(html).toContain('action="/admin/pages/9"');
    expect(html).toContain('name="page_type" value="guest"');
    expect(html).toContain('name="page_id" value="8"');
    expect(html).toContain('name="*mail_list" value="8"');
    expect(html).toContain('name="return_to" value="/admin/plugins/events/rsvp/8"');
    expect(html).toContain('Town &amp; Country');
    expect(html).toContain('name="@phone"');
    expect(html).toContain('name=".last_name|mis"');
    expect(html).toContain('Additional information');
    expect(html).toContain('name="@rsvp_custom_diet"');
    expect(html).toContain('<option value="vegan" selected>Vegan</option>');
  });

  it('renders guest Activity from RSVP, check-in and sent EDM history', async () => {
    const cmsFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/8') {
        return Response.json({ page: { id: 8, page_type: 'mail_list', name: 'VIP', lect: { _pointers: { event: '7' } } } });
      }
      if (url.pathname === '/__cms/pages/7') {
        return Response.json({ page: { id: 7, page_type: 'event', name: 'Town & Country', lect: {} } });
      }
      if (url.pathname === '/__cms/pages/50') {
        return Response.json({ page: { id: 50, page_type: 'edm', name: 'Annual invite', lect: {} } });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'mail_list') {
        return Response.json({ pages: [{ id: 8, page_type: 'mail_list', name: 'VIP', lect: { _pointers: { event: '7' } } }], total: 1 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request('/__plugin/edit', {
      method: 'POST',
      headers: { 'x-plugin-secret': 'shared-secret', 'content-type': 'application/json' },
      body: JSON.stringify(editContext({
        action: '/admin/pages/9',
        backHref: '/admin/plugins/events/rsvp/8',
        pageType: 'guest',
        page: {
          id: 9,
          name: 'Ada Lovelace',
          slug: 'ada-lovelace',
          pageType: 'guest',
          page_id: 8,
          lect: JSON.stringify({
            _type: 'guest',
            name: { mis: 'Ada Lovelace' },
            email: 'ada@example.com',
            status: 'confirmed',
            _pointers: { event: '7', mail_list: '8' },
            response: [{ status: 'confirmed', date: '2026-06-25T09:30:00Z', message: 'Looking forward to it' }],
            checkin: [{ status: 'checked-in', date: '2026-06-26T01:15:00Z', message: 'front desk' }],
            sent_edm: [{ edm: '50', date: '2026-06-24T08:00:00Z', message: 'manual send' }],
          }),
        },
      })),
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Activity');
    expect(html).toContain('Response');
    expect(html).toContain('Confirmed');
    expect(html).toContain('Looking forward to it');
    expect(html).toContain('Check-in');
    expect(html).toContain('front desk');
    expect(html).toContain('Sent eDM');
    expect(html).toContain('Annual invite');
    expect(html).toContain('manual send');
  });

  it('does not serve the old plugin guest edit URL', async () => {
    const cmsFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/8') {
        return Response.json({ page: { id: 8, page_type: 'mail_list', name: 'VIP', lect: { _pointers: { event: '7' } } } });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request('/__plugin/admin/rsvp/8/guests/9', {
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(404);

    const post = await plugin.fetch(request('/__plugin/admin/rsvp/8/guests/9', {
      method: 'POST',
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));
    expect(post.status).toBe(404);
  });

  it('falls back (404) for a non-edm and non-guest page type', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    const response = await plugin.fetch(request('/__plugin/edit', {
      method: 'POST',
      headers: { 'x-plugin-secret': 'shared-secret', 'content-type': 'application/json' },
      body: JSON.stringify(editContext({ pageType: 'event' })),
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));
    expect(response.status).toBe(404);
  });

  it('rejects the edit view without the shared secret', async () => {
    const response = await plugin.fetch(request('/__plugin/edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(editContext()),
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));
    expect(response.status).toBe(403);
  });
});

describe('public RSVP', () => {
  it('accepts a signed RSVP and records the response against the guest', async () => {
    let updateRequest: RequestInit | undefined;
    const cmsFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/7') return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch', lect: {} } });
      if (url.pathname === '/__cms/pages/8') return Response.json({ page: { id: 8, page_type: 'mail_list', name: 'VIP', lect: { _pointers: { event: '7' } } } });
      if (url.pathname === '/__cms/pages/9' && init?.method === 'PUT') {
        updateRequest = init;
        return Response.json({ page: { id: 9 } });
      }
      if (url.pathname === '/__cms/pages/9') return Response.json({ page: { id: 9, page_type: 'guest', page_id: 8, name: 'Ada', lect: { plus_guests: '0', response: [] } } });
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);
    const signature = await signPayload('shared-secret', 'rsvp:7:8:9');

    const response = await plugin.fetch(request(`/rsvp/7/8/9/${signature}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ status: 'confirmed', plus_guests: '1', message: 'Looking forward to it' }),
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('/rsvp/thank-you?status=confirmed');
    expect(JSON.parse(String(updateRequest?.body))).toMatchObject({
      lect: { status: 'confirmed', plus_guests: '1', response: [{ status: 'confirmed', message: 'Looking forward to it' }] },
    });
  });
});

describe('event tooling (reorder, import, all-guests, QR)', () => {
  it('persists guest-list order by writing each list weight', async () => {
    const updates: Array<{ id: string; body: unknown }> = [];
    const cmsFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (init?.method === 'PUT') {
        updates.push({ id: url.pathname.split('/').pop()!, body: JSON.parse(String(init.body)) });
        return Response.json({ page: {} });
      }
      if (url.pathname === '/__cms/pages/8') return Response.json({ page: { id: 8, page_type: 'mail_list', name: 'VIP', lect: { _pointers: { event: '7' } } } });
      if (url.pathname === '/__cms/pages/9') return Response.json({ page: { id: 9, page_type: 'mail_list', name: 'General', lect: { _pointers: { event: '7' } } } });
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request('/__plugin/admin/events/7/reorder-guest-lists', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-plugin-secret': 'shared-secret' },
      body: JSON.stringify({ reorder: [{ id: 9, weight: 0 }, { id: 8, weight: 1 }] }),
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(updates).toEqual([
      { id: '9', body: { weight: 0 } },
      { id: '8', body: { weight: 1 } },
    ]);
  });

  it('reorders sessions by writing an in-place weight (never moving array rows)', async () => {
    let updateBody: { lect?: { session?: Array<{ _weight?: number }> } } | undefined;
    const sessions = [{ name: { en: 'Keynote' } }, { name: { en: 'Lunch' } }, { name: { en: 'Workshop' } }];
    const cmsFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/7' && init?.method === 'PUT') {
        updateBody = JSON.parse(String(init.body));
        return Response.json({ page: { id: 7 } });
      }
      if (url.pathname === '/__cms/pages/7') return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch', lect: { session: sessions } } });
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    // New display order = [original idx 2, 0, 1] → weights idx0=1, idx1=2, idx2=0.
    const response = await plugin.fetch(request('/__plugin/admin/events/7/reorder-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-plugin-secret': 'shared-secret' },
      body: JSON.stringify({ order: [2, 0, 1] }),
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(200);
    // Only `_weight` is patched, in the original array order — no row data moves.
    expect(updateBody?.lect?.session).toEqual([{ _weight: 1 }, { _weight: 2 }, { _weight: 0 }]);
  });

  it('rejects a session reorder whose indices do not cover every row', async () => {
    const cmsFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/7') return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch', lect: { session: [{}, {}] } } });
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request('/__plugin/admin/events/7/reorder-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-plugin-secret': 'shared-secret' },
      body: JSON.stringify({ order: [0, 0] }),
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(400);
    expect(cmsFetch).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: 'PUT' }));
  });

  it('imports guests into per-list groups, creating missing lists', async () => {
    const listCreates: Array<Record<string, unknown>> = [];
    const guestCreates: Array<Record<string, unknown>> = [];
    const cmsFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/7') return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch', lect: {} } });
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'mail_list') {
        return Response.json({ pages: [{ id: 8, page_type: 'mail_list', name: 'VIP', lect: { _pointers: { event: '7' } } }], total: 1 });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'guest') {
        return Response.json({ pages: [], total: 0 });
      }
      if (url.pathname === '/__cms/pages' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (body.page_type === 'mail_list') listCreates.push(body);
        if (body.page_type === 'guest') guestCreates.push(body);
        return Response.json({ page: { id: 99, name: body.name } });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const csv = '\uFEFFguest_list_name,name,primary_email,cc_email,company,job_title\nVIP,Ada,ada@x.io,pa@x.io,Analytical Engines,Engineer\nGeneral,Grace,grace@x.io,,Compiler Co,Admiral\n';
    const file = new File([csv], 'guests.csv', { type: 'text/csv' });
    const form = new FormData();
    form.set('file', file);
    const preview = await plugin.fetch(request('/__plugin/admin/events/7/import', {
      method: 'POST',
      headers: { 'x-plugin-secret': 'shared-secret' },
      body: form,
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(preview.status).toBe(200);
    const html = await preview.text();
    expect(html).toContain('Preview import');
    expect(html).toContain('VIP');
    expect(html).toContain('General');
    expect(html).toContain('Will create');
    expect(listCreates).toHaveLength(0);
    expect(guestCreates).toHaveLength(0);

    const response = await plugin.fetch(request('/__plugin/admin/events/7/import/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-plugin-secret': 'shared-secret' },
      body: new URLSearchParams({ mode: 'new_and_update', csv }),
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/plugins/events/events/7/all-guests');
    // "General" did not exist, so it was created; "VIP" already existed.
    expect(listCreates).toHaveLength(1);
    expect(listCreates[0]).toMatchObject({ page_type: 'mail_list', name: 'General', lect: { _pointers: { event: '7' } } });
    expect(guestCreates).toHaveLength(2);
    expect(guestCreates.map((guest) => guest.name)).toEqual(['Ada', 'Grace']);
    expect(guestCreates[0].lect).toMatchObject({ email: 'ada@x.io', cc: 'pa@x.io', organization: 'Analytical Engines', job_title: 'Engineer' });
  });

  it('renders a flat all-guests view filtered by search, status and color tag', async () => {
    const cmsFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/7') return Response.json({ page: {
        id: 7,
        page_type: 'event',
        name: 'Launch',
        lect: {
          _blocks: [
            { _type: 'rsvp-custom', custom_input: [{ type: 'select', label: { mis: 'Diet' }, default_value: 'vegan:Vegan|meat:Meat' }] },
          ],
        },
      } });
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'mail_list') {
        return Response.json({ pages: [
          { id: 8, name: 'VIP', weight: 0, lect: { _pointers: { event: '7', edm: '50' } } },
          { id: 9, name: 'General', weight: 1, lect: { _pointers: { event: '7' } } },
        ], total: 2 });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'guest') {
        const listId = url.searchParams.get('page_id') ?? url.searchParams.get('pointer_value');
        if (listId === '8') {
          return Response.json({ pages: [
            { id: 1, name: 'Ada', lect: { email: 'ada@x.io', phone: '+852 5555 0000', status: 'confirmed', color_tag: 'blue', rsvp_custom_diet: 'vegan' } },
            { id: 3, name: 'Lin', lect: { email: 'lin@x.io', phone: '+852 5555 1111', status: 'confirmed', color_tag: 'red' } },
          ], total: 2 });
        }
        return Response.json({ pages: [{ id: 2, name: 'Grace', lect: { email: 'grace@x.io', phone: '+852 5555 2222', status: 'invited', color_tag: 'blue' } }], total: 1 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request('/__plugin/admin/events/7/all-guests?q=5555&status=confirmed&color=blue&cf=rsvp-custom-diet', {
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('All guests');
    expect(html).toContain('Ada');
    expect(html).not.toContain('Lin');
    expect(html).not.toContain('Grace'); // filtered out
    expect(html).toContain('value="5555"');
    expect(html).toContain('<option value="blue" selected>blue</option>');
    expect(html).toContain('<option value="yellow"');
    expect(html).toContain('<option value="purple"');
    expect(html).toContain('<th class="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">List</th>');
    expect(html).toContain('Email&nbsp;send');
    expect(html).toContain('id="custom-field-selector"');
    expect(html).toContain('<option value="rsvp_custom_diet" selected>Diet</option>');
    expect(html).toContain('vegan');
    expect(html).toContain('action="/admin/plugins/events/rsvp/8/guests/1/status"');
    expect(html).toContain('action="/admin/plugins/events/rsvp/8/guests/1/checkin"');
    expect(html).toContain('name="return_to" value="/admin/plugins/events/events/7/all-guests?q=5555&amp;status=confirmed&amp;color=blue&amp;cf=rsvp-custom-diet"');
    expect(html).toContain('href="/admin/plugins/events/rsvp/8/guests/1/qrcode"');
    expect(html).toContain('style="color:#22c55e"');
    expect(html).toContain('1 of 3 guests');
  });

  it('renders the sessions view in event order', async () => {
    const cmsFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/7') {
        return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch', lect: { session: [{ name: { en: 'Keynote' }, start: '09:00' }, { name: { en: 'Lunch' } }] } } });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request('/__plugin/admin/events/7/sessions', {
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Sessions');
    expect(html).toContain('Keynote');
    expect(html).toContain('data-reorder-mode="order"');
    expect(html).toContain('data-index="0"');
  });

  it('renders the event-wide import form', async () => {
    const cmsFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/7') return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch', lect: {} } });
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request('/__plugin/admin/events/7/import', {
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Import guests');
    expect(html).toContain('type="file"');
  });

  it('refreshes a guest from its linked contact and logs the change', async () => {
    let updateBody: { name?: string; lect?: Record<string, unknown> } | undefined;
    const contact = {
      id: 200, page_type: 'contact', name: 'Ada Lovelace',
      lect: {
        first_name: { en: 'Ada' }, last_name: { en: 'Lovelace' }, prefix: 'Ms', nationality: 'GB', prefer_language: 'en',
        position: [{ organization_name: { en: 'Analytical Engines' }, title: { en: 'Engineer' }, email: 'ada@work.io', direct_phone: '+44 20 7946 0000' }],
        email: [{ email: 'ada@primary.io' }],
        assistant: [{ email: 'pa@ada.io' }],
      },
    };
    const cmsFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/55' && init?.method === 'PUT') {
        updateBody = JSON.parse(String(init.body));
        return Response.json({ page: { id: 55 } });
      }
      if (url.pathname === '/__cms/pages/55') return Response.json({ page: { id: 55, page_type: 'guest', page_id: 8, name: 'Stale', lect: { contact_id: '200', status: 'invited', _pointers: { mail_list: '8' }, response: [{ status: 'invited' }] } } });
      if (url.pathname === '/__cms/pages/8') return Response.json({ page: { id: 8, page_type: 'mail_list', page_id: 7, name: 'VIP', lect: {} } });
      if (url.pathname === '/__cms/pages/200') return Response.json({ page: contact });
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request('/__plugin/admin/rsvp/8/guests/55/update-from-contact', {
      method: 'POST',
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/pages/55/edit?return_to=%2Fadmin%2Fplugins%2Fevents%2Frsvp%2F8');
    expect(updateBody?.name).toBe('Ada Lovelace');
    expect(updateBody?.lect).toMatchObject({
      name: { en: 'Ada Lovelace' },
      email: 'ada@primary.io', // email[] wins over position email
      phone: '+44 20 7946 0000',
      cc: 'pa@ada.io',
      organization: 'Analytical Engines',
      job_title: 'Engineer',
      prefix: 'Ms',
    });
    // Existing history is preserved and a refresh entry appended.
    const response_log = (updateBody?.lect as { response: Array<{ message?: string }> }).response;
    expect(response_log).toHaveLength(2);
    expect(response_log[1].message).toContain('Contact ID: 200');
  });

  it('skips guests without a contact link when updating a whole list', async () => {
    const puts: string[] = [];
    const cmsFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (init?.method === 'PUT') { puts.push(url.pathname); return Response.json({ page: {} }); }
      if (url.pathname === '/__cms/pages/8') return Response.json({ page: { id: 8, page_type: 'mail_list', page_id: 7, name: 'VIP', lect: {} } });
      if (url.pathname === '/__cms/pages/7') return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch', lect: {} } });
      if (url.pathname === '/__cms/pages/200') return Response.json({ page: { id: 200, page_type: 'contact', name: 'Ada', lect: { first_name: { en: 'Ada' } } } });
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'guest') {
        return Response.json({ pages: [
          { id: 1, page_type: 'guest', page_id: 8, name: 'Linked', lect: { contact_id: '200' } },
          { id: 2, page_type: 'guest', page_id: 8, name: 'Unlinked', lect: {} },
        ], total: 2 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request('/__plugin/admin/rsvp/8/update-from-contacts', {
      method: 'POST',
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/plugins/events/rsvp/8');
    // Only the linked guest (id 1) was written.
    expect(puts).toEqual(['/__cms/pages/1']);
  });

  it('renders a scannable per-guest QR with a signed check-in payload', async () => {
    const cmsFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/8') return Response.json({ page: { id: 8, page_type: 'mail_list', page_id: 7, name: 'VIP', lect: {} } });
      if (url.pathname === '/__cms/pages/7') return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch', lect: {} } });
      if (url.pathname === '/__cms/pages/55') return Response.json({ page: { id: 55, page_type: 'guest', page_id: 8, name: 'Ada', lect: { _pointers: { mail_list: '8' } } } });
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request('/__plugin/admin/rsvp/8/guests/55/qrcode', {
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<svg');
    expect(html).toContain('<rect'); // QR modules rendered
    const sig = await signPayload('shared-secret', '8.55');
    expect(html).toContain(`8.55.${sig}`);
  });
});

describe('RSVP EDM sending (guest-list controls)', () => {
  // A list (8) under event 7, linked to EDM 50, with one good-quality guest (55).
  function rsvpEdmFetch(captured?: { put?: RequestInit }) {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      const p = url.pathname;
      if (p === '/__cms/pages/8') {
        return Response.json({ page: { id: 8, page_type: 'mail_list', page_id: 7, name: 'VIP', lect: { _pointers: { event: '7', edm: '50' } } } });
      }
      if (p === '/__cms/pages/7') return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch', lect: {} } });
      if (p === '/__cms/pages/50') {
        return Response.json({ page: { id: 50, page_type: 'edm', name: 'Invite', page_id: 7, lect: { subject: { en: 'Hi' }, heading: { en: 'Join us' }, sender: 'events@example.com' } } });
      }
      if (p === '/__cms/pages' && url.searchParams.get('page_type') === 'edm') {
        return Response.json({ pages: [{ id: 50, page_type: 'edm', name: 'Invite', lect: { _pointers: { event: '7' } } }], total: 1 });
      }
      if (p === '/__cms/pages' && url.searchParams.get('page_type') === 'guest') {
        return Response.json({ pages: [{ id: 55, page_type: 'guest', page_id: 8, name: 'Ada', lect: { email: 'ada@example.com', _pointers: { mail_list: '8' } } }], total: 1 });
      }
      if (p === '/__cms/pages/55' && init?.method === 'PUT') { if (captured) captured.put = init; return Response.json({ page: { id: 55 } }); }
      if (p === '/__cms/pages/55') return Response.json({ page: { id: 55, page_type: 'guest', page_id: 8, name: 'Ada', lect: { email: 'ada@example.com', _pointers: { mail_list: '8' } } } });
      return new Response('not found', { status: 404 });
    });
  }

  it('renders the EDM dropdown, send and auto-send controls when the list has an EDM', async () => {
    vi.stubGlobal('fetch', rsvpEdmFetch());
    const response = await plugin.fetch(request('/__plugin/admin/rsvp/8', {
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Auto Send (Good)');
    expect(html).toContain('Auto Send (Risky)');
    expect(html).toContain('/admin/plugins/events/rsvp/8/send-edm?quality=good');
    expect(html).toContain('data-autosubmit');                                   // EDM dropdown
    expect(html).toContain('action="/admin/plugins/events/rsvp/8/guests/55/send"'); // per-guest send
    expect(html).toContain('href="/admin/pages/55/edit?return_to=%2Fadmin%2Fplugins%2Fevents%2Frsvp%2F8"');
    expect(html).not.toContain('href="/admin/plugins/events/rsvp/8/guests/55"');
    expect(html).toContain('>good<');                                            // quality chip
  });

  it('sends the EDM to one guest and records it as sent', async () => {
    const captured: { put?: RequestInit } = {};
    vi.stubGlobal('fetch', rsvpEdmFetch(captured));
    const sent: Record<string, unknown>[] = [];
    const EMAIL = { send: vi.fn(async (m: Record<string, unknown>) => { sent.push(m); }) };

    const response = await plugin.fetch(request('/__plugin/admin/rsvp/8/guests/55/send', {
      method: 'POST',
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret', EMAIL, EMAIL_FROM: 'noreply@example.com' }));

    expect(response.status).toBe(302);
    expect(EMAIL.send).toHaveBeenCalledTimes(1);
    expect(sent[0]).toMatchObject({ to: 'ada@example.com' });
    // The guest is marked as sent this EDM so the button flips to "Re-send".
    expect(JSON.parse(String(captured.put?.body))).toMatchObject({ lect: { sent_edm: ['50'] } });
  });

  it('redirects GET /rsvp/:id/edm back to the guest list detail', async () => {
    vi.stubGlobal('fetch', rsvpEdmFetch());
    const response = await plugin.fetch(request('/__plugin/admin/rsvp/8/edm', {
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/plugins/events/rsvp/8');
  });

  it('auto-sends to good-quality guests and skips others', async () => {
    const EMAIL = { send: vi.fn(async () => {}) };
    vi.stubGlobal('fetch', rsvpEdmFetch());
    const response = await plugin.fetch(request('/__plugin/admin/rsvp/8/send-edm?quality=good', {
      method: 'POST',
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret', EMAIL, EMAIL_FROM: 'noreply@example.com' }));

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/admin/plugins/events/rsvp/8?flash=');
    expect(EMAIL.send).toHaveBeenCalledTimes(1); // the one good guest
  });
});

describe('check-in detection', () => {
  it('ignores the empty check-in row the host seeds on new guests', () => {
    // The guest blueprint declares a `checkin` block, so the host seeds one
    // empty row on create. That must not read as a real check-in.
    expect(checkins({ checkin: [{ status: '', date: '', message: '' }] })).toHaveLength(0);
    expect(checkins({})).toHaveLength(0);
    expect(checkins({ checkin: [{ status: 'checked-in', date: '2026-06-10T01:00:00Z' }] })).toHaveLength(1);
    expect(checkins({ checkin: [{ date: '2026-06-10T01:00:00Z' }] })).toHaveLength(1);
  });
});

describe('legacy guest import', () => {
  it('groups by guest_list_name and carries over check-in state', async () => {
    const batches: Array<{ pages: Array<{ name: string; lect: Record<string, unknown> }> }> = [];
    const cmsFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/7') return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch', lect: {} } });
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'mail_list') {
        return Response.json({ pages: [], total: 0 }); // no lists yet
      }
      if (url.pathname === '/__cms/pages' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { name: string };
        return Response.json({ page: { id: 50, name: body.name, lect: {} } });
      }
      if (url.pathname === '/__cms/pages/batch' && init?.method === 'POST') {
        batches.push(JSON.parse(String(init.body)));
        return Response.json({ created: [], errors: [] });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const csv = [
      'guest_list_name,name,email,checkin_status,checkin_date,checkin_message',
      'VIP,Ada,ada@x.io,checked-in,2026-06-10T01:00:00Z,from kiosk',
      'VIP,Bob,bob@x.io,,,',
      'VIP,Cleo,cleo@x.io,session-checked-in,2026-06-10T02:00:00Z,Lunch',
      'VIP,Dre,dre@x.io,undo-main-attendee,,',
      '',
    ].join('\n');
    const response = await plugin.fetch(request('/__plugin/admin/events/7/import/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-plugin-secret': 'shared-secret' },
      body: new URLSearchParams({ mode: 'new_and_update', csv }),
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(302);
    expect(batches).toHaveLength(1);
    const guests = new Map(batches[0].pages.map((p) => [p.name, p.lect]));
    expect(checkins(guests.get('Ada')!)).toHaveLength(1);
    expect((guests.get('Ada')!.checkin as Array<Record<string, string>>)[0]).toMatchObject({ status: 'checked-in', date: '2026-06-10T01:00:00Z', message: 'from kiosk' });
    expect(checkins(guests.get('Cleo')!)).toHaveLength(1); // session check-in counts
    expect(guests.get('Bob')!.checkin).toBeUndefined(); // never checked in
    expect(guests.get('Dre')!.checkin).toBeUndefined(); // undo-* is not a check-in
  });
});

describe('per-list import preview', () => {
  type ImportTestGuest = {
    id: number;
    page_type: string;
    page_id: number;
    name: string;
    lect: Record<string, unknown>;
  };

  // Existing guest in list 8: Ada (ada@x.io) with no phone.
  const existingGuests: ImportTestGuest[] = [
    { id: 100, page_type: 'guest', page_id: 8, name: 'Ada', lect: { name: { en: 'Ada' }, email: 'ada@x.io', status: 'invited' } },
  ];
  type ImportSink = {
    batches?: Array<{ pages: Array<Record<string, unknown>> }>;
    creates?: unknown[];
    failNextBatch?: boolean;
    updates?: Array<{ id: number; body: unknown }>;
  };

  const listFetch = (sink?: ImportSink, guests = existingGuests) =>
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/8') {
        return Response.json({ page: { id: 8, page_type: 'mail_list', name: 'VIP', lect: { _pointers: { event: '7' } } } });
      }
      if (url.pathname === '/__cms/pages/7') return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch', lect: {} } });
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'guest') return Response.json({ pages: guests, total: guests.length });
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'edm') return Response.json({ pages: [], total: 0 });
      if (url.pathname === '/__cms/pages/batch' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { pages: Array<Record<string, unknown>> };
        sink?.batches?.push(body);
        if (sink?.failNextBatch) {
          sink.failNextBatch = false;
          return Response.json({ error: 'error' }, { status: 503 });
        }
        return Response.json({ created: body.pages.map((page, index) => ({ id: 300 + index, ...page })), errors: [] });
      }
      if (url.pathname === '/__cms/pages' && init?.method === 'POST') {
        sink?.creates?.push(JSON.parse(String(init.body)));
        return Response.json({ page: { id: 200 } });
      }
      const updateMatch = url.pathname.match(/^\/__cms\/pages\/(\d+)$/);
      if (updateMatch && init?.method === 'PUT') {
        sink?.updates?.push({ id: Number(updateMatch[1]), body: JSON.parse(String(init.body)) });
        return Response.json({ page: { id: Number(updateMatch[1]) } });
      }
      return new Response('not found', { status: 404 });
    });

  const importCsv = (path: string, csv: string) => {
    const form = new FormData();
    form.set('file', new File([csv], 'g.csv', { type: 'text/csv' }));
    return plugin.fetch(request(path, {
      method: 'POST',
      headers: { 'x-plugin-secret': 'shared-secret' },
      body: form,
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));
  };

  it('classifies rows as new vs existing (with a diff) without writing', async () => {
    const sink = { creates: [] as unknown[], updates: [] as Array<{ id: number; body: unknown }> };
    vi.stubGlobal('fetch', listFetch(sink));

    // Ada already exists (gets phone added); Bob is new.
    const csv = 'name,email,phone\nAda,ada@x.io,555-1234\nBob,bob@x.io,555-9999\n';
    const response = await importCsv('/__plugin/admin/rsvp/8/import', csv);

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Preview import');
    expect(html).toContain('1 new');
    expect(html).toContain('1 to update');
    expect(html).toContain('555-1234'); // the value being added to Ada
    expect(sink.creates).toHaveLength(0); // preview is read-only
    expect(sink.updates).toHaveLength(0);
  });

  // The confirm step carries the raw CSV (not an expanded payload) and re-derives
  // the plan server-side against the list's current guests.
  const confirmCsv = 'name,email,phone\nAda,ada@x.io,555-1234\nBob,bob@x.io,555-9999\n';
  const confirm = (mode: string, sink: ImportSink) => {
    vi.stubGlobal('fetch', listFetch(sink));
    return plugin.fetch(request('/__plugin/admin/rsvp/8/import/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-plugin-secret': 'shared-secret' },
      body: new URLSearchParams({ mode, csv: confirmCsv }),
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));
  };

  it('re-importing a file with duplicate emails shows no updates (idempotent)', async () => {
    // Two existing guests share an email (one guest per CSV row was created on
    // the first import). Re-importing must match each to its own twin, not both
    // to the first — so nothing shows as an update.
    const dupGuests = [
      { id: 100, page_type: 'guest', page_id: 8, name: 'Ada', lect: { name: { en: 'Ada' }, email: 'dup@x.io', phone: '111' } },
      { id: 101, page_type: 'guest', page_id: 8, name: 'Ada Two', lect: { name: { en: 'Ada Two' }, email: 'dup@x.io', phone: '222' } },
    ];
    vi.stubGlobal('fetch', listFetch(undefined, dupGuests));
    const csv = 'name,email,phone\nAda,dup@x.io,111\nAda Two,dup@x.io,222\n';
    const response = await importCsv('/__plugin/admin/rsvp/8/import', csv);

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('0 new');
    expect(html).toContain('0 to update');
  });

  it('on confirm with the default mode, creates new and updates existing', async () => {
    const sink = { creates: [] as Array<Record<string, unknown>>, updates: [] as Array<{ id: number; body: unknown }> };
    const response = await confirm('new_and_update', sink);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/plugins/events/rsvp/8');
    expect(sink.creates).toHaveLength(1);
    expect(sink.creates[0]).toMatchObject({ page_type: 'guest', page_id: 8, name: 'Bob' }); // new
    // Ada (id 100) matched by email → her missing phone is added.
    expect(sink.updates).toEqual([{ id: 100, body: { lect: { phone: '555-1234' } } }]);
  });

  it('batches multiple new guests on confirm', async () => {
    const sink = { batches: [] as Array<{ pages: Array<Record<string, unknown>> }>, creates: [] as unknown[], updates: [] as Array<{ id: number; body: unknown }> };
    vi.stubGlobal('fetch', listFetch(sink, []));
    const csv = [
      'name,email',
      'Bob,bob@x.io',
      'Cleo,cleo@x.io',
      'Dee,dee@x.io',
      'Eve,eve@x.io',
      'Finn,finn@x.io',
    ].join('\n');

    const response = await plugin.fetch(request('/__plugin/admin/rsvp/8/import/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-plugin-secret': 'shared-secret' },
      body: new URLSearchParams({ mode: 'new_and_update', csv }),
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(302);
    expect(sink.batches).toHaveLength(1);
    expect(sink.batches[0].pages.map((page) => page.name)).toEqual(['Bob', 'Cleo', 'Dee', 'Eve', 'Finn']);
    expect(sink.creates).toHaveLength(0);
  });

  it('splits a transiently failing import batch instead of failing the confirm', async () => {
    const sink = {
      batches: [] as Array<{ pages: Array<Record<string, unknown>> }>,
      creates: [] as Array<Record<string, unknown>>,
      failNextBatch: true,
      updates: [] as Array<{ id: number; body: unknown }>,
    };
    vi.stubGlobal('fetch', listFetch(sink, []));
    const csv = 'name,email\nBob,bob@x.io\nCleo,cleo@x.io\nDee,dee@x.io\n';

    const response = await plugin.fetch(request('/__plugin/admin/rsvp/8/import/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-plugin-secret': 'shared-secret' },
      body: new URLSearchParams({ mode: 'new_and_update', csv }),
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(302);
    expect(sink.batches.map((batch) => batch.pages.map((page) => page.name))).toEqual([
      ['Bob', 'Cleo', 'Dee'],
      ['Bob', 'Cleo'],
    ]);
    expect(sink.creates.map((page) => page.name)).toEqual(['Dee']);
  });

  it('mode new_only skips updates; update_only skips creates', async () => {
    const newOnly = { creates: [] as unknown[], updates: [] as Array<{ id: number; body: unknown }> };
    await confirm('new_only', newOnly);
    expect(newOnly.creates).toHaveLength(1); // Bob created
    expect(newOnly.updates).toHaveLength(0); // Ada untouched

    const updateOnly = { creates: [] as unknown[], updates: [] as Array<{ id: number; body: unknown }> };
    await confirm('update_only', updateOnly);
    expect(updateOnly.creates).toHaveLength(0); // Bob not created
    expect(updateOnly.updates).toHaveLength(1); // Ada updated
  });
});
