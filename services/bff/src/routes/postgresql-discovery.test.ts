import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';
const state = vi.hoisted(() => ({ db: null as FakeDb | null }));
vi.mock('@axiom/supabase', () => ({
  createSupabaseAdmin: () => state.db!.client,
  createHumanActionWriter: () => state.db!.client,
}));
import { postgresqlDiscoveryRoutes } from './postgresql-discovery.js';
const id = (n: number) => `72720000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const run = vi.fn();
let db: FakeDb;
beforeEach(() => {
  db = createFakeDb({ postgresql_discovery_requests: [], connector_discovery_runs: [] });
  state.db = db;
  run.mockReset().mockResolvedValue({ workerStatus: 'read_completed', cleanupConfirmed: true });
  db.onRpc('request_postgresql_discovery', () => ({
    requestId: id(3),
    status: 'queued',
    replayed: false,
  }));
  db.onRpc('finish_postgresql_discovery', () => ({ requestId: id(3), status: 'completed' }));
});
function app(role: UserRole = UserRole.OWNER) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('tenantId', id(1) as never);
    c.set('user', { id: id(2) } as never);
    c.set('role', role);
    await next();
  });
  app.route('/v1', postgresqlDiscoveryRoutes({ run }));
  return app;
}
const body = { operationKey: id(3), estateId: id(4), engagementId: id(5), operation: 'enumerate' };
const request = (input: unknown = body, role: UserRole = UserRole.OWNER) =>
  app(role).request(`/v1/connectors/${id(6)}/discovery`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
it('persists authenticated human scope before pointer-only controller dispatch', async () => {
  expect((await request()).status).toBe(200);
  expect(run).toHaveBeenCalledWith(id(1), id(3));
});
it('does not dispatch a viewer', async () => {
  expect((await request(body, UserRole.VIEWER)).status).toBe(403);
  expect(run).not.toHaveBeenCalled();
});
it('refuses caller endpoints, passwords and workload proofs', async () => {
  for (const field of ['endpoint', 'password', 'workloadProof'])
    expect((await request({ ...body, [field]: 'untrusted' })).status).toBe(400);
  expect(run).not.toHaveBeenCalled();
});
it('never retries an already retained operation', async () => {
  db.onRpc('request_postgresql_discovery', () => ({
    requestId: id(3),
    status: 'claimed',
    replayed: true,
  }));
  expect((await request()).status).toBe(200);
  expect(run).not.toHaveBeenCalled();
});
it('keeps uncertain controller cleanup honest', async () => {
  run.mockRejectedValue(new Error('private daemon error'));
  db.onRpc('finish_postgresql_discovery', (args) => {
    expect(args.clean).toBe(false);
    return { requestId: id(3), status: 'unconfirmed' };
  });
  const response = await request();
  expect(response.status).toBe(202);
  expect(await response.text()).not.toContain('daemon');
});
it('does not show metadata from a read awaiting supervisor cleanup', async () => {
  db.rows('postgresql_discovery_requests').push(
    ...[
      {
        id: id(3),
        tenant_id: id(1),
        connector_id: id(6),
        status: 'read_completed',
        discovery_run_id: id(7),
      },
    ],
  );
  db.rows('connector_discovery_runs').push(
    ...[{ id: id(7), tenant_id: id(1), result: [{ resource: 'public.synthetic' }] }],
  );
  const response = await app().request(`/v1/connectors/${id(6)}/discovery`);
  expect(await response.json()).toMatchObject({ data: [{ result: null }] });
});
