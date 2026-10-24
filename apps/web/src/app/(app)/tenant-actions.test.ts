import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * W1 — switching the active tenant.
 *
 * Half of the plan's exit criterion is "a viewer in tenant A cannot see tenant
 * B". Four things hold that line: RLS on `tenant_users`, the BFF's tenant
 * resolver, `requireTenantContext()` ignoring a cookie it does not recognise,
 * and this action, which is the only thing that writes the cookie.
 *
 * It is the one worth testing here because it is where a slug the user typed
 * turns into server state. The others are covered in the BFF suite and by the
 * policies themselves.
 */

const state = vi.hoisted(() => ({
  origin: null as string | null,
  user: { id: 'user-a' } as { id: string } | null,
  memberships: [] as Array<{ tenant_id: string; tenants: { slug: string } }>,
  founderLive: false,
  organizations: [] as Array<{ id: string; slug: string; name: string }>,
  membershipError: null as { message: string } | null,
  cookiesSet: [] as Array<{ name: string; value: string; options: Record<string, unknown> }>,
  revalidated: [] as string[],
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers(state.origin ? { origin: state.origin } : {}),
  cookies: async () => ({
    set: (name: string, value: string, options: Record<string, unknown>) => {
      state.cookiesSet.push({ name, value, options });
    },
  }),
}));

vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => state.revalidated.push(path),
}));

vi.mock('@axiom/supabase', () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    rpc: () => ({ abortSignal: async () => ({ data: state.founderLive, error: null }) }),
    from: () => ({
      select: () => ({
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve(resolve({ data: state.organizations, error: state.membershipError })),
        eq: async () => ({ data: state.memberships, error: state.membershipError }),
      }),
    }),
  }),
}));

const { switchTenantAction } = await import('./tenant-actions');

afterEach(() => vi.unstubAllEnvs());

beforeEach(() => {
  vi.stubEnv('ENVIRONMENT', 'production');
  state.origin = null;
  state.user = { id: 'user-a' };
  state.memberships = [
    { tenant_id: 'tenant-a', tenants: { slug: 'alpha' } },
    { tenant_id: 'tenant-c', tenants: { slug: 'gamma' } },
  ];
  state.membershipError = null;
  state.founderLive = false;
  state.organizations = [];
  state.cookiesSet = [];
  state.revalidated = [];
});

describe('switchTenantAction', () => {
  it('switches to a tenant the user belongs to', async () => {
    const result = await switchTenantAction('gamma');
    expect(result).toEqual({ ok: true, slug: 'gamma' });
    expect(state.cookiesSet).toHaveLength(1);
    expect(state.cookiesSet[0]?.value).toBe('gamma');
  });

  it('refuses a tenant the user is not a member of, and writes nothing', async () => {
    // Tenant B exists; this user has no membership in it. Naming it must not
    // be the same as being in it.
    const result = await switchTenantAction('beta');
    expect(result).toEqual({ ok: false, reason: 'not_a_member' });
    expect(state.cookiesSet).toHaveLength(0);
  });

  it('sets the cookie httpOnly, so page scripts cannot steer server rendering', async () => {
    await switchTenantAction('alpha');
    expect(state.cookiesSet[0]?.options.httpOnly).toBe(true);
    expect(state.cookiesSet[0]?.options.sameSite).toBe('lax');
  });

  it('refuses when the membership lookup fails rather than guessing', async () => {
    state.membershipError = { message: 'connection lost' };
    const result = await switchTenantAction('alpha');
    expect(result).toEqual({ ok: false, reason: 'lookup_failed' });
    expect(state.cookiesSet).toHaveLength(0);
  });

  it('refuses an unauthenticated caller', async () => {
    state.user = null;
    const result = await switchTenantAction('alpha');
    expect(result).toEqual({ ok: false, reason: 'unauthenticated' });
    expect(state.cookiesSet).toHaveLength(0);
  });

  it('revalidates the layout so server components re-render for the new tenant', async () => {
    await switchTenantAction('gamma');
    // Without this the browser shows one tenant while the server still renders
    // the other, which is the worst failure mode this switcher has.
    expect(state.revalidated).toContain('/');
  });
});

it('switches a live global founder to an existing nonmember organization and refuses it immediately after revocation', async () => {
  state.founderLive = true;
  state.memberships = [];
  state.organizations = [{ id: 'foreign', slug: 'foreign', name: 'Foreign organization' }];
  expect(await switchTenantAction('foreign')).toEqual({ ok: true, slug: 'foreign' });
  state.cookiesSet = [];
  state.founderLive = false;
  expect(await switchTenantAction('foreign')).toEqual({ ok: false, reason: 'not_a_member' });
  expect(state.cookiesSet).toHaveLength(0);
});

it.each([
  ['local', 'http://192.168.1.20:3301', false],
  ['development', 'http://10.1.2.3:3001', false],
  ['test', 'http://localhost:3301', false],
  ['local', 'https://192.168.1.20:3301', true],
  ['production', 'http://192.168.1.20:3301', true],
  ['preprod', 'http://localhost:3301', true],
  ['local', 'http://public.example', true],
  ['local', 'not-an-origin', true],
  ['local', null, true],
] as const)(
  'keeps tenant preference transport scoped for %s / %s',
  async (environment, origin, secure) => {
    vi.stubEnv('ENVIRONMENT', environment);
    // The canonical deployment URL cannot override this request's local transport.
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://app.example.invalid');
    state.origin = origin;
    expect(await switchTenantAction('alpha')).toEqual({ ok: true, slug: 'alpha' });
    expect(state.cookiesSet[0]?.options).toMatchObject({ secure, httpOnly: true, sameSite: 'lax' });
  },
);
