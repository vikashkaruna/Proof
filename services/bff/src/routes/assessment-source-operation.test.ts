import { beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { canonicalJson } from '@axiom/ledger';
import { AssessmentRequestSchema, UserRole } from '@axiom/types';
import type { Variables } from '../types.js';
const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@axiom/supabase', () => ({
  createHumanActionWriter: () => ({ rpc: mocks.rpc }),
  createSupabaseAdmin: () => ({ rpc: mocks.rpc }),
}));
import { assessmentSourceOperationRoutes } from './assessment-source-operation.js';
const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  E = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  J = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  R = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const request = AssessmentRequestSchema.parse({
  operationKey: J,
  engagementId: E,
  reviewRef: { reviewId: R, requestSha256: 'a'.repeat(64), snapshotSha256: 'b'.repeat(64) },
});
const reason = 'Human explicitly abandons only this original undispatched intent.';
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
function proof() {
  const request_text = canonicalJson(request),
    request_sha256 = hash(request_text);
  const cancellation_text = canonicalJson({
    version: 1,
    tenantId: T,
    actorId: A,
    jobId: J,
    engagementId: E,
    requestSha256: request_sha256,
    reason,
  });
  return {
    id: R,
    tenant_id: T,
    actor_id: A,
    job_id: J,
    engagement_id: E,
    request_text,
    request_sha256,
    reason,
    cancellation_text,
    cancellation_sha256: hash(cancellation_text),
    receipt_id: '9223372036854775807',
    created_at: '2026-10-16T00:00:00Z',
  };
}
function app(role: UserRole = UserRole.OWNER) {
  const a = new Hono<{ Variables: Variables }>();
  a.use('*', async (c, next) => {
    c.set('tenantId', T);
    c.set('user', { id: A } as never);
    c.set('role', role);
    await next();
  });
  a.route('/', assessmentSourceOperationRoutes());
  return a;
}
function post(body: unknown = { request, reason }, role: UserRole = UserRole.OWNER) {
  return app(role).request(`/assessment/jobs/${J}/cancel-source-intent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': J, 'X-Expected-Actor-Id': A },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.rpc.mockReturnValue({
    abortSignal: async () => ({ error: null, data: { state: 'cancelled', data: proof() } }),
  });
});
it('accepts only exact source intent cancellation proof through the human writer', async () => {
  const result = await post();
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({
    data: { data: { receipt_id: '9223372036854775807' } },
  });
  expect(mocks.rpc).toHaveBeenCalledWith('cancel_assessment_source_intent', {
    p_tenant_id: T,
    p_actor_id: A,
    p_request_text: canonicalJson(request),
    p_reason: reason,
  });
});
it.each([UserRole.VIEWER, UserRole.PARTNER, UserRole.REVIEWER, UserRole.AGENT])(
  'does not grant cancellation to role %s',
  async (role) => {
    expect((await post(undefined, role)).status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  },
);
it.each(['actor', 'request', 'hash', 'reason', 'absent'] as const)(
  'refuses forged or non-positive proof: %s',
  async (kind) => {
    const row = proof();
    if (kind === 'actor') row.actor_id = R;
    if (kind === 'request') {
      row.request_text = canonicalJson({ ...request, operationKey: R });
      row.request_sha256 = hash(row.request_text);
    }
    if (kind === 'hash') row.cancellation_sha256 = '0'.repeat(64);
    if (kind === 'reason') {
      row.reason = 'Changed reason';
      row.cancellation_text = canonicalJson({
        ...JSON.parse(row.cancellation_text),
        reason: row.reason,
      });
      row.cancellation_sha256 = hash(row.cancellation_text);
    }
    mocks.rpc.mockReturnValue({
      abortSignal: async () => ({
        error: null,
        data: kind === 'absent' ? { state: 'not_found' } : { state: 'cancelled', data: row },
      }),
    });
    expect((await post()).status).toBe(503);
  },
);
it('returns already-recorded proof without claiming cancellation or issuing another dispatch', async () => {
  mocks.rpc.mockReturnValue({
    abortSignal: async () => ({
      error: null,
      data: { state: 'recorded', jobId: J, runId: R, expiresAt: '2026-10-16T01:00:00Z' },
    }),
  });
  const r = await post();
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ data: { state: 'recorded' } });
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
});
it('does not turn a missing operation read into positive cancellation', async () => {
  mocks.rpc.mockReturnValue({
    abortSignal: async () => ({ error: null, data: { state: 'not_found' } }),
  });
  const q = new URLSearchParams({ engagementId: E, ...request.reviewRef! });
  const r = await app().request(`/assessment/jobs/${J}/source-operation?${q}`);
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ data: { state: 'not_found' } });
  const invalid = await app().request(`/assessment/jobs/${J}/source-operation?${q}&reviewId=${R}`);
  expect(invalid.status).toBe(400);
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
});
it('bounds a cancellation body and rejects missing source or actor before writer access', async () => {
  expect((await post({ request: { operationKey: J, engagementId: E }, reason })).status).toBe(400);
  const r = await app().request(`/assessment/jobs/${J}/cancel-source-intent`, {
    method: 'POST',
    headers: { 'X-Expected-Actor-Id': A },
    body: 'x'.repeat(16385),
  });
  expect(r.status).toBe(413);
  expect(mocks.rpc).not.toHaveBeenCalled();
});
