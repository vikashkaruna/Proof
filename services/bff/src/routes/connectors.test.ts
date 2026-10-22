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
vi.mock('@axiom/supabase', () => ({
  createSupabaseAdmin: () => db.current!.client,
  createHumanActionWriter: () => db.current!.client,
}));
import { connectorRoutes } from './connectors.js';
let fake: FakeDb;
let calls: Record<string, unknown>[];
beforeEach(() => {
  fake = createFakeDb({
    connectors: [
      { id: FOREIGN, tenant_id: FOREIGN, descriptor_id: DESCRIPTOR },
      { id: USER, tenant_id: TENANT, descriptor_id: DESCRIPTOR, status: 'active' },
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
    const body = (await result.json()) as {
      executionAvailable: boolean;
      entries: { target: string; family: string; targetBinding: string }[];
    };
    expect(body.executionAvailable).toBe(false);
    expect(calls).toHaveLength(0);
    // Every SQL plug-in is offered for production and the local sandbox.
    for (const target of ['postgresql', 'mysql', 'mariadb'])
      for (const binding of ['production', 'sandbox'])
        expect(
          body.entries.some(
            (e) => e.target === target && e.family === 'sql' && e.targetBinding === binding,
          ),
        ).toBe(true);
  });
  it('reports only current tenant setup metadata without exposing credential material or claiming a live check', async () => {
    const expired = '2020-01-01T00:00:00.000Z';
    const current = '2099-01-01T00:00:00.000Z';
    fake.seed('connector_credentials', {
      id: 'old',
      tenant_id: TENANT,
      connector_id: USER,
      expires_at: expired,
      revoked_at: null,
      ciphertext: 'private-secret',
    });
    fake.seed('connector_credentials', {
      id: 'current',
      tenant_id: TENANT,
      connector_id: USER,
      expires_at: current,
      revoked_at: null,
      ciphertext: 'private-secret',
    });
    fake.seed('connector_credentials', {
      id: 'foreign',
      tenant_id: FOREIGN,
      connector_id: USER,
      expires_at: null,
      revoked_at: null,
      ciphertext: 'foreign-secret',
    });
    fake.seed('connector_grants', {
      id: 'grant',
      tenant_id: TENANT,
      connector_id: USER,
      internal_scope: 'connector.read',
      expires_at: current,
      revoked_at: null,
    });
    fake.seed('connector_health_checks', {
      tenant_id: TENANT,
      connector_id: USER,
      status: 'degraded',
      checked_at: '2026-10-03T12:00:00.000Z',
      error_code: 'timeout',
    });
    const response = await app(UserRole.VIEWER).request(`/v1/connectors/${USER}/readiness`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await response.json();
    expect(body).toEqual({
      data: {
        connectorId: USER,
        registrationStatus: 'active',
        credentialConfigured: true,
        readGrantConfigured: true,
        lastObservation: {
          status: 'degraded',
          checked_at: '2026-10-03T12:00:00.000Z',
          error_code: 'timeout',
        },
        liveCheckAvailable: false,
      },
    });
    expect(JSON.stringify(body)).not.toContain('private-secret');
    expect(JSON.stringify(body)).not.toContain('foreign-secret');
    expect(await (await app().request(`/v1/connectors/${FOREIGN}/readiness`)).json()).toMatchObject(
      { error: { code: 'not_found' } },
    );
  });
  it('does not treat expired or revoked setup as current', async () => {
    fake.seed('connector_credentials', {
      tenant_id: TENANT,
      connector_id: USER,
      expires_at: '2020-01-01T00:00:00.000Z',
      revoked_at: null,
    });
    fake.seed('connector_grants', {
      tenant_id: TENANT,
      connector_id: USER,
      internal_scope: 'connector.read',
      expires_at: '2099-01-01T00:00:00.000Z',
      revoked_at: '2026-01-01T00:00:00.000Z',
    });
    const response = await app().request(`/v1/connectors/${USER}/readiness`);
    expect(await response.json()).toMatchObject({
      data: { credentialConfigured: false, readGrantConfigured: false, lastObservation: null },
    });
  });
  it('ignores other tenants even when they reuse the same connector identifier', async () => {
    fake.seed('connector_credentials', {
      tenant_id: FOREIGN,
      connector_id: USER,
      expires_at: null,
      revoked_at: null,
    });
    fake.seed('connector_grants', {
      tenant_id: FOREIGN,
      connector_id: USER,
      internal_scope: 'connector.read',
      expires_at: '2099-01-01T00:00:00.000Z',
      revoked_at: null,
    });
    fake.seed('connector_health_checks', {
      tenant_id: FOREIGN,
      connector_id: USER,
      status: 'healthy',
      checked_at: '2026-10-03T12:00:00.000Z',
      error_code: null,
    });
    const response = await app().request(`/v1/connectors/${USER}/readiness`);
    expect(await response.json()).toMatchObject({
      data: { credentialConfigured: false, readGrantConfigured: false, lastObservation: null },
    });
  });
  it('fails closed when setup storage is unavailable', async () => {
    fake.failNext('connector_credentials');
    const response = await app().request(`/v1/connectors/${USER}/readiness`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'connector_unavailable' } });
  });
  it('refuses readiness to roles without posture-read access and malformed connector ids', async () => {
    expect((await app(UserRole.AGENT).request(`/v1/connectors/${USER}/readiness`)).status).toBe(
      403,
    );
    expect((await app().request('/v1/connectors/not-a-uuid/readiness')).status).toBe(400);
  });
});
