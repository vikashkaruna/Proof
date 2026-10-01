import { beforeEach, expect, it, vi } from 'vitest';
import { Capability } from '@axiom/types';

const state = vi.hoisted(() => ({
  user: { id: 'user-1', email: 'reader@example.invalid' } as { id: string; email: string } | null,
  memberships: [
    { tenant_id: 'tenant-a', role: 'viewer', approval_scopes: [], tenants: { slug: 'alpha', name: 'Alpha', is_demo: false } },
    { tenant_id: 'tenant-b', role: 'owner', approval_scopes: [], tenants: { slug: 'beta', name: 'Beta', is_demo: true } },
  ] as Array<{ tenant_id: string; role: string; approval_scopes: string[]; tenants: { slug: string; name: string; is_demo: boolean } }>,
  cookieSlug: 'alpha',
  internal: false,
  factors: [{ id: 'factor-1' }] as Array<{ id: string }>,
  attestations: [{ expires_at: new Date(Date.now() + 60000).toISOString() }] as Array<{ expires_at: string }>,
  session: { access_token: 'token' } as { access_token: string } | null,
  policyRoles: [] as string[],
}));

const database = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('@axiom/supabase', () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }), getSession: async () => ({ data: { session: state.session } }) },
    from: database.from,
  }),
  sessionIdFromAccessToken: () => 'session-1',
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => state.cookieSlug ? { value: state.cookieSlug } : undefined }) }));
vi.mock('next/navigation', () => ({ redirect: (path: string) => { throw new Error(`redirect:${path}`); } }));

import { requireCapabilityContext, requireInternalContext, requireTenantContext } from './tenant-context';

beforeEach(() => {
  state.user = { id: 'user-1', email: 'reader@example.invalid' };
  state.memberships = [
    { tenant_id: 'tenant-a', role: 'viewer', approval_scopes: [], tenants: { slug: 'alpha', name: 'Alpha', is_demo: false } },
    { tenant_id: 'tenant-b', role: 'owner', approval_scopes: [], tenants: { slug: 'beta', name: 'Beta', is_demo: true } },
  ];
  state.cookieSlug = 'alpha';
  state.internal = false;
  state.factors = [{ id: 'factor-1' }];
  state.attestations = [{ expires_at: new Date(Date.now() + 60000).toISOString() }];
  state.session = { access_token: 'token' };
  state.policyRoles = [];

  database.from.mockImplementation((table: string) => {
    const rows = () => {
      if (table === 'tenant_users') return state.memberships;
      if (table === 'user_mfa_factors') return state.factors;
      if (table === 'mfa_session_attestations') return state.attestations;
      return [];
    };
    const builder = {
      select: () => builder,
      eq: () => builder,
      is: () => builder,
      limit: () => builder,
      maybeSingle: async () => ({ data: table === 'users' ? { is_axiom_internal: state.internal } : table === 'tenants' ? { mfa_required_roles: state.policyRoles } : null }),
      then: (resolve: (value: { data: unknown }) => unknown) => Promise.resolve(resolve({ data: rows() })),
    };
    return builder;
  });
});

it('redirects an unauthenticated caller before membership access', async () => {
  state.user = null;
  await expect(requireTenantContext()).rejects.toThrow('redirect:/login');
  expect(database.from).not.toHaveBeenCalled();
});

it('redirects a user with no tenant membership', async () => {
  state.memberships = [];
  await expect(requireTenantContext()).rejects.toThrow('redirect:/onboarding');
});

it('ignores a forged active-tenant cookie and returns only a verified membership', async () => {
  state.cookieSlug = 'foreign-tenant';
  const context = await requireTenantContext();
  expect(context.tenantId).toBe('tenant-a');
  expect(context.tenantSlug).toBe('alpha');
  expect(context.isDemo).toBe(false);
  expect((await requireTenantContext('beta')).tenantId).toBe('tenant-b');
});

it('quarantines a caller when tenant MFA policy requires a missing factor', async () => {
  state.policyRoles = ['viewer'];
  state.factors = [];
  await expect(requireTenantContext()).rejects.toThrow('redirect:/settings/security?enrol=required');
  expect((await requireTenantContext(undefined, { allowUnverifiedMfa: true })).tenantId).toBe('tenant-a');
});

it('requires a live session-bound MFA attestation', async () => {
  state.policyRoles = ['viewer'];
  state.attestations = [{ expires_at: new Date(Date.now() - 60000).toISOString() }];
  await expect(requireTenantContext()).rejects.toThrow('redirect:/verify');
  state.attestations = [{ expires_at: new Date(Date.now() + 60000).toISOString() }];
  await expect(requireTenantContext()).resolves.toMatchObject({ tenantId: 'tenant-a' });
});

it('refuses a capability not granted to the tenant role', async () => {
  await expect(requireCapabilityContext(Capability.PLAN_APPROVE)).rejects.toThrow('redirect:/portal?error=forbidden');
});

it('requires both internal employment and Workbench role authority', async () => {
  await expect(requireInternalContext()).rejects.toThrow('redirect:/portal');
  state.internal = true;
  await expect(requireInternalContext()).rejects.toThrow('redirect:/portal');
});
