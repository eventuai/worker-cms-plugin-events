import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearTenantCache, tenantRef, type TenantConfig } from '@lionrockjs/worker-cms-plugin';
import { signPayload } from '../src/crypto';
import worker from '../src/index';

const plugin = worker as unknown as {
  fetch(request: Request, env: Record<string, unknown>, ctx?: ExecutionContext): Promise<Response>;
  queue(batch: MessageBatch<unknown>, env: Record<string, unknown>): Promise<void>;
};

const CMS1 = 'https://cms1.test';
const CMS2 = 'https://cms2.test';

function fakeKv(records: Record<string, TenantConfig>): KVNamespace {
  return {
    list: async ({ prefix = '' }: { prefix?: string } = {}) => ({
      keys: Object.keys(records).filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
      cursor: undefined,
    }),
    get: async (name: string) => records[name] ?? null,
  } as unknown as KVNamespace;
}

function twoTenantEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    TENANTS: fakeKv({
      [`tenant:${CMS1}`]: { secret: 'secret-one', signKey: 'sign-one' },
      [`tenant:${CMS2}`]: { secret: 'secret-two', signKey: 'sign-two' },
    }),
    VIEWS: { fetch: async () => new Response('{}') } as unknown as Fetcher,
    ...overrides,
  };
}

function request(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://events.test${path}`, { headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearTenantCache();
});

describe('multi-tenant admin routing', () => {
  it("binds the CMS client to the authenticated tenant's URL and secret", async () => {
    const seen: Array<{ origin: string; secret: string | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      seen.push({ origin: url.origin, secret: new Headers(init?.headers).get('x-plugin-secret') });
      return Response.json({ pages: [], total: 0 });
    }));

    const response = await plugin.fetch(
      request('/__plugin/admin/events?json', { 'x-cms-tenant': CMS2, 'x-plugin-secret': 'secret-two' }),
      twoTenantEnv(),
    );

    expect(response.status).toBe(200);
    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) {
      expect(call.origin).toBe(CMS2);
      expect(call.secret).toBe('secret-two');
    }
  });

  it("rejects one tenant's secret presented as another tenant without touching any CMS", async () => {
    const cmsFetch = vi.fn(async () => Response.json({ pages: [], total: 0 }));
    vi.stubGlobal('fetch', cmsFetch);

    const response = await plugin.fetch(
      request('/__plugin/admin/events?json', { 'x-cms-tenant': CMS1, 'x-plugin-secret': 'secret-two' }),
      twoTenantEnv(),
    );

    expect(response.status).toBe(403);
    expect(cmsFetch).not.toHaveBeenCalled();
  });

  it('fails closed when several tenants exist and no tenant header is sent', async () => {
    const response = await plugin.fetch(
      request('/__plugin/admin/events?json', { 'x-plugin-secret': 'secret-one' }),
      twoTenantEnv(),
    );
    expect(response.status).toBe(403);
  });
});

describe('multi-tenant /qr verification', () => {
  it("verifies a signature only under the referenced tenant's signKey", async () => {
    const env = twoTenantEnv({
      VIEWS: { fetch: async () => new Response('<svg>{{ label }}</svg>') } as unknown as Fetcher,
    });
    const data = 'https://checkin.test/checkin/3/9/abc';
    const sig = await signPayload('sign-two', data);
    const refTwo = await tenantRef(CMS2);
    const refOne = await tenantRef(CMS1);

    const ok = await plugin.fetch(request(`/qr?data=${encodeURIComponent(data)}&sig=${sig}&t=${refTwo}`), env);
    expect(ok.status).toBe(200);

    // Same token replayed against the other tenant's ref must fail.
    const crossTenant = await plugin.fetch(request(`/qr?data=${encodeURIComponent(data)}&sig=${sig}&t=${refOne}`), env);
    expect(crossTenant.status).toBe(403);

    const unknownRef = await plugin.fetch(request(`/qr?data=${encodeURIComponent(data)}&sig=${sig}&t=ffffffffffffffff`), env);
    expect(unknownRef.status).toBe(403);
  });

  it('signs via /sign with the tenant key and returns a t-scoped QR URL', async () => {
    const response = await plugin.fetch(
      request('/sign?data=hello', { 'x-cms-tenant': CMS1, 'x-plugin-secret': 'secret-one' }),
      twoTenantEnv(),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { sig: string; url: string };
    expect(body.sig).toBe(await signPayload('sign-one', 'hello'));
    expect(body.url).toContain(`t=${await tenantRef(CMS1)}`);
  });
});

describe('multi-tenant email queue', () => {
  it('delivers each message with its own tenant vars and drops unknown tenants', async () => {
    const sends: Array<{ from?: string; to?: string }> = [];
    const env = {
      TENANTS: fakeKv({
        [`tenant:${CMS1}`]: { secret: 'secret-one', vars: { EMAIL_FROM: 'one@example.com' } },
        [`tenant:${CMS2}`]: { secret: 'secret-two', vars: { EMAIL_FROM: 'two@example.com' } },
      }),
      EMAIL: { send: async (message: { from?: string; to?: string }) => { sends.push(message); } },
      EMAIL_FROM: 'global@example.com',
      VIEWS: { fetch: async () => new Response('{}') } as unknown as Fetcher,
    };

    const message = (body: Record<string, unknown>) => ({ body } as unknown as Message<unknown>);
    await plugin.queue({
      messages: [
        message({ to: 'a@example.com', subject: 's', html: '<p>x</p>', text: 'x', edmId: 1, tenantId: CMS1 }),
        message({ to: 'b@example.com', subject: 's', html: '<p>x</p>', text: 'x', edmId: 1, tenantId: CMS2 }),
        message({ to: 'c@example.com', subject: 's', html: '<p>x</p>', text: 'x', edmId: 1, tenantId: 'https://gone.test' }),
      ],
    } as unknown as MessageBatch<unknown>, env);

    expect(sends.map((send) => [send.to, send.from])).toEqual([
      ['a@example.com', 'one@example.com'],
      ['b@example.com', 'two@example.com'],
    ]);
  });
});
