import { describe, it, expect, beforeEach, vi } from 'vitest';

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
  user: { id: 'user-a' } as { id: string } | null,
  memberships: [] as Array<{ tenant_id: string; tenants: { slug: string } }>,
  membershipError: null as { message: string } | null,
  cookiesSet: [] as Array<{ name: string; value: string; options: Record<string, unknown> }>,
  revalidated: [] as string[],
}));

vi.mock('next/headers', () => ({
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
    from: () => ({
      select: () => ({
        eq: async () => ({ data: state.memberships, error: state.membershipError }),
      }),
    }),
  }),
}));

const { switchTenantAction } = await import('./tenant-actions');

beforeEach(() => {
  state.user = { id: 'user-a' };
  state.memberships = [
    { tenant_id: 'tenant-a', tenants: { slug: 'alpha' } },
    { tenant_id: 'tenant-c', tenants: { slug: 'gamma' } },
  ];
  state.membershipError = null;
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
