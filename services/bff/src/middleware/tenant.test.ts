import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Variables } from '../types.js';
import { applyEnv, createSupabaseDouble, TENANT_A, TENANT_B } from '../test/harness.js';

/**
 * W9 · Adversarial suite for tenant resolution.
 *
 *   SEC-1  membership check skipped in staging/preprod; role forced to `owner`
 *   SEC-3  tenancy is the product's "Absolute" NFR-2 — it must never be assumed
 *   SEC-13 preprod must behave exactly as production
 */

const supabase = vi.hoisted(() => ({
  current: null as ReturnType<typeof createSupabaseDouble> | null,
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => {
    if (!supabase.current) throw new Error('supabase double not installed');
    return (supabase.current.createClient as (...a: unknown[]) => unknown)(...args);
  },
}));

async function buildApp(
  env: Record<string, string | undefined>,
  double: ReturnType<typeof createSupabaseDouble>,
  token = 'a-valid-jwt',
) {
  applyEnv(env);
  supabase.current = double;
  vi.resetModules();
  const { resetEnvCache } = await import('@axiom/config');
  resetEnvCache();
  const { tenantResolver } = await import('./tenant.js');
  const app = new Hono<{ Variables: Variables }>();
  // Stand in for authMiddleware, which has its own suite.
  app.use('/v1/*', async (c, next) => {
    c.set('user', { id: 'user-a' } as never);
    c.set('token', token as never);
    await next();
  });
  app.use('/v1/*', tenantResolver);
  app.get('/v1/scope', (c) => c.json({ tenantId: c.get('tenantId'), role: c.get('role') }));
  app.post('/v1/organizations/onboard', (c) =>
    c.json({ tenantId: c.get('tenantId') ?? null, role: c.get('role') }),
  );
  app.post('/v1/invitations/accept', (c) =>
    c.json({ tenantId: c.get('tenantId') ?? null, role: c.get('role') ?? null }),
  );
  return app;
}

const DEPLOYED_ENVIRONMENTS = ['staging', 'preprod', 'production', 'onprem'] as const;

afterEach(() => {
  supabase.current = null;
  vi.resetModules();
});

describe('tenantResolver — SEC-1 · membership must be verified', () => {
  // The headline cross-tenant case from the plan's W9 list.
  it.each(DEPLOYED_ENVIRONMENTS)(
    'returns 403 when the caller is not a member of the requested tenant in %s',
    async (environment) => {
      const app = await buildApp(
        { ENVIRONMENT: environment },
        createSupabaseDouble({ membership: null }),
      );
      const res = await app.request('/v1/scope', { headers: { 'x-tenant-id': TENANT_B } });
      expect(res.status).toBe(403);
    },
  );

  it.each(DEPLOYED_ENVIRONMENTS)(
    'returns 400 when X-Tenant-Id is absent in %s, rather than defaulting to a tenant',
    async (environment) => {
      const app = await buildApp({ ENVIRONMENT: environment }, createSupabaseDouble({}));
      const res = await app.request('/v1/scope');
      expect(res.status).toBe(400);
    },
  );

  // SEC-1 step 5: a synthetic token used to be handed `owner` on any tenant
  // it named, with no membership lookup at all.
  it.each(['dev-token', 'test-access-token'])(
    'does not grant owner on an arbitrary tenant for the synthetic token %s',
    async (token) => {
      const app = await buildApp(
        { ENVIRONMENT: 'preprod' },
        createSupabaseDouble({ membership: null }),
        token,
      );
      const res = await app.request('/v1/scope', { headers: { 'x-tenant-id': TENANT_B } });
      expect(res.status).toBe(403);
    },
  );

  it('assigns the role recorded in tenant_users, not a hardcoded owner', async () => {
    const app = await buildApp(
      { ENVIRONMENT: 'production' },
      createSupabaseDouble({ membership: { role: 'viewer' } }),
    );
    const res = await app.request('/v1/scope', { headers: { 'x-tenant-id': TENANT_A } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenantId: TENANT_A, role: 'viewer' });
  });
});

describe('tenantResolver — bypass mode is still tenant-scoped', () => {
  // W0.1 parity: a local E2E run and a preprod run must agree on cross-tenant
  // refusal, or the parity lane compares two different products.
  it('refuses an unseeded tenant even under e2e-bypass', async () => {
    const app = await buildApp(
      { ENVIRONMENT: 'test', AXIOM_AUTH_MODE: 'e2e-bypass' },
      createSupabaseDouble({ membership: null }),
      'dev-token',
    );
    const res = await app.request('/v1/scope', { headers: { 'x-tenant-id': TENANT_B } });
    expect(res.status).toBe(403);
  });

  it('permits a seeded fixture tenant under e2e-bypass', async () => {
    const app = await buildApp(
      { ENVIRONMENT: 'test', AXIOM_AUTH_MODE: 'e2e-bypass' },
      createSupabaseDouble({ membership: null }),
      'dev-token',
    );
    const res = await app.request('/v1/scope', {
      headers: { 'x-tenant-id': '00000000-0000-0000-0000-000000000001' },
    });
    expect(res.status).toBe(200);
  });
});

describe('tenantResolver — SEC-5 · the onboarding exemption', () => {
  // /organizations/onboard legitimately has no tenant yet. It must not
  // therefore be handed `owner` over an existing tenant.
  it('exempts onboarding from tenant resolution without granting a tenant scope', async () => {
    const app = await buildApp({ ENVIRONMENT: 'production' }, createSupabaseDouble({}));
    const res = await app.request('/v1/organizations/onboard', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tenantId: string | null }).tenantId).toBeNull();
  });
});

describe('tenantResolver — C-W1-3 · invitation acceptance exemption', () => {
  // The invitee is not yet a member; acceptance must not be handed any tenant scope.
  it('exempts acceptance from tenant resolution without granting a tenant or role', async () => {
    const app = await buildApp({ ENVIRONMENT: 'production' }, createSupabaseDouble({}));
    const res = await app.request('/v1/invitations/accept', {
      method: 'POST',
      headers: { 'x-tenant-id': '11111111-1111-4111-8111-111111111111' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenantId: null, role: null });
  });
});
