import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import {
  UserRole,
  AssessmentRequestReceiptSchema,
  AssessmentSourceRefusalSchema,
  ASSESSMENT_REQUEST_MAX_BYTES,
} from '@axiom/types';
import { assessmentRequestRoutes } from './assessment-request.js';
import type { AssessmentRequestProducer } from '../workloads/assessment-producer.js';
import {
  AssessmentContextRefused,
  AssessmentQuestionnaireRefused,
} from '../workloads/assessment-producer.js';
import type { Variables } from '../types.js';
const TENANT = 'aaaaaaaa-1111-4111-8111-111111111111',
  ACTOR = 'bbbbbbbb-2222-4222-8222-222222222222',
  JOB = 'cccccccc-3333-4333-8333-333333333333',
  ENGAGEMENT = 'dddddddd-4444-4444-8444-444444444444',
  RUN = 'eeeeeeee-5555-4555-8555-555555555555';
const body = { operationKey: JOB, engagementId: ENGAGEMENT };
function fixture(
  producer: AssessmentRequestProducer | undefined = {
    request: vi.fn(async () => ({ job_id: JOB, run_id: RUN, expires_at: '2026-10-05T20:00:00Z' })),
  },
  role: UserRole = UserRole.OWNER,
) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('tenantId', TENANT.toUpperCase() as never);
    c.set('user', { id: ACTOR.toUpperCase() } as never);
    c.set('role', role);
    await next();
  });
  app.route('/v1', assessmentRequestRoutes(producer));
  return {
    producer,
    send: (
      value: unknown = body,
      headers: Record<string, string> = {},
      path = '/v1/assessment/jobs',
    ) =>
      app.request(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': JOB,
          'X-Expected-Actor-Id': ACTOR,
          ...headers,
        },
        body: typeof value === 'string' ? value : JSON.stringify(value),
      }),
  };
}
describe('human assessment request boundary', () => {
  it('returns only accepted receipt, normalizes identity, and keeps omitted facts explicitly unknown', async () => {
    const { producer, send } = fixture();
    const response = await send();
    expect(response.status).toBe(202);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const receipt = AssessmentRequestReceiptSchema.parse(await response.json());
    expect(receipt).toEqual({
      jobId: JOB,
      runId: RUN,
      expiresAt: '2026-10-05T20:00:00Z',
      status: 'accepted',
      statusUrl: `/api/bff/v1/assessment/jobs/${JOB}`,
    });
    expect(producer!.request).toHaveBeenCalledWith(TENANT, ACTOR, {
      ...body,
      answers: {},
      applicability: { sdfSelfAttested: null, processesChildren: null, processesHealth: null },
    });
  });
  it.each([UserRole.VIEWER, UserRole.REVIEWER, UserRole.PARTNER, UserRole.AGENT])(
    'withholds enqueue from %s',
    async (role) => {
      const { producer, send } = fixture(undefined, role);
      expect((await send()).status).toBe(403);
      expect(producer?.request).not.toHaveBeenCalled();
    },
  );
  it('rejects a public receipt pointing to a different job status', () => {
    expect(
      AssessmentRequestReceiptSchema.safeParse({
        jobId: JOB,
        runId: RUN,
        expiresAt: '2026-10-05T20:00:00Z',
        status: 'accepted',
        statusUrl: `/api/bff/v1/assessment/jobs/${RUN}`,
      }).success,
    ).toBe(false);
  });
  it('rejects an actor-switched pending request without invoking producer', async () => {
    const { producer, send } = fixture();
    expect((await send(body, { 'X-Expected-Actor-Id': TENANT })).status).toBe(409);
    expect(producer!.request).not.toHaveBeenCalled();
  });
  it.each(['', 'invalid'])('requires expected actor UUID %s', async (expected) => {
    const { producer, send } = fixture();
    expect((await send(body, { 'X-Expected-Actor-Id': expected })).status).toBe(400);
    expect(producer!.request).not.toHaveBeenCalled();
  });
  it.each(['', 'invalid', RUN])('requires exact stable operation header %s', async (key) => {
    const { producer, send } = fixture();
    expect((await send(body, { 'Idempotency-Key': key })).status).toBe(400);
    expect(producer!.request).not.toHaveBeenCalled();
  });
  it.each([
    { ...body, actorId: ACTOR },
    { ...body, workloadId: RUN },
    { ...body, answers: { A: { Q1: 'yes' } } },
    { ...body, applicability: { processesChildren: false, region: 'India' } },
    null,
  ])('refuses malformed/foreign caller context', async (value) => {
    const { producer, send } = fixture();
    expect((await send(value)).status).toBe(400);
    expect(producer!.request).not.toHaveBeenCalled();
  });
  it.each([
    { answers: Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`C${i}`, {}])) },
    { answers: { A: Object.fromEntries(Array.from({ length: 5001 }, (_, i) => [`Q${i}`, null])) } },
  ])('refuses oversized questionnaire maps before producer', async (extra) => {
    const { producer, send } = fixture();
    expect((await send({ ...body, ...extra })).status).toBe(400);
    expect(producer!.request).not.toHaveBeenCalled();
  });
  it('counts actual bytes rather than trusting a forged content length', async () => {
    const { producer, send } = fixture();
    const response = await send(' '.repeat(ASSESSMENT_REQUEST_MAX_BYTES + 1), {
      'Content-Length': '1',
    });
    expect(response.status).toBe(413);
    expect(producer!.request).not.toHaveBeenCalled();
  });
  it('rejects unrecognized query parameters', async () => {
    const { send } = fixture();
    expect((await send(body, {}, '/v1/assessment/jobs?tenant=foreign')).status).toBe(400);
  });
  it('fails explicitly when production composition is not configured', async () => {
    const app = new Hono<{ Variables: Variables }>();
    app.use('*', async (c, next) => {
      c.set('tenantId', TENANT as never);
      c.set('user', { id: ACTOR } as never);
      c.set('role', UserRole.OWNER);
      await next();
    });
    app.route('/v1', assessmentRequestRoutes());
    const response = await app.request('/v1/assessment/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': JOB,
        'X-Expected-Actor-Id': ACTOR,
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'assessment_requests_unavailable' },
    });
  });
  it.each([
    new AssessmentQuestionnaireRefused(),
    new AssessmentContextRefused('assessment_engagement_not_found'),
    new AssessmentContextRefused('assessment_already_recorded'),
  ])('preserves bounded refusal %s', async (error) => {
    const { send } = fixture({
      request: async () => {
        throw error;
      },
    });
    const response = await send();
    expect(response.status).toBe(
      error instanceof AssessmentQuestionnaireRefused
        ? 400
        : error.code === 'assessment_engagement_not_found'
          ? 404
          : 409,
    );
  });
  it('does not claim a failed enqueue is definitely uncommitted or expose private diagnostics', async () => {
    const { send } = fixture({
      request: async () => {
        throw new Error('private credential and questionnaire');
      },
    });
    const response = await send();
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toContain('assessment_request_unconfirmed');
    expect(text).toContain('same request ID');
    expect(text).not.toContain('private credential');
  });
  it('refuses an unrelated receipt from a broken adapter', async () => {
    const { send } = fixture({
      request: async () => ({ job_id: RUN, run_id: RUN, expires_at: '2026-10-05T20:00:00Z' }),
    });
    expect((await send()).status).toBe(503);
  });
});
it.each([true, false, undefined])(
  'reports tenant configuration presence %s without claiming readiness',
  async (configured) => {
    const producer: AssessmentRequestProducer = {
      request: vi.fn(),
      ...(configured === undefined
        ? {}
        : {
            configurationForTenant: vi.fn((tenant: string) => {
              expect(tenant).toBe(TENANT);
              return configured;
            }),
          }),
    };
    const app = new Hono<{ Variables: Variables }>();
    app.use('*', async (c, next) => {
      c.set('tenantId', TENANT);
      c.set('user', { id: ACTOR } as never);
      c.set('role', UserRole.OWNER);
      await next();
    });
    app.route('/v1', assessmentRequestRoutes(producer));
    const result = await app.request('/v1/assessment/configuration');
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({
      tenantId: TENANT,
      configuration:
        configured === undefined ? 'unknown' : configured ? 'configured' : 'unconfigured',
      executionReadiness: 'not_verified',
      sourceRequirement: 'unknown',
    });
    expect(producer.request).not.toHaveBeenCalled();
  },
);
it('reports absent producer without secrets and refuses agent configuration reads', async () => {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('tenantId', TENANT);
    c.set('user', { id: ACTOR } as never);
    c.set('role', UserRole.OWNER);
    await next();
  });
  app.route('/v1', assessmentRequestRoutes());
  expect(await (await app.request('/v1/assessment/configuration')).json()).toEqual({
    tenantId: TENANT,
    configuration: 'unconfigured',
    executionReadiness: 'not_verified',
    sourceRequirement: 'unknown',
  });
  const agent = new Hono<{ Variables: Variables }>();
  agent.use('*', async (c, next) => {
    c.set('tenantId', TENANT);
    c.set('user', { id: ACTOR } as never);
    c.set('role', UserRole.AGENT);
    await next();
  });
  agent.route('/v1', assessmentRequestRoutes());
  expect((await agent.request('/v1/assessment/configuration')).status).toBe(403);
});

it('returns an exact definite source refusal only when the trusted producer establishes it', async () => {
  const { send } = fixture({
    request: vi.fn(async () => {
      throw new AssessmentContextRefused('assessment_public_control_review_required');
    }),
  });
  const r = await send();
  expect(r.status).toBe(409);
  const v = await r.json();
  expect(v).toMatchObject({
    error: {
      code: 'assessment_public_control_review_required',
      tenantId: TENANT,
      actorId: ACTOR,
      engagementId: ENGAGEMENT,
      operationKey: JOB,
      dispatchState: 'not_recorded',
      sourceRequirement: 'public_control_review_required',
    },
  });
  expect(
    AssessmentSourceRefusalSchema.parse((v as { error: unknown }).error).requestText,
  ).toContain(JOB);
});
it('reads configured source requirement without implying execution readiness', async () => {
  const producer = {
    configurationForTenant: () => true,
    sourceRequirementForTenant: async () => 'public_control_review_required' as const,
    request: vi.fn(),
  };
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('tenantId', TENANT as never);
    c.set('role', UserRole.OWNER);
    await next();
  });
  app.route('/v1', assessmentRequestRoutes(producer));
  const r = await app.request('/v1/assessment/configuration');
  expect(await r.json()).toMatchObject({
    sourceRequirement: 'public_control_review_required',
    executionReadiness: 'not_verified',
  });
  expect(producer.request).not.toHaveBeenCalled();
});
