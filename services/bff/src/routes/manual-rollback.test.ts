import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';

/**
 * W5 · M3.5 — the manual rollback route.
 *
 * The route carries the human's authority and record: PLAN_EXECUTE, the kill
 * switch, and a ledger entry under the requester's own actor. The undo itself
 * is never written from here — only the runtime's adapter that attempted it
 * may record its outcome through `record_rollback_execution`. So these tests
 * pin mostly what must NOT happen: no dispatch for actions the database would
 * refuse to reverse, no ledger entry without the human actor, and no response
 * that renders an unconfirmed dispatch as a success.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '00000000-0000-4000-8000-0000000000aa';
const PLAN = '22222222-2222-4222-8222-222222222222';
const OTHER_PLAN = '22222222-2222-4222-8222-222222229999';
const BATCH = '55555555-5555-4555-8555-555555555555';
const OTHER_BATCH = '55555555-5555-4555-8555-555555559999';
const ACTION_A = '33333333-3333-4333-8333-33333333000a';
const ACTION_B = '33333333-3333-4333-8333-33333333000b';
const ACTION_C = '33333333-3333-4333-8333-33333333000c';

const db = vi.hoisted(() => ({ current: null as FakeDb | null }));

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SUPABASE_URL = 'https://local.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'a'.repeat(40);
  process.env.SUPABASE_SERVICE_KEY = 'b'.repeat(40);
  process.env.APPROVAL_SIGNING_KEY = 'k'.repeat(48);
});

vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));
vi.mock('@axiom/supabase', () => ({
  createSupabaseAdmin: () => {
    if (!db.current) throw new Error('fake db not installed');
    return db.current.client;
  },
}));

const dispatchRollback = vi.hoisted(() => vi.fn());
vi.mock('../services/rollback-dispatch.js', () => ({ dispatchRollback }));

let fake: FakeDb;
let broadcast: ReturnType<typeof vi.fn>;
let ledgerAppend: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fake = createFakeDb();
  db.current = fake;
  broadcast = vi.fn();
  ledgerAppend = vi.fn();
  dispatchRollback.mockReset();
  dispatchRollback.mockResolvedValue({
    status: 'accepted',
    error: null,
    outcomes: [
      { actionId: ACTION_A, outcome: 'rolled_back', errorCode: null },
      { actionId: ACTION_B, outcome: 'rolled_back', errorCode: null },
    ],
  });
  seedExecutedActions();
});

/** Actions the batch completed and nobody has reversed yet. */
function seedExecutedActions() {
  for (const id of [ACTION_A, ACTION_B]) {
    fake.seed('remediation_actions', {
      id,
      tenant_id: TENANT,
      plan_id: PLAN,
      action_type: 'data.mask',
      execution_status: 'succeeded',
      final_outcome: 'succeeded',
      execution_batch_id: BATCH,
    });
  }
}

async function buildApp(role: UserRole = UserRole.ADMIN, killSwitchActive = false) {
  const { v1Routes } = await import('./v1.js');
  const routes = v1Routes({
    approvalEngine: {} as never,
    killSwitch: { isActive: async () => killSwitchActive } as never,
    ledger: { append: ledgerAppend } as never,
    mfa: {} as never,
    realtime: { broadcast } as never,
  });
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: USER } as never);
    c.set('tenantId', TENANT as never);
    c.set('role', role);
    c.set('approvalScopes', [] as never);
    await next();
  });
  app.route('/v1', routes);
  return app;
}

const post = (app: Hono<{ Variables: Variables }>, body: string) =>
  app.request(`/v1/plans/${PLAN}/rollback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

const rollbackBody = (actionIds: string[]) => JSON.stringify({ actionIds });

describe('POST /v1/plans/:id/rollback', () => {
  it('rolls executed actions back and records the human decision', async () => {
    const res = await post(await buildApp(), rollbackBody([ACTION_A, ACTION_B]));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { batchId: string; correlationId: string; outcomes: unknown[] };
    };
    expect(data.batchId).toBe(BATCH);
    expect(data.outcomes).toHaveLength(2);

    // The dispatch carried the stored batch scope, not anything the caller
    // could widen.
    expect(dispatchRollback).toHaveBeenCalledTimes(1);
    const payload = dispatchRollback.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(payload['contract_version']).toBe(1);
    expect(payload['tenant_id']).toBe(TENANT);
    expect(payload['batch_id']).toBe(BATCH);
    expect(payload['action_ids']).toEqual([ACTION_A, ACTION_B]);
    expect(payload['correlation_id']).toEqual(expect.any(String));

    // The human actor is on the ledger, bound to the same correlation id.
    expect(ledgerAppend).toHaveBeenCalledTimes(1);
    const entry = ledgerAppend.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(entry['actorType']).toBe('human');
    expect(entry['actorId']).toBe(USER);
    expect(entry['actionType']).toBe('execution.rollback.started');
    expect(entry['result']).toBe('pending');
    expect(entry['correlationId']).toBe(payload['correlation_id']);
    expect(entry['detail']).toMatchObject({
      triggered_by: 'manual',
      batch_id: BATCH,
      action_ids: [ACTION_A, ACTION_B],
    });

    // An execution-status change occurred, so the recorded outcomes broadcast.
    expect(broadcast).toHaveBeenCalledTimes(2);
    const event = broadcast.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(event['type']).toBe('execution.progress');
    expect(event['status']).toBe('rolled_back');
  });

  it('refuses a caller without PLAN_EXECUTE', async () => {
    const res = await post(await buildApp(UserRole.AXIOM_ANALYST), rollbackBody([ACTION_A]));
    expect(res.status).toBe(403);
    expect(dispatchRollback).not.toHaveBeenCalled();
    expect(ledgerAppend).not.toHaveBeenCalled();
  });

  it('refuses the rollback while the kill switch is engaged', async () => {
    const res = await post(await buildApp(UserRole.ADMIN, true), rollbackBody([ACTION_A]));
    expect(res.status).toBe(423);
    expect(dispatchRollback).not.toHaveBeenCalled();
    expect(ledgerAppend).not.toHaveBeenCalled();
  });

  it('refuses a malformed request', async () => {
    const app = await buildApp();
    for (const body of [
      '',
      '{}',
      JSON.stringify({ actionIds: [] }),
      JSON.stringify({ actionIds: ['not-a-uuid'] }),
      JSON.stringify({ actionIds: [ACTION_A], sneakyKey: 1 }),
    ]) {
      const res = await post(app, body);
      expect(res.status).toBe(400);
    }
    expect(dispatchRollback).not.toHaveBeenCalled();
  });

  it('renders unknown and foreign-plan actions as not found', async () => {
    fake.seed('remediation_actions', {
      id: ACTION_C,
      tenant_id: TENANT,
      plan_id: OTHER_PLAN,
      action_type: 'data.mask',
      execution_status: 'succeeded',
      final_outcome: 'succeeded',
      execution_batch_id: BATCH,
    });
    const app = await buildApp();
    for (const actionIds of [['33333333-3333-4333-8333-333333330099'], [ACTION_C]]) {
      const res = await post(app, rollbackBody(actionIds));
      expect(res.status).toBe(404);
      const { error } = (await res.json()) as { error: { code: string } };
      expect(error.code).toBe('actions_not_found');
    }
    expect(dispatchRollback).not.toHaveBeenCalled();
  });

  it('refuses actions spanning more than one execution', async () => {
    fake.rows('remediation_actions').forEach((r) => {
      if (r['id'] === ACTION_B) r['execution_batch_id'] = OTHER_BATCH;
    });
    const res = await post(await buildApp(), rollbackBody([ACTION_A, ACTION_B]));
    expect(res.status).toBe(422);
    const { error } = (await res.json()) as { error: { code: string } };
    expect(error.code).toBe('actions_span_batches');
    expect(dispatchRollback).not.toHaveBeenCalled();
  });

  it('refuses actions the database would not record as reversed', async () => {
    const app = await buildApp();
    // An already-reversed action is not reversible a second time.
    fake.seed('remediation_actions', {
      id: ACTION_C,
      tenant_id: TENANT,
      plan_id: PLAN,
      action_type: 'data.mask',
      execution_status: 'rolled_back',
      final_outcome: 'rolled_back',
      execution_batch_id: BATCH,
    });
    const res = await post(app, rollbackBody([ACTION_A, ACTION_C]));
    expect(res.status).toBe(422);
    const { error } = (await res.json()) as { error: { code: string } };
    expect(error.code).toBe('actions_not_reversible');

    // A failed action never reversed in the first place.
    fake.rows('remediation_actions').forEach((r) => {
      if (r['id'] === ACTION_A) r['final_outcome'] = 'failed';
    });
    const res2 = await post(app, rollbackBody([ACTION_A]));
    expect(res2.status).toBe(422);

    expect(dispatchRollback).not.toHaveBeenCalled();
    expect(ledgerAppend).not.toHaveBeenCalled();
  });

  it('renders an explicit runtime refusal as 503 and closes the ledger entry', async () => {
    dispatchRollback.mockResolvedValue({
      status: 'failed',
      error: 'runtime refused dispatch (503)',
      outcomes: null,
    });
    const res = await post(await buildApp(), rollbackBody([ACTION_A, ACTION_B]));
    expect(res.status).toBe(503);
    const { error, correlationId } = (await res.json()) as {
      error: { code: string };
      correlationId: string;
    };
    expect(error.code).toBe('rollback_dispatch_failed');
    expect(correlationId).toEqual(expect.any(String));
    expect(broadcast).not.toHaveBeenCalled();
    // The requested rollback concluded without effect — never left dangling.
    const completed = ledgerAppend.mock.calls.map((call) => call[0] as Record<string, unknown>);
    expect(completed).toHaveLength(2);
    expect(completed[0]?.['actionType']).toBe('execution.rollback.started');
    expect(completed[1]?.['actionType']).toBe('execution.rollback.completed');
    expect(completed[1]?.['result']).toBe('failure');
    expect(completed[1]?.['actorType']).toBe('human');
  });

  it('never reports an unconfirmed dispatch as a rollback', async () => {
    dispatchRollback.mockResolvedValue({
      status: 'unknown',
      error: 'runtime acknowledgement unavailable',
      outcomes: null,
    });
    const res = await post(await buildApp(), rollbackBody([ACTION_A]));
    expect(res.status).toBe(503);
    const { error, correlationId } = (await res.json()) as {
      error: { code: string };
      correlationId: string;
    };
    expect(error.code).toBe('rollback_outcome_unknown');
    expect(correlationId).toEqual(expect.any(String));
    expect(broadcast).not.toHaveBeenCalled();
    const started = ledgerAppend.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(started['actionType']).toBe('execution.rollback.started');
    expect(ledgerAppend).toHaveBeenCalledTimes(1);
  });

  it('renders an unreachable database as 500', async () => {
    fake.failNext('remediation_actions');
    const res = await post(await buildApp(), rollbackBody([ACTION_A]));
    expect(res.status).toBe(500);
    expect(dispatchRollback).not.toHaveBeenCalled();
  });
});
