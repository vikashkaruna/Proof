import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { TenantMembership } from '@/lib/tenant-selection';

const A = '10000000-0000-4000-8000-000000000001';
const B = '20000000-0000-4000-8000-000000000002';
const state = vi.hoisted(() => ({
  token: 'fixture-session' as string | null,
  user: { id: 'verified-user' } as { id: string } | null,
  authError: false,
  lookupError: false,
  throwLookup: false,
  rows: [] as TenantMembership[],
  filter: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock('@axiom/supabase', () => ({
  createSupabaseServerClient: async () => ({
    auth: {
      getSession: async () => ({
        data: { session: state.token ? { access_token: state.token } : null },
      }),
      getUser: async () => ({ data: { user: state.user }, error: state.authError }),
    },
    from: (table: string) => {
      expect(table).toBe('tenant_users');
      return {
        select: () => ({
          eq: async (key: string, value: string) => {
            state.filter(key, value);
            if (state.throwLookup) throw new Error('private database failure');
            return { data: state.rows, error: state.lookupError };
          },
        }),
      };
    },
  }),
}));
const { GET, POST } = await import('./[...path]/route');

async function call(cookie?: string, explicit?: string, path = 'v1/estates', method = 'GET') {
  const headers = new Headers();
  if (cookie !== undefined)
    headers.set('cookie', `axiom_active_tenant=${cookie}; private_cookie=hidden`);
  if (explicit !== undefined) headers.set('X-Tenant-Id', explicit);
  const request = new NextRequest(`http://localhost/api/bff/${path}`, { method, headers });
  return (method === 'POST' ? POST : GET)(request, {
    params: Promise.resolve({ path: path.split('/') }),
  });
}
function forwardedHeaders() {
  return state.fetch.mock.calls[0]?.[1].headers as Headers;
}

beforeEach(() => {
  vi.stubEnv('BFF_PUBLIC_URL', 'http://bff.invalid');
  vi.stubGlobal('fetch', state.fetch);
  state.fetch.mockReset().mockImplementation(async () => new Response('{}', { status: 200 }));
  state.filter.mockReset();
  state.token = 'fixture-session';
  state.user = { id: 'verified-user' };
  state.authError = false;
  state.lookupError = false;
  state.throwLookup = false;
  state.rows = [
    { tenant_id: B, tenants: { slug: 'new-customer' } },
    { tenant_id: A, tenants: [{ slug: 'first-customer' }] },
  ];
});

describe('browser BFF tenant resolution', () => {
  it.each(['new-customer', B])('routes a verified custom selection %s', async (selection) => {
    expect((await call(selection)).status).toBe(200);
    expect(forwardedHeaders().get('x-tenant-id')).toBe(B);
    expect(forwardedHeaders().get('authorization')).toBe('Bearer fixture-session');
    expect(forwardedHeaders().has('cookie')).toBe(false);
    expect(state.filter).toHaveBeenCalledWith('user_id', 'verified-user');
  });
  it('uses a deterministic real membership when no preference exists', async () => {
    expect((await call()).status).toBe(200);
    expect(forwardedHeaders().get('x-tenant-id')).toBe(A);
  });
  it.each(['foreign', 'meridian', '', '30000000-0000-4000-8000-000000000003'])(
    'refuses stale or foreign selection %s',
    async (selection) => {
      expect((await call(selection)).status).toBe(403);
      expect(state.fetch).not.toHaveBeenCalled();
    },
  );
  it('does not supply a tenant for a user without memberships', async () => {
    state.rows = [];
    expect((await call()).status).toBe(403);
    expect(state.fetch).not.toHaveBeenCalled();
  });
  it.each(['lookupError', 'throwLookup'] as const)(
    'fails closed on %s without leaking diagnostics',
    async (field) => {
      state[field] = true;
      const response = await call('new-customer');
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('private database failure');
      expect(state.fetch).not.toHaveBeenCalled();
    },
  );
  it.each(['no-session', 'no-user', 'auth-error'])('refuses %s', async (failure) => {
    if (failure === 'no-session') state.token = null;
    if (failure === 'no-user') state.user = null;
    if (failure === 'auth-error') state.authError = true;
    expect((await call('new-customer')).status).toBe(401);
    expect(state.fetch).not.toHaveBeenCalled();
  });
  it('forwards an explicit selection for independent BFF authorization', async () => {
    expect((await call('stale-cookie', B)).status).toBe(200);
    expect(forwardedHeaders().get('x-tenant-id')).toBe(B);
    expect(state.filter).not.toHaveBeenCalled();
  });
  it.each([
    ['v1/organizations/onboard', 'POST'],
    ['v1/user/tenants', 'GET'],
  ])('keeps %s tenantless', async (path, method) => {
    state.rows = [];
    expect((await call('stale-cookie', B, path, method)).status).toBe(200);
    expect(forwardedHeaders().has('x-tenant-id')).toBe(false);
    expect(state.filter).not.toHaveBeenCalled();
  });
  it('does not exempt a suffix lookalike path', async () => {
    state.rows = [];
    expect(
      (await call(undefined, undefined, 'v1/other/organizations/onboard', 'POST')).status,
    ).toBe(403);
    expect(state.fetch).not.toHaveBeenCalled();
  });
});
