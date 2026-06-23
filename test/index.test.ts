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
        // Summaries are computed by the plugin now — the generic CMS API has no
        // include=guest_summary mode.
        expect(url.searchParams.get('include')).toBeNull();
        return Response.json({
          pages: [{ id: 34, page_type: 'mail_list', name: 'VIP', page_id: 12, lect: {} }],
          total: 1,
        });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'guest') {
        expect(url.searchParams.get('page_id')).toBe('34');
        // 4 groups → 6 people; one confirmed+checked-in (2 people), one invited,
        // one on hold, one unknown status (counted "to be invited").
        return Response.json({
          pages: [
            { id: 1, page_type: 'guest', name: 'Ada', lect: { status: 'confirmed', plus_guests: '1', checkin: [{ status: 'checked-in' }] } },
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

  it('exports every guest across an event as one CSV', async () => {
    const cmsFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/7') {
        return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch', lect: {} } });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'mail_list') {
        return Response.json({ pages: [{ id: 8, name: 'VIP' }, { id: 9, name: 'General' }], total: 2 });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'guest') {
        const listId = url.searchParams.get('page_id');
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
        return Response.json({ page: { id: 8, page_type: 'mail_list', page_id: 7, name: 'VIP', lect: {} } });
      }
      if (url.pathname === '/__cms/pages/7') {
        return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch', lect: {} } });
      }
      if (url.pathname === '/__cms/pages/99') {
        // A list belonging to a different event (page_id 70).
        return Response.json({ page: { id: 99, page_type: 'mail_list', page_id: 70, name: 'Other', lect: {} } });
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

describe('event tooling (reorder, import, all-guests, QR)', () => {
  it('persists guest-list order by writing each list weight', async () => {
    const updates: Array<{ id: string; body: unknown }> = [];
    const cmsFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (init?.method === 'PUT') {
        updates.push({ id: url.pathname.split('/').pop()!, body: JSON.parse(String(init.body)) });
        return Response.json({ page: {} });
      }
      if (url.pathname === '/__cms/pages/8') return Response.json({ page: { id: 8, page_type: 'mail_list', page_id: 7, name: 'VIP', lect: {} } });
      if (url.pathname === '/__cms/pages/9') return Response.json({ page: { id: 9, page_type: 'mail_list', page_id: 7, name: 'General', lect: {} } });
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
    const creates: Array<Record<string, unknown>> = [];
    const batches: unknown[] = [];
    const cmsFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/7') return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch', lect: {} } });
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'mail_list') {
        return Response.json({ pages: [{ id: 8, page_type: 'mail_list', page_id: 7, name: 'VIP', lect: {} }], total: 1 });
      }
      if (url.pathname === '/__cms/pages' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        creates.push(body);
        return Response.json({ page: { id: 99, name: body.name } });
      }
      if (url.pathname === '/__cms/pages/batch' && init?.method === 'POST') {
        batches.push(JSON.parse(String(init.body)));
        return Response.json({ created: [], errors: [] });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const csv = 'list,name,email\nVIP,Ada,ada@x.io\nGeneral,Grace,grace@x.io\n';
    const file = new File([csv], 'guests.csv', { type: 'text/csv' });
    const form = new FormData();
    form.set('file', file);
    const response = await plugin.fetch(request('/__plugin/admin/events/7/import', {
      method: 'POST',
      headers: { 'x-plugin-secret': 'shared-secret' },
      body: form,
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/plugins/events/events/7/all-guests');
    // "General" did not exist, so it was created; "VIP" already existed.
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({ page_type: 'mail_list', name: 'General', page_id: 7 });
    // Two batch calls, one per destination list.
    expect(batches).toHaveLength(2);
  });

  it('renders a flat all-guests view filtered by status', async () => {
    const cmsFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/__cms/pages/7') return Response.json({ page: { id: 7, page_type: 'event', name: 'Launch', lect: {} } });
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'mail_list') {
        return Response.json({ pages: [{ id: 8, name: 'VIP', weight: 0 }, { id: 9, name: 'General', weight: 1 }], total: 2 });
      }
      if (url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'guest') {
        const listId = url.searchParams.get('page_id');
        if (listId === '8') return Response.json({ pages: [{ id: 1, name: 'Ada', lect: { status: 'confirmed' } }], total: 1 });
        return Response.json({ pages: [{ id: 2, name: 'Grace', lect: { status: 'invited' } }], total: 1 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(request('/__plugin/admin/events/7/all-guests?status=confirmed', {
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), env({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' }));

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('All guests');
    expect(html).toContain('Ada');
    expect(html).not.toContain('Grace'); // filtered out
    expect(html).toContain('1 of 2 guests');
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
      if (url.pathname === '/__cms/pages/55') return Response.json({ page: { id: 55, page_type: 'guest', page_id: 8, name: 'Stale', lect: { contact_id: '200', status: 'invited', response: [{ status: 'invited' }] } } });
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
    expect(response.headers.get('location')).toBe('/admin/plugins/events/rsvp/8/guests/55');
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
      if (url.pathname === '/__cms/pages/55') return Response.json({ page: { id: 55, page_type: 'guest', page_id: 8, name: 'Ada', lect: {} } });
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
