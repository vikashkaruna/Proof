import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';

const id = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = id(1),
  FOREIGN = id(2),
  JOB = id(3),
  RUN = id(4),
  ENGAGEMENT = id(5),
  CORRELATION = id(6),
  WORKLOAD = id(7);
const INPUT = '1'.repeat(64),
  RESULT = '2'.repeat(64),
  LIBRARY = '3'.repeat(64);
const TIME = '2026-10-05T09:00:00.000Z';
const db = vi.hoisted(() => ({ current: null as FakeDb | null, calls: [] as string[] }));
vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SUPABASE_URL = 'https://local.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'a'.repeat(40);
  process.env.SUPABASE_SERVICE_KEY = 'b'.repeat(40);
  process.env.APPROVAL_SIGNING_KEY = 'k'.repeat(48);
});
vi.mock('@axiom/supabase', () => ({
  createSupabaseAdmin: () => {
    db.calls.push('create');
    return {
      from: (table: string) => {
        db.calls.push(table);
        const builder = db.current!.client.from(table) as Record<string, unknown>;
        for (const operation of ['insert', 'update', 'delete'])
          builder[operation] = () => {
            throw new Error('write prohibited');
          };
        return builder;
      },
      rpc: () => {
        throw new Error('RPC prohibited on read route');
      },
    };
  },
  createHumanActionWriter: () => {
    throw new Error('writer prohibited on read route');
  },
}));
import { assessmentJobStatusRoutes } from './assessment-job-status.js';

let fake: FakeDb;
function app(role: UserRole = UserRole.OWNER, tenant = T) {
  const result = new Hono<{ Variables: Variables }>();
  result.use('*', async (c, next) => {
    c.set('user', { id: id(10) } as never);
    c.set('tenantId', tenant as never);
    c.set('role', role);
    await next();
  });
  result.route('/v1', assessmentJobStatusRoutes());
  return result;
}
function request(job = JOB, role: UserRole = UserRole.OWNER, query = '') {
  return app(role).request(`/v1/assessment/jobs/${job}${query}`);
}
beforeEach(() => {
  db.calls = [];
  fake = createFakeDb({
    assessment_dispatch_jobs: [
      {
        id: JOB,
        tenant_id: T,
        run_id: RUN,
        workload_id: WORKLOAD,
        actor_id: id(10),
        engagement_id: ENGAGEMENT,
        correlation_id: CORRELATION,
        input_hash: INPUT,
        created_at: TIME,
        claimed_at: TIME,
        scheduling_status: 'submitted',
        ciphertext: 'PRIVATE-CIPHERTEXT',
        wrapped_key: 'PRIVATE-KEY',
      },
    ],
    agent_runs: [
      {
        id: RUN,
        tenant_id: T,
        agent: 'parikshan',
        engagement_id: ENGAGEMENT,
        correlation_id: CORRELATION,
        status: 'succeeded',
        input_redacted_hash: INPUT,
        output_redacted_hash: RESULT,
        completed_at: TIME,
        error: null,
        input: 'PRIVATE-ANSWERS',
      },
    ],
    engagements: [{ id: ENGAGEMENT, tenant_id: T, library_version: '0.1.1' }],
    workload_assessment_packets: [
      {
        run_id: RUN,
        tenant_id: T,
        engagement_id: ENGAGEMENT,
        library_version: '0.1.1',
        library_digest: LIBRARY,
        started_receipt: '100',
        completed_receipt: '101',
        finalized_receipt: '102',
        result_digest: RESULT,
        completed_at: TIME,
        finalized_at: TIME,
        result: { answers: 'PRIVATE-ANSWERS' },
      },
    ],
    audit_ledger: [
      {
        id: '100',
        sequence_no: '40',
        tenant_id: T,
        correlation_id: CORRELATION,
        actor_type: 'agent',
        actor_id: 'parikshan',
        action_type: 'assessment.started',
        target_ref: ENGAGEMENT,
        input_hash: INPUT,
        output_hash: null,
        result: 'pending',
        detail: { run_id: RUN, workload_id: WORKLOAD, library_digest: LIBRARY },
      },
      {
        id: '101',
        sequence_no: '41',
        tenant_id: T,
        correlation_id: CORRELATION,
        actor_type: 'agent',
        actor_id: 'parikshan',
        action_type: 'assessment.scored',
        target_ref: ENGAGEMENT,
        input_hash: INPUT,
        output_hash: RESULT,
        result: 'success',
        detail: { run_id: RUN, workload_id: WORKLOAD, library_digest: LIBRARY },
      },
      {
        id: '102',
        sequence_no: '42',
        tenant_id: T,
        correlation_id: CORRELATION,
        actor_type: 'system',
        actor_id: 'assessment-controller',
        action_type: 'workload.task_completed',
        target_ref: RUN,
        input_hash: INPUT,
        output_hash: RESULT,
        result: 'success',
        detail: {
          workload_id: WORKLOAD,
          library_version: '0.1.1',
          assessment_started_receipt: '100',
          assessment_completed_receipt: '101',
        },
      },
    ],
  });
  db.current = fake;
});

describe('existing durable assessment job readback', () => {
  function cancelledFixture() {
    const job = fake.rows('assessment_dispatch_jobs')[0]!;
    job.claimed_at = null;
    job.correlation_id = JOB;
    const run = fake.rows('agent_runs')[0]!;
    run.correlation_id = JOB;
    run.status = 'cancelled';
    run.output_redacted_hash = null;
    run.completed_at = TIME;
    run.metadata = { request_kind: 'durable_assessment_v1', assessment_request_receipt: '100' };
    fake.rows('workload_assessment_packets').splice(0);
    fake.seed('assessment_request_resolutions', {
      job_id: JOB,
      tenant_id: T,
      run_id: RUN,
      actor_id: id(10),
      engagement_id: ENGAGEMENT,
      correlation_id: JOB,
      input_hash: INPUT,
      library_version: '0.1.1',
      requested_receipt: '100',
      cancellation_receipt: '103',
      resolved_at: TIME,
      kind: 'cancelled_unclaimed',
    });
    fake.seed('workload_task_delegations', {
      run_id: RUN,
      tenant_id: T,
      workload_identity_id: WORKLOAD,
      agent_name: 'parikshan',
      created_by: id(10),
      estate_id: null,
      engagement_id: ENGAGEMENT,
      correlation_id: JOB,
      input_hash: INPUT,
      revoked_at: TIME,
    });
    fake.rows('audit_ledger').splice(0);
    const detail = {
      job_id: JOB,
      run_id: RUN,
      workload_id: WORKLOAD,
      engagement_id: ENGAGEMENT,
      library_version: '0.1.1',
    };
    fake.seed('audit_ledger', {
      id: '100',
      sequence_no: '40',
      tenant_id: T,
      correlation_id: JOB,
      actor_type: 'human',
      actor_id: id(10),
      action_type: 'assessment.requested',
      target_ref: JOB,
      input_hash: INPUT,
      output_hash: null,
      result: 'pending',
      detail: { ...detail, purpose: 'durable_assessment', estate_id: null },
    });
    fake.seed('audit_ledger', {
      id: '103',
      sequence_no: '41',
      tenant_id: T,
      correlation_id: JOB,
      actor_type: 'human',
      actor_id: id(10),
      action_type: 'assessment.request_cancelled',
      target_ref: JOB,
      input_hash: INPUT,
      output_hash: null,
      result: 'success',
      detail: {
        ...detail,
        purpose: 'cancel_unclaimed_assessment',
        requested_receipt: '100',
        resolution: 'cancelled_unclaimed',
      },
    });
  }
  it('returns authoritative unclaimed cancellation without claiming assessment completion or worker cleanup', async () => {
    cancelledFixture();
    const before = JSON.stringify(fake.rows('assessment_request_resolutions'));
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'resolution_recorded',
      phase: 'cancelled_unclaimed',
      finalization: null,
      allAgentEndToEndAccepted: false,
      resolution: {
        actorId: id(10),
        requestedReceipt: '100',
        cancellationReceipt: '103',
        resolvedAt: TIME,
        verification: 'persisted_human_unclaimed_cancellation_bindings',
        workerCleanupVerified: false,
      },
    });
    expect(JSON.stringify(fake.rows('assessment_request_resolutions'))).toBe(before);
  });
  it.each([
    ['assessment_request_resolutions', 'actor_id', FOREIGN],
    ['assessment_request_resolutions', 'input_hash', RESULT],
    ['assessment_request_resolutions', 'run_id', FOREIGN],
    ['assessment_request_resolutions', 'library_version', 'foreign'],
    ['assessment_request_resolutions', 'requested_receipt', '103'],
    ['assessment_request_resolutions', 'resolved_at', '2026-10-04T09:00:00.000Z'],
    ['agent_runs', 'status', 'queued'],
    ['agent_runs', 'error', 'PRIVATE-ERROR'],
    ['agent_runs', 'output_redacted_hash', RESULT],
    ['assessment_dispatch_jobs', 'claimed_at', TIME],
    ['workload_task_delegations', 'revoked_at', null],
    ['workload_task_delegations', 'revoked_at', '2026-10-04T09:00:00.000Z'],
    ['workload_task_delegations', 'workload_identity_id', FOREIGN],
    ['workload_task_delegations', 'created_by', FOREIGN],
    ['workload_task_delegations', 'engagement_id', FOREIGN],
    ['workload_task_delegations', 'input_hash', RESULT],
    ['workload_task_delegations', 'estate_id', FOREIGN],
  ])('refuses corrupt resolution context %s.%s', async (table, field, value) => {
    cancelledFixture();
    fake.rows(String(table))[0]![String(field)] = value;
    const response = await request();
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('PRIVATE');
  });
  it.each([
    [0, 'actor_id', FOREIGN],
    [0, 'action_type', 'assessment.started'],
    [0, 'result', 'success'],
    [0, 'input_hash', RESULT],
    [0, 'target_ref', ENGAGEMENT],
    [1, 'actor_type', 'system'],
    [1, 'actor_id', FOREIGN],
    [1, 'sequence_no', '39'],
    [1, 'action_type', 'operator.request.cancelled'],
    [1, 'output_hash', RESULT],
    [1, 'result', 'pending'],
  ])('refuses mismatched cancellation receipt %i.%s', async (index, field, value) => {
    cancelledFixture();
    fake.rows('audit_ledger')[Number(index)]![String(field)] = value;
    expect((await request()).status).toBe(503);
  });
  it.each([
    [0, 'purpose', 'other'],
    [0, 'estate_id', FOREIGN],
    [0, 'job_id', FOREIGN],
    [0, 'library_version', 'foreign'],
    [1, 'workload_id', FOREIGN],
    [1, 'requested_receipt', '99'],
    [1, 'resolution', 'completed'],
  ])('refuses forged cancellation receipt detail %i.%s', async (index, field, value) => {
    cancelledFixture();
    (fake.rows('audit_ledger')[Number(index)]!.detail as Record<string, unknown>)[String(field)] =
      value;
    expect((await request()).status).toBe(503);
  });
  it('never treats a generic cancelled run or revoked task as authoritative request resolution', async () => {
    cancelledFixture();
    fake.rows('assessment_request_resolutions').splice(0);
    expect(await (await request()).json()).toMatchObject({
      status: 'unconfirmed',
      recordedRunStatus: 'cancelled',
      finalization: null,
    });
  });
  it('refuses unavailable resolution and task reads without inventing a recoverable outcome', async () => {
    cancelledFixture();
    fake.failNext('assessment_request_resolutions');
    expect((await request()).status).toBe(503);
    fake.failNext('workload_task_delegations');
    expect((await request()).status).toBe(503);
  });
  it('returns controller-recorded finalization with exact receipt bindings, without promoting all-agent acceptance', async () => {
    const before = JSON.stringify(
      ['assessment_dispatch_jobs', 'agent_runs', 'workload_assessment_packets', 'audit_ledger'].map(
        (t) => fake.rows(t),
      ),
    );
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const data = await response.json();
    expect(data).toMatchObject({
      jobId: JOB,
      runId: RUN,
      engagementId: ENGAGEMENT,
      status: 'finalization_recorded',
      allAgentEndToEndAccepted: false,
      finalization: {
        startedReceipt: '100',
        completedReceipt: '101',
        finalizedReceipt: '102',
        resultDigest: RESULT,
      },
    });
    expect(JSON.stringify(data)).not.toMatch(
      /PRIVATE-|ciphertext|wrapped_key|input_hash|answers|workload_id/,
    );
    expect(
      JSON.stringify(
        [
          'assessment_dispatch_jobs',
          'agent_runs',
          'workload_assessment_packets',
          'audit_ledger',
        ].map((t) => fake.rows(t)),
      ),
    ).toBe(before);
  });
  it('is mounted in the actual v1 route aggregator', async () => {
    const { v1Routes } = await import('./v1.js');
    const full = new Hono<{ Variables: Variables }>();
    full.use('*', async (c, next) => {
      c.set('user', { id: id(10) } as never);
      c.set('tenantId', T as never);
      c.set('role', UserRole.OWNER);
      await next();
    });
    full.route(
      '/v1',
      v1Routes({
        approvalEngine: {} as never,
        killSwitch: {} as never,
        ledger: {} as never,
        mfa: {} as never,
        realtime: {} as never,
      }),
    );
    expect((await full.request(`/v1/assessment/jobs/${JOB}`)).status).toBe(200);
  });
  it('checks current read capability before database access', async () => {
    expect((await request(JOB, UserRole.AGENT)).status).toBe(403);
    expect(db.calls).toEqual([]);
    expect((await request(JOB, UserRole.VIEWER)).status).toBe(200);
  });
  it.each(['invalid', `${JOB}?tenantId=${FOREIGN}`, `${JOB}?confirm=true`])(
    'refuses malformed or authority-selecting identifiers %s',
    async (value) => {
      expect((await request(value)).status).toBe(400);
      expect(db.calls).toEqual([]);
    },
  );
  it('canonicalizes valid upper-case identifiers', async () => {
    expect((await request(JOB.toUpperCase())).status).toBe(200);
  });
  it('returns the same not-found response for missing and foreign jobs', async () => {
    expect((await request(id(99))).status).toBe(404);
    fake.rows('assessment_dispatch_jobs')[0]!.tenant_id = FOREIGN;
    expect((await request()).status).toBe(404);
    expect(db.calls).not.toContain('agent_runs');
  });
  it('never treats a succeeded generic run without a packet as finalized', async () => {
    fake.rows('workload_assessment_packets').splice(0);
    const data = await (await request()).json();
    expect(data).toMatchObject({
      status: 'unconfirmed',
      phase: 'terminal_unconfirmed',
      finalization: null,
    });
    expect(db.calls).not.toContain('audit_ledger');
  });
  it.each(['queued', 'running', 'failed', 'cancelled', 'timed_out'])(
    'does not claim completion for unfinalized %s runs',
    async (status) => {
      fake.rows('agent_runs')[0]!.status = status;
      fake.rows('workload_assessment_packets').splice(0);
      expect(await (await request()).json()).toMatchObject({
        status: 'unconfirmed',
        finalization: null,
        recordedRunStatus: status,
      });
    },
  );
  it('keeps a committed worker result unconfirmed until controller finalization', async () => {
    fake.rows('workload_assessment_packets')[0]!.finalized_receipt = null;
    fake.rows('workload_assessment_packets')[0]!.finalized_at = null;
    expect(await (await request()).json()).toMatchObject({
      status: 'unconfirmed',
      phase: 'result_recorded',
      finalization: null,
    });
  });
  it.each([
    'assessment_dispatch_jobs',
    'agent_runs',
    'workload_assessment_packets',
    'engagements',
    'audit_ledger',
  ])('refuses unavailable %s reads without leaking adapter errors', async (table) => {
    fake.failNext(table);
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: 'assessment_status_unavailable',
        message: 'Assessment job status could not be verified.',
      },
    });
  });
  it.each([
    ['agent_runs', 'tenant_id', FOREIGN],
    ['agent_runs', 'engagement_id', FOREIGN],
    ['agent_runs', 'correlation_id', FOREIGN],
    ['agent_runs', 'input_redacted_hash', RESULT],
    ['agent_runs', 'output_redacted_hash', INPUT],
    ['agent_runs', 'error', 'PRIVATE-ERROR'],
    ['agent_runs', 'status', 'failed'],
    ['agent_runs', 'completed_at', '2026-10-04T09:00:00.000Z'],
    ['engagements', 'tenant_id', FOREIGN],
    ['workload_assessment_packets', 'engagement_id', FOREIGN],
    ['workload_assessment_packets', 'library_version', 'different'],
    ['workload_assessment_packets', 'completed_receipt', null],
    ['workload_assessment_packets', 'started_receipt', '102'],
    ['workload_assessment_packets', 'result_digest', INPUT],
  ])('refuses corrupt finalization context %s.%s', async (table, field, value) => {
    fake.rows(String(table))[0]![String(field)] = value;
    expect((await request()).status).toBe(503);
  });
  it.each([
    [0, 'actor_id', 'sanket'],
    [0, 'action_type', 'assessment.scored'],
    [0, 'target_ref', FOREIGN],
    [0, 'result', 'success'],
    [0, 'sequence_no', '43'],
    [1, 'output_hash', INPUT],
    [2, 'output_hash', INPUT],
    [1, 'tenant_id', FOREIGN],
    [1, 'correlation_id', FOREIGN],
    [1, 'input_hash', RESULT],
    [2, 'actor_type', 'agent'],
    [2, 'actor_id', 'worker'],
    [2, 'target_ref', ENGAGEMENT],
    [2, 'action_type', 'workload.dispatch_scheduled'],
    [2, 'result', 'pending'],
  ])('refuses mismatched receipt %i.%s', async (index, field, value) => {
    fake.rows('audit_ledger')[Number(index)]![String(field)] = value;
    expect((await request()).status).toBe(503);
  });
  it.each([
    [0, 'run_id', FOREIGN],
    [1, 'workload_id', FOREIGN],
    [0, 'library_digest', RESULT],
    [2, 'workload_id', FOREIGN],
    [2, 'library_version', 'different'],
    [2, 'assessment_started_receipt', '99'],
    [2, 'assessment_completed_receipt', '99'],
  ])('refuses mismatched receipt detail %i.%s', async (index, field, value) => {
    (fake.rows('audit_ledger')[Number(index)]!.detail as Record<string, unknown>)[String(field)] =
      value;
    expect((await request()).status).toBe(503);
  });
  it('refuses missing or duplicated receipts', async () => {
    fake.rows('audit_ledger').pop();
    expect((await request()).status).toBe(503);
  });
  it('refuses a coherent packet and final receipt pinned to a different engagement library', async () => {
    fake.rows('workload_assessment_packets')[0]!.library_version = 'other-library';
    (fake.rows('audit_ledger')[2]!.detail as Record<string, unknown>).library_version =
      'other-library';
    expect((await request()).status).toBe(503);
  });
  it('refuses duplicated receipt rows even when every required receipt is present', async () => {
    fake.seed('audit_ledger', { ...fake.rows('audit_ledger')[0]! });
    expect((await request()).status).toBe(503);
  });
  it('does not expose or implement browser launch or confirmation operations', async () => {
    expect((await app().request(`/v1/assessment/jobs/${JOB}`, { method: 'POST' })).status).toBe(
      404,
    );
    expect(db.calls).toEqual([]);
  });
});
