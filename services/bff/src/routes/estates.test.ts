import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';
const TENANT = '11111111-1111-4111-8111-111111111111';
const FOREIGN = '22222222-2222-4222-8222-222222222222';
const USER = '00000000-0000-4000-8000-000000000001';
const db = vi.hoisted(() => ({ current: null as FakeDb | null }));
vi.mock('@axiom/supabase', () => ({ createSupabaseAdmin: () => db.current!.client }));
import { estateRoutes } from './estates.js';
let fake: FakeDb;
let calls: Record<string, unknown>[];
beforeEach(() => {
  fake = createFakeDb({ estates: [{ id: FOREIGN, tenant_id: FOREIGN, name: 'Foreign' }] });
  db.current = fake;
  calls = [];
  fake.onRpc('manage_estate', (args) => {
    calls.push(args);
    return { resource: { id: USER, ...(args.p_payload as object) } };
  });
});
function app(role: UserRole = UserRole.OWNER) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: USER } as never);
    c.set('tenantId', TENANT as never);
    c.set('role', role);
    await next();
  });
  app.route('/v1', estateRoutes());
  return app;
}
function post(role: UserRole, body: unknown) {
  return app(role).request('/v1/estates', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
describe('estate API boundaries', () => {
  it.each([UserRole.OWNER, UserRole.ADMIN, UserRole.FOUNDER])(
    '%s can create with trusted tenant/actor',
    async (role) => {
      expect((await post(role, { slug: 'production', name: 'Production' })).status).toBe(201);
      expect(calls[0]).toMatchObject({
        p_tenant_id: TENANT,
        p_actor_id: USER,
        p_operation: 'estate.create',
        p_payload: { slug: 'production', name: 'Production', description: '' },
      });
    },
  );
  it.each([UserRole.VIEWER, UserRole.AXIOM_ANALYST, UserRole.APPROVER, UserRole.AGENT])(
    '%s cannot mutate',
    async (role) => {
      expect((await post(role, { slug: 'production', name: 'Production' })).status).toBe(403);
      expect(calls).toHaveLength(0);
    },
  );
  it('rejects injected tenant or actor fields', async () => {
    expect(
      (await post(UserRole.OWNER, { slug: 'production', name: 'Production', tenantId: FOREIGN }))
        .status,
    ).toBe(400);
    expect(calls).toHaveLength(0);
  });
  it('does not leak another tenant estate', async () => {
    expect((await app().request(`/v1/estates/${FOREIGN}`)).status).toBe(404);
    const res = await app().request('/v1/estates');
    expect(await res.json()).toEqual({ data: [] });
  });
  it('maps concurrent edits to a refreshable conflict', async () => {
    fake.onRpc('manage_estate', () => ({ error: 'version_conflict' }));
    const res = await app().request(`/v1/estates/${USER}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Changed', status: 'active', expectedVersion: 1 }),
    });
    expect(res.status).toBe(409);
  });
  it('fails closed when storage is unavailable', async () => {
    fake.failNextRpc('manage_estate');
    expect((await post(UserRole.OWNER, { slug: 'production', name: 'Production' })).status).toBe(
      503,
    );
  });
  it('requires an explicit scope confirmation', async () => {
    const res = await app().request(`/v1/engagements/${USER}/estate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ estateId: TENANT }),
    });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
