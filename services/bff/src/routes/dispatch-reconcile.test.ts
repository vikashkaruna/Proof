import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';

/**
 * W5 — the operator's judgement on a dispatch that never confirmed.
 *
 * The founder's decision is that redelivery always needs a fresh approval, so
 * these tests are mostly about what this endpoint must NOT do: re-dispatch
 * anything, reopen work the runtime accepted, or accept a judgement with no
 * reason attached.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '00000000-0000-4000-8000-0000000000aa';
const PLAN = '22222222-2222-4222-8222-222222222222';

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
let ledgerAppend: ReturnType<typeof vi.fn>;

async function buildApp(role: UserRole = UserRole.OWNER) {
  const { v1Routes } = await import('./v1.js');
  ledgerAppend = vi.fn(async () => ({ sequenceNo: 1, entryHash: 'hash' }));

  const routes = v1Routes({
    approvalEngine: { verify: async () => ({ valid: true }), markNonceUsed: vi.fn() } as never,
    killSwitch: { isActive: async () => false } as never,
    ledger: { append: ledgerAppend } as never,
    mfa: {} as never,
    realtime: { broadcast: vi.fn() } as never,
  });

  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: USER, email: 'operator@example.com' } as never);
    c.set('tenantId', TENANT as never);
    c.set('role', role as never);
    c.set('approvalScopes', [] as never);
    c.set('idempotencyKey', 'idem-1' as never);
    await next();
  });
  app.route('/v1', routes);
  return app;
}

const reconcile = (app: Hono<{ Variables: Variables }>, body: Record<string, unknown>) =>
  app.request('/v1/execution/dispatches/reconcile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const validBody = (over: Record<string, unknown> = {}) => ({
  planId: PLAN,
  requestKey: 'req-batch-001',
  decision: 'released',
  reason: 'runtime never received it; verified in connector logs',
  ...over,
});

beforeEach(() => {
  vi.resetModules();
  fake = createFakeDb({});
  db.current = fake;
  fake.onRpc('reconcile_execution_dispatch', (args) => ({
    decision: args.p_decision,
    released_action_count: args.p_decision === 'released' ? 2 : 0,
    correlation_id: '55555555-5555-4555-8555-555555555555',
  }));
});

describe('POST /v1/execution/dispatches/reconcile — authority', () => {
  it.each([UserRole.APPROVER, UserRole.REVIEWER, UserRole.VIEWER, UserRole.AGENT])(
    'refuses %s',
    async (role) => {
      // Releasing a claim asserts that work is NOT running on a client estate.
      // That sits with the roles that can release the emergency stop.
      const app = await buildApp(role);
      const res = await reconcile(app, validBody());
      expect(res.status).toBe(403);
      expect(ledgerAppend).not.toHaveBeenCalled();
    },
  );

  it('allows an owner', async () => {
    const app = await buildApp(UserRole.OWNER);
    expect((await reconcile(app, validBody())).status).toBe(200);
  });
});

describe('POST /v1/execution/dispatches/reconcile — validation', () => {
  it.each([
    ['no reason', { reason: '' }],
    ['a whitespace-only reason', { reason: '   ' }],
    ['no request key', { requestKey: '' }],
    ['an unknown decision', { decision: 'redeliver' }],
    ['a non-uuid plan', { planId: 'not-a-uuid' }],
  ])('refuses %s', async (_label, over) => {
    const app = await buildApp();
    const res = await reconcile(app, validBody(over));
    expect(res.status).toBe(400);
    expect(ledgerAppend).not.toHaveBeenCalled();
  });

  it('offers no redeliver decision at all', async () => {
    // The founder ruled out automatic redelivery; the schema is where that
    // decision is enforced rather than described.
    const app = await buildApp();
    expect((await reconcile(app, validBody({ decision: 'redeliver' }))).status).toBe(400);
  });
});

describe('POST /v1/execution/dispatches/reconcile — outcomes', () => {
  it('records a release and says redelivery still needs a fresh approval', async () => {
    const app = await buildApp();
    const res = await reconcile(app, validBody());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      decision: 'released',
      releasedActionCount: 2,
      redeliveryRequiresFreshApproval: true,
    });
  });

  it('returns the database transaction correlation without a separate ledger write', async () => {
    const app = await buildApp();
    const response = await reconcile(app, validBody());
    expect(await response.json()).toMatchObject({
      correlationId: '55555555-5555-4555-8555-555555555555',
    });
    // Atomic ledger/failure behavior is proved against real PostgreSQL.
    expect(ledgerAppend).not.toHaveBeenCalled();
  });

  it('releases nothing when the decision is to abandon', async () => {
    const app = await buildApp();
    const res = await reconcile(app, validBody({ decision: 'abandoned', reason: 'cannot tell' }));
    expect(await res.json()).toMatchObject({ decision: 'abandoned', releasedActionCount: 0 });
  });

  it('refuses to reopen work the runtime accepted', async () => {
    fake.onRpc('reconcile_execution_dispatch', () => ({
      decision: 'not_reconcilable',
      status: 'delivered',
    }));
    const app = await buildApp();
    const res = await reconcile(app, validBody());
    expect(res.status).toBe(409);
    // Nothing happened, so nothing is claimed to have happened.
    expect(ledgerAppend).not.toHaveBeenCalled();
  });

  it('reports an unknown intent as not found', async () => {
    fake.onRpc('reconcile_execution_dispatch', () => ({ decision: 'intent_not_found' }));
    const app = await buildApp();
    expect((await reconcile(app, validBody())).status).toBe(404);
    expect(ledgerAppend).not.toHaveBeenCalled();
  });

  it('does not ledger a reconciliation the database refused', async () => {
    fake.onRpc('reconcile_execution_dispatch', () => ({ decision: 'reason_required' }));
    const app = await buildApp();
    expect((await reconcile(app, validBody())).status).toBe(422);
    expect(ledgerAppend).not.toHaveBeenCalled();
  });

  it('surfaces a database failure rather than reporting success', async () => {
    fake.failNextRpc('reconcile_execution_dispatch');
    const app = await buildApp();
    expect((await reconcile(app, validBody())).status).toBe(500);
    expect(ledgerAppend).not.toHaveBeenCalled();
  });
});

describe('GET /v1/execution/dispatches/pending', () => {
  it('refuses a role without the capability', async () => {
    const app = await buildApp(UserRole.APPROVER);
    expect((await app.request('/v1/execution/dispatches/pending')).status).toBe(403);
  });

  it('lists this tenant’s unconfirmed intents', async () => {
    fake.seed('pending_execution_dispatches', {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      tenant_id: TENANT,
      plan_id: PLAN,
      request_key: 'req-batch-001',
      status: 'unknown',
    });
    fake.seed('pending_execution_dispatches', {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      tenant_id: '99999999-9999-4999-8999-999999999999',
      plan_id: PLAN,
      request_key: 'other-tenant',
      status: 'unknown',
    });

    const app = await buildApp();
    const res = await app.request('/v1/execution/dispatches/pending');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dispatches: { request_key: string }[] };
    // One tenant's stuck batch must never appear in another's queue.
    expect(body.dispatches).toHaveLength(1);
    expect(body.dispatches[0]?.request_key).toBe('req-batch-001');
  });
});
