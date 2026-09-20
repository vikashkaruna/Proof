import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Variables } from '../types.js';
import { applyEnv, createSupabaseDouble, FOUNDER_ID } from '../test/harness.js';

/**
 * W9 · Adversarial suite for the authentication middleware.
 *
 * Every case here corresponds to a finding in the gap-closure plan. They are
 * written against the *target* behaviour — fail closed, in every environment —
 * so they go red against the pre-W0.0 middleware and green once the
 * environment-conditional branches are deleted.
 *
 *   SEC-1  unauthenticated request must be 401 in every environment
 *   SEC-1  a Supabase error or outage must NOT yield the founder identity
 *   SEC-2  `test-access-token` must not resolve to a real user
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
) {
  applyEnv(env);
  supabase.current = double;
  vi.resetModules();
  const { resetEnvCache } = await import('@axiom/config');
  resetEnvCache();
  const { authMiddleware } = await import('./auth.js');
  const app = new Hono<{ Variables: Variables }>();
  app.use('/v1/*', authMiddleware);
  app.get('/v1/whoami', (c) => c.json({ id: (c.get('user') as { id: string }).id }));
  return app;
}

// The environments a deployment can actually run in. `local` and `test` are
// excluded deliberately — they are the only two where a bypass is reachable,
// and they are not deployed.
const DEPLOYED_ENVIRONMENTS = ['staging', 'preprod', 'production', 'onprem'] as const;

afterEach(() => {
  supabase.current = null;
  vi.resetModules();
});

describe('authMiddleware — SEC-1 · unauthenticated access', () => {
  it.each(DEPLOYED_ENVIRONMENTS)(
    'returns 401 for a request with no Authorization header in %s',
    async (environment) => {
      const app = await buildApp({ ENVIRONMENT: environment }, createSupabaseDouble({}));
      const res = await app.request('/v1/whoami');
      expect(res.status).toBe(401);
    },
  );

  // The specific SEC-1 trigger: a container that simply forgot to set NODE_ENV
  // used to satisfy `NODE_ENV !== 'production'` and open the door.
  it('returns 401 when NODE_ENV is unset entirely', async () => {
    const app = await buildApp(
      { ENVIRONMENT: 'staging', NODE_ENV: undefined },
      createSupabaseDouble({}),
    );
    const res = await app.request('/v1/whoami');
    expect(res.status).toBe(401);
  });

  it('ignores a stale AXIOM_E2E_BYPASS_AUTH=true in a deployed environment', async () => {
    const app = await buildApp(
      { ENVIRONMENT: 'production', AXIOM_E2E_BYPASS_AUTH: 'true' },
      createSupabaseDouble({}),
    );
    const res = await app.request('/v1/whoami');
    expect(res.status).toBe(401);
  });
});

describe('authMiddleware — SEC-2 · synthetic tokens', () => {
  it.each(['test-access-token', 'dev-token'])(
    'does not accept the synthetic token %s in a deployed environment',
    async (token) => {
      const app = await buildApp(
        { ENVIRONMENT: 'preprod' },
        createSupabaseDouble({ auth: { kind: 'error', message: 'invalid JWT' } }),
      );
      const res = await app.request('/v1/whoami', {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(401);
    },
  );
});

describe('authMiddleware — SEC-1 · fail closed on service failure', () => {
  it('returns 401 when Supabase rejects the token, never a founder identity', async () => {
    const app = await buildApp(
      { ENVIRONMENT: 'staging' },
      createSupabaseDouble({ auth: { kind: 'error', message: 'invalid JWT' } }),
    );
    const res = await app.request('/v1/whoami', {
      headers: { authorization: 'Bearer some-real-looking-jwt' },
    });
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(FOUNDER_ID);
  });

  it('returns 503 when Supabase is unreachable, never a founder identity', async () => {
    const app = await buildApp(
      { ENVIRONMENT: 'preprod' },
      createSupabaseDouble({ auth: { kind: 'unreachable', message: 'ECONNREFUSED' } }),
    );
    const res = await app.request('/v1/whoami', {
      headers: { authorization: 'Bearer some-real-looking-jwt' },
    });
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain(FOUNDER_ID);
  });
});

describe('authMiddleware — the happy path still works', () => {
  it('attaches the authenticated user for a valid token', async () => {
    const app = await buildApp(
      { ENVIRONMENT: 'production' },
      createSupabaseDouble({ auth: { kind: 'user', id: 'aaaaaaaa-0000-0000-0000-000000000009' } }),
    );
    const res = await app.request('/v1/whoami', {
      headers: { authorization: 'Bearer a-valid-jwt' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'aaaaaaaa-0000-0000-0000-000000000009' });
  });
});
