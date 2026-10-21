import { beforeEach, expect, it, vi } from 'vitest';
import { Capability } from '@axiom/types';
import { AuthRetryableFetchError } from '@supabase/supabase-js';

const state = vi.hoisted(() => ({
  user: { id: 'user-1', email: 'reader@example.invalid' } as { id: string; email: string } | null,
  memberships: [
    {
      tenant_id: 'tenant-a',
      role: 'viewer',
      approval_scopes: [],
      tenants: { slug: 'alpha', name: 'Alpha', is_demo: false },
    },
    {
      tenant_id: 'tenant-b',
      role: 'owner',
      approval_scopes: [],
      tenants: { slug: 'beta', name: 'Beta', is_demo: true },
    },
  ] as Array<{
    tenant_id: string;
    role: string;
    approval_scopes: string[];
    tenants: { slug: string; name: string; is_demo: boolean };
  }>,
  cookieSlug: 'alpha',
  internal: false,
  founderLive: false,
  organizations: [] as Array<{ id: string; slug: string; name: string; is_demo: boolean }>,
  factors: [{ id: 'factor-1' }] as Array<{ id: string }>,
  attestations: [{ expires_at: new Date(Date.now() + 60000).toISOString() }] as Array<{
    expires_at: string;
  }>,
  session: { access_token: 'token' } as { access_token: string } | null,
  policyRoles: [] as string[],
  membershipError: null as { code?: string; message: string } | null,
  firstMembershipError: null as { code?: string; message: string } | null,
  membershipReads: 0,
  authError: null as Error | null,
  authThrows: false,
}));

const database = vi.hoisted(() => ({
  from: vi.fn(),
  recovery: null as unknown,
}));
vi.mock('@axiom/supabase', () => ({
  createSupabaseServerClient: async () => ({
    auth: {
      getUser: async () => {
        if (state.authThrows) throw new Error('provider unavailable');
        return { data: { user: state.user }, error: state.authError };
      },
      getSession: async () => ({ data: { session: state.session } }),
    },
    from: database.from,
    rpc: (name: string) => {
      if (name === 'is_live_platform_founder')
        return { abortSignal: async () => ({ data: state.founderLive, error: null }) };
      if (name !== 'read_my_mfa_recovery') throw new Error('unexpected rpc');
      return Promise.resolve({ data: database.recovery, error: null });
    },
  }),
  sessionIdFromAccessToken: () => 'session-1',
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (state.cookieSlug ? { value: state.cookieSlug } : undefined),
  }),
}));
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));

import {
  requireCapabilityContext,
  requireInternalContext,
  requireTenantContext,
} from './tenant-context';

beforeEach(() => {
  database.recovery = null;
  state.user = { id: 'user-1', email: 'reader@example.invalid' };
  state.memberships = [
    {
      tenant_id: 'tenant-a',
      role: 'viewer',
      approval_scopes: [],
      tenants: { slug: 'alpha', name: 'Alpha', is_demo: false },
    },
    {
      tenant_id: 'tenant-b',
      role: 'owner',
      approval_scopes: [],
      tenants: { slug: 'beta', name: 'Beta', is_demo: true },
    },
  ];
  state.cookieSlug = 'alpha';
  state.internal = false;
  state.founderLive = false;
  state.organizations = [];
  state.factors = [{ id: 'factor-1' }];
  state.attestations = [{ expires_at: new Date(Date.now() + 60000).toISOString() }];
  state.session = { access_token: 'token' };
  state.policyRoles = [];
  state.membershipError = null;
  state.firstMembershipError = null;
  state.membershipReads = 0;
  state.authError = null;
  state.authThrows = false;

  database.from.mockImplementation((table: string) => {
    const rows = () => {
      if (table === 'tenant_users') return state.memberships;
      if (table === 'tenants') return state.organizations;
      if (table === 'user_mfa_factors') return state.factors;
      if (table === 'mfa_session_attestations') return state.attestations;
      return [];
    };
    const builder = {
      select: () => builder,
      eq: () => builder,
      is: () => builder,
      limit: () => builder,
      maybeSingle: async () => ({
        data:
          table === 'users'
            ? { is_axiom_internal: state.internal }
            : table === 'tenants'
              ? { mfa_required_roles: state.policyRoles }
              : null,
      }),
      then: (resolve: (value: { data: unknown; error: unknown }) => unknown) => {
        if (table === 'tenant_users') state.membershipReads += 1;
        const error =
          table === 'tenant_users'
            ? state.membershipReads === 1 && state.firstMembershipError
              ? state.firstMembershipError
              : state.membershipError
            : null;
        return Promise.resolve(resolve({ data: error ? null : rows(), error }));
      },
    };
    return builder;
  });
});

it('redirects an unauthenticated caller before membership access', async () => {
  state.user = null;
  await expect(requireTenantContext()).rejects.toThrow('redirect:/login');
  expect(database.from).not.toHaveBeenCalled();
});

it('reports a transient Auth failure without losing an existing session', async () => {
  state.authThrows = true;
  await expect(requireTenantContext()).rejects.toThrow(
    'Authentication service is temporarily unavailable',
  );
  state.authThrows = false;
  state.authError = new AuthRetryableFetchError('provider unavailable', 503);
  await expect(requireTenantContext()).rejects.toThrow(
    'Authentication service is temporarily unavailable',
  );
  expect(database.from).not.toHaveBeenCalled();
});

it('redirects a user with no tenant membership', async () => {
  state.memberships = [];
  await expect(requireTenantContext()).rejects.toThrow('redirect:/onboarding');
});

it('retries only a future-issued JWT membership refusal after sign-in', async () => {
  state.firstMembershipError = { code: 'PGRST303', message: 'JWT issued at future' };
  await expect(requireTenantContext()).resolves.toMatchObject({ tenantId: 'tenant-a' });
  expect(state.membershipReads).toBe(2);
});

it('never treats a membership read failure as a user with no tenant', async () => {
  state.membershipError = { code: 'PGRST301', message: 'provider unavailable' };
  await expect(requireTenantContext()).rejects.toThrow('Tenant memberships are unavailable');
  expect(state.membershipReads).toBe(1);
  state.membershipReads = 0;
  state.membershipError = { code: 'PGRST303', message: 'JWT issued at future' };
  await expect(requireTenantContext()).rejects.toThrow('Tenant memberships are unavailable');
  expect(state.membershipReads).toBe(2);
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
  await expect(requireTenantContext()).rejects.toThrow(
    'redirect:/settings/security?enrol=required',
  );
  expect((await requireTenantContext(undefined, { allowUnverifiedMfa: true })).tenantId).toBe(
    'tenant-a',
  );
});

it.each(['founder', 'axiom_analyst', 'owner', 'admin', 'approver'])(
  'requires enrolment and a live session for %s with an empty tenant policy',
  async (role) => {
    state.memberships[0]!.role = role;
    state.factors = [];
    await expect(requireTenantContext()).rejects.toThrow(
      'redirect:/settings/security?enrol=required',
    );
    expect((await requireTenantContext(undefined, { allowUnverifiedMfa: true })).role).toBe(role);
    state.factors = [{ id: 'factor-1' }];
    state.attestations = [];
    await expect(requireTenantContext()).rejects.toThrow('redirect:/verify');
    state.attestations = [{ expires_at: new Date(Date.now() - 60000).toISOString() }];
    await expect(requireTenantContext()).rejects.toThrow('redirect:/verify');
    state.attestations = [{ expires_at: new Date(Date.now() + 60000).toISOString() }];
    await expect(requireTenantContext()).resolves.toMatchObject({ role });
    state.session = null;
    await expect(requireTenantContext()).rejects.toThrow('redirect:/verify');
  },
);

it.each(['reviewer', 'viewer', 'partner'])('preserves tenant MFA choice for %s', async (role) => {
  state.memberships[0]!.role = role;
  state.factors = [];
  await expect(requireTenantContext()).resolves.toMatchObject({ role });
  state.policyRoles = [role];
  await expect(requireTenantContext()).rejects.toThrow(
    'redirect:/settings/security?enrol=required',
  );
});

it('quarantines an existing session after switching into an admin membership', async () => {
  state.factors = [];
  await expect(requireTenantContext()).resolves.toMatchObject({ role: 'viewer' });
  state.memberships[1]!.role = 'admin';
  await expect(requireTenantContext('beta')).rejects.toThrow(
    'redirect:/settings/security?enrol=required',
  );
});

it('requires a live session-bound MFA attestation', async () => {
  state.policyRoles = ['viewer'];
  state.attestations = [{ expires_at: new Date(Date.now() - 60000).toISOString() }];
  await expect(requireTenantContext()).rejects.toThrow('redirect:/verify');
  state.attestations = [{ expires_at: new Date(Date.now() + 60000).toISOString() }];
  await expect(requireTenantContext()).resolves.toMatchObject({ tenantId: 'tenant-a' });
});

it('refuses a capability not granted to the tenant role', async () => {
  await expect(requireCapabilityContext(Capability.PLAN_APPROVE)).rejects.toThrow(
    'redirect:/portal?error=forbidden',
  );
});

it('requires both internal employment and Workbench role authority', async () => {
  await expect(requireInternalContext()).rejects.toThrow('redirect:/portal');
  state.internal = true;
  await expect(requireInternalContext()).rejects.toThrow('redirect:/portal');
});

it('sends an account under founder-led recovery to the recovery panel, not the code prompt', async () => {
  database.recovery = { case_id: 'case-1', state: 'opened' };
  state.attestations = [{ expires_at: new Date(Date.now() + 60000).toISOString() }];
  await expect(requireTenantContext()).rejects.toThrow('redirect:/settings/security?recovery=1');
  database.recovery = null;
  await expect(requireTenantContext()).resolves.toMatchObject({ tenantId: 'tenant-a' });
});

it('uses live global founder authority for organizations without or with lower explicit membership, while preserving mandatory MFA', async () => {
  state.founderLive = true;
  state.memberships = [];
  state.organizations = [
    { id: 'tenant-z', slug: 'unrelated', name: 'Unrelated suspended organization', is_demo: false },
  ];
  await expect(requireTenantContext('unrelated')).resolves.toMatchObject({
    tenantId: 'tenant-z',
    role: 'founder',
    approvalScopes: [],
    isGlobalFounder: true,
    isAxiomInternal: true,
  });
  await expect(requireInternalContext('unrelated')).resolves.toMatchObject({
    isGlobalFounder: true,
  });
  state.memberships = [
    {
      tenant_id: 'tenant-z',
      role: 'viewer',
      approval_scopes: ['limited'],
      tenants: { slug: 'unrelated', name: 'Unrelated', is_demo: false },
    },
  ];
  await expect(requireTenantContext('unrelated')).resolves.toMatchObject({
    role: 'founder',
    approvalScopes: [],
  });
  state.factors = [];
  await expect(requireTenantContext('unrelated')).rejects.toThrow(
    'redirect:/settings/security?enrol=required',
  );
});
it('revoked or nondesignated internal users cannot borrow global organization context', async () => {
  state.internal = true;
  state.memberships = [];
  state.founderLive = false;
  state.organizations = [{ id: 'tenant-z', slug: 'foreign', name: 'Foreign', is_demo: false }];
  await expect(requireTenantContext('foreign')).rejects.toThrow('redirect:/onboarding');
});
