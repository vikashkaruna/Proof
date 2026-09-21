import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';
const TENANT = '11111111-1111-4111-8111-111111111111';
const FOREIGN = '22222222-2222-4222-8222-222222222222';
const USER = '00000000-0000-4000-8000-000000000001';
const DESCRIPTOR = '41410000-0000-4000-8000-000000000001';
const db = vi.hoisted(() => ({ current: null as FakeDb | null }));
vi.mock('@axiom/supabase', () => ({ createSupabaseAdmin: () => db.current!.client }));
import { connectorRoutes } from './connectors.js';
let fake: FakeDb;
let calls: Record<string, unknown>[];
beforeEach(() => {
  fake = createFakeDb({
    connectors: [
      { id: FOREIGN, tenant_id: FOREIGN, descriptor_id: DESCRIPTOR },
      { id: USER, tenant_id: TENANT, descriptor_id: DESCRIPTOR },
    ],
  });
  db.current = fake;
  calls = [];
  fake.onRpc('manage_connector', (args) => {
    calls.push(args);
    return { resource: { id: USER } };
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
  app.route('/v1', connectorRoutes());
  return app;
}
const payload = {
  systemId: USER,
  descriptorId: DESCRIPTOR,
  name: 'Primary',
  endpointRef: 'primary_crm',
};
const request = (
  body: unknown = payload,
  role: UserRole = UserRole.OWNER,
  path = '/v1/connectors',
  method = 'POST',
) =>
  app(role).request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
describe('connector registration API', () => {
  it.each([UserRole.OWNER, UserRole.ADMIN, UserRole.FOUNDER])(
    'allows %s with trusted scope',
    async (role) => {
      expect((await request(payload, role)).status).toBe(201);
      expect(calls[0]).toMatchObject({
        p_actor_id: USER,
        p_tenant_id: TENANT,
        p_operation: 'create',
        p_payload: payload,
        p_descriptor: { id: DESCRIPTOR, targetBinding: 'production' },
      });
    },
  );
  it.each([
    UserRole.AXIOM_ANALYST,
    UserRole.PARTNER,
    UserRole.VIEWER,
    UserRole.REVIEWER,
    UserRole.APPROVER,
    UserRole.AGENT,
  ])('refuses %s mutations', async (role) => {
    expect((await request(payload, role)).status).toBe(403);
    expect(calls).toHaveLength(0);
  });
  it.each([
    { ...payload, tenantId: FOREIGN },
    { ...payload, password: 'no' },
    { ...payload, descriptorId: FOREIGN },
    { ...payload, endpointRef: 'postgres://secret@host' },
  ])('rejects scope/secret/catalogue injection %#', async (body) => {
    expect((await request(body)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
  it('scopes all admin reads and refuses foreign ids', async () => {
    const list = await app().request('/v1/connectors');
    expect(await list.json()).toMatchObject({ data: [{ id: USER }] });
    expect(
      (
        await request(
          { operation: 'transition', expectedVersion: 1, status: 'active' },
          UserRole.OWNER,
          `/v1/connectors/${FOREIGN}`,
          'PATCH',
        )
      ).status,
    ).toBe(404);
    expect(calls).toHaveLength(0);
  });
  it.each([
    'version_conflict',
    'parent_archived',
    'descriptor_conflict',
    'invalid_transition',
    'disable_before_edit',
  ])('maps %s to conflict', async (error) => {
    fake.onRpc('manage_connector', () => ({ error }));
    expect(
      (
        await request(
          { operation: 'transition', expectedVersion: 1, status: 'active' },
          UserRole.OWNER,
          `/v1/connectors/${USER}`,
          'PATCH',
        )
      ).status,
    ).toBe(409);
  });
  it('does not expose database errors', async () => {
    fake.failNextRpc('manage_connector');
    const result = await request();
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({ error: { code: 'connector_unavailable' } });
  });
  it('catalogue is read-only and does not claim execution', async () => {
    const result = await app(UserRole.VIEWER).request('/v1/connector-catalogue');
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ executionAvailable: false });
    expect(calls).toHaveLength(0);
  });
});
