import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';

/**
 * W6 — drift acknowledgement and the monitoring-health surface.
 *
 * The acknowledgement route records a human judgement through the
 * SECURITY DEFINER path and renders RPC refusals as refusals. The health
 * route reports what an operator needs to defend "continuous": schedule
 * freshness (with overdue flags) and recent drift counts.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '00000000-0000-4000-8000-000000000001';
const ESTATE = '55555555-5555-4555-8555-555555555555';
const EVENT = '66666666-6666-4666-8666-666666666666';

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
beforeEach(() => {
  fake = createFakeDb();
  db.current = fake;
  fake.onRpc('acknowledge_drift_event', (args) => {
    expect(args.p_tenant_id).toBe(TENANT);
    return { acknowledged: true, acknowledgedBy: args.p_acknowledged_by };
  });
});

async function app(role: UserRole = UserRole.ADMIN) {
  const { v1Routes } = await import('./v1.js');
  const hono = new Hono<{ Variables: Variables }>();
  hono.use('*', async (c, next) => {
    c.set('user', { id: USER } as never);
    c.set('tenantId', TENANT as never);
    c.set('role', role);
    await next();
  });
  hono.route(
    '/v1',
    v1Routes({
      approvalEngine: {} as never,
      killSwitch: { isActive: async () => false } as never,
      ledger: { append: vi.fn() } as never,
      mfa: {} as never,
      realtime: { broadcast: vi.fn() } as never,
    }),
  );
  return hono;
}

describe('POST /v1/monitoring/drift-events/:id/acknowledge', () => {
  it('records the judgement for an estate manager', async () => {
    const res = await (
      await app()
    ).request(`/v1/monitoring/drift-events/${EVENT}/acknowledge`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { acknowledged: boolean } }).data.acknowledged).toBe(
      true,
    );
  });

  it('refuses a caller without ESTATE_MANAGE', async () => {
    const res = await (
      await app(UserRole.AXIOM_ANALYST)
    ).request(`/v1/monitoring/drift-events/${EVENT}/acknowledge`, { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('renders the RPC refusal as a 409', async () => {
    fake.onRpc('acknowledge_drift_event', () => ({ error: 'already_acknowledged' }));
    const res = await (
      await app()
    ).request(`/v1/monitoring/drift-events/${EVENT}/acknowledge`, {
      method: 'POST',
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'already_acknowledged',
    );
  });

  it('refuses a malformed event id', async () => {
    const res = await (
      await app()
    ).request('/v1/monitoring/drift-events/nope/acknowledge', {
      method: 'POST',
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /v1/monitoring/health', () => {
  it('reports schedule freshness and drift counts, tenant-scoped', async () => {
    fake.seed('monitoring_schedules', {
      id: 'sch-1',
      tenant_id: TENANT,
      estate_id: ESTATE,
      name: 'Drift check',
      kind: 'drift_check',
      status: 'active',
      next_run_at: new Date(Date.now() - 60_000).toISOString(),
      last_run_at: new Date(Date.now() - 86_400_000).toISOString(),
    });
    fake.seed('drift_events', {
      id: EVENT,
      tenant_id: TENANT,
      estate_id: ESTATE,
      kind: 'system_added',
      severity: 'high',
      summary: 'system added: New CRM',
      detected_at: new Date(Date.now() - 3_600_000).toISOString(),
      acknowledged_at: new Date(Date.now() - 1_800_000).toISOString(),
    });
    fake.seed('drift_events', {
      id: 'e2',
      tenant_id: TENANT,
      estate_id: ESTATE,
      kind: 'system_changed',
      severity: 'medium',
      summary: 'system changed: HR',
      detected_at: new Date(Date.now() - 7_200_000).toISOString(),
      acknowledged_at: null,
    });
    const res = await (await app()).request('/v1/monitoring/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        schedules: Array<{ overdue: boolean }>;
        drift: {
          detectedLast7Days: number;
          unacknowledged: number;
          bySeverity: Record<string, number>;
        };
      };
    };
    expect(body.data.schedules[0]?.overdue).toBe(true);
    expect(body.data.drift.detectedLast7Days).toBe(2);
    expect(body.data.drift.unacknowledged).toBe(1);
    expect(body.data.drift.bySeverity.high).toBe(1);
  });
});
