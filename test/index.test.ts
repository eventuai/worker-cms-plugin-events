import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('requires the shared secret for admin routes and renders the RSVP placeholder when authorized', async () => {
    const testEnv = env({ PLUGIN_SECRET: 'shared-secret' });

    const forbidden = await plugin.fetch(request('/__plugin/admin/rsvp'), testEnv);
    expect(forbidden.status).toBe(403);

    const response = await plugin.fetch(request('/__plugin/admin/rsvp', {
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), testEnv);

    expect(response.status).toBe(200);
    expect(response.headers.get('x-cms-chrome')).toBe('1');
    expect(response.headers.get('x-cms-title')).toBe('RSVP');
    expect(await response.text()).toContain('Guest management, bulk add/remove');
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

  it('creates and checks in an adhoc guest through the CMS write-back API', async () => {
    let cmsRequest: RequestInit | undefined;
    const cmsFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      cmsRequest = init;
      return Response.json({ page: { id: 99 } });
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
    expect(response.headers.get('location')).toBe('/admin/plugins/events/events/7/all-guests');
    expect(cmsFetch).toHaveBeenCalledTimes(1);
    expect(cmsRequest?.method).toBe('POST');
    expect(new Headers(cmsRequest?.headers).get('x-plugin-id')).toBe('events');
    expect(JSON.parse(String(cmsRequest?.body))).toMatchObject({
      page_type: 'guest',
      name: 'Ada',
      page_id: 7,
      lect: {
        plus_guests: '2',
        status: 'confirmed',
        checkin: [{ status: 'checked-in' }],
      },
    });
  });
});
