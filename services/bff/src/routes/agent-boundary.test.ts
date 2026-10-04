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
  return { db: null as FakeDb | null, adminCalls: 0 };
});
vi.mock('@axiom/supabase', () => ({
  createHumanActionWriter: () => state.db!.client,
  createSupabaseAdmin: () => {
    state.adminCalls++;
    return state.db!.client;
  },
}));
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

async function request(
  role: UserRole,
  agent: string,
  body: Record<string, unknown>,
  options: { tenantId?: string; headers?: Record<string, string> } = {},
) {
  const { v1Routes } = await import('./v1.js');
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } as never);
    c.set('tenantId', (options.tenantId ?? A) as never);
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
    headers: { 'content-type': 'application/json', ...options.headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.db = createFakeDb();
  state.adminCalls = 0;
  state.db.onRpc('record_generic_agent_run_start', (args) => {
    const prior = state
      .db!.rows('agent_runs')
      .find(
        (r) =>
          r.tenant_id === args.p_tenant_id &&
          r.agent === args.p_agent &&
          r.correlation_id === args.p_correlation_id,
      );
    if (prior) return { run_id: prior.id, created: false, status: prior.status };
    const row = state.db!.seed('agent_runs', {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      tenant_id: args.p_tenant_id,
      agent: args.p_agent,
      engagement_id: args.p_engagement_id,
      correlation_id: args.p_correlation_id,
      status: 'running',
      input_redacted_hash: args.p_request_hash,
      metadata: {
        requested_by: args.p_actor_id,
        lifecycle_writer: 'generic_agent_rpc_v1',
        request_input_hash: args.p_request_hash,
      },
    });
    return { run_id: row.id, created: true, status: 'running' };
  });
  state.db.onRpc('record_generic_agent_run_finish', (args) => {
    const row = state
      .db!.rows('agent_runs')
      .find(
        (r) =>
          r.id === args.p_run_id &&
          r.tenant_id === args.p_tenant_id &&
          r.agent === args.p_agent &&
          r.correlation_id === args.p_correlation_id &&
          r.status === 'running',
      );
    if (!row) return { error: 'terminal_conflict' };
    row.status = args.p_status;
    row.error = args.p_error_code;
    row.output_redacted_hash = args.p_status === 'succeeded' ? 'c'.repeat(64) : null;
    row.response_output_hash = args.p_response_hash;
    return { run_id: row.id, status: row.status, replayed: false };
  });

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
  it.each([UserRole.OWNER, UserRole.ADMIN, UserRole.FOUNDER])(
    'refuses generic Prativedan for %s before database access or runtime dispatch',
    async (role) => {
      const response = await request(role, 'Prativedan', {
        engagement_id: ENGAGEMENT,
        tenant_id: A,
        report_type: 'board',
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: 'board_report_workflow_required' },
      });
      expect(state.adminCalls).toBe(0);
      expect(state.db!.rows('agent_runs')).toHaveLength(0);
      expect(transport).not.toHaveBeenCalled();
      expect(broadcast).not.toHaveBeenCalled();
    },
  );
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
    expect(row.metadata).toEqual({
      requested_by: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      lifecycle_writer: 'generic_agent_rpc_v1',
      request_input_hash: row.input_redacted_hash,
    });
    expect(row.engagement_id).toBe(ENGAGEMENT);
    expect(row.status).toBe('succeeded');
    expect(row.input_redacted_hash).toBe(
      await sha256(canonicalJson(JSON.parse(String(call[1].body)).input)),
    );
    expect(row.output_redacted_hash).toBe('c'.repeat(64));
    expect(row.response_output_hash).toBe(await sha256(canonicalJson({ inventory: [] })));
    expect(JSON.parse(String(call[1].body)).dispatch_context).toEqual({
      run_id: row.id,
      request_hash: row.input_redacted_hash,
    });
    expect(call[1].redirect).toBe('error');
    expect(call[1].signal).toBeInstanceOf(AbortSignal);
  });
  it('fails closed when it cannot persist the invocation', async () => {
    state.db!.failNextRpc('record_generic_agent_run_start');
    expect((await request(UserRole.OWNER, 'drishti', {})).status).toBe(503);
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('scoped generic lifecycle boundary', () => {
  it('does not replay a recorded dispatch with the same correlation', async () => {
    const body = { correlation_id: ENGAGEMENT };
    expect((await request(UserRole.OWNER, 'drishti', body)).status).toBe(200);
    const repeat = await request(UserRole.OWNER, 'drishti', body);
    expect(repeat.status).toBe(409);
    expect(await repeat.json()).toMatchObject({ error: { code: 'agent_dispatch_exists' } });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(state.db!.rows('agent_runs')).toHaveLength(1);
  });
  it('binds dispatch context outside caller-controlled input', async () => {
    await request(UserRole.OWNER, 'drishti', {
      dispatch_context: { run_id: B, request_hash: '0'.repeat(64) },
    });
    const envelope = JSON.parse(String(transport.mock.calls[0]![1]!.body));
    expect(envelope.dispatch_context.run_id).toBe(state.db!.rows('agent_runs')[0]!.id);
    expect(envelope.dispatch_context.run_id).not.toBe(B);
    expect(envelope.dispatch_context.request_hash).toBe(
      await sha256(canonicalJson(envelope.input)),
    );
  });
  it('does not publish success for genuine-looking receipts refused by the database', async () => {
    state.db!.onRpc('record_generic_agent_run_finish', () => ({ error: 'receipts_unconfirmed' }));
    const response = await request(UserRole.OWNER, 'drishti', {});
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('inventory');
    expect(broadcast).toHaveBeenCalledTimes(1);
  });
  it.each(['mem-1', '01', '0', '9223372036854775808', '1e2'])(
    'cannot establish success with receipt %s',
    async (id) => {
      transport.mockImplementation(
        async (_url, init) =>
          new Response(JSON.stringify(success(init, { ledger_entry_ids: [id, '2'] }))),
      );
      expect((await request(UserRole.OWNER, 'drishti', {})).status).toBe(502);
      expect(state.db!.rows('agent_runs')[0]!.status).toBe('failed');
    },
  );
});

describe('canonical generic dispatch identifiers', () => {
  const tenant = 'abcdefab-cdef-4cde-8fde-abcdefabcdea';
  const engagement = 'abcdefab-cdef-4cde-8fde-abcdefabcdeb';
  const correlation = 'abcdefab-cdef-4cde-8fde-abcdefabcdec';
  it.each(['body', 'header'])(
    'accepts valid uppercase UUIDs with correlation in %s',
    async (source) => {
      state.db!.seed('engagements', { id: engagement, tenant_id: tenant });
      const body = {
        tenant_id: tenant.toUpperCase(),
        tenantId: tenant.toUpperCase(),
        engagement_id: engagement.toUpperCase(),
        ...(source === 'body' ? { correlation_id: correlation.toUpperCase() } : {}),
      };
      const response = await request(UserRole.OWNER, 'drishti', body, {
        tenantId: tenant.toUpperCase(),
        headers:
          source === 'header' ? { 'x-correlation-id': correlation.toUpperCase() } : undefined,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ correlation_id: correlation });
      const envelope = JSON.parse(String(transport.mock.calls[0]![1]!.body));
      expect(envelope.input).toMatchObject({
        tenant_id: tenant,
        tenantId: tenant,
        engagement_id: engagement,
      });
      expect(envelope.correlation_id).toBe(correlation);
      const row = state.db!.rows('agent_runs')[0]!;
      expect(row.tenant_id).toBe(tenant);
      expect(row.engagement_id).toBe(engagement);
      expect(envelope.dispatch_context.request_hash).toBe(
        await sha256(canonicalJson(envelope.input)),
      );
    },
  );
  it('does not redispatch the same valid UUID under different casing', async () => {
    state.db!.seed('engagements', { id: engagement, tenant_id: tenant });
    const body = {
      engagement_id: engagement.toUpperCase(),
      correlation_id: correlation.toUpperCase(),
    };
    expect(
      (await request(UserRole.OWNER, 'drishti', body, { tenantId: tenant.toUpperCase() })).status,
    ).toBe(200);
    expect(
      (
        await request(
          UserRole.OWNER,
          'drishti',
          { engagement_id: engagement, correlation_id: correlation },
          { tenantId: tenant },
        )
      ).status,
    ).toBe(409);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe('confirmed runtime completion', () => {
  it('returns no output or success event when the completion write fails', async () => {
    transport.mockImplementation(async (_url, init) => {
      state.db!.failNextRpc('record_generic_agent_run_finish');
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
    expect(broadcast.mock.calls.at(-1)?.[0].step).toBe('drishti.outcome_unconfirmed');
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
    expect(broadcast.mock.calls.at(-1)?.[0]).toMatchObject({
      step: 'drishti.runtime_reported_failure',
      message: 'The runtime reported failure for agent drishti.',
    });
    expect(broadcast.mock.calls.at(-1)?.[0].message).not.toBe('Agent drishti failed');
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
      expect(broadcast.mock.calls.at(-1)?.[0]).toMatchObject({
        step: 'drishti.outcome_unconfirmed',
        message: expect.stringContaining('unconfirmed'),
      });
      expect(broadcast.mock.calls.at(-1)?.[0].message).not.toBe('Agent drishti failed');
      expect(
        broadcast.mock.calls.some(
          ([event]) => event.step === 'drishti.failed' || event.step === 'drishti.succeeded',
        ),
      ).toBe(false);
      expect(state.db!.rows('agent_runs')[0]?.status).toBe('failed');
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
