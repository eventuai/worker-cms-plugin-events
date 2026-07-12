// ============================================================
// Event archive — preview classification and the resumable apply
// (merge guests into contacts, trash submissions, mark archived).
//
// Drives the plugin Worker directly with a STATEFUL fetch stub standing in
// for the host Plugin API: PUT shallow-merges lect and DELETE removes rows,
// so a second apply run sees the stamps the first one wrote.
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
  start?: string | null;
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
 * Stateful in-memory Plugin API. GET /pages honours page_type / page_id /
 * pointer filters (limit/offset ignored — collections stay under one page);
 * POST /pages appends, PUT /pages/:id shallow-merges lect, DELETE (single and
 * /pages/batch) removes rows. Records every call.
 */
function stubCms(pages: FakePage[]): RecordedCall[] {
  const calls: RecordedCall[] = [];
  let nextId = 9000;
  let rows = pages.map((page) => ({
    uuid: `uuid-${page.id}`,
    name: `Page ${page.id}`,
    slug: `page-${page.id}`,
    page_id: null as number | null,
    start: null as string | null,
    created_at: '2026-07-07 00:00:00',
    lect: {} as Record<string, unknown>,
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

    if (url.pathname === '/__cms/credits/charge' && method === 'POST') {
      return Response.json({ ok: true, charged: 0 });
    }
    if (url.pathname === '/__cms/pages/batch' && method === 'DELETE') {
      const ids = new Set(((call.body?.ids ?? []) as number[]).map(Number));
      rows = rows.filter((row) => !ids.has(row.id));
      return Response.json({ removed: ids.size });
    }
    const idMatch = url.pathname.match(/^\/__cms\/pages\/(\d+)$/);
    if (idMatch) {
      const page = rows.find((row) => row.id === Number(idMatch[1]));
      if (!page) return Response.json({ error: 'not_found' }, { status: 404 });
      if (method === 'DELETE') {
        rows = rows.filter((row) => row.id !== page.id);
        return Response.json({ ok: true, id: page.id });
      }
      if (method === 'PUT') {
        page.lect = { ...page.lect, ...((call.body?.lect ?? {}) as Record<string, unknown>) };
        if (typeof call.body?.name === 'string') page.name = call.body.name;
        return Response.json({ page });
      }
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
      const created = {
        uuid: `uuid-${nextId}`,
        name: String(call.body?.name ?? `Page ${nextId}`),
        slug: `page-${nextId}`,
        page_id: (call.body?.page_id as number | null) ?? null,
        start: null,
        created_at: '2026-07-07 00:00:00',
        ...call.body,
        lect: (call.body?.lect ?? {}) as Record<string, unknown>,
        id: nextId,
      } as typeof rows[number];
      rows.push(created);
      return Response.json({ page: created });
    }
    return new Response('not found', { status: 404 });
  }));

  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Event with two lists, five guests covering every category, and submissions. */
function fixture(): FakePage[] {
  return [
    { id: 100, page_type: 'event', name: 'Gala', start: '2026-05-01T18:00', lect: {} },
    { id: 200, page_type: 'mail_list', name: 'VIP', lect: { _pointers: { event: '100' } } },
    { id: 201, page_type: 'mail_list', name: 'Staff', lect: { _pointers: { event: '100' } } },

    // Contacts: 300 linked from guest 1; 301 shares guest 2's email; 302 shares guest 3's name.
    { id: 300, page_type: 'contact', name: 'Ada Lovelace', lect: { first_name: { en: 'Ada' }, last_name: { en: 'Lovelace' }, email: [{ type: 'other', email: 'ada@x.com' }] } },
    { id: 301, page_type: 'contact', name: 'Grace Hopper', lect: { first_name: { en: 'Grace' }, last_name: { en: 'Hopper' }, email: [{ type: 'other', email: 'grace@x.com' }] } },
    { id: 302, page_type: 'contact', name: 'Alan Turing', lect: { first_name: { en: 'Alan' }, last_name: { en: 'Turing' } } },

    // Guest 1 — linked via the contact pointer (duplicated contact).
    {
      id: 1, page_type: 'guest', name: 'Ada Lovelace',
      lect: {
        name: { en: 'Ada' }, last_name: { en: 'Lovelace' }, email: 'ada@x.com', status: 'confirmed', plus_guests: '1',
        _pointers: { mail_list: '200', event: '100', contact: '300' },
        checkin: [{ status: 'checked-in', date: '2026-05-01' }],
        response: [{ status: 'confirmed', date: '2026-04-01' }],
      },
    },
    // Guest 2 — no pointer, email matches contact 301 (likely duplicate).
    { id: 2, page_type: 'guest', name: 'Grace Hopper', lect: { name: { en: 'Grace' }, last_name: { en: 'Hopper' }, email: 'grace@x.com', status: 'declined', _pointers: { mail_list: '200', event: '100' } } },
    // Guest 3 — no email, exact name matches contact 302 (likely duplicate).
    { id: 3, page_type: 'guest', name: 'Alan Turing', lect: { name: { en: 'Alan' }, last_name: { en: 'Turing' }, status: 'invited', _pointers: { mail_list: '200', event: '100' } } },
    // Guest 4 — nobody in the contact database (new contact).
    { id: 4, page_type: 'guest', name: 'New Person', lect: { name: { en: 'New' }, last_name: { en: 'Person' }, email: 'new@x.com', organization: 'Acme', job_title: 'CTO', status: 'confirmed', _pointers: { mail_list: '200', event: '100' } } },
    // Guest 5 — same email as guest 2, on the other list (duplicated guest).
    { id: 5, page_type: 'guest', name: 'Grace Hopper', lect: { name: { en: 'Grace' }, last_name: { en: 'Hopper' }, email: 'grace@x.com', status: 'confirmed', _pointers: { mail_list: '201', event: '100' } } },

    // Ingested submissions: 501/601 belong to event 100; 502/602 to another event.
    { id: 501, page_type: 'rsvp_response', page_id: 1, lect: { event_id: '100', applied_at: '2026-05-01' } },
    { id: 502, page_type: 'rsvp_response', page_id: 77, lect: { event_id: '999' } },
    { id: 601, page_type: 'rsvp_registration', page_id: 100, lect: { event_id: '100', email: 'reg@x.com' } },
    { id: 602, page_type: 'rsvp_registration', page_id: 999, lect: { event_id: '999' } },
  ];
}

function lectOf(call: RecordedCall | undefined): Record<string, unknown> {
  return (call?.body?.lect ?? {}) as Record<string, unknown>;
}

describe('archive preview', () => {
  it('classifies guests into duplicated / linked / likely / new', async () => {
    stubCms(fixture());
    const response = await plugin.fetch(request('/__plugin/admin/events/100/archive'), env());
    expect(response.status).toBe(200);
    const text = await renderedText(response);

    expect(text).toContain('Duplicated guests');
    expect(text).toContain('Duplicated contacts (contact ID matched)');
    expect(text).toContain('Likely duplicated contacts');
    expect(text).toContain('New contacts');

    // Guest 5 duplicates guest 2 (same email, other list).
    expect(text).toContain('same person as Grace Hopper (VIP)');
    // Guest 2 matched contact 301 by email; guest 3 matched contact 302 by name.
    expect(text).toContain('contact #301 shares this email');
    expect(text).toContain('contact #302 has the same name');
    // Guest 4 has no match.
    expect(text).toContain('a new contact will be created');
    // Guest 1 is linked to contact 300.
    expect(text).toContain('contact #300');
  });

  it('makes no writes', async () => {
    const calls = stubCms(fixture());
    await plugin.fetch(request('/__plugin/admin/events/100/archive'), env());
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });
});

describe('archive apply', () => {
  it('merges guests into contacts, trashes submissions and archives the event', async () => {
    const calls = stubCms(fixture());
    const response = await plugin.fetch(request('/__plugin/admin/events/100/archive', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'action=apply',
    }), env());

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/admin/plugins/events/events?archived=1');

    // One new contact created — for guest 4, with the history entry inline.
    const creates = calls.filter((call) => call.method === 'POST' && call.path === '/__cms/pages');
    expect(creates).toHaveLength(1);
    expect(creates[0].body).toMatchObject({ page_type: 'contact', name: 'New Person' });
    const createdLect = lectOf(creates[0]);
    expect(createdLect.source).toBe('events-archive');
    expect(createdLect.email).toEqual([{ type: 'other', email: 'new@x.com' }]);
    expect(createdLect.position).toEqual([{ type: 'work', organization_name: { en: 'Acme' }, title: { en: 'CTO' } }]);
    expect(createdLect.event_history).toMatchObject([{ event_name: 'Gala', date: '2026-05-01', rsvp: 'confirmed', _ref: 'uuid-4' }]);

    // Linked contact 300 gets guest 1's activity (status, check-in, list name).
    const contact300 = calls.filter((call) => call.method === 'PUT' && call.path === '/__cms/pages/300');
    expect(contact300).toHaveLength(1);
    expect(lectOf(contact300[0]).event_history).toMatchObject([{
      event_name: 'Gala', date: '2026-05-01', rsvp: 'confirmed', group_rsvp: '1',
      remark: 'List: VIP · checked in · 1 RSVP response(s)', _ref: 'uuid-1',
    }]);

    // Likely-duplicate contact 301 collects BOTH copies of Grace (guests 2 and 5).
    const contact301 = calls.filter((call) => call.method === 'PUT' && call.path === '/__cms/pages/301');
    expect(contact301).toHaveLength(2);
    expect(lectOf(contact301[1]).event_history).toMatchObject([
      { rsvp: 'declined', _ref: 'uuid-2' },
      { rsvp: 'confirmed', _ref: 'uuid-5' },
    ]);

    // Name-matched contact 302 gets guest 3's entry.
    const contact302 = calls.filter((call) => call.method === 'PUT' && call.path === '/__cms/pages/302');
    expect(lectOf(contact302[0]).event_history).toMatchObject([{ _ref: 'uuid-3', rsvp: 'invited' }]);

    // Every guest is stamped and pointed at its contact.
    for (const [guestId, contactId] of [[1, '300'], [2, '301'], [3, '302'], [5, '301']] as Array<[number, string]>) {
      const stamp = calls.find((call) => call.method === 'PUT' && call.path === `/__cms/pages/${guestId}`);
      const lect = lectOf(stamp);
      expect(lect.contact_merged_at).toBeTruthy();
      expect((lect._pointers as Record<string, string>).contact).toBe(contactId);
      // Existing pointers survive the stamp.
      expect((lect._pointers as Record<string, string>).mail_list).toBeTruthy();
    }
    const guest4Stamp = calls.find((call) => call.method === 'PUT' && call.path === '/__cms/pages/4');
    expect((lectOf(guest4Stamp)._pointers as Record<string, string>).contact).toBe('9001');

    // Only THIS event's submissions are trashed.
    const batchDeletes = calls.filter((call) => call.method === 'DELETE' && call.path === '/__cms/pages/batch');
    const deletedIds = batchDeletes.flatMap((call) => (call.body?.ids ?? []) as number[]);
    expect(deletedIds.sort()).toEqual([501, 601]);

    // The event ends archived, with the in-progress flag cleared.
    const eventPuts = calls.filter((call) => call.method === 'PUT' && call.path === '/__cms/pages/100');
    const finalLect = lectOf(eventPuts[eventPuts.length - 1]);
    expect(finalLect.archived).toBe('yes');
    expect(finalLect.archiving).toBe('');
  });

  it('is idempotent: a second apply adds no contacts, history or stamps', async () => {
    const calls = stubCms(fixture());
    await plugin.fetch(request('/__plugin/admin/events/100/archive', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'action=apply',
    }), env());
    const alreadyMade = calls.length;

    const response = await plugin.fetch(request('/__plugin/admin/events/100/archive', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'action=apply',
    }), env());
    expect(response.status).toBe(302);

    const fresh = calls.slice(alreadyMade);
    expect(fresh.filter((call) => call.method === 'POST' && call.path === '/__cms/pages')).toEqual([]);
    expect(fresh.filter((call) => call.method === 'PUT' && /\/pages\/(1|2|3|4|5|30\d)$/.test(call.path))).toEqual([]);
    expect(fresh.filter((call) => call.method === 'DELETE')).toEqual([]);
  });

  it('archive only (no merge) just hides the event', async () => {
    const calls = stubCms(fixture());
    const response = await plugin.fetch(request('/__plugin/admin/events/100/archive', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'action=skip',
    }), env());
    expect(response.status).toBe(302);
    const eventPut = calls.find((call) => call.method === 'PUT' && call.path === '/__cms/pages/100');
    expect(lectOf(eventPut)).toMatchObject({ archived: 'yes' });
    expect(calls.filter((call) => call.method === 'POST' && call.path === '/__cms/pages')).toEqual([]);
    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([]);
  });

  it('stop clears the in-progress archiving flag and keeps progress', async () => {
    const pages = fixture();
    pages[0].lect = { archiving: 'yes', archiving_at: '2026-07-12T00:00:00.000Z' };
    const calls = stubCms(pages);
    const response = await plugin.fetch(request('/__plugin/admin/events/100/archive/stop', { method: 'POST' }), env());

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/admin/plugins/events/events/100');
    const eventPut = calls.find((call) => call.method === 'PUT' && call.path === '/__cms/pages/100');
    expect(lectOf(eventPut)).toMatchObject({ archiving: '', archiving_at: '' });
    expect(lectOf(eventPut).archived).toBeUndefined();
    // Stop only clears the flag — nothing is merged or trashed.
    expect(calls.filter((call) => call.method === 'POST' && call.path === '/__cms/pages')).toEqual([]);
    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([]);
  });

  it('restore clears the archived flag', async () => {
    const pages = fixture();
    pages[0].lect = { archived: 'yes' };
    const calls = stubCms(pages);
    const response = await plugin.fetch(request('/__plugin/admin/events/100/archive', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'action=unarchive',
    }), env());
    expect(response.status).toBe(302);
    const eventPut = calls.find((call) => call.method === 'PUT' && call.path === '/__cms/pages/100');
    expect(lectOf(eventPut)).toMatchObject({ archived: '', archiving: '' });
  });
});
