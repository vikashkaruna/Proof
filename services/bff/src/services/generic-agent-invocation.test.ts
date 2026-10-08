import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson, sha256 } from '@axiom/ledger';
import { createFakeDb } from '../test/fake-postgrest.js';
import {
  invokeGenericAgent,
  type GenericAgentInvocationDeps,
  type GenericAgentPreparationContext,
} from './generic-agent-invocation.js';

const state = vi.hoisted(() => {
  Object.assign(process.env, {
    ENVIRONMENT: 'test',
    AXIOM_AUTH_MODE: 'strict',
    SUPABASE_URL: 'http://localhost:55321',
    SUPABASE_ANON_KEY: 'a'.repeat(40),
    SUPABASE_SERVICE_KEY: 'b'.repeat(40),
    APPROVAL_SIGNING_KEY: 'k'.repeat(48),
  });
  return { configuredWriter: vi.fn() };
});

vi.mock('@axiom/supabase', () => ({
  createHumanActionWriter: () => state.configuredWriter(),
  createSupabaseAdmin: () => {
    throw new Error('Lifecycle writes must use the scoped human writer');
  },
}));

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const ENGAGEMENT = '33333333-3333-4333-8333-333333333333';
const CORRELATION = '44444444-4444-4444-8444-444444444444';
const RUN = '55555555-5555-4555-8555-555555555555';
const FOREIGN = '66666666-6666-4666-8666-666666666666';

function context() {
  return {
    agent: 'drishti',
    tenantId: TENANT,
    actorId: ACTOR,
    engagementId: ENGAGEMENT,
    correlationId: CORRELATION,
    input: {
      tenant_id: TENANT,
      engagement_id: ENGAGEMENT,
      nested: { sequence: [2, 1], retained: null },
      dispatch_context: { run_id: FOREIGN, request_hash: '0'.repeat(64) },
    },
  };
}

function runtimeResult(init?: RequestInit, overrides: Record<string, unknown> = {}) {
  const envelope = JSON.parse(String(init?.body)) as { correlation_id: string };
  return {
    agent: 'drishti',
    correlation_id: envelope.correlation_id,
    status: 'succeeded',
    latency_ms: 7,
    input_tokens: 2,
    output_tokens: 3,
    cost_usd: 0.01,
    error: null,
    output: { inventory: [], normalized: { a: 1, z: 2 } },
    ledger_entry_ids: ['17', '18'],
    ...overrides,
  };
}

function fixture() {
  const db = createFakeDb();
  const rpc = vi.fn((name: string, args: Record<string, unknown>) => db.client.rpc(name, args));
  db.onRpc('record_generic_agent_run_start', (args) => {
    const row = db.rows('agent_runs')[0];
    if (row) return { run_id: row.id, created: false, status: row.status };
    db.seed('agent_runs', {
      id: RUN,
      tenant_id: args.p_tenant_id,
      actor_id: args.p_actor_id,
      agent: args.p_agent,
      engagement_id: args.p_engagement_id,
      correlation_id: args.p_correlation_id,
      request_hash: args.p_request_hash,
      status: 'running',
    });
    return { run_id: RUN, created: true, status: 'running' };
  });
  db.onRpc('record_generic_agent_run_finish', (args) => {
    const row = db.rows('agent_runs')[0];
    if (
      !row ||
      row.id !== args.p_run_id ||
      row.tenant_id !== args.p_tenant_id ||
      row.actor_id !== args.p_actor_id ||
      row.agent !== args.p_agent ||
      row.engagement_id !== args.p_engagement_id ||
      row.correlation_id !== args.p_correlation_id ||
      row.request_hash !== args.p_request_hash ||
      row.status !== 'running'
    )
      return { error: 'context_changed' };
    row.status = args.p_status;
    row.response_hash = args.p_response_hash;
    return { run_id: RUN, status: args.p_status, replayed: false };
  });
  const fetchImpl = vi.fn<typeof fetch>(
    async (_url, init) => new Response(JSON.stringify(runtimeResult(init))),
  );
  const authHeaders = vi.fn(async () => ({ 'X-Serverless-Authorization': 'synthetic-auth' }));
  const broadcast = vi.fn();
  const log = { error: vi.fn() };
  const writer = { rpc } as unknown as ReturnType<
    NonNullable<GenericAgentInvocationDeps['writerFactory']>
  >;
  const writerFactory = vi.fn(() => writer);
  const deps = {
    runtimeUrl: 'http://runtime.invalid',
    runtimeToken: 'synthetic-runtime-token',
    realtime: { broadcast },
    writerFactory,
    fetchImpl,
    authHeaders,
    logger: log,
  };
  state.configuredWriter.mockReturnValue(writer);
  return { db, rpc, fetchImpl, authHeaders, broadcast, log, writerFactory, writer, deps };
}

beforeEach(() => {
  state.configuredWriter.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('shared proof-bound lifecycle', () => {
  it('returns internal run metadata only after confirmed settlement with separate hash domains', async () => {
    const f = fixture();
    const input = context();
    const response = await invokeGenericAgent(input, f.deps);
    expect(response.status).toBe(200);
    if (response.status !== 200) throw new Error('Successful settlement expected');
    const requestHash = await sha256(canonicalJson(input.input));
    const responseHash = await sha256(canonicalJson(response.body.output));
    expect(response.run).toEqual({
      runId: RUN,
      correlationId: CORRELATION,
      requestHash,
      responseHash,
    });
    expect(response.body).not.toHaveProperty('run');
    expect(response.body).not.toHaveProperty('requestHash');
    expect(f.rpc.mock.calls).toEqual([
      [
        'record_generic_agent_run_start',
        {
          p_tenant_id: TENANT,
          p_actor_id: ACTOR,
          p_agent: 'drishti',
          p_engagement_id: ENGAGEMENT,
          p_correlation_id: CORRELATION,
          p_request_hash: requestHash,
        },
      ],
      [
        'record_generic_agent_run_finish',
        {
          p_tenant_id: TENANT,
          p_actor_id: ACTOR,
          p_run_id: RUN,
          p_agent: 'drishti',
          p_engagement_id: ENGAGEMENT,
          p_correlation_id: CORRELATION,
          p_request_hash: requestHash,
          p_status: 'succeeded',
          p_error_code: null,
          p_latency_ms: 7,
          p_input_tokens: 2,
          p_output_tokens: 3,
          p_cost_usd: 0.01,
          p_started_receipt: '17',
          p_completed_receipt: '18',
          p_response_hash: responseHash,
        },
      ],
    ]);
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    const [url, options] = f.fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://runtime.invalid/agents/drishti/invoke');
    expect(options).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': 'synthetic-runtime-token',
        'X-Serverless-Authorization': 'synthetic-auth',
      },
    });
    expect(options!.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(options!.body))).toEqual({
      correlation_id: CORRELATION,
      input: input.input,
      dispatch_context: { run_id: RUN, request_hash: requestHash },
    });
    expect(f.authHeaders).toHaveBeenCalledWith('http://runtime.invalid');
    expect(f.broadcast.mock.calls.map(([event]) => event.step)).toEqual([
      'drishti.started',
      'drishti.succeeded',
    ]);
    expect(f.log.error).not.toHaveBeenCalled();
  });

  it('snapshots caller input and context before asynchronous hashing or SQL work', async () => {
    const f = fixture();
    const input = context();
    const original = structuredClone(input);
    const pending = invokeGenericAgent(input, f.deps);
    input.agent = 'sudhaar';
    input.tenantId = FOREIGN;
    input.actorId = FOREIGN;
    input.engagementId = FOREIGN;
    input.correlationId = FOREIGN;
    input.input.tenant_id = FOREIGN;
    input.input.nested.sequence.push(99);
    f.deps.runtimeUrl = 'http://changed.invalid';
    f.deps.runtimeToken = 'changed-token';
    const response = await pending;
    expect(response.status).toBe(200);
    if (response.status !== 200) throw new Error('Original context must settle');
    const expectedHash = await sha256(canonicalJson(original.input));
    expect(response.run).toMatchObject({ requestHash: expectedHash, correlationId: CORRELATION });
    expect(f.fetchImpl.mock.calls[0]![0]).toBe('http://runtime.invalid/agents/drishti/invoke');
    expect(JSON.parse(String(f.fetchImpl.mock.calls[0]![1]!.body))).toEqual({
      correlation_id: CORRELATION,
      input: original.input,
      dispatch_context: { run_id: RUN, request_hash: expectedHash },
    });
    expect(f.db.rows('agent_runs')[0]).toMatchObject({
      tenant_id: TENANT,
      actor_id: ACTOR,
      engagement_id: ENGAGEMENT,
      correlation_id: CORRELATION,
    });
  });

  it('preserves canonical undefined semantics separately from JSON transport omissions', async () => {
    const f = fixture();
    const input = {
      ...context(),
      engagementId: null,
      input: { tenant_id: TENANT, absent: undefined },
    };
    const response = await invokeGenericAgent(input, f.deps);
    expect(response.status).toBe(200);
    if (response.status !== 200) throw new Error('Successful settlement expected');
    expect(response.run.requestHash).toBe(
      await sha256(canonicalJson({ tenant_id: TENANT, absent: null })),
    );
    expect(JSON.parse(String(f.fetchImpl.mock.calls[0]![1]!.body)).input).toEqual({
      tenant_id: TENANT,
    });
    expect(f.rpc.mock.calls[0]![1].p_engagement_id).toBeNull();
    expect(f.rpc.mock.calls[1]![1].p_engagement_id).toBeNull();
  });

  it('uses the configured scoped writer and production transport/auth defaults', async () => {
    const f = fixture();
    vi.stubGlobal('fetch', f.fetchImpl);
    const response = await invokeGenericAgent(context(), {
      runtimeUrl: f.deps.runtimeUrl,
      runtimeToken: f.deps.runtimeToken,
      realtime: f.deps.realtime,
    });
    expect(response.status).toBe(200);
    expect(state.configuredWriter).toHaveBeenCalledTimes(1);
    expect(f.writerFactory).not.toHaveBeenCalled();
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(f.authHeaders).not.toHaveBeenCalled();
  });

  it.each(['forbidden', 'context_refused', 'dispatch_conflict'])(
    'refuses live-authority/context start %s without peer work or run metadata',
    async (code) => {
      const f = fixture();
      f.db.onRpc('record_generic_agent_run_start', () => ({ error: code }));
      const result = await invokeGenericAgent(context(), f.deps);
      expect(result).toEqual({
        status: code === 'forbidden' ? 403 : 409,
        body: { error: { code, message: 'Agent dispatch was refused.' } },
      });
      expect(result).not.toHaveProperty('run');
      expect(f.fetchImpl).not.toHaveBeenCalled();
      expect(f.broadcast).not.toHaveBeenCalled();
      expect(f.rpc).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['writer', 'rpc', 'invalid_record', 'malformed', 'not_running'])(
    'sanitizes unconfirmed start (%s) before dispatch',
    async (kind) => {
      const f = fixture();
      if (kind === 'writer')
        f.writerFactory.mockImplementation(() => {
          throw new Error('private-credential');
        });
      else if (kind === 'rpc') f.db.failNextRpc('record_generic_agent_run_start');
      else if (kind === 'invalid_record')
        f.db.onRpc('record_generic_agent_run_start', () => ({ error: 'invalid_record' }));
      else if (kind === 'malformed')
        f.db.onRpc('record_generic_agent_run_start', () => ({
          run_id: 'not-a-uuid',
          created: true,
          status: 'running',
        }));
      else
        f.db.onRpc('record_generic_agent_run_start', () => ({
          run_id: RUN,
          created: true,
          status: 'cancelled',
        }));
      const result = await invokeGenericAgent(context(), f.deps);
      expect(result).toEqual({
        status: 503,
        body: {
          error: {
            code: 'persistence_failed',
            message: 'Could not record agent invocation.',
          },
        },
      });
      expect(f.fetchImpl).not.toHaveBeenCalled();
      expect(f.broadcast).not.toHaveBeenCalled();
      expect(JSON.stringify(f.log.error.mock.calls)).not.toContain('private-');
    },
  );

  it('returns existing dispatch without redispatching or publishing terminal events', async () => {
    const f = fixture();
    await invokeGenericAgent(context(), f.deps);
    f.broadcast.mockClear();
    const result = await invokeGenericAgent(context(), f.deps);
    expect(result).toEqual({
      status: 409,
      body: {
        error: {
          code: 'agent_dispatch_exists',
          message: 'This invocation is already recorded. Inspect the existing run before retrying.',
          runId: RUN,
          correlationId: CORRELATION,
        },
      },
    });
    expect(result).not.toHaveProperty('run');
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(f.broadcast).not.toHaveBeenCalled();
    expect(
      f.rpc.mock.calls.filter(([fn]) => fn === 'record_generic_agent_run_finish'),
    ).toHaveLength(1);
  });

  it.each(['receipts', 'write', 'malformed', 'wrong_run', 'wrong_status'])(
    'withholds runtime output and confirmed run metadata after ambiguous settlement (%s)',
    async (kind) => {
      const f = fixture();
      if (kind === 'write') f.db.failNextRpc('record_generic_agent_run_finish');
      else
        f.db.onRpc('record_generic_agent_run_finish', () =>
          kind === 'receipts'
            ? { error: 'receipts_unconfirmed' }
            : kind === 'malformed'
              ? { run_id: RUN, status: 'succeeded' }
              : {
                  run_id: kind === 'wrong_run' ? FOREIGN : RUN,
                  status: kind === 'wrong_status' ? 'cancelled' : 'succeeded',
                  replayed: false,
                },
        );
      const result = await invokeGenericAgent(context(), f.deps);
      expect(result).toEqual({
        status: 503,
        body: {
          error: {
            code: 'agent_completion_unconfirmed',
            message: 'Could not confirm the recorded outcome. Inspect this run before retrying.',
            runId: RUN,
            correlationId: CORRELATION,
          },
        },
      });
      expect(result).not.toHaveProperty('run');
      expect(JSON.stringify(result)).not.toContain('inventory');
      expect(f.fetchImpl).toHaveBeenCalledTimes(1);
      expect(f.broadcast.mock.calls.map(([event]) => event.step)).toEqual(['drishti.started']);
    },
  );

  it('distinguishes a sanitized runtime-reported failure from an unknown outcome', async () => {
    const f = fixture();
    f.fetchImpl.mockImplementation(
      async (_url, init) =>
        new Response(
          JSON.stringify(
            runtimeResult(init, {
              status: 'failed',
              error: 'private-runtime-error',
              output: { secret: 'private-output' },
            }),
          ),
        ),
    );
    const result = await invokeGenericAgent(context(), f.deps);
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({
      error: {
        code: 'agent_reported_failure',
        runtimeOutcome: 'runtime_reported_failure',
      },
    });
    expect(result).not.toHaveProperty('run');
    expect(JSON.stringify(result)).not.toContain('private-');
    expect(f.rpc.mock.calls[1]![1]).toMatchObject({
      p_status: 'failed',
      p_error_code: 'agent_reported_failure',
      p_started_receipt: null,
      p_completed_receipt: null,
      p_response_hash: null,
    });
    expect(f.broadcast.mock.calls.at(-1)![0]).toMatchObject({
      step: 'drishti.runtime_reported_failure',
    });
  });

  it.each([
    'auth',
    'network',
    'http',
    'http_empty',
    'json',
    'wrong_correlation',
    'duplicate_receipt',
    'overflow',
  ])(
    'does not claim a runtime failure or return run metadata for unknown outcome (%s)',
    async (kind) => {
      const f = fixture();
      if (kind === 'auth') f.authHeaders.mockRejectedValue(new Error('private-auth-credential'));
      else
        f.fetchImpl.mockImplementation(async (_url, init) => {
          if (kind === 'network') throw new Error('private-network-credential');
          if (kind === 'http') return new Response('private-http-body', { status: 503 });
          if (kind === 'http_empty') return new Response(null, { status: 503 });
          if (kind === 'json') return new Response('private-invalid-json');
          const override =
            kind === 'wrong_correlation'
              ? { correlation_id: FOREIGN }
              : kind === 'duplicate_receipt'
                ? { ledger_entry_ids: ['17', '17'] }
                : { input_tokens: 2147483647, output_tokens: 1 };
          return new Response(JSON.stringify(runtimeResult(init, override)));
        });
      const result = await invokeGenericAgent(context(), f.deps);
      expect(result.status).toBe(502);
      expect(result.body).toMatchObject({
        error: {
          code: 'agent_invocation_failed',
          runtimeOutcome: 'unconfirmed',
        },
      });
      expect(result).not.toHaveProperty('run');
      expect(JSON.stringify(result)).not.toContain('private-');
      expect(JSON.stringify(f.log.error.mock.calls)).not.toContain('private-');
      expect(f.rpc.mock.calls[1]![1]).toMatchObject({
        p_status: 'failed',
        p_error_code: 'agent_invocation_failed',
        p_started_receipt: null,
        p_completed_receipt: null,
        p_response_hash: null,
      });
      expect(f.broadcast.mock.calls.at(-1)![0]).toMatchObject({
        step: 'drishti.outcome_unconfirmed',
      });
      expect(f.fetchImpl).toHaveBeenCalledTimes(kind === 'auth' ? 0 : 1);
    },
  );
});

function publicContext(agent = 'drishti') {
  return {
    ...context(),
    agent,
    input: {
      mode: 'public_website',
      tenant_id: TENANT,
      engagement_id: ENGAGEMENT,
      synthetic_unicode: 'Café 字',
      absent: undefined,
    },
  };
}

function expectNoDispatch(
  f: ReturnType<typeof fixture>,
  result: Awaited<ReturnType<typeof invokeGenericAgent>>,
) {
  expect(result).not.toHaveProperty('run');
  expect(f.authHeaders).not.toHaveBeenCalled();
  expect(f.fetchImpl).not.toHaveBeenCalled();
  expect(f.broadcast.mock.calls.map(([event]) => event.step)).toEqual([
    'drishti.started',
    'drishti.outcome_unconfirmed',
  ]);
  expect(f.rpc.mock.calls[1]![1]).toMatchObject({
    p_status: 'failed',
    p_error_code: 'agent_invocation_failed',
    p_started_receipt: null,
    p_completed_receipt: null,
    p_response_hash: null,
  });
}

describe('trusted source dispatch preparation', () => {
  it.each(['drishti', 'vibhaag'])(
    'prepares %s after recorded start and sends only fixed lookup identifiers',
    async (agent) => {
      const f = fixture();
      const input = publicContext(agent);
      const canonicalInput = canonicalJson(input.input);
      const requestHash = await sha256(canonicalInput);
      const prepareDispatch = vi.fn(async (dispatch: GenericAgentPreparationContext) => {
        expect(f.db.rows('agent_runs')[0]).toMatchObject({ id: RUN, status: 'running' });
        expect(f.rpc.mock.calls).toHaveLength(1);
        expect(f.fetchImpl).not.toHaveBeenCalled();
        expect(f.authHeaders).not.toHaveBeenCalled();
        expect(Object.isFrozen(dispatch)).toBe(true);
        expect(Reflect.set(dispatch, 'tenantId', FOREIGN)).toBe(false);
        expect(dispatch).toEqual({
          agent,
          tenantId: TENANT,
          actorId: ACTOR,
          engagementId: ENGAGEMENT,
          correlationId: CORRELATION,
          runId: RUN,
          requestHash,
          canonicalInput,
        });
        expect(await sha256(dispatch.canonicalInput)).toBe(dispatch.requestHash);
        return { kind: 'public_source' as const };
      });
      f.fetchImpl.mockImplementation(
        async (_url, init) => new Response(JSON.stringify(runtimeResult(init, { agent }))),
      );
      const result = await invokeGenericAgent(input, { ...f.deps, prepareDispatch });
      expect(result.status).toBe(200);
      if (result.status !== 200) throw new Error('Confirmed source dispatch expected');
      expect(result.run).toMatchObject({ runId: RUN, requestHash });
      expect(prepareDispatch).toHaveBeenCalledTimes(1);
      expect(f.fetchImpl.mock.calls).toHaveLength(1);
      const [url, options] = f.fetchImpl.mock.calls[0]!;
      expect(url).toBe(`http://runtime.invalid/public-source/agents/${agent}/invoke`);
      expect(JSON.parse(String(options!.body))).toEqual({
        tenant_id: TENANT,
        run_id: RUN,
        correlation_id: CORRELATION,
      });
      expect(options).toMatchObject({
        method: 'POST',
        redirect: 'error',
        headers: {
          'X-Internal-Token': 'synthetic-runtime-token',
          'X-Serverless-Authorization': 'synthetic-auth',
        },
      });
      expect(f.authHeaders).toHaveBeenCalledWith('http://runtime.invalid');
    },
  );

  it('snapshots preparation callback, mode and canonical UTF8 input before asynchronous work', async () => {
    const f = fixture();
    const input = publicContext();
    const original = structuredClone(input);
    const prepareDispatch = vi.fn(async (_dispatch: GenericAgentPreparationContext) => ({
      kind: 'public_source' as const,
    }));
    const deps = { ...f.deps, prepareDispatch };
    const pending = invokeGenericAgent(input, deps);
    input.agent = 'sudhaar';
    input.tenantId = FOREIGN;
    input.actorId = FOREIGN;
    input.engagementId = FOREIGN;
    input.correlationId = FOREIGN;
    input.input.mode = 'legacy_inventory';
    input.input.tenant_id = FOREIGN;
    input.input.synthetic_unicode = 'changed';
    deps.prepareDispatch = vi.fn(async () => {
      throw new Error('Replaced callback must not run');
    });
    const result = await pending;
    expect(result.status).toBe(200);
    expect(prepareDispatch).toHaveBeenCalledTimes(1);
    expect(deps.prepareDispatch).not.toHaveBeenCalled();
    expect(prepareDispatch.mock.calls[0]![0]).toMatchObject({
      agent: 'drishti',
      tenantId: TENANT,
      actorId: ACTOR,
      engagementId: ENGAGEMENT,
      correlationId: CORRELATION,
      canonicalInput: canonicalJson(original.input),
      requestHash: await sha256(canonicalJson(original.input)),
    });
    expect(JSON.parse(prepareDispatch.mock.calls[0]![0].canonicalInput)).toMatchObject({
      absent: null,
      synthetic_unicode: 'Café 字',
    });
    expect(JSON.parse(String(f.fetchImpl.mock.calls[0]![1]!.body))).toEqual({
      tenant_id: TENANT,
      run_id: RUN,
      correlation_id: CORRELATION,
    });
  });

  it.each(['refused', 'commit_then_disconnect'])(
    'preparation %s never transports or claims runtime-reported failure',
    async (kind) => {
      const f = fixture();
      let preparationWasCommitted = false;
      const prepareDispatch = vi.fn(async () => {
        preparationWasCommitted = kind === 'commit_then_disconnect';
        throw new Error('private-source-binding credential and output');
      });
      const result = await invokeGenericAgent(publicContext(), { ...f.deps, prepareDispatch });
      expect(result).toMatchObject({
        status: 502,
        body: { error: { code: 'agent_invocation_failed', runtimeOutcome: 'unconfirmed' } },
      });
      expect(preparationWasCommitted).toBe(kind === 'commit_then_disconnect');
      expect(prepareDispatch).toHaveBeenCalledTimes(1);
      expect(f.rpc).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(result)).not.toContain('private-');
      expect(JSON.stringify(f.log.error.mock.calls)).not.toContain('private-');
      expectNoDispatch(f, result);
    },
  );

  it('keeps preparation failure unconfirmed when settlement also cannot be confirmed', async () => {
    const f = fixture();
    f.db.failNextRpc('record_generic_agent_run_finish');
    const prepareDispatch = vi.fn(async () => {
      throw new Error('private-preparation');
    });
    const result = await invokeGenericAgent(publicContext(), { ...f.deps, prepareDispatch });
    expect(result).toMatchObject({
      status: 503,
      body: { error: { code: 'agent_completion_unconfirmed' } },
    });
    expect(result).not.toHaveProperty('run');
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(f.authHeaders).not.toHaveBeenCalled();
    expect(prepareDispatch).toHaveBeenCalledTimes(1);
    expect(f.rpc).toHaveBeenCalledTimes(2);
    expect(f.broadcast.mock.calls.map(([event]) => event.step)).toEqual(['drishti.started']);
  });

  it('does not prepare an existing invocation on duplicate dispatch', async () => {
    const f = fixture();
    const prepareDispatch = vi.fn(async () => ({ kind: 'public_source' as const }));
    await invokeGenericAgent(publicContext(), { ...f.deps, prepareDispatch });
    f.broadcast.mockClear();
    const result = await invokeGenericAgent(publicContext(), { ...f.deps, prepareDispatch });
    expect(result).toMatchObject({
      status: 409,
      body: { error: { code: 'agent_dispatch_exists' } },
    });
    expect(prepareDispatch).toHaveBeenCalledTimes(1);
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(f.broadcast).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('run');
  });

  it.each(['forbidden', 'cancelled', 'unconfirmed'])(
    'does not prepare a start that is %s',
    async (kind) => {
      const f = fixture();
      if (kind === 'forbidden')
        f.db.onRpc('record_generic_agent_run_start', () => ({ error: 'forbidden' }));
      else if (kind === 'cancelled')
        f.db.onRpc('record_generic_agent_run_start', () => ({
          run_id: RUN,
          created: true,
          status: 'cancelled',
        }));
      else f.db.failNextRpc('record_generic_agent_run_start');
      const prepareDispatch = vi.fn(async () => ({ kind: 'public_source' as const }));
      const result = await invokeGenericAgent(publicContext(), { ...f.deps, prepareDispatch });
      expect(result.status).toBe(kind === 'forbidden' ? 403 : 503);
      expect(prepareDispatch).not.toHaveBeenCalled();
      expect(f.fetchImpl).not.toHaveBeenCalled();
      expect(f.authHeaders).not.toHaveBeenCalled();
      expect(f.rpc).toHaveBeenCalledTimes(1);
      expect(f.broadcast).not.toHaveBeenCalled();
    },
  );

  it.each([
    { agent: 'sudhaar', mode: 'public_website' },
    { agent: 'drishti', mode: 'legacy_inventory' },
    { agent: 'vibhaag', mode: undefined },
  ])(
    'refuses source preparation for unsupported agent/mode $agent/$mode',
    async ({ agent, mode }) => {
      const f = fixture();
      const input = { ...publicContext(agent), input: { tenant_id: TENANT, mode } };
      const prepareDispatch = vi.fn(async () => ({ kind: 'public_source' as const }));
      const result = await invokeGenericAgent(input, { ...f.deps, prepareDispatch });
      expect(result).toMatchObject({
        status: 502,
        body: { error: { code: 'agent_invocation_failed', runtimeOutcome: 'unconfirmed' } },
      });
      expect(prepareDispatch).not.toHaveBeenCalled();
      expect(f.fetchImpl).not.toHaveBeenCalled();
      expect(f.authHeaders).not.toHaveBeenCalled();
      expect(result).not.toHaveProperty('run');
      expect(f.broadcast.mock.calls.at(-1)![0].step).toBe(`${agent}.outcome_unconfirmed`);
    },
  );

  it.each([
    null,
    { kind: 'generic' },
    { kind: 'public_source', path: 'https://foreign.invalid' },
    { kind: 'public_source', body: { tenant_id: FOREIGN } },
    { kind: 'public_source', headers: { Authorization: 'private-token' } },
  ])('rejects a malformed or expanded preparation selector %j', async (selector) => {
    const f = fixture();
    const prepareDispatch = vi.fn(async () => selector as unknown as { kind: 'public_source' });
    const result = await invokeGenericAgent(publicContext(), { ...f.deps, prepareDispatch });
    expect(result).toMatchObject({
      status: 502,
      body: { error: { runtimeOutcome: 'unconfirmed' } },
    });
    expect(prepareDispatch).toHaveBeenCalledTimes(1);
    expectNoDispatch(f, result);
  });

  it('keeps public-mode requests on the generic transport without trusted preparation', async () => {
    const f = fixture();
    await invokeGenericAgent(publicContext(), f.deps);
    expect(f.fetchImpl.mock.calls[0]![0]).toBe('http://runtime.invalid/agents/drishti/invoke');
    expect(JSON.parse(String(f.fetchImpl.mock.calls[0]![1]!.body))).toMatchObject({
      input: { mode: 'public_website' },
      dispatch_context: { run_id: RUN },
    });
  });
});

it('bounds the scoped human start and settlement RPC transports', async () => {
  const f = fixture();
  const signals: AbortSignal[] = [];
  f.rpc.mockImplementation((name, args) => {
    const call = f.db.client.rpc(name, args) as { abortSignal(signal: AbortSignal): unknown };
    const original = call.abortSignal.bind(call);
    call.abortSignal = (signal) => {
      signals.push(signal);
      return original(signal);
    };
    return call;
  });
  const out = await invokeGenericAgent(context(), f.deps);
  expect(out.status).toBe(200);
  expect(signals).toHaveLength(2);
  expect(signals.every((signal) => signal instanceof AbortSignal && !signal.aborted)).toBe(true);
});
