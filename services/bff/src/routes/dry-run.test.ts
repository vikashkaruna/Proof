import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';

/**
 * W5 · M3.2 — the dry-run routes.
 *
 * The BFF reads the stored actions, hands exactly that content to the
 * runtime, and reports per-action what the runtime recorded. A refusal is
 * an outcome in the response, not an error, because the runtime records
 * refusals too. What these tests mostly pin is what must NOT happen: no
 * dispatch for content that is not the stored action, no dry-run for an
 * approved action, and no response that renders "runtime unreachable" as
 * a result.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '00000000-0000-4000-8000-000000000001';
const PLAN = '22222222-2222-4222-8222-222222222222';
const ACTION_A = '44444444-4444-4444-8444-44444444000a';
const ACTION_B = '44444444-4444-4444-8444-44444444000b';
const ACTION_C = '44444444-4444-4444-8444-44444444000c';

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

const dispatchDryRun = vi.hoisted(() => vi.fn());
vi.mock('../services/dry-run-dispatch.js', () => ({ dispatchDryRun }));

const recorded = (dryRunId: string) => ({
  status: 'recorded',
  dryRunId,
  outcome: 'succeeded',
  refusalReason: null,
  error: null,
});

let fake: FakeDb;
beforeEach(() => {
  fake = createFakeDb();
  db.current = fake;
  dispatchDryRun.mockReset();
  fake.seed('remediation_actions', {
    id: ACTION_A,
    tenant_id: TENANT,
    plan_id: PLAN,
    sequence: 1,
    action_type: 'data.mask',
    parameters: { system: 'crm', fields: ['phone'] },
    blast_radius: { records: 10 },
    rollback_definition: { steps: [] },
    approval_status: 'draft',
  });
  fake.seed('remediation_actions', {
    id: ACTION_B,
    tenant_id: TENANT,
    plan_id: PLAN,
    sequence: 2,
    action_type: 'data.delete',
    parameters: { system: 'crm', criteria: 'expired' },
    blast_radius: {},
    rollback_definition: { steps: [] },
    approval_status: 'awaiting_approval',
  });
  fake.seed('remediation_actions', {
    id: ACTION_C,
    tenant_id: TENANT,
    plan_id: PLAN,
    sequence: 3,
    action_type: 'data.mask',
    parameters: { system: 'hr', fields: ['salary'] },
    blast_radius: {},
    rollback_definition: { steps: [] },
    approval_status: 'approved',
  });
});

async function app(role: UserRole = UserRole.ADMIN) {
  // v1.ts reads env at module scope; the dynamic import keeps that after
  // the hoisted env writes above.
  const { v1Routes } = await import('./v1.js');
  const hono = new Hono<{ Variables: Variables }>();
  hono.use('*', async (c, next) => {
    c.set('user', { id: USER } as never);
    c.set('tenantId', TENANT as never);
    c.set('role', role);
    await next();
  });
  hono.route('/v1', v1Routes({
    approvalEngine: {} as never,
    killSwitch: { isActive: async () => false } as never,
    ledger: { append: vi.fn() } as never,
    mfa: {} as never,
    realtime: { broadcast: vi.fn() } as never,
  }));
  return hono;
}

const post = async (role?: UserRole, payload: unknown = {}) =>
  (await app(role)).request(`/v1/plans/${PLAN}/dry-run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

describe('POST /v1/plans/:id/dry-run', () => {
  it('dispatches the stored content of each eligible action and reports results', async () => {
    dispatchDryRun
      .mockResolvedValueOnce(recorded('dr-a'))
      .mockResolvedValueOnce({
        status: 'recorded',
        dryRunId: 'dr-b',
        outcome: 'refused',
        refusalReason: 'action_type_not_simulable',
        error: null,
      });
    const res = await post();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summary: Record<string, number>; data: unknown[] };
    expect(body.summary).toEqual({ requested: 2, recorded: 2, refused: 0, unavailable: 0 });
    expect(body.data).toHaveLength(2);
    // The stored action content is what goes on the wire — nothing else.
    expect(dispatchDryRun).toHaveBeenCalledTimes(2);
    const firstCall = dispatchDryRun.mock.calls[0] as unknown[] | undefined;
    expect(firstCall).toBeDefined();
    const payload = firstCall![2] as Record<string, unknown>;
    expect(payload).toMatchObject({
      contract_version: 1,
      tenant_id: TENANT,
      action_id: ACTION_A,
      action_type: 'data.mask',
      parameters: { system: 'crm', fields: ['phone'] },
      blast_radius: { records: 10 },
      rollback_definition: { steps: [] },
    });
  });

  it('never dispatches an approved action', async () => {
    dispatchDryRun.mockResolvedValue(recorded('dr-1'));
    await post(undefined, { actionIds: [ACTION_C] });
    expect(dispatchDryRun).not.toHaveBeenCalled();
    const res = await post(undefined, { actionIds: [ACTION_C] });
    expect(res.status).toBe(409);
  });

  it('reports 404 for a plan with no actions', async () => {
    const res = await (await app()).request(`/v1/plans/${crypto.randomUUID()}/dry-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });

  it('reports 400 for a malformed request', async () => {
    const res = await post(undefined, { actionIds: ['not-a-uuid'] });
    expect(res.status).toBe(400);
  });

  it('refuses a caller without PLAN_CREATE', async () => {
    const res = await post(UserRole.VIEWER);
    expect(res.status).toBe(403);
  });

  it('marks an unreachable runtime as unavailable, not as a result', async () => {
    dispatchDryRun.mockResolvedValue({
      status: 'unavailable',
      dryRunId: null,
      outcome: null,
      refusalReason: null,
      error: 'runtime acknowledgement unavailable',
    });
    const res = await post(undefined, { actionIds: [ACTION_A] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summary: Record<string, number>; data: unknown[] };
    expect(body.summary.unavailable).toBe(1);
    expect(body.data[0]).toMatchObject({ status: 'unavailable', dryRunId: null });
  });
});

describe('GET /v1/plans/:id/dry-runs', () => {
  it('returns the tenant’s recorded dry-runs for the plan, newest first', async () => {
    fake.seed('dry_runs', {
      id: 'dr-old',
      tenant_id: TENANT,
      action_id: ACTION_A,
      plan_id: PLAN,
      status: 'refused',
      diff: null,
      refusal_reason: 'parameters_invalid',
      renderable: false,
      parameters_hash: 'a'.repeat(64),
      rollback_definition_hash: 'b'.repeat(64),
      simulated_by: 'sudhaar',
      correlation_id: 'c-1',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      created_at: '2026-09-25T00:00:00Z',
    });
    fake.seed('dry_runs', {
      id: 'dr-new',
      tenant_id: TENANT,
      action_id: ACTION_A,
      plan_id: PLAN,
      status: 'succeeded',
      diff: { renderable: true, changes: [] },
      refusal_reason: null,
      renderable: true,
      parameters_hash: 'a'.repeat(64),
      rollback_definition_hash: 'b'.repeat(64),
      simulated_by: 'sudhaar',
      correlation_id: 'c-2',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      created_at: '2026-09-26T00:00:00Z',
    });
    // Another tenant's run for the same plan id must not appear.
    fake.seed('dry_runs', {
      id: 'dr-other',
      tenant_id: '99999999-9999-4999-8999-999999999999',
      action_id: ACTION_A,
      plan_id: PLAN,
      status: 'succeeded',
      diff: { changes: [] },
      refusal_reason: null,
      renderable: true,
      parameters_hash: 'c'.repeat(64),
      rollback_definition_hash: 'd'.repeat(64),
      simulated_by: 'sudhaar',
      correlation_id: 'c-3',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      created_at: '2026-09-26T12:00:00Z',
    });
    const res = await (await app()).request(`/v1/plans/${PLAN}/dry-runs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((r) => r.id)).toEqual(['dr-new', 'dr-old']);
  });
});
