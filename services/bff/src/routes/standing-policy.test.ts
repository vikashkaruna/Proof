import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';

/**
 * W6.2 · M4.1 — the standing-policy routes.
 *
 * A standing policy is the one place where authority is granted by someone
 * who is not looking at the request. The route tests pin the boundaries the
 * database already enforces, plus the ones only the route can: the author
 * cannot approve their own policy, a lapsed policy is refused before any
 * digest is computed, escalation is a decision (200) rather than an error,
 * and a within-scope issuance returns the same signed-token shape the
 * approve route returns. The database suite (standing-policy-evaluation)
 * proves the gate itself; these prove the wire.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '00000000-0000-4000-8000-0000000000aa';
const CHECKER = '00000000-0000-4000-8000-0000000000bb';
const PLAN = '22222222-2222-4222-8222-222222222222';
const POLICY = '44444444-4444-4444-8444-444444444444';
const ACTION_A = '33333333-3333-4333-8333-33333333000a';
const ACTION_B = '33333333-3333-4333-8333-33333333000b';

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

let fake: FakeDb;
let broadcast: ReturnType<typeof vi.fn>;
let evaluateArgs: Record<string, unknown> | null;

beforeEach(() => {
  fake = createFakeDb();
  db.current = fake;
  broadcast = vi.fn();
  evaluateArgs = null;
  fake.onRpc('create_standing_policy', (args) => {
    expect(args['p_created_by']).toBe(USER);
    expect(args['p_approved_by']).not.toBe(USER);
    return {
      policy: {
        id: POLICY,
        name: args['p_name'],
        version: 1,
        scope: args['p_scope'],
        status: 'active',
        expiresAt: args['p_expires_at'],
      },
    };
  });
  fake.onRpc('revoke_standing_policy', (args) => {
    expect(args['p_revoked_by']).toBe(USER);
    return { policy: { id: args['p_policy_id'], status: 'revoked', revokedAt: new Date() } };
  });
  fake.onRpc('evaluate_standing_policy', (args) => {
    evaluateArgs = args;
    return {
      decision: 'issued',
      token_id: 'tok-1',
      evaluation_id: 'eval-1',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      content_digest: 'd'.repeat(64),
    };
  });
});

/** An approvable plan: dry-run complete, rollback validated, nothing stale. */
function seedApprovablePlan() {
  fake.seed('remediation_plans', {
    id: PLAN,
    tenant_id: TENANT,
    status: 'review',
    version: 3,
    library_version: '0.1.1',
  });
  for (const id of [ACTION_A, ACTION_B]) {
    fake.seed('remediation_actions', {
      id,
      tenant_id: TENANT,
      plan_id: PLAN,
      action_type: 'data.mask',
      approval_status: 'awaiting_approval',
      dry_run_status: 'dry_run_complete',
      rollback_validated: true,
      dry_run_expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      parameters: { system: 'crm' },
      rollback_definition: { steps: [] },
      closes_finding_ids: [],
      dry_run_result: { renderable: true },
    });
  }
  fake.seed('standing_approval_policies', {
    id: POLICY,
    tenant_id: TENANT,
    name: 'Small masking batch',
    version: 1,
    scope: { action_types: ['data.mask'], max_actions: 2 },
    status: 'active',
    created_by: USER,
    approved_by: CHECKER,
    expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });
}

async function buildApp(role: UserRole = UserRole.ADMIN) {
  const { v1Routes } = await import('./v1.js');
  const routes = v1Routes({
    approvalEngine: {
      issue: async (_tenantId: string, spec: Record<string, unknown>) => ({
        signature: 'sig',
        spec: { ...spec, nonce: 'nonce-1' },
      }),
    } as never,
    killSwitch: { isActive: async () => false } as never,
    ledger: { append: vi.fn() } as never,
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

const post = (app: Hono<{ Variables: Variables }>, path: string, body?: string) =>
  app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

const createBody = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: 'Small masking batch',
    scope: { actionTypes: ['data.mask'], maxActions: 2 },
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    approvedById: CHECKER,
    ...extra,
  });

describe('POST /v1/policies/standing', () => {
  it('creates a policy for an estate manager, scope bound to another human', async () => {
    const res = await post(await buildApp(), '/v1/policies/standing', createBody());
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { policy: { status: string } } };
    expect(data.policy.status).toBe('active');
  });

  it('refuses a caller without ESTATE_MANAGE', async () => {
    const res = await post(
      await buildApp(UserRole.AXIOM_ANALYST),
      '/v1/policies/standing',
      createBody(),
    );
    expect(res.status).toBe(403);
  });

  it('refuses the author approving their own policy', async () => {
    const res = await post(
      await buildApp(),
      '/v1/policies/standing',
      createBody({
        approvedById: USER,
      }),
    );
    expect(res.status).toBe(422);
    const { error } = (await res.json()) as { error: { code: string } };
    expect(error.code).toBe('dual_control_required');
  });

  it('refuses a malformed scope or an unbounded expiry', async () => {
    const base = await buildApp();
    for (const body of [
      createBody({ scope: { actionTypes: [] } }),
      createBody({ scope: { actionTypes: ['data.mask'], maxActions: 0 } }),
      createBody({ scope: { actionTypes: ['data.mask'], sneakyKey: 1 } }),
      createBody({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
      createBody({
        expiresAt: new Date(Date.now() + 400 * 86_400_000).toISOString(),
      }),
    ]) {
      const res = await post(base, '/v1/policies/standing', body);
      expect(res.status).toBe(400);
    }
  });

  it('renders a database refusal as 409, not a success', async () => {
    fake.onRpc('create_standing_policy', () => ({ error: 'approver_not_found' }));
    const res = await post(await buildApp(), '/v1/policies/standing', createBody());
    expect(res.status).toBe(409);
    const { error } = (await res.json()) as { error: { code: string } };
    expect(error.code).toBe('approver_not_found');
  });

  it('renders an unreachable database as 500', async () => {
    fake.failNextRpc('create_standing_policy');
    const res = await post(await buildApp(), '/v1/policies/standing', createBody());
    expect(res.status).toBe(500);
  });
});

describe('GET /v1/policies/standing', () => {
  it('lists the tenant\u2019s policies, filtered by status', async () => {
    fake.seed('standing_approval_policies', {
      id: POLICY,
      tenant_id: TENANT,
      name: 'P1',
      status: 'active',
    });
    const res = await (await buildApp()).request('/v1/policies/standing?status=active');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: unknown[] };
    expect(data).toHaveLength(1);
  });
});

describe('POST /v1/policies/standing/:id/revoke', () => {
  it('revokes and reports the revoked policy', async () => {
    const res = await post(await buildApp(), `/v1/policies/standing/${POLICY}/revoke`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { policy: { status: string } } };
    expect(data.policy.status).toBe('revoked');
  });

  it('renders an unknown policy as 404', async () => {
    fake.onRpc('revoke_standing_policy', () => ({ error: 'policy_not_found' }));
    const res = await post(await buildApp(), `/v1/policies/standing/${POLICY}/revoke`);
    expect(res.status).toBe(404);
  });
});

describe('POST /v1/plans/:id/standing-approval', () => {
  const evaluate = (app: Hono<{ Variables: Variables }>, body?: string) =>
    post(app, `/v1/plans/${PLAN}/standing-approval`, body);

  const evaluateBody = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ policyId: POLICY, ...extra });

  it('issues a signed token inside the scope, through the policy\u2019s approver', async () => {
    seedApprovablePlan();
    const res = await evaluate(await buildApp(), evaluateBody());
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      decision: string;
      approvalTokenId: string;
      token: { spec: Record<string, unknown> };
    };
    expect(body.decision).toBe('issued');
    expect(body.approvalTokenId).toBe('tok-1');
    expect(body.token.spec.nonce).toBe('nonce-1');
    // The evaluation carried the reviewed digest and the plan version the
    // route read, so the database gate can bind the issuance to both.
    expect(evaluateArgs?.['p_expected_plan_version']).toBe(3);
    expect(evaluateArgs?.['p_action_ids']).toEqual([ACTION_A, ACTION_B]);
    expect(evaluateArgs?.['p_expected_digest']).toEqual(expect.any(String));
    expect(broadcast).toHaveBeenCalled();
  });

  it('signs with the policy\u2019s approver, not the caller', async () => {
    seedApprovablePlan();
    await evaluate(await buildApp(), evaluateBody());
    const spec = (evaluateArgs?.['p_signed_payload'] ?? {}) as Record<string, unknown>;
    expect(spec['approverId']).toBe(CHECKER);
  });

  it('defaults to the plan\u2019s pending actions', async () => {
    seedApprovablePlan();
    fake.rows('remediation_actions').forEach((r) => {
      if (r['id'] === ACTION_B) r['approval_status'] = 'approved';
    });
    const res = await evaluate(await buildApp(), evaluateBody({ actionIds: undefined }));
    expect(res.status).toBe(201);
    expect(evaluateArgs?.['p_action_ids']).toEqual([ACTION_A]);
  });

  it('reports an escalation as a decision, not an error', async () => {
    seedApprovablePlan();
    fake.onRpc('evaluate_standing_policy', () => ({
      decision: 'escalated',
      evaluation_id: 'eval-2',
      uncovered_action_types: ['data.delete'],
    }));
    const res = await evaluate(await buildApp(), evaluateBody());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { decision: string; uncoveredActionTypes: string[] };
    expect(body.decision).toBe('escalated');
    expect(body.uncoveredActionTypes).toEqual(['data.delete']);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('refuses a lapsed or revoked policy before evaluating', async () => {
    seedApprovablePlan();
    fake.rows('standing_approval_policies').forEach((r) => {
      if (r['id'] === POLICY) r['status'] = 'revoked';
    });
    const res = await evaluate(await buildApp(), evaluateBody());
    expect(res.status).toBe(409);
    const { error } = (await res.json()) as { error: { code: string } };
    expect(error.code).toBe('policy_inactive');
  });

  it('refuses an expired policy', async () => {
    seedApprovablePlan();
    fake.rows('standing_approval_policies').forEach((r) => {
      r['expires_at'] = new Date(Date.now() - 1000).toISOString();
    });
    const res = await evaluate(await buildApp(), evaluateBody());
    expect(res.status).toBe(409);
    const { error } = (await res.json()) as { error: { code: string } };
    expect(error.code).toBe('policy_expired');
  });

  it('does not let a standing policy skip the dry-run gate', async () => {
    seedApprovablePlan();
    fake.rows('remediation_actions').forEach((r) => {
      r['rollback_validated'] = false;
    });
    const res = await evaluate(await buildApp(), evaluateBody());
    expect(res.status).toBe(422);
    const { error } = (await res.json()) as { error: { code: string } };
    expect(error.code).toBe('actions_ineligible');
    expect(evaluateArgs).toBeNull();
  });

  it('refuses stale dry-runs', async () => {
    seedApprovablePlan();
    fake.rows('remediation_actions').forEach((r) => {
      r['dry_run_expires_at'] = new Date(Date.now() - 1000).toISOString();
    });
    const res = await evaluate(await buildApp(), evaluateBody());
    expect(res.status).toBe(422);
    const { error } = (await res.json()) as { error: { code: string } };
    expect(error.code).toBe('dry_run_expired');
  });

  it('refuses actions outside the plan', async () => {
    seedApprovablePlan();
    const res = await evaluate(
      await buildApp(),
      evaluateBody({ actionIds: ['33333333-3333-4333-8333-333333330099'] }),
    );
    expect(res.status).toBe(404);
    const { error } = (await res.json()) as { error: { code: string } };
    expect(error.code).toBe('actions_not_found');
  });

  it('maps a content drift under lock to 409', async () => {
    seedApprovablePlan();
    fake.onRpc('evaluate_standing_policy', () => ({ decision: 'content_changed' }));
    const res = await evaluate(await buildApp(), evaluateBody());
    expect(res.status).toBe(409);
  });

  it('maps a gate refusal under lock to 422 and broadcasts nothing', async () => {
    seedApprovablePlan();
    fake.onRpc('evaluate_standing_policy', () => ({ decision: 'actions_not_ready' }));
    const res = await evaluate(await buildApp(), evaluateBody());
    expect(res.status).toBe(422);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('refuses the evaluation while the kill switch is engaged', async () => {
    seedApprovablePlan();
    const { v1Routes } = await import('./v1.js');
    const routes = v1Routes({
      approvalEngine: {} as never,
      killSwitch: { isActive: async () => true } as never,
      ledger: { append: vi.fn() } as never,
      mfa: {} as never,
      realtime: { broadcast } as never,
    });
    const app = new Hono<{ Variables: Variables }>();
    app.use('*', async (c, next) => {
      c.set('user', { id: USER } as never);
      c.set('tenantId', TENANT as never);
      c.set('role', UserRole.ADMIN);
      c.set('approvalScopes', [] as never);
      await next();
    });
    app.route('/v1', routes);
    const res = await evaluate(app, evaluateBody());
    expect(res.status).toBe(423);
    expect(evaluateArgs).toBeNull();
  });
});
