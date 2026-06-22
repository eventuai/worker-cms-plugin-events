import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signPayload } from '../src/crypto';
import worker from '../src/index';

interface PluginEnv {
  CMS_URL?: string;
  PLUGIN_SECRET?: string;
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
  it('renders CMS event data through the Liquid view', async () => {
    const cmsFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      expect(url.pathname).toBe('/__cms/pages');
      expect(url.searchParams.get('page_type')).toBe('event');
      return Response.json({
        pages: [{ id: 12, name: 'Town & Country', lect: { start: '2026-10-12' } }],
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
    expect(html).toContain('2026-10-12');
    expect(cmsFetch).toHaveBeenCalledTimes(1);
  });

  it('shows every event guest list with its RSVP summary', async () => {
    const cmsFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/12') {
        return Response.json({ page: { id: 12, page_type: 'event', name: 'Town & Country', lect: {} } });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'mail_list') {
        expect(url.searchParams.get('page_id')).toBe('12');
        expect(url.searchParams.get('include')).toBe('guest_summary');
        return Response.json({
          pages: [{
            id: 34, page_type: 'mail_list', name: 'VIP', page_id: 12, lect: {},
            guest_summary: {
              guest_count: 4, guest_total: 6, onhold_count: 1, to_be_invited_count: 1,
              invited_count: 1, confirmed_count: 1, declined_count: 0, unconfirmed_count: 0,
              checked_in_count: 1, checked_in_total: 2,
            },
          }], total: 1,
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

    const response = await plugin.fetch(request('/__plugin/admin/rsvp/new', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-plugin-secret': 'shared-secret' },
      body: new URLSearchParams({ event_id: '7', name: 'VIP guests', allow_checkin: 'yes' }),
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/plugins/events/rsvp/8');
    expect(JSON.parse(String(createRequest?.body))).toMatchObject({
      page_type: 'mail_list', name: 'VIP guests', page_id: 7,
      lect: { _pointers: { event: '7' }, allow_checkin: 'yes' },
    });
  });

  it('deletes a guest list and returns to its event lists', async () => {
    const cmsFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/8' && init?.method === 'DELETE') return Response.json({ ok: true, id: 8 });
      if (url.pathname === '/__cms/pages/8') {
        return Response.json({ page: { id: 8, page_type: 'mail_list', page_id: 7, name: 'VIP', lect: {} } });
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
        return Response.json({ pages: [{ id: 222, page_type: 'mail_list', page_id: eventId, name: 'Adhoc', lect: {} }], total: 1 });
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
  it('creates an EDM under its event with localized email content', async () => {
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
      body: new URLSearchParams({
        event_id: '7', name: 'Launch invitation', sender: 'events@example.com', subject: 'You are invited',
        heading: 'Join us', body: '<p>Welcome</p>', rsvp_button: 'RSVP now',
      }),
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/plugins/events/edm/12');
    expect(JSON.parse(String(createRequest?.body))).toMatchObject({
      page_type: 'edm', page_id: 7, name: 'Launch invitation',
      lect: { sender: 'events@example.com', subject: { en: 'You are invited' }, _pointers: { event: '7' } },
    });
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

describe('public RSVP', () => {
  it('accepts a signed RSVP and records the response against the guest', async () => {
    let updateRequest: RequestInit | undefined;
    const cmsFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/7') return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch', lect: {} } });
      if (url.pathname === '/__cms/pages/8') return Response.json({ page: { id: 8, page_type: 'mail_list', page_id: 7, name: 'VIP', lect: {} } });
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
