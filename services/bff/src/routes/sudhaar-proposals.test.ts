import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalJson } from '@axiom/ledger';
import { z } from 'zod';
import { Hono } from 'hono';
import {
  UserRole,
  sudhaarInputSchema,
  sudhaarProposalSchema,
  sudhaarReviewReason,
} from '@axiom/types';
import { createFakeDb } from '../test/fake-postgrest.js';
import { sudhaarProposalRoutes } from './sudhaar-proposals.js';
import { readSudhaarSource, signSudhaarDispatch } from '../services/sudhaar-proposals.js';
import type { EvidenceDatabase } from '../services/evidence-ingestion.js';
import type { Variables } from '../types.js';
const state = vi.hoisted(() => {
  Object.assign(process.env, {
    ENVIRONMENT: 'test',
    AXIOM_AUTH_MODE: 'strict',
    SUPABASE_URL: 'http://localhost:55321',
    SUPABASE_ANON_KEY: 'a'.repeat(40),
    SUPABASE_SERVICE_KEY: 'b'.repeat(40),
    APPROVAL_SIGNING_KEY: 'k'.repeat(48),
  });
  return {};
});
void state;
const TENANT = '11111111-1111-4111-8111-111111111111',
  ENG = '22222222-2222-4222-8222-222222222222',
  RUN = '33333333-3333-4333-8333-333333333333',
  ACTOR = '44444444-4444-4444-8444-444444444444',
  KEY = '55555555-5555-4555-8555-555555555555',
  DISPATCH = '66666666-6666-4666-8666-666666666666';
const secret = 'synthetic-only-key-' + 'x'.repeat(32);
const peerSecret = 'synthetic-peer-only-' + 'y'.repeat(32);
let db: ReturnType<typeof createFakeDb>,
  proof: boolean,
  calls: { name: string; args: Record<string, unknown> }[],
  halted: boolean,
  killUnreadable: boolean,
  fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
function seed() {
  const controls = [0, 1].map((i) => ({
    id: `C${i}`,
    title: `Control ${i}`,
    severity: 'critical',
    library_version: 'v1',
    sdf_only: false,
    children_only: false,
    assessment_questions: i ? [] : [{ id: 'Q', type: 'boolean' }],
  }));
  const digest = createHash('sha256').update(JSON.stringify(controls)).digest('hex');
  const result = {
    library_version: 'v1',
    posture_score: 30,
    estimated_exposure_inr: 100,
    findings: controls.map((c) => ({
      control_id: c.id,
      score: 30,
      risk_points: 7.5,
      rationale: 'Unknown answers; evidence needed.',
    })),
    questionnaire_provenance: {
      version: 1,
      source_library_version: 'v1',
      source_library_digest: digest,
      estimates: 'provisional',
      review_required: true,
      controls: controls.map((c) => ({
        control_id: c.id,
        questions: c.assessment_questions.map((q) => ({
          question_id: q.id,
          declaration: 'unknown',
        })),
        known_boolean_question_count: c.assessment_questions.length,
        caller_affirmed_count: 0,
        caller_denied_count: 0,
        unknown_count: c.assessment_questions.length,
        answer_state: c.assessment_questions.length ? 'unknown' : 'not_boolean_assessable',
        applicability_state: 'unconditional',
      })),
      applicability: {
        sdf_self_attested: { value: null, provenance: 'unknown' },
        processes_children: { value: null, provenance: 'unknown' },
        processes_health: { value: null, provenance: 'unknown' },
      },
    },
  };
  db.seed('engagements', { id: ENG, tenant_id: TENANT, library_version: 'v1' });
  db.seed('control_libraries', { version: 'v1', status: 'published', control_count: 2 });
  db.seed('workload_assessment_packets', {
    tenant_id: TENANT,
    engagement_id: ENG,
    run_id: RUN,
    library_version: 'v1',
    library_digest: digest,
    result_digest: 'b'.repeat(64),
    controls,
    result,
    finalized_receipt: '119',
    finalized_at: '2026-10-06T12:00:00.000Z',
  });
  for (let i = 0; i < 2; i++)
    db.seed('findings', {
      id: `77777777-7777-4777-8777-77777777777${i}`,
      tenant_id: TENANT,
      engagement_id: ENG,
      library_version: 'v1',
      ...result.findings[i],
    });
}
function result(body: Record<string, unknown>) {
  const envelope = JSON.parse(body.signed_text as string),
    input = sudhaarInputSchema.parse(JSON.parse(envelope.input_text));
  return {
    agent: 'sudhaar',
    correlation_id: KEY,
    status: 'succeeded',
    latency_ms: 1,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    error: null,
    ledger_entry_ids: ['120', '121'],
    output: {
      schema_version: 1,
      kind: 'remediation_proposal',
      title: input.title,
      source: input.source,
      persistence: 'not_saved',
      review_required: true,
      escalate: true,
      execution_allowed: false,
      review_tasks: input.findings.map((f, i) => ({
        sequence: i + 1,
        finding_id: f.finding_id,
        control_id: f.control_id,
        title: f.title,
        reason: sudhaarReviewReason(f),
        instruction:
          'Review the recorded questionnaire, applicability and supporting evidence before proposing corrective work. No finding is closed by this proposal.',
      })),
      provisional_actions: [],
      aggregate_records_affected: null,
      aggregate_systems: [],
    },
  };
}
function app(role: UserRole = UserRole.OWNER, sourceSigningKey: string | undefined = secret) {
  const instance = new Hono<{ Variables: Variables }>();
  instance.use('*', async (c, next) => {
    c.set('user', { id: ACTOR } as never);
    c.set('tenantId', TENANT);
    c.set('role', role);
    c.set('approvalScopes', []);
    await next();
  });
  instance.route(
    '/v1',
    sudhaarProposalRoutes({
      db: db.client as EvidenceDatabase,
      killSwitch: {
        isActive: async () => {
          if (killUnreadable) throw new Error('private-detail');
          return halted;
        },
      },
      runtimeUrl: 'http://runtime.invalid',
      runtimeToken: peerSecret,
      sourceSigningKey,
      realtime: { broadcast: vi.fn() },
      writerFactory: () => db.client as never,
      fetchImpl,
      authHeaders: async () => ({}),
    }),
  );
  return instance;
}
function request(
  options: {
    role?: UserRole;
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
  } = {},
) {
  return app(options.role).request('/v1/plans/proposals', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Idempotency-Key': KEY,
      'X-Expected-Actor-Id': ACTOR,
      ...options.headers,
    },
    body: JSON.stringify({
      operationKey: KEY,
      engagementId: ENG,
      assessmentRunId: RUN,
      ...options.body,
    }),
  });
}
beforeEach(() => {
  halted = false;
  killUnreadable = false;
  db = createFakeDb();
  proof = true;
  calls = [];
  seed();
  db.onRpc('board_assessment_source_valid', (args) => {
    calls.push({ name: 'proof', args });
    return proof;
  });
  db.onRpc('record_generic_agent_run_start', (args) => {
    calls.push({ name: 'start', args });
    return { run_id: DISPATCH, status: 'running', created: true };
  });
  db.onRpc('record_generic_agent_run_finish', (args) => {
    calls.push({ name: 'finish', args });
    return { run_id: DISPATCH, status: args.p_status, replayed: false };
  });
  fetchImpl = vi.fn<typeof fetch>(
    async (_url, init) =>
      new Response(JSON.stringify(result(JSON.parse(String(init?.body)))), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
});
describe('source-bound readonly Sudhaar proposals', () => {
  it('derives source IDs, signs actual runtime transport and returns review tasks without saved plans', async () => {
    const response = await request();
    expect(response.status).toBe(200);
    const body = z
      .object({ data: sudhaarProposalSchema, invocation: z.object({ runId: z.uuid() }) })
      .parse(await response.json());
    expect(body.data).toMatchObject({
      review_required: true,
      execution_allowed: false,
      persistence: 'not_saved',
      provisional_actions: [],
      aggregate_records_affected: null,
    });
    expect(body.data.review_tasks.map((t: { reason: string }) => t.reason)).toEqual([
      'questionnaire_incomplete',
      'evidence_required',
    ]);
    expect(body.invocation.runId).toBe(DISPATCH);
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      'http://runtime.invalid/assessment-source/sudhaar/invoke',
    );
    const wire = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body));
    expect(wire.signature).toBe(
      createHmac('sha256', secret)
        .update('axiom-sudhaar-source-v1\0')
        .update(wire.signed_text)
        .digest('hex'),
    );
    const payload = JSON.parse(wire.signed_text);
    expect(payload.dispatch_context).toEqual({
      run_id: DISPATCH,
      request_hash: calls.find((c) => c.name === 'start')!.args.p_request_hash,
    });
    expect(createHash('sha256').update(payload.input_text).digest('hex')).toBe(
      payload.dispatch_context.request_hash,
    );
    expect(calls.map((c) => c.name)).toEqual(['proof', 'start', 'finish']);
    expect(calls.at(-1)!.args.p_status).toBe('succeeded');
    for (const table of ['remediation_plans', 'remediation_actions', 'evidence'])
      expect(db.rows(table)).toHaveLength(0);
  });
  it.each([UserRole.VIEWER, UserRole.APPROVER, UserRole.REVIEWER])(
    'refuses %s before source lookup',
    async (role) => {
      expect((await request({ role })).status).toBe(403);
      expect(calls).toHaveLength(0);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );
  it.each(['actor', 'key', 'findings', 'scope', 'cap', 'proof', 'credential'])(
    'refuses caller authority or source override %s',
    async (mode) => {
      const body: Record<string, unknown> = {},
        headers: Record<string, string> = {};
      if (mode === 'actor') headers['X-Expected-Actor-Id'] = ENG;
      if (mode === 'key') headers['Idempotency-Key'] = ENG;
      if (mode === 'findings') body.findings = [];
      if (mode === 'scope') body.scope_hints = {};
      if (mode === 'cap') body.blast_radius_cap_records = 1e20;
      if (mode === 'proof') body.source = {};
      if (mode === 'credential') body.approval_token = 'forged';
      expect((await request({ body, headers })).status).toBe(mode === 'actor' ? 409 : 400);
      expect(calls).toHaveLength(0);
    },
  );
  it('rechecks source on every replay instead of returning a cached success', async () => {
    expect((await request()).status).toBe(200);
    proof = false;
    expect((await request()).status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.name === 'proof')).toHaveLength(2);
  });
  it.each([
    'foreign',
    'duplicate',
    'score',
    'risk',
    'rationale',
    'library',
    'missing',
    'metadata',
    'unfinalized',
  ])('refuses corrupt/foreign source %s before invocation', async (mode) => {
    const row = db.rows('findings')[0]!,
      packet = db.rows('workload_assessment_packets')[0]!;
    if (mode === 'foreign') row.tenant_id = ENG;
    if (mode === 'duplicate') db.rows('findings').push({ ...row });
    if (mode === 'score') row.score = 90;
    if (mode === 'risk') row.risk_points = 0;
    if (mode === 'rationale') row.rationale = 'changed';
    if (mode === 'library') packet.library_version = 'foreign';
    if (mode === 'missing') db.rows('findings').pop();
    if (mode === 'metadata')
      (packet.result as Record<string, unknown>).questionnaire_provenance = null;
    if (mode === 'unfinalized') proof = false;
    expect([409, 503]).toContain((await request()).status);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(calls.some((c) => c.name === 'start')).toBe(false);
  });
  it.each(['source', 'finding', 'reason', 'action', 'execution', 'review', 'scope'])(
    'validates runtime output BEFORE successful settlement: %s',
    async (mode) => {
      fetchImpl.mockImplementation(async (_url, init) => {
        const value = result(JSON.parse(String(init?.body)));
        if (mode === 'source') value.output.source.resultDigest = 'f'.repeat(64);
        if (mode === 'finding') value.output.review_tasks[0]!.finding_id = ENG;
        if (mode === 'reason') value.output.review_tasks[0]!.reason = 'declarations_unverified';
        if (mode === 'action')
          (value.output.provisional_actions as unknown[]).push({ action_type: 'data.delete' });
        if (mode === 'execution') value.output.execution_allowed = true;
        if (mode === 'review') value.output.review_required = false;
        if (mode === 'scope')
          (value.output as unknown as Record<string, unknown>).aggregate_records_affected = 0;
        return new Response(JSON.stringify(value));
      });
      expect((await request()).status).not.toBe(200);
      expect(calls.some((c) => c.name === 'finish' && c.args.p_status === 'succeeded')).toBe(false);
    },
  );
  it('marks historical absent provenance unavailable without deriving answers from score', async () => {
    delete (db.rows('workload_assessment_packets')[0]!.result as Record<string, unknown>)
      .questionnaire_provenance;
    const source = await readSudhaarSource(
      db.client as EvidenceDatabase,
      TENANT,
      ENG,
      RUN,
      'Review',
    );
    expect(
      source.findings.every((f) => f.answer_state === 'unavailable' && f.answer_counts === null),
    ).toBe(true);
  });
  it('refuses absent or weak transport signing configuration', () => {
    expect(() =>
      signSudhaarDispatch(
        { runId: DISPATCH, requestHash: 'a'.repeat(64), wireInput: '{}', correlationId: KEY },
        'short',
        peerSecret,
      ),
    ).toThrow();
  });
});

describe('shared synthetic TypeScript/Python proposal vector', () => {
  it('signs the exact 46-control/65-unknown-question fixture with no mutable action claims', () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL('../../../../tests/contracts/sudhaar-source.v1.json', import.meta.url),
        'utf8',
      ),
    );
    const input = sudhaarInputSchema.parse(fixture.input);
    const wireInput = canonicalJson(input);
    const payload = JSON.parse(fixture.envelope.signed_text);
    expect(
      signSudhaarDispatch(
        {
          runId: payload.dispatch_context.run_id,
          requestHash: createHash('sha256').update(wireInput).digest('hex'),
          wireInput,
          correlationId: payload.correlation_id,
        },
        'synthetic-only-key-' + 'x'.repeat(32),
        peerSecret,
        fixture.nowSeconds * 1000,
      ),
    ).toEqual(fixture.envelope);
    const result = sudhaarProposalSchema.parse(fixture.expectedOutput);
    expect(result.review_tasks).toHaveLength(46);
    expect(result.review_tasks.filter((t) => t.reason === 'questionnaire_incomplete')).toHaveLength(
      44,
    );
    expect(result.review_tasks.filter((t) => t.reason === 'evidence_required')).toHaveLength(2);
    expect(input.findings.reduce((n, f) => n + (f.answer_counts?.unknown ?? 0), 0)).toBe(65);
    expect(result.provisional_actions).toEqual([]);
  });
});

it.each(['active', 'unavailable'])(
  'refuses planning when kill state is %s before source reads or audit writes',
  async (mode) => {
    halted = mode === 'active';
    killUnreadable = mode === 'unavailable';
    const response = await request();
    expect(response.status).toBe(mode === 'active' ? 423 : 503);
    expect(calls).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain('private-detail');
  },
);

it.each([0, 100])(
  'does not treat a numerical score of %s as confirmed failure or compliance',
  async (score) => {
    const packet = db.rows('workload_assessment_packets')[0]!;
    const resultRows = (packet.result as { findings: { score: number }[] }).findings;
    for (const row of db.rows('findings')) row.score = score;
    for (const row of resultRows) row.score = score;
    const response = await request();
    expect(response.status).toBe(200);
    const body = z.object({ data: sudhaarProposalSchema }).parse(await response.json());
    expect(body.data.review_tasks.map((t: { reason: string }) => t.reason)).toEqual([
      'questionnaire_incomplete',
      'evidence_required',
    ]);
    expect(body.data.provisional_actions).toEqual([]);
  },
);
it('supports an exact deprecated pinned library without accepting a draft library', async () => {
  db.rows('control_libraries')[0]!.status = 'deprecated';
  expect((await request()).status).toBe(200);
  db.rows('control_libraries')[0]!.status = 'draft';
  expect((await request()).status).toBe(409);
});
it('refuses source verifier transport failure without a business success or dispatch', async () => {
  db.failNextRpc('board_assessment_source_valid');
  expect((await request()).status).toBe(503);
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(calls.some((c) => c.name === 'start')).toBe(false);
});

it.each(['absent', 'weak', 'equal'])(
  'fails closed before source lookup for %s source signing configuration',
  async (mode) => {
    const signingKey = mode === 'absent' ? '' : mode === 'weak' ? 'short' : peerSecret;
    const response = await app(UserRole.OWNER, signingKey).request('/v1/plans/proposals', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': KEY,
        'X-Expected-Actor-Id': ACTOR,
      },
      body: JSON.stringify({ operationKey: KEY, engagementId: ENG, assessmentRunId: RUN }),
    });
    expect(response.status).toBe(503);
    expect(calls).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  },
);
it('refuses equal peer/source keys even through the trusted signing helper', () => {
  expect(() =>
    signSudhaarDispatch(
      { runId: DISPATCH, requestHash: 'a'.repeat(64), wireInput: '{}', correlationId: KEY },
      peerSecret,
      peerSecret,
    ),
  ).toThrow();
});

describe('read-only proposal source choices', () => {
  beforeEach(() => {
    db.rows('engagements')[0]!.title = 'Owned assessment';
  });
  it('lists scoped metadata without verifying or transporting all source findings', async () => {
    const res = await app().request('/v1/plans/proposal-assessment-options');
    expect(res.status).toBe(200);
    const body = z
      .object({ assessments: z.array(z.unknown()), runtimeAvailable: z.boolean() })
      .parse(await res.json());
    expect(body.assessments).toEqual([
      {
        assessmentRunId: RUN,
        engagementId: ENG,
        engagementTitle: 'Owned assessment',
        libraryVersion: 'v1',
        finalizedAt: '2026-10-06T12:00:00.000Z',
      },
    ]);
    expect(body.runtimeAvailable).toBe(true);
    expect(calls).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('keeps source choices available but identifies missing execution configuration', async () => {
    const res = await app(UserRole.OWNER, '').request('/v1/plans/proposal-assessment-options');
    expect(res.status).toBe(200);
    expect(
      z.object({ runtimeAvailable: z.boolean() }).parse(await res.json()).runtimeAvailable,
    ).toBe(false);
  });
  it('viewer cannot list or read proposal source facts', async () => {
    for (const path of [
      '/v1/plans/proposal-assessment-options',
      `/v1/plans/proposal-assessment-source/${RUN}?engagementId=${ENG}`,
    ])
      expect((await app(UserRole.VIEWER).request(path)).status).toBe(403);
    expect(calls).toEqual([]);
  });
  it('selected source verifies pinned ownership and finalization without invoking', async () => {
    const res = await app().request(
      `/v1/plans/proposal-assessment-source/${RUN}?engagementId=${ENG}`,
    );
    expect(res.status).toBe(200);
    const { input } = z.object({ input: sudhaarInputSchema }).parse(await res.json());
    expect(input.tenant_id).toBe(TENANT);
    expect(input.source.assessmentRunId).toBe(RUN);
    expect(input.findings).toHaveLength(2);
    expect(calls.map((c) => c.name)).toEqual(['proof']);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(['proof', 'foreign', 'malformed'])(
    'selected source refuses %s and exposes no facts',
    async (fault) => {
      if (fault === 'proof') proof = false;
      const run = fault === 'foreign' ? DISPATCH : fault === 'malformed' ? 'invalid' : RUN;
      const res = await app().request(
        `/v1/plans/proposal-assessment-source/${run}?engagementId=${ENG}`,
      );
      expect(res.status).toBe(fault === 'malformed' ? 400 : 503);
      expect(await res.json()).not.toHaveProperty('input');
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );
  it('source read errors remain unavailable rather than false empty success', async () => {
    db.failNext('workload_assessment_packets');
    const res = await app().request('/v1/plans/proposal-assessment-options');
    expect(res.status).toBe(503);
    expect(await res.json()).not.toHaveProperty('assessments');
  });
});

it.each(['limit=0', 'limit=26', 'offset=-1', 'offset=1.5', 'offset=1000001', 'extra=secret'])(
  'refuses unbounded or unknown source pagination: %s',
  async (query) => {
    const res = await app().request(`/v1/plans/proposal-assessment-options?${query}`);
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  },
);
it('reads later bounded source pages without source facts or runtime invocation', async () => {
  db.rows('engagements')[0]!.title = 'Owned assessment';
  const packet = db.rows('workload_assessment_packets')[0]!;
  for (let i = 0; i < 30; i++)
    db.seed('workload_assessment_packets', {
      ...packet,
      run_id: `77777777-7777-4777-8777-${String(i).padStart(12, '0')}`,
      finalized_at: '2026-10-08T00:00:00Z',
    });
  const res = await app().request('/v1/plans/proposal-assessment-options?limit=25&offset=25');
  expect(res.status).toBe(200);
  const page = z
    .object({
      assessments: z.array(z.unknown()),
      limit: z.number(),
      offset: z.number(),
      total: z.number(),
    })
    .parse(await res.json());
  expect(page.limit).toBe(25);
  expect(page.offset).toBe(25);
  expect(page.total).toBe(31);
  expect(page.assessments).toHaveLength(6);
  expect(page.assessments).toContainEqual(expect.objectContaining({ assessmentRunId: RUN }));
  expect(calls).toEqual([]);
  expect(fetchImpl).not.toHaveBeenCalled();
});
