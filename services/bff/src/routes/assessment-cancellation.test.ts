import { beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { UserRole, AssessmentRequestSchema } from '@axiom/types';
import { canonicalJson } from '@axiom/ledger';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';
import type { MfaService } from '../services/mfa.js';
import { requireSessionMfa } from '../middleware/session-mfa.js';
vi.mock('@axiom/config', async (load) => ({
  ...(await load<typeof import('@axiom/config')>()),
  isAuthBypassEnabled: () => false,
}));
const state = vi.hoisted(() => ({
  db: null as FakeDb | null,
  reads: [] as string[],
  args: null as Record<string, unknown> | null,
  reply: null as unknown,
}));
vi.mock('@axiom/supabase', () => ({
  createSupabaseAdmin: () => ({
    from: (table: string) => {
      state.reads.push(table);
      return state.db!.client.from(table);
    },
    rpc: () => {
      throw new Error('service role write forbidden');
    },
  }),
  createHumanActionWriter: () => state.db!.client,
}));
import { assessmentCancellationRoutes } from './assessment-cancellation.js';
const id = (n: number) => `99990000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenant = id(1),
  actor = id(2),
  engagement = id(3),
  job = id(4),
  run = id(5);
const input = () =>
  AssessmentRequestSchema.parse({
    operationKey: job,
    engagementId: engagement,
    answers: { C: { Q1: true, Q2: false, Q3: null } },
    applicability: { processesChildren: false },
  });
beforeEach(() => {
  state.db = createFakeDb({
    engagements: [{ id: engagement, tenant_id: tenant, library_version: '0.1.1' }],
  });
  state.reads = [];
  state.args = null;
  state.reply = {
    job_id: job,
    run_id: run,
    cancellation_receipt: '82',
    resolved_at: '2026-10-08T12:00:00Z',
  };
  state.db.onRpc('cancel_unclaimed_assessment_request', (args) => {
    state.args = args;
    return state.reply;
  });
});
function request(
  body: unknown = input(),
  headers: Record<string, string> = {},
  role: UserRole = UserRole.OWNER,
  wantedJob = job,
  query = '',
  mfa?: MfaService,
) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('tenantId', tenant as never);
    c.set('user', { id: actor } as never);
    c.set('role', role);
    await next();
  });
  if (mfa) app.use('/v1/*', requireSessionMfa(mfa));
  app.route('/v1', assessmentCancellationRoutes());
  return app.request(`/v1/assessment/jobs/${wantedJob}/cancel${query}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Expected-Actor-Id': actor,
      'Idempotency-Key': job,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
it('hashes the original pinned declaration body server-side and uses only the human writer', async () => {
  const response = await request();
  expect(response.status).toBe(202);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual({
    jobId: job,
    runId: run,
    cancellationReceipt: '82',
    resolvedAt: '2026-10-08T12:00:00Z',
    status: 'cancellation_recorded',
  });
  expect(state.args).toEqual({
    p_tenant_id: tenant,
    p_actor_id: actor,
    p_job_id: job,
    p_engagement_id: engagement,
    p_library_version: '0.1.1',
    p_input_hash: createHash('sha256')
      .update(
        canonicalJson({
          tenant_id: tenant,
          engagement_id: engagement,
          library_version: '0.1.1',
          answers: input().answers,
          sdf_self_attested: null,
          processes_children: false,
          processes_health: null,
        }),
      )
      .digest('hex'),
  });
});
it('is mounted independently of enqueue producer configuration', async () => {
  const { assessmentRequestRoutes } = await import('./assessment-request.js');
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('tenantId', tenant as never);
    c.set('user', { id: actor } as never);
    c.set('role', UserRole.OWNER);
    await next();
  });
  app.route('/v1', assessmentRequestRoutes());
  expect(
    (
      await app.request(`/v1/assessment/jobs/${job}/cancel`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Expected-Actor-Id': actor,
          'Idempotency-Key': job,
        },
        body: JSON.stringify(input()),
      })
    ).status,
  ).toBe(202);
});
it.each([UserRole.VIEWER, UserRole.AGENT, UserRole.REVIEWER])(
  'refuses current role %s before reads or writes',
  async (role) => {
    expect((await request(input(), {}, role)).status).toBe(403);
    expect(state.reads).toEqual([]);
    expect(state.args).toBeNull();
  },
);
it.each(['actor', 'missing-actor', 'key', 'body-key', 'path', 'query', 'authority'])(
  'refuses changed or malformed cancellation context %s',
  async (kind) => {
    const body =
      kind === 'body-key'
        ? { ...input(), operationKey: id(9) }
        : kind === 'authority'
          ? { ...input(), inputHash: 'f'.repeat(64) }
          : input();
    const headers: Record<string, string> =
      kind === 'actor'
        ? { 'X-Expected-Actor-Id': id(9) }
        : kind === 'missing-actor'
          ? { 'X-Expected-Actor-Id': '' }
          : kind === 'key'
            ? { 'Idempotency-Key': id(9) }
            : {};
    const response = await request(
      body,
      headers,
      UserRole.OWNER,
      kind === 'path' ? 'invalid' : job,
      kind === 'query' ? '?force=true' : '',
    );
    expect([400, 409]).toContain(response.status);
    expect(state.reads).toEqual([]);
    expect(state.args).toBeNull();
  },
);
it('hides foreign or missing engagements without invoking the human writer', async () => {
  state.db!.rows('engagements')[0]!.tenant_id = id(9);
  expect((await request()).status).toBe(404);
  expect(state.args).toBeNull();
});
it.each([
  'forbidden',
  'kill_switch_engaged',
  'assessment_job_not_found',
  'cancellation_conflict',
  'assessment_already_started',
  'assessment_not_unclaimed',
])('preserves authoritative refusal %s', async (error) => {
  state.reply = { error };
  const response = await request();
  expect(response.status).toBe(
    error === 'forbidden' ? 403 : error === 'assessment_job_not_found' ? 404 : 409,
  );
  expect(await response.json()).toEqual({ error: { code: error } });
});
it.each([
  'wrong-job',
  'malformed',
  'private-extra',
  'unrecognized-error',
  'db-error',
  'read-error',
])('fails closed on unverified adapter outcome %s', async (kind) => {
  if (kind === 'wrong-job')
    state.reply = { ...(state.reply as Record<string, unknown>), job_id: id(9) };
  if (kind === 'malformed') state.reply = { cancellation_receipt: '82' };
  if (kind === 'private-extra')
    state.reply = { ...(state.reply as Record<string, unknown>), ciphertext: 'PRIVATE' };
  if (kind === 'unrecognized-error') state.reply = { error: 'PRIVATE-ERROR' };
  if (kind === 'db-error') state.db!.failNextRpc('cancel_unclaimed_assessment_request');
  if (kind === 'read-error') state.db!.failNext('engagements');
  const response = await request();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: { code: 'assessment_cancellation_unconfirmed' } });
});

it.each(['unenrolled', 'unverified'] as const)(
  'normal owner session MFA blocks cancellation before data reads: %s',
  async (kind) => {
    const mfa = {
      requiresLoginMfa: vi.fn().mockResolvedValue(true),
      isEnrolled: vi.fn().mockResolvedValue(kind !== 'unenrolled'),
      sessionAttestation: vi.fn().mockResolvedValue(null),
    } as unknown as MfaService;
    const response = await request(input(), {}, UserRole.OWNER, job, '', mfa);
    expect(response.status).toBe(kind === 'unenrolled' ? 403 : 401);
    expect(await response.json()).toMatchObject({
      error: {
        code: kind === 'unenrolled' ? 'mfa_enrolment_required' : 'mfa_verification_required',
      },
    });
    expect(state.reads).toEqual([]);
    expect(state.args).toBeNull();
  },
);
it('a verified owner session still traverses the same exact human cancellation path', async () => {
  const mfa = {
    requiresLoginMfa: vi.fn().mockResolvedValue(true),
    isEnrolled: vi.fn().mockResolvedValue(true),
    sessionAttestation: vi.fn().mockResolvedValue({ id: 'verified' }),
  } as unknown as MfaService;
  expect((await request(input(), {}, UserRole.OWNER, job, '', mfa)).status).toBe(202);
  expect(state.args?.p_actor_id).toBe(actor);
});
