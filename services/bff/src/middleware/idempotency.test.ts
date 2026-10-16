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
  for (const path of [
    '/v1/public-website-assets/operations',
    '/v1/public-website-assets/operations/99990000-0000-4000-8000-000000000004/cancel',
    '/v1/public-website-assets/operations-extra',
    '/v1/public-website-assets/operations/extra',
    '/v1/public-website-assets/operations/not-a-uuid/cancel',
    '/v1/public-website-assets/operations/99990000-0000-4000-8000-000000000004/cancel-extra',
    '/v1/engagements',
    '/v1/engagements-extra',
    '/v1/engagements/extra',
    '/v1/plans/owned-synthetic',
    '/v1/plans/owned-synthetic/cancel',
    '/v1/plans/owned-synthetic/outcome',
    '/v1/plans/owned-synthetic-extra',
    '/v1/plans/owned-synthetic/extra',
    '/v1/assessment/jobs',
    '/v1/plans/proposals',
    '/v1/plans/proposals-extra',
    '/v1/plans/proposals/extra',
    '/v1/assessment/jobs-extra',
    '/v1/assessment/jobs/extra',
    '/v1/assessment/jobs/99990000-0000-4000-8000-000000000004/cancel',
    '/v1/assessment/jobs/not-a-uuid/cancel',
    '/v1/assessment/jobs/99990000-0000-4000-8000-000000000004/cancel-extra',
  ]) {
    app.post(path, (c) => c.json({ executed: true, key: c.get('idempotencyKey') }));
    app.put(path, (c) => c.json({ executed: true, key: c.get('idempotencyKey') }));
  }
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
  it.each(['conflict', 'in_progress', 'expired'])(
    'refuses a %s claim before the handler',
    async (decision) => {
      const double = createSupabaseDouble({});
      double.state.claimDecision = { decision };
      const app = await buildApp({ ENVIRONMENT: 'production' }, double);
      const res = await app.request('/v1/execute', {
        method: 'POST',
        headers: { 'idempotency-key': 'repeat-request-key' },
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as ErrorBody).error.code).toBe(`idempotency_${decision}`);
    },
  );

  it.each(['claim_request', 'complete_request'])(
    'does not report success when %s fails',
    async (rpc) => {
      const double = createSupabaseDouble({});
      double.state.failRpc = rpc;
      const app = await buildApp({ ENVIRONMENT: 'production' }, double);
      const res = await app.request('/v1/execute', {
        method: 'POST',
        headers: { 'idempotency-key': 'repeat-request-key' },
      });
      expect(res.status).toBe(503);
      expect(((await res.json()) as ErrorBody).error.code).toBe(
        rpc === 'claim_request' ? 'idempotency_unavailable' : 'idempotency_outcome_unknown',
      );
    },
  );

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

  it('bypasses only the exact human assessment POST cache so durable SQL rechecks current authorization', async () => {
    const double = createSupabaseDouble({
      idempotencyHit: { response_status: 200, response_body: { cached: true } },
    });
    double.state.failRpc = 'claim_request';
    const app = await buildApp({ ENVIRONMENT: 'production' }, double);
    const res = await app.request('/v1/assessment/jobs', {
      method: 'POST',
      headers: { 'idempotency-key': 'client-operation-key' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ executed: true, key: 'client-operation-key' });
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('rechecks live source/capability on exact planning POST rather than returning cached business success', async () => {
    const double = createSupabaseDouble({
      idempotencyHit: { response_status: 200, response_body: { cached: true } },
    });
    double.state.failRpc = 'claim_request';
    const app = await buildApp({ ENVIRONMENT: 'production' }, double);
    const response = await app.request('/v1/plans/proposals', {
      method: 'POST',
      headers: { 'idempotency-key': 'client-operation-key' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ executed: true, key: 'client-operation-key' });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
  it.each([
    ['POST', '/v1/assessment/jobs-extra'],
    ['POST', '/v1/assessment/jobs/extra'],
    ['PUT', '/v1/assessment/jobs'],
    ['POST', '/v1/plans/proposals-extra'],
    ['POST', '/v1/plans/proposals/extra'],
    ['PUT', '/v1/plans/proposals'],
    ['PUT', '/v1/assessment/jobs/99990000-0000-4000-8000-000000000004/cancel'],
    ['POST', '/v1/assessment/jobs/not-a-uuid/cancel'],
    ['POST', '/v1/assessment/jobs/99990000-0000-4000-8000-000000000004/cancel-extra'],
  ])('keeps generic idempotency on %s %s', async (method, path) => {
    const double = createSupabaseDouble({});
    double.state.failRpc = 'claim_request';
    const app = await buildApp({ ENVIRONMENT: 'production' }, double);
    const res = await app.request(path!, {
      method,
      headers: { 'idempotency-key': 'client-operation-key' },
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as ErrorBody).error.code).toBe('idempotency_unavailable');
  });

  it('still requires a client key on durable assessment requests', async () => {
    const app = await buildApp({ ENVIRONMENT: 'production' }, createSupabaseDouble({}));
    const res = await app.request('/v1/assessment/jobs', { method: 'POST' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error.code).toBe('idempotency_required');
  });

  it.each([undefined, 'short'])(
    'still validates the key before durable cancellation with key %s',
    async (key) => {
      const app = await buildApp({ ENVIRONMENT: 'production' }, createSupabaseDouble({}));
      const response = await app.request(
        '/v1/assessment/jobs/99990000-0000-4000-8000-000000000004/cancel',
        { method: 'POST', headers: key ? { 'idempotency-key': key } : {} },
      );
      expect(response.status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
    },
  );

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

it.each([
  '/v1/plans/owned-synthetic',
  '/v1/plans/owned-synthetic/cancel',
  '/v1/plans/owned-synthetic/outcome',
])('original owned operation %s rechecks source instead of generic cached reply', async (path) => {
  const double = createSupabaseDouble({
    idempotencyHit: { response_status: 200, response_body: { cached: true } },
  });
  double.state.failRpc = 'claim_request';
  const app = await buildApp({ ENVIRONMENT: 'test' }, double);
  const response = await app.request(path, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'owned-original-operation' },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ executed: true, key: 'owned-original-operation' });
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect((await app.request(path, { method: 'POST' })).status).toBe(400);
});
it.each([
  ['POST', '/v1/plans/owned-synthetic-extra'],
  ['POST', '/v1/plans/owned-synthetic/extra'],
  ['PUT', '/v1/plans/owned-synthetic'],
])('owned-like %s %s retains generic idempotency claim', async (method, path) => {
  const double = createSupabaseDouble({});
  double.state.failRpc = 'claim_request';
  const app = await buildApp({ ENVIRONMENT: 'test' }, double);
  const response = await app.request(path, {
    method,
    headers: { 'Idempotency-Key': 'owned-original-operation' },
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: { code: 'idempotency_unavailable' } });
});

it('lets only exact intake POST reach live atomic replay without a generic cached claim', async () => {
  const double = createSupabaseDouble({});
  double.state.failRpc = 'claim_request';
  const app = await buildApp({ NODE_ENV: 'test' }, double);
  const response = await app.request('/v1/engagements', {
    method: 'POST',
    headers: { 'Idempotency-Key': 'opaque-operation' },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(double.createClient).not.toHaveBeenCalled();
});

it.each([
  '/v1/public-website-assets/operations',
  '/v1/public-website-assets/operations/99990000-0000-4000-8000-000000000004/cancel',
])(
  'website asset operation %s always reaches live durable authority and receipt reconciliation',
  async (path) => {
    const double = createSupabaseDouble({
      idempotencyHit: { response_status: 200, response_body: { cached: true } },
    });
    double.state.failRpc = 'claim_request';
    const app = await buildApp({ ENVIRONMENT: 'production' }, double);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await app.request(path, {
        method: 'POST',
        headers: { 'Idempotency-Key': 'durable-website-asset' },
        body: JSON.stringify({ attempt }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ executed: true, key: 'durable-website-asset' });
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    }
    expect(double.createClient).not.toHaveBeenCalled();
    for (const key of [undefined, 'short', 'x'.repeat(257)]) {
      const response = await app.request(path, {
        method: 'POST',
        headers: key ? { 'Idempotency-Key': key } : {},
      });
      expect(response.status).toBe(400);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    }
  },
);

it.each([
  ['PUT', '/v1/public-website-assets/operations'],
  ['POST', '/v1/public-website-assets/operations-extra'],
  ['POST', '/v1/public-website-assets/operations/extra'],
  ['POST', '/v1/public-website-assets/operations/not-a-uuid/cancel'],
  [
    'POST',
    '/v1/public-website-assets/operations/99990000-0000-4000-8000-000000000004/cancel-extra',
  ],
  ['PUT', '/v1/public-website-assets/operations/99990000-0000-4000-8000-000000000004/cancel'],
])('website-like %s %s retains generic idempotency protection', async (method, path) => {
  const double = createSupabaseDouble({});
  double.state.failRpc = 'claim_request';
  const app = await buildApp({ ENVIRONMENT: 'production' }, double);
  const response = await app.request(path, {
    method,
    headers: { 'Idempotency-Key': 'durable-website-asset' },
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: { code: 'idempotency_unavailable' } });
});
