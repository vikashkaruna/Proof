import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson, sha256 } from '@axiom/ledger';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';

const state = vi.hoisted(() => {
  Object.assign(process.env, {
    ENVIRONMENT: 'test',
    AXIOM_AUTH_MODE: 'strict',
    SUPABASE_URL: 'http://localhost:55321',
    SUPABASE_ANON_KEY: 'a'.repeat(40),
    SUPABASE_SERVICE_KEY: 'b'.repeat(40),
    APPROVAL_SIGNING_KEY: 'k'.repeat(48),
    AGENT_RUNTIME_URL: 'http://runtime.invalid',
    AGENT_RUNTIME_INTERNAL_TOKEN: 't'.repeat(40),
  });
  return { db: null as FakeDb | null };
});
vi.mock('@axiom/supabase', () => ({ createSupabaseAdmin: () => state.db!.client }));
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ENGAGEMENT = '33333333-3333-4333-8333-333333333333';
function success(init?: RequestInit, overrides: Record<string, unknown> = {}) {
  const dispatch = JSON.parse(String(init?.body)) as { correlation_id: string };
  return {
    agent: 'drishti',
    correlation_id: dispatch.correlation_id,
    status: 'succeeded',
    latency_ms: 1,
    input_tokens: 2,
    output_tokens: 3,
    cost_usd: 0,
    error: null,
    output: { inventory: [] },
    ledger_entry_ids: ['1', '2'],
    ...overrides,
  };
}
const transport = vi.fn<typeof fetch>();
const broadcast = vi.fn();

async function request(role: UserRole, agent: string, body: Record<string, unknown>) {
  const { v1Routes } = await import('./v1.js');
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: 'test-user' } as never);
    c.set('tenantId', A as never);
    c.set('role', role);
    c.set('approvalScopes', []);
    await next();
  });
  app.route(
    '/',
    v1Routes({
      approvalEngine: {} as never,
      killSwitch: {} as never,
      ledger: {} as never,
      mfa: {} as never,
      realtime: { broadcast, subscribe: vi.fn() },
    }),
  );
  return app.request(`/agents/${agent}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.db = createFakeDb();
  transport.mockReset();
  transport.mockImplementation(async (_url, init) => new Response(JSON.stringify(success(init))));
  broadcast.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', transport);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('agent invocation authority', () => {
  it.each([UserRole.VIEWER, UserRole.PARTNER, UserRole.APPROVER, UserRole.AGENT])(
    'denies %s before dispatch',
    async (role) => {
      expect((await request(role, 'drishti', {})).status).toBe(403);
      expect(transport).not.toHaveBeenCalled();
    },
  );
  it.each(['tenant_id', 'tenantId'])('rejects a foreign %s', async (field) => {
    expect((await request(UserRole.OWNER, 'drishti', { [field]: B })).status).toBe(403);
    expect(transport).not.toHaveBeenCalled();
  });
  it('rejects a foreign engagement', async () => {
    state.db!.seed('engagements', { id: ENGAGEMENT, tenant_id: B });
    expect((await request(UserRole.OWNER, 'drishti', { engagement_id: ENGAGEMENT })).status).toBe(
      404,
    );
    expect(transport).not.toHaveBeenCalled();
  });
  it('cannot invoke Karya even as founder', async () => {
    expect((await request(UserRole.FOUNDER, 'karya', {})).status).toBe(403);
    expect(transport).not.toHaveBeenCalled();
  });
  it.each(['sanket', 'nazar', 'lekha'])('denies customer invocation of %s', async (agent) => {
    expect((await request(UserRole.OWNER, agent, {})).status).toBe(403);
    expect(transport).not.toHaveBeenCalled();
  });
  it('dispatches the owned engagement under the authenticated tenant', async () => {
    state.db!.seed('engagements', { id: ENGAGEMENT, tenant_id: A });
    expect(
      (await request(UserRole.OWNER, 'drishti', { engagement_id: ENGAGEMENT, tenant_id: A }))
        .status,
    ).toBe(200);
    const call = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(call[1].body)).input.tenant_id).toBe(A);
    const row = state.db!.rows('agent_runs')[0]!;
    expect(row.metadata).toEqual({ requested_by: 'test-user' });
    expect(row.engagement_id).toBe(ENGAGEMENT);
    expect(row.status).toBe('succeeded');
    expect(row.input_redacted_hash).toBe(
      await sha256(canonicalJson(JSON.parse(String(call[1].body)).input)),
    );
    expect(row.output_redacted_hash).toBe(await sha256(canonicalJson({ inventory: [] })));
    expect(call[1].redirect).toBe('error');
    expect(call[1].signal).toBeInstanceOf(AbortSignal);
  });
  it('fails closed when it cannot persist the invocation', async () => {
    state.db!.failNext('agent_runs');
    expect((await request(UserRole.OWNER, 'drishti', {})).status).toBe(503);
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('confirmed runtime completion', () => {
  it('returns no output or success event when the completion write fails', async () => {
    transport.mockImplementation(async (_url, init) => {
      state.db!.failNext('agent_runs');
      return new Response(JSON.stringify(success(init)));
    });
    const res = await request(UserRole.OWNER, 'drishti', {});
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ error: { code: 'agent_completion_unconfirmed' } });
    expect(body).not.toHaveProperty('output');
    expect(state.db!.rows('agent_runs')[0]?.status).toBe('running');
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each(['cancelled', 'succeeded'])(
    'cannot overwrite concurrent %s completion',
    async (status) => {
      transport.mockImplementation(async (_url, init) => {
        state.db!.rows('agent_runs')[0]!.status = status;
        return new Response(JSON.stringify(success(init)));
      });
      const res = await request(UserRole.OWNER, 'drishti', {});
      expect(res.status).toBe(503);
      expect(state.db!.rows('agent_runs')[0]?.status).toBe(status);
      expect(broadcast).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['tenant_id', 'agent', 'correlation_id'])(
    'cannot complete a run whose %s changed',
    async (field) => {
      transport.mockImplementation(async (_url, init) => {
        state.db!.rows('agent_runs')[0]![field] = field === 'agent' ? 'sudhaar' : B;
        return new Response(JSON.stringify(success(init)));
      });
      expect((await request(UserRole.OWNER, 'drishti', {})).status).toBe(503);
      expect(state.db!.rows('agent_runs')[0]?.status).toBe('running');
    },
  );
  it.each([
    { status: undefined },
    { status: 'running' },
    { agent: 'sudhaar' },
    { correlation_id: B },
    { latency_ms: -1 },
    { input_tokens: 1.5 },
    { cost_usd: -1 },
    { output: null },
    { error: 'private-runtime-error' },
    { ledger_entry_ids: [] },
    { ledger_entry_ids: ['1', '1'] },
    { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 },
    { input_tokens: 2147483647, output_tokens: 1 },
    { latency_ms: 2147483648 },
    { cost_usd: 10000 },
  ])('refuses malformed or contradictory runtime completion (%j)', async (override) => {
    transport.mockImplementation(
      async (_url, init) => new Response(JSON.stringify(success(init, override))),
    );
    const res = await request(UserRole.OWNER, 'drishti', {});
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('private-runtime-error');
    expect(state.db!.rows('agent_runs')[0]?.status).toBe('failed');
    expect(state.db!.rows('agent_runs')[0]?.error).toBe('agent_invocation_failed');
    expect(broadcast.mock.calls.at(-1)?.[0].step).toBe('drishti.failed');
  });
  it('returns a non-success HTTP status for a runtime-reported failure and strips its payload', async () => {
    transport.mockImplementation(
      async (_url, init) =>
        new Response(
          JSON.stringify(
            success(init, {
              status: 'failed',
              error: 'private-runtime-error',
              output: { secret: 'private-output' },
              private_extra: 'private-extra',
            }),
          ),
        ),
    );
    const res = await request(UserRole.OWNER, 'drishti', {});
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ error: { code: 'agent_reported_failure' } });
    expect(JSON.stringify(body)).not.toMatch(/private-|output|ledger_entry_ids/);
    expect(state.db!.rows('agent_runs')[0]?.error).toBe('agent_reported_failure');
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('private-');
  });
  it.each(['http', 'network', 'json'])(
    'sanitizes %s errors in responses, database rows and logs',
    async (kind) => {
      transport.mockImplementation(async (_url, init) => {
        if (kind === 'network') throw new Error('private-credential-in-url');
        if (kind === 'json') return new Response('private-invalid-json');
        return new Response(
          JSON.stringify(success(init, { output: { secret: 'private-failure-body' } })),
          { status: 500 },
        );
      });
      const res = await request(UserRole.OWNER, 'drishti', {});
      expect(res.status).toBe(502);
      expect(await res.text()).not.toContain('private-');
      expect(JSON.stringify(state.db!.rows('agent_runs'))).not.toContain('private-');
      expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('private-');
    },
  );
  it('does not forward unknown top-level runtime fields on success', async () => {
    transport.mockImplementation(
      async (_url, init) =>
        new Response(JSON.stringify(success(init, { private_extra: 'private-credential' }))),
    );
    const res = await request(UserRole.OWNER, 'drishti', {});
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('private-credential');
    expect(broadcast.mock.calls.at(-1)?.[0].step).toBe('drishti.succeeded');
  });
});
