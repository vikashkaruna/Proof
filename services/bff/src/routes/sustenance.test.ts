import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';
vi.mock('@axiom/supabase', () => ({ createSupabaseAdmin: vi.fn() }));
import { sustenanceRoutes } from './sustenance.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '00000000-0000-4000-8000-000000000001';
const ESTATE = '55555555-5555-4555-8555-555555555555';
const GRANT = '66666666-6666-4666-8666-666666666666';
type Reply = { data?: unknown; error?: Record<string, unknown> };
const body = async (res: Response) => (await res.json()) as Reply;
let fake: FakeDb;
let calls: Record<string, Record<string, unknown>[]>;
let attest: (a: Record<string, unknown>) => unknown;
let drift: unknown;
let issue: (a: Record<string, unknown>) => unknown;
beforeEach(() => {
  fake = createFakeDb();
  calls = {};
  drift = { status: 'current', added: [], removed: [], changed: [], connectionLost: [] };
  attest = (a) => ({ attestation: { id: 'x', decision: a.p_decision } });
  issue = (a) => ({ grant: { id: GRANT, internal_scope: a.p_scope } });
  const record = (fn: string, result: (a: Record<string, unknown>) => unknown) =>
    fake.onRpc(fn, (args) => {
      (calls[fn] ??= []).push(args);
      return result(args);
    });
  record('onboarding_estate_drift', () => drift);
  record('connector_grant_review_queue', () => [{ id: GRANT, overdue: true }]);
  record('attest_connector_grant', (a) => attest(a));
  record('issue_connector_grant', (a) => issue(a));
});
function app(role: UserRole = UserRole.ADMIN) {
  const hono = new Hono<{ Variables: Variables }>();
  hono.use('*', async (c, next) => {
    c.set('user', { id: USER } as never);
    c.set('tenantId', TENANT as never);
    c.set('role', role);
    await next();
  });
  hono.route('/v1', sustenanceRoutes({ client: () => fake.client as never }));
  return hono;
}
const attestAs = (decision: unknown, role?: UserRole, grant = GRANT) =>
  app(role).request(`/v1/connector-grants/${grant}/attestations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision }),
  });

describe('sustenance routes (C-W3-6)', () => {
  it('reports drift for a tenant estate to readers', async () => {
    const res = await app(UserRole.VIEWER).request(`/v1/estates/${ESTATE}/drift`);
    expect(res.status).toBe(200);
    expect((await body(res)).data).toEqual(drift);
    expect(calls.onboarding_estate_drift?.[0]).toEqual({
      p_tenant_id: TENANT,
      p_estate_id: ESTATE,
    });
  });

  it('maps an unknown estate to 404 and refuses a malformed id', async () => {
    drift = { error: 'not_found' };
    expect((await app().request(`/v1/estates/${ESTATE}/drift`)).status).toBe(404);
    expect((await app().request('/v1/estates/nope/drift')).status).toBe(400);
  });

  it('lists the grant review queue', async () => {
    const res = await app(UserRole.VIEWER).request('/v1/connector-grants/review');
    expect((await body(res)).data).toEqual([{ id: GRANT, overdue: true }]);
  });

  it('records keep and revoke decisions for connector managers only', async () => {
    const kept = await attestAs('keep');
    expect(kept.status).toBe(201);
    expect(calls.attest_connector_grant?.[0]).toMatchObject({
      p_tenant_id: TENANT,
      p_actor_id: USER,
      p_grant_id: GRANT,
      p_decision: 'keep',
    });
    expect((await attestAs('revoke')).status).toBe(201);
    expect((await attestAs('keep', UserRole.APPROVER)).status).toBe(403);
    expect(calls.attest_connector_grant).toHaveLength(2);
  });

  it('refuses invalid decisions before the database and maps refusals', async () => {
    expect((await attestAs('extend')).status).toBe(400);
    expect((await attestAs('keep', undefined, 'nope')).status).toBe(400);
    expect(calls.attest_connector_grant).toBeUndefined();
    attest = () => ({ error: 'not_active' });
    const res = await attestAs('keep');
    expect(res.status).toBe(409);
    expect((await body(res)).error?.code).toBe('not_active');
    attest = () => ({ error: 'surprise' });
    expect((await attestAs('keep')).status).toBe(503);
  });

  const grantBody = {
    connectorId: ESTATE,
    workloadIdentityId: GRANT,
    scope: 'connector.read',
    targetScopes: ['crm.read'],
    ttlDays: 30,
  };
  const issueAs = (payload: unknown, role?: UserRole) =>
    app(role).request('/v1/connector-grants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

  it('issues a grant through the audited RPC for connector managers', async () => {
    const res = await issueAs(grantBody);
    expect(res.status).toBe(201);
    expect(calls.issue_connector_grant?.[0]).toMatchObject({
      p_tenant_id: TENANT,
      p_actor_id: USER,
      p_scope: 'connector.read',
      p_target_scopes: ['crm.read'],
      p_ttl_days: 30,
    });
    expect((await issueAs(grantBody, UserRole.APPROVER)).status).toBe(403);
    expect(calls.issue_connector_grant).toHaveLength(1);
  });

  it('validates grant bodies and maps refusals', async () => {
    for (const bad of [
      { ...grantBody, ttlDays: 91 },
      { ...grantBody, targetScopes: [] },
      { ...grantBody, targetScopes: ['a', 'a'] },
      { ...grantBody, agentName: 'karya' },
    ])
      expect((await issueAs(bad)).status).toBe(400);
    expect(calls.issue_connector_grant).toBeUndefined();
    issue = () => ({ error: 'agent_scope_refused' });
    expect((await issueAs(grantBody)).status).toBe(403);
    issue = () => ({ error: 'write_requires_production' });
    expect((await issueAs(grantBody)).status).toBe(409);
  });
});
