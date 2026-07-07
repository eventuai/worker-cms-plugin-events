// ============================================================
// Ingested submissions — response apply (create hook) and the
// registration review admin (convert / discard / pull).
//
// Drives the plugin Worker directly with a fetch stub standing in for the
// host Plugin API ({CMS_URL}/__cms/*), the same pattern as index.test.ts.
// ============================================================

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { renderView } from '../src/templates/liquid';

interface PluginEnv {
  CMS_URL?: string;
  PLUGIN_SECRET?: string;
  VIEWS: Fetcher;
}

const plugin = worker as {
  fetch(request: Request, env: PluginEnv, ctx?: ExecutionContext): Promise<Response>;
};

function views(): Fetcher {
  return {
    async fetch(input: RequestInfo | URL): Promise<Response> {
      const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
      try {
        return new Response(await readFile(fileURLToPath(new URL(`../views${url.pathname}`, import.meta.url).href), 'utf8'));
      } catch {
        return new Response('not found', { status: 404 });
      }
    },
  } as Fetcher;
}

async function renderedText(response: Response): Promise<string> {
  if (response.headers.get('x-cms-client-view') !== '1') return response.text();
  const viewPath = response.headers.get('x-cms-view-path');
  if (!viewPath) throw new Error('Missing x-cms-view-path');
  const data = await response.clone().json() as Record<string, unknown>;
  return renderView(views(), viewPath, data);
}

function env(): PluginEnv {
  return { VIEWS: views(), CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret' };
}

function request(path: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set('x-plugin-secret', 'shared-secret');
  headers.set('x-cms-user', JSON.stringify({ id: '42', email: 'admin@example.com', name: 'admin', role: 'admin', permissions: [] }));
  return new Request(`https://events.test${path}`, { ...init, headers });
}

interface FakePage {
  id: number;
  uuid?: string;
  page_type: string;
  name?: string;
  slug?: string;
  page_id?: number | null;
  created_at?: string;
  lect?: Record<string, unknown>;
}

interface RecordedCall {
  method: string;
  path: string;
  search: Record<string, string>;
  body?: Record<string, unknown>;
}

/**
 * In-memory Plugin API: GET /pages/:id, GET /pages (page_type / page_id /
 * pointer filters), POST /pages, PUT /pages/:id (recorded, not merged),
 * DELETE /pages/:id, POST /ingest/submissions. Records every call.
 */
function stubCms(pages: FakePage[], ingest = { scanned: 0, created: 0, more: false }): RecordedCall[] {
  const calls: RecordedCall[] = [];
  let nextId = 9000;
  const rows = pages.map((page) => ({
    uuid: `uuid-${page.id}`,
    name: `Page ${page.id}`,
    slug: `page-${page.id}`,
    page_id: null,
    created_at: '2026-07-07 00:00:00',
    lect: {},
    ...page,
  }));

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
    const method = init?.method ?? 'GET';
    const call: RecordedCall = {
      method,
      path: url.pathname,
      search: Object.fromEntries(url.searchParams.entries()),
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined,
    };
    calls.push(call);

    if (url.pathname === '/__cms/ingest/submissions' && method === 'POST') {
      return Response.json({ ok: true, ...ingest });
    }
    const idMatch = url.pathname.match(/^\/__cms\/pages\/(\d+)$/);
    if (idMatch) {
      const page = rows.find((row) => row.id === Number(idMatch[1]));
      if (!page) return Response.json({ error: 'not_found' }, { status: 404 });
      if (method === 'DELETE') return Response.json({ ok: true, id: page.id });
      return Response.json({ page });
    }
    if (url.pathname === '/__cms/pages' && method === 'GET') {
      let matched = rows.filter((row) => row.page_type === url.searchParams.get('page_type'));
      const parent = url.searchParams.get('page_id');
      if (parent) matched = matched.filter((row) => String(row.page_id) === parent);
      const pointerKey = url.searchParams.get('pointer_key');
      if (pointerKey) {
        const value = url.searchParams.get('pointer_value');
        matched = matched.filter((row) => {
          const pointers = (row.lect as { _pointers?: Record<string, string> })._pointers ?? {};
          return pointers[pointerKey] === value;
        });
      }
      return Response.json({ pages: matched, total: matched.length });
    }
    if (url.pathname === '/__cms/pages' && method === 'POST') {
      nextId += 1;
      return Response.json({ page: { id: nextId, uuid: `uuid-${nextId}`, ...(call.body ?? {}) } });
    }
    return new Response('not found', { status: 404 });
  }));

  return calls;
}

function hookRequest(page: { id: number; page_type: string }): Request {
  return request('/__plugin/hooks/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'create', page }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('rsvp_response create hook', () => {
  const responsePage: FakePage = {
    id: 501,
    uuid: 'sub-uuid-1',
    page_type: 'rsvp_response',
    page_id: 9,
    lect: {
      status: 'declined',
      plus_guests: '2',
      message: 'sorry!',
      submitted_at: '2026-07-07T10:00:00.000Z',
    },
  };

  it('applies the response to the guest and stamps the response page', async () => {
    const calls = stubCms([
      responsePage,
      { id: 9, page_type: 'guest', lect: { status: 'invited', response: [{}] } },
    ]);

    const response = await plugin.fetch(hookRequest({ id: 501, page_type: 'rsvp_response' }), env());
    expect(response.status).toBe(200);

    const guestPut = calls.find((call) => call.method === 'PUT' && call.path === '/__cms/pages/9');
    expect(guestPut?.body).toMatchObject({
      lect: {
        status: 'declined',
        plus_guests: '2',
        response: [{
          status: 'declined',
          date: '2026-07-07T10:00:00.000Z',
          message: 'sorry!',
          _ref: 'sub-uuid-1',
        }],
      },
    });

    const stamp = calls.find((call) => call.method === 'PUT' && call.path === '/__cms/pages/501');
    expect((stamp?.body as { lect?: Record<string, unknown> })?.lect).toMatchObject({ applied_guest_id: '9' });
    expect((stamp?.body as { lect?: { applied_at?: string } })?.lect?.applied_at).toBeTruthy();
  });

  it('is idempotent: an already-logged _ref updates nothing on the guest', async () => {
    const calls = stubCms([
      responsePage,
      {
        id: 9,
        page_type: 'guest',
        lect: { status: 'declined', response: [{ status: 'declined', date: '2026-07-07', _ref: 'sub-uuid-1' }] },
      },
    ]);

    await plugin.fetch(hookRequest({ id: 501, page_type: 'rsvp_response' }), env());
    expect(calls.find((call) => call.method === 'PUT' && call.path === '/__cms/pages/9')).toBeUndefined();
    expect(calls.find((call) => call.method === 'PUT' && call.path === '/__cms/pages/501')).toBeTruthy();
  });

  it('skips entirely when the response page is already applied', async () => {
    const calls = stubCms([
      { ...responsePage, lect: { ...responsePage.lect, applied_at: '2026-07-07T11:00:00.000Z' } },
      { id: 9, page_type: 'guest', lect: {} },
    ]);

    await plugin.fetch(hookRequest({ id: 501, page_type: 'rsvp_response' }), env());
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
  });

  it('stamps a note instead of failing when the guest is gone', async () => {
    const calls = stubCms([responsePage]); // guest 9 missing

    const response = await plugin.fetch(hookRequest({ id: 501, page_type: 'rsvp_response' }), env());
    expect(response.status).toBe(200);
    const stamp = calls.find((call) => call.method === 'PUT' && call.path === '/__cms/pages/501');
    expect((stamp?.body as { lect?: Record<string, unknown> })?.lect).toMatchObject({
      applied_guest_id: '',
      apply_note: 'guest not found',
    });
  });
});

describe('registration review admin', () => {
  const event: FakePage = { id: 7, page_type: 'event', name: 'Launch' };
  const registration: FakePage = {
    id: 601,
    uuid: 'reg-uuid-1',
    page_type: 'rsvp_registration',
    page_id: 7,
    name: 'Grace Hopper',
    lect: {
      name: 'Grace Hopper',
      first_name: 'Grace',
      last_name: 'Hopper',
      email: 'grace@example.com',
      salutation: 'dr',
      organization: 'Navy',
      job_title: 'Rear Admiral',
      plus_guests: '1',
      language: 'en',
      submitted_at: '2026-07-07T09:00:00.000Z',
      answers: { 'rsvp-public-source': 'Friend' },
    },
  };
  const adhocList: FakePage = {
    id: 80,
    page_type: 'mail_list',
    name: 'Adhoc',
    lect: { _type: 'mail_list', name: { en: 'Adhoc' }, _pointers: { event: '7' } },
  };

  it('lists pending registrations with convert/discard actions', async () => {
    stubCms([event, registration]);

    const response = await plugin.fetch(request('/__plugin/admin/events/7/registrations'), env());
    expect(response.status).toBe(200);
    const html = await renderedText(response);
    expect(html).toContain('Grace Hopper');
    expect(html).toContain('grace@example.com');
    expect(html).toContain('/registrations/601/convert');
    expect(html).toContain('/registrations/601/discard');
  });

  it('converts a registration into a guest on the Adhoc list', async () => {
    const calls = stubCms([event, registration, adhocList]);

    const response = await plugin.fetch(request('/__plugin/admin/events/7/registrations/601/convert', { method: 'POST' }), env());
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/admin/plugins/events/events/7/registrations');

    const create = calls.find((call) => call.method === 'POST' && call.path === '/__cms/pages');
    expect(create?.body).toMatchObject({
      page_type: 'guest',
      page_id: 80,
      name: 'Grace Hopper',
      lect: {
        email: 'grace@example.com',
        organization: 'Navy',
        job_title: 'Rear Admiral',
        plus_guests: '1',
        status: 'confirmed',
        type: 'adhoc',
        registration_ref: 'reg-uuid-1',
        _pointers: { event: '7', mail_list: '80' },
        response: [{ status: 'confirmed', date: '2026-07-07T09:00:00.000Z', message: 'public registration', _ref: 'reg-uuid-1' }],
        public_registration: { 'rsvp-public-source': 'Friend' },
      },
    });

    const stamp = calls.find((call) => call.method === 'PUT' && call.path === '/__cms/pages/601');
    expect((stamp?.body as { lect?: Record<string, unknown> })?.lect).toMatchObject({ converted_guest_id: '9001' });
  });

  it('links to an existing guest by email instead of creating a duplicate', async () => {
    const calls = stubCms([
      event,
      registration,
      adhocList,
      {
        id: 90,
        page_type: 'guest',
        name: 'Grace Hopper',
        page_id: 80,
        lect: { email: 'GRACE@example.com', _pointers: { event: '7', mail_list: '80' } },
      },
    ]);

    const response = await plugin.fetch(request('/__plugin/admin/events/7/registrations/601/convert', { method: 'POST' }), env());
    expect(response.status).toBe(302);
    expect(calls.find((call) => call.method === 'POST' && call.path === '/__cms/pages')).toBeUndefined();
    const stamp = calls.find((call) => call.method === 'PUT' && call.path === '/__cms/pages/601');
    expect((stamp?.body as { lect?: Record<string, unknown> })?.lect).toMatchObject({ converted_guest_id: '90' });
  });

  it('discards a registration by soft-deleting the review copy', async () => {
    const calls = stubCms([event, registration]);

    const response = await plugin.fetch(request('/__plugin/admin/events/7/registrations/601/discard', { method: 'POST' }), env());
    expect(response.status).toBe(302);
    expect(calls.find((call) => call.method === 'DELETE' && call.path === '/__cms/pages/601')).toBeTruthy();
  });

  it('404s a convert for a registration of a different event', async () => {
    stubCms([event, { ...registration, page_id: 8 }]);

    const response = await plugin.fetch(request('/__plugin/admin/events/7/registrations/601/convert', { method: 'POST' }), env());
    expect(response.status).toBe(404);
  });

  it('pull triggers the host ingest and sweeps unapplied responses', async () => {
    const calls = stubCms([
      event,
      { id: 501, uuid: 'sub-uuid-2', page_type: 'rsvp_response', page_id: 9, lect: { status: 'confirmed' } },
      { id: 9, page_type: 'guest', lect: { response: [{}] } },
    ], { scanned: 3, created: 2, more: false });

    const response = await plugin.fetch(request('/__plugin/admin/events/7/registrations/pull', { method: 'POST' }), env());
    expect(response.status).toBe(302);
    expect(decodeURIComponent(response.headers.get('location') ?? '')).toContain('Pulled 2 new submissions');

    expect(calls.find((call) => call.method === 'POST' && call.path === '/__cms/ingest/submissions')).toBeTruthy();
    // The sweep applied the unapplied response it found.
    expect(calls.find((call) => call.method === 'PUT' && call.path === '/__cms/pages/9')).toBeTruthy();
    expect(calls.find((call) => call.method === 'PUT' && call.path === '/__cms/pages/501')).toBeTruthy();
  });
});
