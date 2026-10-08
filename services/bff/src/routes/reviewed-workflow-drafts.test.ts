import { beforeEach, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { canonicalJson, sha256 } from '@axiom/ledger';
import { UserRole } from '@axiom/types';
import { createFakeDb } from '../test/fake-postgrest.js';
import { reviewedWorkflowDraftRoutes } from './reviewed-workflow-drafts.js';
import type { Variables } from '../types.js';
const setup = vi.hoisted(() => {
  Object.assign(process.env, {
    ENVIRONMENT: 'test',
    AXIOM_AUTH_MODE: 'strict',
    SUPABASE_URL: 'http://localhost:55321',
    SUPABASE_ANON_KEY: 'a'.repeat(40),
    SUPABASE_SERVICE_KEY: 'b'.repeat(40),
    APPROVAL_SIGNING_KEY: 'k'.repeat(48),
  });
});
void setup;
const fixture = JSON.parse(
  readFileSync('../../packages/types/src/__fixtures__/reviewed-workflow-drafts.json', 'utf8'),
);
const input = fixture.input,
  output = fixture.output,
  actor = '77777777-7777-4777-8777-777777777777',
  key = '88888888-8888-4888-8888-888888888888',
  run = '99999999-9999-4999-8999-999999999999',
  ackKey = '60000000-0000-4000-8000-000000000006';
let db: ReturnType<typeof createFakeDb>,
  saved: Record<string, unknown> | null,
  calls: ReturnType<typeof vi.fn<typeof fetch>>,
  capture: ReturnType<typeof vi.fn<(args: Record<string, unknown>) => Record<string, unknown>>>,
  start: ReturnType<typeof vi.fn<(args: Record<string, unknown>) => Record<string, unknown>>>,
  halted: boolean,
  peerOutput: unknown;
beforeEach(() => {
  db = createFakeDb();
  saved = null;
  halted = false;
  peerOutput = structuredClone(output);
  db.onRpc('read_reviewed_workflow_sources', () => ({ records: input.records }));
  db.onRpc('recover_reviewed_workflow_output', () => saved ?? { missing: true });
  start = vi.fn((_args: Record<string, unknown>) => ({
    run_id: run,
    created: true,
    status: 'running',
  }));
  db.onRpc('start_reviewed_workflow_dispatch', start);
  capture = vi.fn((args: Record<string, unknown>) => {
    saved = {
      run_id: run,
      input_hash: args.p_request_hash,
      output_hash: args.p_response_hash,
      output_text: args.p_output_text,
      requested_receipt: '1',
      started_receipt: '2',
      completed_receipt: '3',
      settled_receipt: '4',
    };
    return { run_id: run, status: 'succeeded', replayed: false };
  });
  db.onRpc('settle_reviewed_workflow_output', capture);
  db.onRpc('record_generic_agent_run_finish', () => ({
    run_id: run,
    status: 'failed',
    replayed: false,
  }));
  calls = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          agent: 'vibhaag',
          correlation_id: key,
          status: 'succeeded',
          latency_ms: 1,
          input_tokens: 0,
          output_tokens: 0,
          cost_usd: 0,
          error: null,
          output: peerOutput,
          ledger_entry_ids: ['2', '3'],
        }),
        { status: 200 },
      ),
  );
});
function app(role: Variables['role'] = UserRole.OWNER) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: actor, email: 'synthetic@example.invalid' } as Variables['user']);
    c.set('tenantId', input.tenant_id);
    c.set('role', role);
    await next();
  });
  app.route(
    '/v1',
    reviewedWorkflowDraftRoutes({
      runtimeUrl: 'http://runtime.invalid',
      runtimeToken: 'test-peer-secret',
      writerFactory: () => db.client as never,
      fetchImpl: calls as never,
      authHeaders: async () => ({}),
      realtime: { broadcast: vi.fn() },
      killSwitch: { isActive: async () => halted },
    }),
  );
  return app;
}
function body() {
  return {
    engagementId: input.engagement_id,
    recordIds: input.records.map((r: { id: string }) => r.id),
    sourceDigest: input.source_records_sha256,
    operationKey: key,
    confirmSourceReview: true,
  };
}
function post(
  payload: unknown = body(),
  headers: Record<string, string> = {},
  path = '/v1/reviewed-workflows/runs',
  operationKey = key,
) {
  return app().request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': operationKey,
      'X-Expected-Actor-Id': actor,
      ...headers,
    },
    body: JSON.stringify(payload),
  });
}
it('invokes only IDs at protected peer, captures exact source-bound output and recovers lost success without a second run', async () => {
  const response = await post();
  expect(response.status).toBe(201);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(((await response.json()) as { data: unknown }).data).toEqual(output);
  expect(calls.mock.calls[0]?.[0]).toBe(
    'http://runtime.invalid/reviewed-workflows/agents/vibhaag/invoke',
  );
  expect(JSON.parse(String(calls.mock.calls[0]?.[1]?.body))).toEqual({
    tenant_id: input.tenant_id,
    run_id: run,
    operation_key: key,
  });
  expect(capture.mock.calls[0]?.[0]).toMatchObject({
    p_input_text: canonicalJson(input),
    p_output_text: canonicalJson(output),
  });
  expect((await post()).status).toBe(200);
  expect(calls).toHaveBeenCalledTimes(1);
  expect(start).toHaveBeenCalledTimes(1);
});
it.each(['actor', 'key', 'source', 'confirmation', 'extra'])(
  'refuses %s drift before requesting work',
  async (change) => {
    const request: Record<string, unknown> = body();
    const headers: Record<string, string> = {};
    if (change === 'actor') headers['X-Expected-Actor-Id'] = run;
    else if (change === 'key') headers['Idempotency-Key'] = run;
    else if (change === 'source') request.sourceDigest = 'f'.repeat(64);
    else if (change === 'confirmation') request.confirmSourceReview = false;
    else request.sourceNote = 'Caller invented fact';
    expect([400, 409]).toContain((await post(request, headers)).status);
    expect(start).not.toHaveBeenCalled();
    expect(calls).not.toHaveBeenCalled();
  },
);
it('current kill and viewer role gates precede source reads or peer work', async () => {
  halted = true;
  expect((await post()).status).toBe(423);
  halted = false;
  expect(
    (
      await app(UserRole.VIEWER).request('/v1/reviewed-workflows/runs', {
        method: 'POST',
        headers: { 'X-Expected-Actor-Id': actor },
        body: JSON.stringify(body()),
      })
    ).status,
  ).toBe(403);
  expect(start).not.toHaveBeenCalled();
  expect(calls).not.toHaveBeenCalled();
});
it('added claims are refused before successful capture, never returned as a review draft', async () => {
  const altered = structuredClone(output);
  altered.policy_drafts[0].content += '\nEverything is independently verified compliant.';
  peerOutput = altered;
  expect((await post()).status).not.toBe(201);
  expect(capture).not.toHaveBeenCalled();
  expect(saved).toBeNull();
});
it('uncertain existing run does not mint another run or retry agent work', async () => {
  db.onRpc('recover_reviewed_workflow_output', () => ({ error: 'output_unrecoverable' }));
  expect((await post()).status).toBe(409);
  expect(start).not.toHaveBeenCalled();
  expect(calls).not.toHaveBeenCalled();
});
it('source GET reveals only retained declaration input after actor check', async () => {
  const url =
    '/v1/reviewed-workflows/source?' +
    new URLSearchParams({
      engagementId: input.engagement_id,
      recordIds: body().recordIds.join(','),
    });
  const response = await app().request(url, { headers: { 'X-Expected-Actor-Id': actor } });
  expect(response.status).toBe(200);
  expect(((await response.json()) as { input: unknown }).input).toEqual(input);
  expect((await app().request(url, { headers: { 'X-Expected-Actor-Id': run } })).status).toBe(409);
});
it('explicit separate acknowledgement adopts only a selected server-proven policy with exact original body and new key', async () => {
  await post();
  const acknowledgement = {
    runId: run,
    outputHash: await sha256(canonicalJson(output)),
    policyIndex: 0,
    reason: 'Reviewed exact unverified source; legal decision is separate',
    confirmReview: true,
  };
  const manifest = {
    kind: 'reviewed_workflow_acknowledgement_recorded',
    tenantId: input.tenant_id,
    actorId: actor,
    operationKey: ackKey,
    originalOperationKey: key,
    runId: run,
    inputHash: await sha256(canonicalJson(input)),
    outputHash: await sha256(canonicalJson(output)),
    sourceDigest: input.source_records_sha256,
    bodyHash: await sha256(canonicalJson(acknowledgement)),
    acknowledgementId: ackKey,
    receiptId: '6',
    policyIndex: 0,
    policyDraftId: run,
    policyReceipt: '5',
    initialPolicyStatus: 'draft',
    currentPolicyStatus: 'draft',
    requestedReceipt: '1',
    startedReceipt: '2',
    completedReceipt: '3',
    settledReceipt: '4',
  };
  const acknowledge = vi.fn((_args: Record<string, unknown>) => ({
    acknowledgement_id: ackKey,
    receipt_id: '6',
    policy_draft_id: run,
    replayed: false,
    manifest,
  }));
  db.onRpc('acknowledge_reviewed_workflow_output', acknowledge);
  const payload = { ...body(), operationKey: ackKey, originalOperationKey: key, acknowledgement };
  delete (payload as Record<string, unknown>).confirmSourceReview;
  const response = await post(payload, {}, '/v1/reviewed-workflows/acknowledgements', ackKey);
  expect(response.status).toBe(201);
  expect(acknowledge.mock.calls[0]?.[0]).toMatchObject({
    p_actor_id: actor,
    p_original_operation_key: key,
    p_operation_key: ackKey,
    p_input_text: canonicalJson(input),
    p_body_text: canonicalJson(acknowledgement),
  });
  const changed = {
    ...payload,
    acknowledgement: { ...acknowledgement, outputHash: 'f'.repeat(64) },
  };
  expect((await post(changed, {}, '/v1/reviewed-workflows/acknowledgements', ackKey)).status).toBe(
    409,
  );
  expect(acknowledge).toHaveBeenCalledTimes(1);
  const readOnly = vi.fn(() => ({ missing: true }));
  db.onRpc('recover_reviewed_workflow_acknowledgement', readOnly);
  expect(
    (
      await post(
        { ...payload, readOnly: true },
        {},
        '/v1/reviewed-workflows/acknowledgements',
        ackKey,
      )
    ).status,
  ).toBe(404);
  expect(acknowledge).toHaveBeenCalledTimes(1);
  expect(readOnly).toHaveBeenCalledTimes(1);
  db.onRpc('recover_reviewed_workflow_acknowledgement', () => ({
    ...acknowledge.mock.results[0]!.value,
    replayed: true,
    manifest: { ...manifest, currentPolicyStatus: 'published' },
  }));
  const historical = await post(
    { ...payload, readOnly: true },
    {},
    '/v1/reviewed-workflows/acknowledgements',
    ackKey,
  );
  expect(historical.status).toBe(200);
  expect(
    ((await historical.json()) as { data: { manifest: unknown } }).data.manifest,
  ).toMatchObject({
    initialPolicyStatus: 'draft',
    currentPolicyStatus: 'published',
  });
  expect(acknowledge).toHaveBeenCalledTimes(1);
  for (const corrupted of [
    { ...manifest, actorId: run },
    { ...manifest, bodyHash: 'f'.repeat(64) },
    { ...manifest, startedReceipt: '4' },
    { ...manifest, policyIndex: 1 },
  ]) {
    db.onRpc('recover_reviewed_workflow_acknowledgement', () => ({
      ...acknowledge.mock.results[0]!.value,
      replayed: true,
      manifest: corrupted,
    }));
    expect(
      (
        await post(
          { ...payload, readOnly: true },
          {},
          '/v1/reviewed-workflows/acknowledgements',
          ackKey,
        )
      ).status,
    ).not.toBe(200);
  }
  expect(calls).toHaveBeenCalledTimes(1);
});
