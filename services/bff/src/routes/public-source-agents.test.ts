import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { canonicalJson, sha256 } from '@axiom/ledger';
import { UserRole } from '@axiom/types';
import type { Variables } from '../types.js';
import type {
  GenericAgentInvocationContext,
  GenericAgentInvocationDeps,
} from '../services/generic-agent-invocation.js';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), invoke: vi.fn(), broadcast: vi.fn() }));
vi.mock('@axiom/supabase', () => ({ createHumanActionWriter: () => ({ rpc: mocks.rpc }) }));
vi.mock('../services/generic-agent-invocation.js', () => ({ invokeGenericAgent: mocks.invoke }));
import { publicSourceAgentRoutes } from './public-source-agents.js';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const ENGAGEMENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BINDING = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const RUN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DISPATCH = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OBSERVATION = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const binding = {
  tenant_id: TENANT,
  engagement_id: ENGAGEMENT,
  check_id: BINDING,
  root_content_sha256: 'a'.repeat(64),
  projection_sha256: 'b'.repeat(64),
  projection_version: 1,
};
const root = { page: 'root', status: 'checked', content_sha256: 'a'.repeat(64) };
const input = {
  mode: 'public_website',
  tenant_id: TENANT,
  engagement_id: ENGAGEMENT,
  source: { version: 1, binding, pages: [root] },
};
const privateFacts = {
  hosting_region: 'unknown',
  backend_personal_data: 'unknown',
  cross_border_processing: 'unknown',
};
const output = {
  mode: 'public_website',
  observation: {
    version: 1,
    binding,
    pages: [{ ...root, form_state: 'unexamined' }],
    private_facts: privateFacts,
    requires_human_review: true,
  },
};
const classificationInput = {
  mode: 'public_website',
  tenant_id: TENANT,
  engagement_id: ENGAGEMENT,
  source_binding: binding,
  observation: output.observation,
};
const classificationOutput = {
  mode: 'public_website',
  source_binding: binding,
  indicators: [],
  private_facts: privateFacts,
  unexamined_pages: ['root'],
  unavailable_pages: [],
  scope_limited: true,
};
const request = { engagementId: ENGAGEMENT, expectedProjectionSha256: binding.projection_sha256 };

function app(role: UserRole = UserRole.OWNER, actor = ACTOR, tenant = TENANT, configured = true) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: actor } as never);
    c.set('role', role);
    c.set('tenantId', tenant);
    c.set('idempotencyKey', c.req.header('Idempotency-Key') ?? '');
    await next();
  });
  app.route(
    '/v1',
    publicSourceAgentRoutes({
      runtimeUrl: configured ? 'http://runtime.invalid' : undefined,
      runtimeToken: configured ? 'test-fixture-token' : undefined,
      realtime: { broadcast: mocks.broadcast },
    }),
  );
  return app;
}
function post(
  role: UserRole = UserRole.OWNER,
  body: unknown = request,
  agent = 'drishti',
  key = 'source-agent-request',
  actor = ACTOR,
  tenant = TENANT,
) {
  return app(role, actor, tenant).request(
    `/v1/public-source-bindings/${BINDING}/agents/${agent}/run`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(body),
    },
  );
}
const get = (role: UserRole = UserRole.VIEWER) =>
  app(role).request(`/v1/public-source-observations/${OBSERVATION}?engagementId=${ENGAGEMENT}`);
const rpc = (name: string) => mocks.rpc.mock.calls.find((call) => call[0] === name)?.[1];

beforeEach(async () => {
  mocks.rpc.mockReset();
  mocks.invoke.mockReset();
  mocks.broadcast.mockReset();
  mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === 'get_public_source_agent_input')
      return {
        data: {
          binding_id: BINDING,
          ...(args.p_agent === 'vibhaag'
            ? { input: classificationInput, observation_id: OBSERVATION }
            : { input }),
        },
        error: null,
      };
    if (name === 'record_public_source_dispatch')
      return { data: { dispatch_id: DISPATCH, created: true, replayed: false }, error: null };
    const actualOutput = name === 'record_public_source_observation' ? args.p_output : output;
    const identity = {
      observation_id: OBSERVATION,
      dispatch_id: DISPATCH,
      output_sha256: await sha256(canonicalJson(actualOutput)),
      completion_receipt: '12',
    };
    if (name === 'record_public_source_observation')
      return { data: { ...identity, created: true, replayed: false }, error: null };
    if (name === 'get_public_source_observation')
      return {
        data: {
          ...identity,
          binding_id: BINDING,
          run_id: RUN,
          agent: 'drishti',
          output: actualOutput,
        },
        error: null,
      };
    throw new Error('unexpected test RPC');
  });
  mocks.invoke.mockImplementation(
    async (context: GenericAgentInvocationContext, deps: GenericAgentInvocationDeps) => {
      const canonicalInput = canonicalJson(context.input),
        requestHash = await sha256(canonicalInput);
      await deps.prepareDispatch!({ ...context, runId: RUN, requestHash, canonicalInput });
      const result = context.agent === 'drishti' ? output : classificationOutput;
      return {
        status: 200,
        body: {
          agent: context.agent,
          correlation_id: context.correlationId,
          status: 'succeeded',
          latency_ms: 2,
          input_tokens: 0,
          output_tokens: 0,
          cost_usd: 0,
          error: null,
          output: result,
          ledger_entry_ids: ['11', '12'],
        },
        run: {
          runId: RUN,
          correlationId: context.correlationId,
          requestHash,
          responseHash: await sha256(canonicalJson(result)),
        },
      };
    },
  );
});

describe('dedicated stored public agent workflow', () => {
  it.each([UserRole.OWNER, UserRole.ADMIN, UserRole.FOUNDER, UserRole.AXIOM_ANALYST])(
    'allows operator %s with SQL as live authority',
    async (role) => {
      const response = await post(role);
      expect(response.status).toBe(201);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      expect(await response.json()).toMatchObject({
        data: {
          observation_id: OBSERVATION,
          dispatch_id: DISPATCH,
          binding_id: BINDING,
          run_id: RUN,
          agent: 'drishti',
          output,
          completion_receipt: '12',
        },
      });
      expect(rpc('get_public_source_agent_input')).toMatchObject({
        p_actor_id: ACTOR,
        p_tenant_id: TENANT,
        p_engagement_id: ENGAGEMENT,
        p_binding_id: BINDING,
        p_observation_id: null,
      });
      expect(rpc('record_public_source_dispatch')).toMatchObject({
        p_run_id: RUN,
        p_input: input,
        p_input_utf8: canonicalJson(input),
      });
      expect(rpc('record_public_source_observation')).toMatchObject({
        p_output: output,
        p_output_utf8: canonicalJson(output),
      });
    },
  );

  it.each([
    UserRole.VIEWER,
    UserRole.REVIEWER,
    UserRole.APPROVER,
    UserRole.PARTNER,
    UserRole.AGENT,
  ])('refuses nonoperator %s before source read', async (role) => {
    expect((await post(role)).status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('uses only a stored Drishti observation for Vibhaag', async () => {
    const response = await post(
      UserRole.OWNER,
      { ...request, observationId: OBSERVATION },
      'vibhaag',
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      data: { agent: 'vibhaag', output: classificationOutput },
    });
    expect(rpc('get_public_source_agent_input')).toMatchObject({ p_observation_id: OBSERVATION });
    expect(mocks.invoke.mock.calls[0]![0].input).toEqual(classificationInput);
  });

  it('keeps the same actor request correlation across lost responses and scopes different actors', async () => {
    await post();
    await post();
    await post(UserRole.OWNER, request, 'drishti', 'source-agent-request', RUN);
    const contexts = mocks.invoke.mock.calls.map(
      (call) => call[0] as GenericAgentInvocationContext,
    );
    expect(contexts[0]!.correlationId).toBe(contexts[1]!.correlationId);
    expect(contexts[0]!.correlationId).not.toBe(contexts[2]!.correlationId);
  });

  it.each([
    { ...request, systems: [] },
    { ...request, field_hints: {} },
    { ...request, input },
    { ...request, observation: output.observation },
    { ...request, engagementId: 'invalid' },
    { ...request, observationId: OBSERVATION },
  ])('rejects caller facts or invalid request %#', async (body) => {
    expect((await post(UserRole.OWNER, body)).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('requires idempotency and a stored discovery for classification', async () => {
    expect((await post(UserRole.OWNER, request, 'drishti', '')).status).toBe(400);
    expect((await post(UserRole.OWNER, request, 'vibhaag')).status).toBe(400);
    for (const name of ['karya', 'prativedan', 'unknown'])
      expect((await post(UserRole.OWNER, request, name)).status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('refuses stale reviewed source before lifecycle creation', async () => {
    expect(
      (await post(UserRole.OWNER, { ...request, expectedProjectionSha256: '0'.repeat(64) })).status,
    ).toBe(409);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it.each(['tenant', 'engagement', 'binding', 'observation'])(
    'refuses a mismatched stored input %s',
    async (kind) => {
      const loaded = {
        binding_id: BINDING,
        input: structuredClone(input),
        observation_id: undefined as string | undefined,
      };
      if (kind === 'tenant') {
        loaded.input.tenant_id = RUN;
        loaded.input.source.binding.tenant_id = RUN;
      }
      if (kind === 'engagement') {
        loaded.input.engagement_id = RUN;
        loaded.input.source.binding.engagement_id = RUN;
      }
      if (kind === 'binding') loaded.binding_id = RUN;
      if (kind === 'observation') loaded.observation_id = RUN;
      if (loaded.observation_id === undefined)
        delete (loaded as { observation_id?: string }).observation_id;
      mocks.rpc.mockResolvedValueOnce({ data: loaded, error: null });
      expect((await post()).status).toBe(503);
      expect(mocks.invoke).not.toHaveBeenCalled();
    },
  );

  it('requires configured runtime and confirmed source preparation', async () => {
    const response = await app(UserRole.OWNER, ACTOR, TENANT, false).request(
      `/v1/public-source-bindings/${BINDING}/agents/drishti/run`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'source-agent-request' },
        body: JSON.stringify(request),
      },
    );
    expect(response.status).toBe(503);
    expect(mocks.rpc).not.toHaveBeenCalled();
    mocks.rpc.mockImplementation(async (name: string) => ({
      data:
        name === 'get_public_source_agent_input'
          ? { input, binding_id: BINDING }
          : { error: 'dispatch_conflict' },
      error: null,
    }));
    expect((await post()).status).toBe(503);
    expect(rpc('record_public_source_observation')).toBeUndefined();
  });

  it('does not persist an unconfirmed runtime outcome or forged source output', async () => {
    mocks.invoke.mockResolvedValueOnce({
      status: 503,
      body: { error: { code: 'agent_completion_unconfirmed', runId: RUN } },
    });
    expect((await post()).status).toBe(503);
    expect(rpc('record_public_source_observation')).toBeUndefined();
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      result.body.output = {
        ...output,
        observation: {
          ...output.observation,
          binding: { ...binding, projection_sha256: '0'.repeat(64) },
        },
      };
      return result;
    });
    expect((await post()).status).toBe(502);
    expect(rpc('record_public_source_observation')).toBeUndefined();
  });

  it.each(['dispatch', 'digest', 'receipt', 'flags', 'throw'])(
    'never exposes unconfirmed persisted output: %s',
    async (kind) => {
      const original = mocks.rpc.getMockImplementation()!;
      mocks.rpc.mockImplementation(async (...args) => {
        const result = await original(...args);
        if (args[0] === 'record_public_source_observation') {
          if (kind === 'throw') throw new Error('provider-private-sentinel');
          if (kind === 'dispatch') result.data.dispatch_id = RUN;
          if (kind === 'digest') result.data.output_sha256 = '0'.repeat(64);
          if (kind === 'receipt') result.data.completion_receipt = '13';
          if (kind === 'flags') result.data.created = result.data.replayed = true;
        }
        return result;
      });
      const response = await post();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: { code: 'public_source_observation_unconfirmed', runId: RUN },
      });
    },
  );

  it('allows viewer reload with output integrity and scoped human identity', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { output } });
    expect(rpc('get_public_source_observation')).toEqual({
      p_tenant_id: TENANT,
      p_actor_id: ACTOR,
      p_engagement_id: ENGAGEMENT,
      p_observation_id: OBSERVATION,
    });
  });

  it.each(['identity', 'tenant', 'digest'])(
    'refuses a poisoned observation reload %s',
    async (kind) => {
      const data = {
        observation_id: OBSERVATION,
        dispatch_id: DISPATCH,
        binding_id: BINDING,
        run_id: RUN,
        agent: 'drishti',
        output: structuredClone(output),
        output_sha256: await sha256(canonicalJson(output)),
        completion_receipt: '12',
      };
      if (kind === 'identity') data.observation_id = RUN;
      if (kind === 'tenant') data.output.observation.binding.tenant_id = RUN;
      if (kind === 'digest') data.output_sha256 = '0'.repeat(64);
      mocks.rpc.mockResolvedValueOnce({ data, error: null });
      expect((await get()).status).toBe(503);
    },
  );
});
