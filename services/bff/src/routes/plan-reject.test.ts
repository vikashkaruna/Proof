import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const PLAN = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const state = vi.hoisted(() => ({ db: null as FakeDb | null }));

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SUPABASE_URL = 'https://local.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'a'.repeat(40);
  process.env.SUPABASE_SERVICE_KEY = 'b'.repeat(40);
  process.env.APPROVAL_SIGNING_KEY = 'k'.repeat(48);
});
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));
vi.mock('@axiom/supabase', () => ({ createSupabaseAdmin: () => state.db!.client }));

let db: FakeDb;
let ledgerAppend: ReturnType<typeof vi.fn>;

beforeEach(() => {
  db = createFakeDb();
  state.db = db;
  ledgerAppend = vi.fn(async () => ({ sequenceNo: 1, entryHash: 'hash' }));
});

async function reject() {
  const { v1Routes } = await import('./v1.js');
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: USER } as never);
    c.set('tenantId', TENANT as never);
    c.set('role', UserRole.APPROVER);
    c.set('approvalScopes', []);
    await next();
  });
  app.route(
    '/v1',
    v1Routes({
      approvalEngine: {} as never,
      killSwitch: { isActive: async () => false } as never,
      ledger: { append: ledgerAppend } as never,
      mfa: {} as never,
      realtime: { broadcast: vi.fn() } as never,
    }),
  );
  return app.request(`/v1/plans/${PLAN}/reject`, { method: 'POST' });
}

describe('plan rejection truth', () => {
  it('refuses an absent or non-rejectable plan without a success ledger event', async () => {
    expect((await reject()).status).toBe(409);
    expect(ledgerAppend).not.toHaveBeenCalled();
    db.seed('remediation_plans', { id: PLAN, tenant_id: TENANT, status: 'executing' });
    expect((await reject()).status).toBe(409);
    expect(ledgerAppend).not.toHaveBeenCalled();
  });

  it('does not claim success when the action update fails', async () => {
    db.seed('remediation_plans', { id: PLAN, tenant_id: TENANT, status: 'review' });
    db.seed('remediation_actions', {
      id: '44444444-4444-4444-8444-444444444444',
      tenant_id: TENANT,
      plan_id: PLAN,
      approval_status: 'awaiting_approval',
    });
    db.failNext('remediation_actions');
    const response = await reject();
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('update_failed');
    expect(ledgerAppend).not.toHaveBeenCalled();
  });

  it('records success only after the matching plan and eligible actions change', async () => {
    db.seed('remediation_plans', { id: PLAN, tenant_id: TENANT, status: 'review' });
    db.seed('remediation_actions', {
      id: '44444444-4444-4444-8444-444444444444',
      tenant_id: TENANT,
      plan_id: PLAN,
      approval_status: 'awaiting_approval',
    });
    expect((await reject()).status).toBe(200);
    expect(db.rows('remediation_plans')[0]?.status).toBe('cancelled');
    expect(db.rows('remediation_actions')[0]?.approval_status).toBe('skipped');
    expect(ledgerAppend).toHaveBeenCalledOnce();
  });
});
