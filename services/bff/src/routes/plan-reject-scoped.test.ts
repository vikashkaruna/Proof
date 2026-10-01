import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '00000000-0000-4000-8000-000000000001';
const PLAN = '22222222-2222-4222-8222-222222222222';
const db = vi.hoisted(() => ({ service: null as FakeDb | null, writer: null as FakeDb | null }));

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SUPABASE_URL = 'https://local.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'a'.repeat(40);
  process.env.SUPABASE_SERVICE_KEY = 'b'.repeat(40);
  process.env.APPROVAL_SIGNING_KEY = 'k'.repeat(48);
});
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));
vi.mock('@axiom/supabase', () => ({
  createSupabaseAdmin: () => db.service!.client,
  createHumanActionWriter: () => db.writer!.client,
}));

async function app(role: UserRole = UserRole.OWNER) {
  const { v1Routes } = await import('./v1.js');
  const routes = v1Routes({
    approvalEngine: {} as never,
    killSwitch: { isActive: async () => false } as never,
    ledger: {
      append: vi.fn(() => {
        throw new Error('route must not append outside the transaction');
      }),
    } as never,
    mfa: {} as never,
    realtime: {} as never,
  });
  const server = new Hono<{ Variables: Variables }>();
  server.use('*', async (c, next) => {
    c.set('user', { id: USER } as never);
    c.set('tenantId', TENANT as never);
    c.set('role', role);
    await next();
  });
  server.route('/v1', routes);
  return server;
}

beforeEach(() => {
  vi.resetModules();
  db.service = createFakeDb({});
  db.writer = createFakeDb({});
  db.writer.onRpc('reject_remediation_plan', () => ({
    status: 'cancelled',
    skippedActions: 2,
    revokedTokens: 1,
  }));
});

describe('atomic plan rejection route', () => {
  it('sends the authenticated actor to the scoped writer and returns committed counts', async () => {
    const writerRpc = vi.spyOn(db.writer!.client, 'rpc');
    const serviceRpc = vi.spyOn(db.service!.client, 'rpc');
    const serviceFrom = vi.spyOn(db.service!.client, 'from');
    const server = await app();
    const response = await server.request(`/v1/plans/${PLAN}/reject`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      status: 'cancelled',
      skippedActions: 2,
      revokedTokens: 1,
    });
    expect(writerRpc).toHaveBeenCalledWith(
      'reject_remediation_plan',
      expect.objectContaining({
        p_tenant_id: TENANT,
        p_plan_id: PLAN,
        p_actor_id: USER,
      }),
    );
    expect(serviceRpc).not.toHaveBeenCalled();
    expect(serviceFrom).not.toHaveBeenCalled();
  });

  it('refuses a viewer, malformed id and missing plan without recording success', async () => {
    const serviceRpc = vi.spyOn(db.service!.client, 'rpc');
    const serviceFrom = vi.spyOn(db.service!.client, 'from');
    expect(
      (await (await app(UserRole.VIEWER)).request(`/v1/plans/${PLAN}/reject`, { method: 'POST' }))
        .status,
    ).toBe(403);
    expect(
      (await (await app()).request('/v1/plans/not-a-uuid/reject', { method: 'POST' })).status,
    ).toBe(400);
    db.writer!.onRpc('reject_remediation_plan', () => ({ error: 'plan_not_found' }));
    expect(
      (await (await app()).request(`/v1/plans/${PLAN}/reject`, { method: 'POST' })).status,
    ).toBe(404);
    db.writer!.onRpc('reject_remediation_plan', () => ({ error: 'forbidden' }));
    expect(
      (await (await app()).request(`/v1/plans/${PLAN}/reject`, { method: 'POST' })).status,
    ).toBe(403);
    db.writer!.onRpc('reject_remediation_plan', () => ({ error: 'plan_not_rejectable' }));
    expect(
      (await (await app()).request(`/v1/plans/${PLAN}/reject`, { method: 'POST' })).status,
    ).toBe(409);
    expect(serviceRpc).not.toHaveBeenCalled();
    expect(serviceFrom).not.toHaveBeenCalled();
  });

  it('does not claim success when the atomic rejection fails or returns a malformed receipt', async () => {
    db.writer!.onRpc('reject_remediation_plan', () => {
      throw new Error('database unavailable');
    });
    const failed = await (await app()).request(`/v1/plans/${PLAN}/reject`, { method: 'POST' });
    expect(failed.status).toBeGreaterThanOrEqual(500);
    db.writer!.onRpc('reject_remediation_plan', () => ({ status: 'cancelled' }));
    const malformed = await (await app()).request(`/v1/plans/${PLAN}/reject`, { method: 'POST' });
    expect(malformed.status).toBe(503);
    expect(await malformed.json()).toEqual({ error: { code: 'update_failed' } });
  });
});
