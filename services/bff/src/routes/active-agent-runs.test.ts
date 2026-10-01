import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const FOREIGN_TENANT = '22222222-2222-4222-8222-222222222222';
const database = vi.hoisted(() => ({ current: null as FakeDb | null }));

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SUPABASE_URL = 'https://local.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'a'.repeat(40);
  process.env.SUPABASE_SERVICE_KEY = 'b'.repeat(40);
  process.env.APPROVAL_SIGNING_KEY = 'k'.repeat(48);
});

vi.mock('@axiom/supabase', () => ({
  createSupabaseAdmin: () => database.current!.client,
}));

let fake: FakeDb;
beforeEach(() => {
  fake = createFakeDb();
  database.current = fake;
});

async function request() {
  const { v1Routes } = await import('./v1.js');
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: 'test-user' } as never);
    c.set('tenantId', TENANT as never);
    c.set('role', UserRole.VIEWER);
    await next();
  });
  app.route(
    '/v1',
    v1Routes({
      approvalEngine: {} as never,
      killSwitch: {} as never,
      ledger: {} as never,
      mfa: {} as never,
      realtime: { broadcast: vi.fn() } as never,
    }),
  );
  return app.request('/v1/agents/runs/active');
}

describe('GET /v1/agents/runs/active', () => {
  it('returns only queued or running rows from the authenticated tenant', async () => {
    fake.seed('agent_runs', {
      id: 'own-running',
      tenant_id: TENANT,
      agent: 'drishti',
      status: 'running',
      started_at: '2026-10-01T02:00:00Z',
    });
    fake.seed('agent_runs', {
      id: 'own-queued',
      tenant_id: TENANT,
      agent: 'vibhaag',
      status: 'queued',
      started_at: '2026-10-01T01:00:00Z',
    });
    fake.seed('agent_runs', {
      id: 'own-complete',
      tenant_id: TENANT,
      agent: 'drishti',
      status: 'succeeded',
      started_at: '2026-10-01T00:00:00Z',
    });
    fake.seed('agent_runs', {
      id: 'foreign-running',
      tenant_id: FOREIGN_TENANT,
      agent: 'lekha',
      status: 'running',
      started_at: '2026-10-01T03:00:00Z',
    });

    const response = await request();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { active_runs: Array<{ id: string; agent: string; status: string }> };
    expect(body.active_runs.map((run) => run.id)).toEqual(['own-running', 'own-queued']);
    expect(body.active_runs.map((run) => ({ agent: run.agent, status: run.status }))).toEqual([
      { agent: 'drishti', status: 'running' },
      { agent: 'vibhaag', status: 'queued' },
    ]);
  });

  it('treats a database error as unavailable rather than reporting no active work', async () => {
    fake.failNext('agent_runs');
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: 'query_failed', message: 'Unable to read active agent runs.' },
    });
  });

  it('refuses a null-success result that cannot prove the active queue is empty', async () => {
    fake.client.from = () => ({
      select: () => ({
        eq: () => ({
          in: () => ({ order: async () => ({ data: null, error: null }) }),
        }),
      }),
    });
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: 'query_failed', message: 'Unable to read active agent runs.' },
    });
  });
});
