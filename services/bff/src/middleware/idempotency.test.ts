import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Variables } from '../types.js';
import { applyEnv, createSupabaseDouble, TENANT_A } from '../test/harness.js';

/**
 * W9 · Adversarial suite for idempotency.
 *
 *   SEC-13 row 3 — the key was auto-generated whenever it was absent in
 *   development, local, preprod, staging, or any container without NODE_ENV.
 *   Every auto-generated key is unique by construction, so the retry-safety
 *   FR-8.3 describes was silently disabled in every environment that was
 *   supposed to be testing it.
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
  const { idempotency } = await import('./idempotency.js');
  const app = new Hono<{ Variables: Variables }>();
  app.use('/v1/*', async (c, next) => {
    c.set('user', { id: 'user-a' } as never);
    c.set('tenantId', TENANT_A as never);
    await next();
  });
  app.use('/v1/*', idempotency);
  app.post('/v1/execute', (c) => c.json({ executed: true, key: c.get('idempotencyKey') }));
  app.get('/v1/read', (c) => c.json({ ok: true }));
  return app;
}

type ErrorBody = { error: { code: string; message: string } };

const DEPLOYED_ENVIRONMENTS = ['staging', 'preprod', 'production', 'onprem'] as const;

afterEach(() => {
  supabase.current = null;
  vi.resetModules();
});

describe('idempotency — SEC-13 · FR-8.3 must be enforced everywhere', () => {
  it.each(DEPLOYED_ENVIRONMENTS)(
    'returns 400 for a mutating request with no Idempotency-Key in %s',
    async (environment) => {
      const app = await buildApp({ ENVIRONMENT: environment }, createSupabaseDouble({}));
      const res = await app.request('/v1/execute', { method: 'POST' });
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorBody).error.code).toBe('idempotency_required');
    },
  );

  it('returns 400 when NODE_ENV is unset, the SEC-1 trigger', async () => {
    const app = await buildApp(
      { ENVIRONMENT: 'staging', NODE_ENV: undefined },
      createSupabaseDouble({}),
    );
    const res = await app.request('/v1/execute', { method: 'POST' });
    expect(res.status).toBe(400);
  });

  it('does not require a key for non-mutating requests', async () => {
    const app = await buildApp({ ENVIRONMENT: 'production' }, createSupabaseDouble({}));
    const res = await app.request('/v1/read');
    expect(res.status).toBe(200);
  });

  it('rejects a key outside the 8–256 character bound', async () => {
    const app = await buildApp({ ENVIRONMENT: 'production' }, createSupabaseDouble({}));
    const res = await app.request('/v1/execute', {
      method: 'POST',
      headers: { 'idempotency-key': 'short' },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error.code).toBe('idempotency_invalid');
  });

  it('accepts a valid key and passes it to the handler', async () => {
    const app = await buildApp({ ENVIRONMENT: 'production' }, createSupabaseDouble({}));
    const res = await app.request('/v1/execute', {
      method: 'POST',
      headers: { 'idempotency-key': 'a-real-client-supplied-key' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ executed: true, key: 'a-real-client-supplied-key' });
  });

  it('replays the cached response for a repeated key rather than re-executing', async () => {
    const app = await buildApp(
      { ENVIRONMENT: 'production' },
      createSupabaseDouble({
        idempotencyHit: { response_status: 200, response_body: { executed: true, replayed: true } },
      }),
    );
    const res = await app.request('/v1/execute', {
      method: 'POST',
      headers: { 'idempotency-key': 'a-real-client-supplied-key' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ executed: true, replayed: true });
  });

  // Even under bypass, FR-8.3 stays on. The bypass relaxes *authentication*;
  // it is not a general "make the product easier to call" switch.
  it('still requires a key under e2e-bypass', async () => {
    const app = await buildApp(
      { ENVIRONMENT: 'test', AXIOM_AUTH_MODE: 'e2e-bypass' },
      createSupabaseDouble({}),
    );
    const res = await app.request('/v1/execute', { method: 'POST' });
    expect(res.status).toBe(400);
  });
});
