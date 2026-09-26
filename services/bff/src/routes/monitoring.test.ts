import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';

/**
 * W6 — monitoring schedule registration.
 *
 * Registration is an estate-manager action, and the tests mostly pin what
 * must NOT happen: a schedule in the past, an unbounded name, a malformed
 * cadence, a viewer registering, and a refusal rendered as a success.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '00000000-0000-4000-8000-000000000001';
const ESTATE = '55555555-5555-4555-8555-555555555555';

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

const schedule = {
  schedule: { id: 'sch-1', kind: 'drift_check', cadence: '*/15 * * * *', status: 'active' },
};

let fake: FakeDb;
let broadcast: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fake = createFakeDb();
  db.current = fake;
  broadcast = vi.fn();
  fake.onRpc('register_monitoring_schedule', (args) => {
    expect(args.p_tenant_id).toBe(TENANT);
    return schedule;
  });
});

const body = {
  estateId: ESTATE,
  name: 'Fortnightly drift check',
  kind: 'drift_check',
  cadence: '*/15 * * * *',
  nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
};

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
      realtime: { broadcast } as never,
    }),
  );
  return hono;
}

describe('POST /v1/monitoring/schedules', () => {
  it('registers a schedule for an estate manager', async () => {
    const res = await (
      await app()
    ).request('/v1/monitoring/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: unknown }).data).toEqual(schedule);
  });

  it('refuses a caller without ESTATE_MANAGE', async () => {
    const res = await (
      await app(UserRole.AXIOM_ANALYST)
    ).request('/v1/monitoring/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(403);
  });

  it.each([
    { ...body, nextRunAt: new Date(Date.now() - 1000).toISOString() },
    { ...body, cadence: 'every fifteen minutes' },
    { ...body, name: 'bad; name <script>' },
    { ...body, kind: 'everything' },
  ])('refuses an invalid schedule %j', async (payload) => {
    const res = await (
      await app()
    ).request('/v1/monitoring/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(400);
  });

  it('renders the RPC refusal as a 409, not a success', async () => {
    fake.onRpc('register_monitoring_schedule', () => ({ error: 'estate_not_found' }));
    const res = await (
      await app()
    ).request('/v1/monitoring/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('estate_not_found');
  });
});

describe('GET /v1/monitoring/schedules', () => {
  it('lists the tenant’s schedules, scoped to the tenant', async () => {
    fake.seed('monitoring_schedules', {
      id: 'sch-a',
      tenant_id: TENANT,
      estate_id: ESTATE,
      name: 'Drift check',
      kind: 'drift_check',
      cadence: '*/15 * * * *',
      status: 'active',
      created_by: USER,
      created_at: '2026-09-26T00:00:00Z',
    });
    fake.seed('monitoring_schedules', {
      id: 'sch-other',
      tenant_id: '99999999-9999-4999-8999-999999999999',
      estate_id: ESTATE,
      name: 'Other tenant',
      kind: 'drift_check',
      cadence: '*/15 * * * *',
      status: 'active',
      created_by: USER,
      created_at: '2026-09-26T01:00:00Z',
    });
    const res = await (await app()).request('/v1/monitoring/schedules');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((s) => s.id)).toEqual(['sch-a']);
  });
});
