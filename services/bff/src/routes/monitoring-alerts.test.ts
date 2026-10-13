import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';

/**
 * W6 — continuous monitoring alerts and dispatch.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '00000000-0000-4000-8000-000000000001';
const ALERT_ID = '77777777-7777-4777-8777-777777777777';

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
  createHumanActionWriter: () => {
    if (!db.current) throw new Error('fake db not installed');
    return db.current.client;
  },
}));

let fake: FakeDb;
beforeEach(() => {
  fake = createFakeDb();
  db.current = fake;
  fake.onRpc('dispatch_monitoring_alerts', (args) => {
    expect(args.p_tenant_id).toBe(TENANT);
    return {
      dispatchedCount: 3,
      totalUnread: 3,
      criticalCount: 1,
      highCount: 2,
    };
  });
  fake.onRpc('dismiss_monitoring_alert', (args) => {
    expect(args.p_tenant_id).toBe(TENANT);
    if (args.p_alert_id === '00000000-0000-4000-8000-000000000404') {
      return { error: 'alert_not_found' };
    }
    if (args.p_alert_id === '00000000-0000-4000-8000-000000000409') {
      return { error: 'already_dismissed' };
    }
    return { dismissed: true, alertId: args.p_alert_id, acknowledgedBy: args.p_user_id };
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

describe('GET /v1/monitoring/alerts', () => {
  it('lists tenant monitoring alerts with summary', async () => {
    fake.seed('monitoring_alerts', {
      id: ALERT_ID,
      tenant_id: TENANT,
      alert_type: 'drift_critical',
      severity: 'critical',
      title: 'Critical Drift',
      summary: 'Replication connection dropped',
      source_id: 'src-1',
      source_type: 'drift_event',
      status: 'unread',
      dispatched_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      metadata: {},
      acknowledged_at: null,
      acknowledged_by: null,
    });

    const res = await (await app(UserRole.VIEWER)).request('/v1/monitoring/alerts');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        alerts: Array<{ id: string; severity: string }>;
        summary: { total: number; unread: number; critical: number };
      };
    };
    expect(body.data.alerts).toHaveLength(1);
    expect(body.data.alerts[0]!.id).toBe(ALERT_ID);
    expect(body.data.summary.total).toBe(1);
    expect(body.data.summary.unread).toBe(1);
    expect(body.data.summary.critical).toBe(1);
  });

  it('accepts actual SQL code-point limits for non-BMP alert text', async () => {
    const title = '🔒'.repeat(200);
    const summary = '🔒'.repeat(500);
    const source = '🔒'.repeat(100);
    fake.seed('monitoring_alerts', {
      id: ALERT_ID,
      tenant_id: TENANT,
      alert_type: 'drift_critical',
      severity: 'critical',
      title,
      summary,
      source_id: source,
      source_type: 'drift_event',
      status: 'unread',
      dispatched_at: '2026-10-13T00:00:00.123456+00:00',
      created_at: '2026-10-13T00:00:00+05:30',
      acknowledged_at: null,
      acknowledged_by: null,
      metadata: {},
    });
    const res = await (await app(UserRole.VIEWER)).request('/v1/monitoring/alerts');
    expect(res.status).toBe(200);
    const result = (await res.json()) as {
      data: { alerts: Array<{ title: string; summary: string; source_id: string }> };
    };
    expect(result.data.alerts[0]).toMatchObject({ title, summary, source_id: source });
  });

  it.each([
    'empty-row',
    'null-row',
    'foreign-tenant',
    'unknown-severity',
    'missing-ack',
    'metadata-array',
  ])('refuses invalid or cross-tenant list data: %s', async (mode) => {
    const row: Record<string, unknown> = {
      id: ALERT_ID,
      tenant_id: TENANT,
      alert_type: 'drift_critical',
      severity: 'critical',
      title: 'Critical drift',
      summary: 'Connection lost',
      source_id: 'src-1',
      source_type: 'drift_event',
      status: 'unread',
      dispatched_at: '2026-10-13T00:00:00+00:00',
      created_at: '2026-10-13T00:00:00+00:00',
      acknowledged_at: null,
      acknowledged_by: null,
      metadata: {},
    };
    if (mode === 'foreign-tenant') row.tenant_id = USER;
    if (mode === 'unknown-severity') row.severity = 'normal';
    if (mode === 'missing-ack') delete row.acknowledged_by;
    if (mode === 'metadata-array') row.metadata = [];
    const data = [mode === 'empty-row' ? {} : mode === 'null-row' ? null : row];
    const query: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'order', 'limit']) query[method] = () => query;
    query.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data, error: null }).then(resolve);
    fake.client.from = () => query;
    const res = await (await app(UserRole.VIEWER)).request('/v1/monitoring/alerts');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: 'database_unavailable' } });
  });

  it('returns a genuine empty tenant page with zero loaded-page counts', async () => {
    const res = await (await app(UserRole.VIEWER)).request('/v1/monitoring/alerts');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { alerts: [], summary: { total: 0, unread: 0, critical: 0, high: 0 } },
    });
  });

  it('refuses a database error instead of reporting zero monitoring alerts', async () => {
    fake.failNext('monitoring_alerts');
    const res = await (await app(UserRole.VIEWER)).request('/v1/monitoring/alerts');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: 'database_unavailable' } });
  });

  it('refuses a null-success list response instead of claiming no alerts', async () => {
    const query: Record<string, unknown> = {};
    query.select = () => query;
    query.eq = () => query;
    query.order = () => query;
    query.limit = () => query;
    query.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: null, error: null }).then(resolve);
    fake.client.from = () => query;

    const res = await (await app(UserRole.VIEWER)).request('/v1/monitoring/alerts');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: 'database_unavailable' } });
  });
});

describe('POST /v1/monitoring/alerts/dispatch', () => {
  it('triggers alert scan and dispatch for estate managers', async () => {
    const res = await (
      await app(UserRole.ADMIN)
    ).request('/v1/monitoring/alerts/dispatch', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        dispatchedCount: number;
        totalUnread: number;
        criticalCount: number;
        highCount: number;
      };
    };
    expect(body.data.dispatchedCount).toBe(3);
    expect(body.data.totalUnread).toBe(3);
    expect(body.data.criticalCount).toBe(1);
    expect(body.data.highCount).toBe(2);
  });

  it.each([
    null,
    {},
    [],
    'success',
    { dispatchedCount: '3', totalUnread: 3, criticalCount: 1, highCount: 2 },
    { dispatchedCount: -1, totalUnread: 3, criticalCount: 1, highCount: 2 },
    { dispatchedCount: 0.5, totalUnread: 3, criticalCount: 1, highCount: 2 },
    { dispatchedCount: 1, totalUnread: 1, criticalCount: 1, highCount: 1 },
    { dispatchedCount: 1, totalUnread: 3, criticalCount: 1 },
    { error: { message: 'private diagnostic' } },
  ])('refuses an unconfirmed or malformed dispatch reply: %j', async (reply) => {
    fake.onRpc('dispatch_monitoring_alerts', () => reply);
    const res = await (
      await app(UserRole.ADMIN)
    ).request('/v1/monitoring/alerts/dispatch', { method: 'POST' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: 'database_unavailable' } });
  });

  it('accepts genuine zero counts without treating missing counts as zero', async () => {
    fake.onRpc('dispatch_monitoring_alerts', () => ({
      dispatchedCount: 0,
      totalUnread: 0,
      criticalCount: 0,
      highCount: 0,
    }));
    const res = await (
      await app(UserRole.ADMIN)
    ).request('/v1/monitoring/alerts/dispatch', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { dispatchedCount: 0, totalUnread: 0, criticalCount: 0, highCount: 0 },
    });
  });
  it('preserves the actual tenant refusal rather than interpreting it as counts', async () => {
    fake.onRpc('dispatch_monitoring_alerts', () => ({ error: 'tenant_not_found' }));
    const res = await (
      await app(UserRole.ADMIN)
    ).request('/v1/monitoring/alerts/dispatch', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: 'tenant_not_found' } });
  });
  it('does not retry a dispatch whose reply cannot confirm its outcome', async () => {
    let calls = 0;
    fake.onRpc('dispatch_monitoring_alerts', () => {
      calls++;
      return null;
    });
    const res = await (
      await app(UserRole.ADMIN)
    ).request('/v1/monitoring/alerts/dispatch', { method: 'POST' });
    expect(res.status).toBe(503);
    expect(calls).toBe(1);
  });

  it('refuses users lacking estate manage capability', async () => {
    const res = await (
      await app(UserRole.VIEWER)
    ).request('/v1/monitoring/alerts/dispatch', {
      method: 'POST',
    });
    expect(res.status).toBe(403);
  });
});

describe('POST /v1/monitoring/alerts/:id/dismiss', () => {
  it('dismisses an alert for estate managers', async () => {
    const res = await (
      await app(UserRole.ADMIN)
    ).request(`/v1/monitoring/alerts/${ALERT_ID}/dismiss`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { dismissed: boolean; alertId: string } };
    expect(body.data.dismissed).toBe(true);
    expect(body.data.alertId).toBe(ALERT_ID);
  });

  it('accepts an uppercase UUID path using the same canonical SQL identity', async () => {
    const id = 'abcdefab-abcd-4abc-8abc-abcdefabcdef';
    fake.onRpc('dismiss_monitoring_alert', (args) => {
      expect(args.p_alert_id).toBe(id);
      return { dismissed: true, alertId: id, acknowledgedBy: USER };
    });
    const res = await (
      await app(UserRole.ADMIN)
    ).request(`/v1/monitoring/alerts/${id.toUpperCase()}/dismiss`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { dismissed: true, alertId: id, acknowledgedBy: USER },
    });
  });

  it('does not retry a dismissal whose reply cannot confirm its outcome', async () => {
    let calls = 0;
    fake.onRpc('dismiss_monitoring_alert', () => {
      calls++;
      return null;
    });
    const res = await (
      await app(UserRole.ADMIN)
    ).request(`/v1/monitoring/alerts/${ALERT_ID}/dismiss`, { method: 'POST' });
    expect(res.status).toBe(503);
    expect(calls).toBe(1);
  });

  it('refuses invalid alert UUIDs', async () => {
    const res = await (
      await app(UserRole.ADMIN)
    ).request('/v1/monitoring/alerts/invalid-uuid/dismiss', { method: 'POST' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for missing alerts', async () => {
    const res = await (
      await app(UserRole.ADMIN)
    ).request('/v1/monitoring/alerts/00000000-0000-4000-8000-000000000404/dismiss', {
      method: 'POST',
    });
    expect(res.status).toBe(404);
  });

  it('returns 409 for already dismissed alerts', async () => {
    const res = await (
      await app(UserRole.ADMIN)
    ).request('/v1/monitoring/alerts/00000000-0000-4000-8000-000000000409/dismiss', {
      method: 'POST',
    });
    expect(res.status).toBe(409);
  });

  it.each([
    null,
    {},
    [],
    { dismissed: 'false', alertId: ALERT_ID, acknowledgedBy: USER },
    { dismissed: false, alertId: ALERT_ID, acknowledgedBy: USER },
    { dismissed: true, acknowledgedBy: USER },
    { dismissed: true, alertId: ALERT_ID },
    { dismissed: true, alertId: TENANT, acknowledgedBy: USER },
    { dismissed: true, alertId: ALERT_ID, acknowledgedBy: TENANT },
    { dismissed: true, alertId: ALERT_ID, acknowledgedBy: USER, error: 'already_dismissed' },
    { error: 'private diagnostic' },
  ])('refuses an unconfirmed or wrong-identity dismissal reply: %j', async (reply) => {
    fake.onRpc('dismiss_monitoring_alert', () => reply);
    const res = await (
      await app(UserRole.ADMIN)
    ).request(`/v1/monitoring/alerts/${ALERT_ID}/dismiss`, { method: 'POST' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: 'database_unavailable' } });
  });

  it('refuses users lacking estate manage capability', async () => {
    const res = await (
      await app(UserRole.VIEWER)
    ).request(`/v1/monitoring/alerts/${ALERT_ID}/dismiss`, { method: 'POST' });
    expect(res.status).toBe(403);
  });
});
