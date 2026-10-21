import { z } from 'zod';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { actor, evidenceFixture, foreign, tenant } from '../test/evidence-fixture.js';
import type { Variables } from '../types.js';

vi.hoisted(() =>
  Object.assign(process.env, {
    NODE_ENV: 'test',
    SUPABASE_URL: 'https://local.supabase.co',
    SUPABASE_ANON_KEY: 'a'.repeat(40),
    SUPABASE_SERVICE_KEY: 'b'.repeat(40),
    APPROVAL_SIGNING_KEY: 'k'.repeat(48),
  }),
);
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@axiom/supabase', async (original) => {
  const actual = (await original()) as typeof import('@axiom/supabase');
  return { ...actual, createSupabaseAdmin: () => state.db };
});

async function setup(designation: 'live' | 'revoked' | 'absent' = 'live') {
  const fixture = evidenceFixture();
  state.db = fixture.db;
  const base = {
    tier: 'growth',
    is_sdf: false,
    processes_health_data: false,
    processes_children_data: false,
    created_at: '2026-10-20T00:00:00Z',
  };
  fixture
    .rows('tenants')
    .push(
      { ...base, id: tenant, name: 'First company', slug: 'first' },
      { ...base, id: foreign, name: 'Second company', slug: 'second' },
    );
  fixture.rows('users').push({ id: actor, is_axiom_internal: true });
  if (designation !== 'absent')
    fixture
      .rows('platform_founders')
      .push({ user_id: actor, revoked_at: designation === 'live' ? null : '2026-10-20T00:00:00Z' });
  fixture.rows('tenant_users').push({
    tenant_id: tenant,
    user_id: actor,
    role: 'viewer',
    tenants: fixture.rows('tenants')[0],
  });
  const { v1Routes } = await import('./v1.js');
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: actor } as never);
    await next();
  });
  app.route(
    '/v1',
    v1Routes({
      approvalEngine: {} as never,
      killSwitch: {} as never,
      ledger: {} as never,
      mfa: {} as never,
      realtime: {} as never,
    }),
  );
  return { fixture, read: () => app.request('/v1/user/tenants') };
}

describe('global founder organization enumeration', () => {
  it('lists every company with effective founder authority despite missing/lower memberships', async () => {
    const f = await setup();
    const response = await f.read();
    expect(response.status).toBe(200);
    const body = z
      .object({ tenants: z.array(z.object({ id: z.uuid(), role: z.string() }).passthrough()) })
      .parse(await response.json());
    expect(body.tenants).toHaveLength(2);
    expect(body.tenants).toEqual(
      expect.arrayContaining([
        { ...f.fixture.rows('tenants')[0], role: 'founder' },
        { ...f.fixture.rows('tenants')[1], role: 'founder' },
      ]),
    );
    expect(f.fixture.rows('tenant_users')[0]?.role).toBe('viewer');
  });
  it.each(['revoked', 'absent'] as const)(
    'retains ordinary explicit viewer scope for %s designation',
    async (designation) => {
      const f = await setup(designation);
      const response = await f.read();
      expect(response.status).toBe(200);
      const body = z
        .object({ tenants: z.array(z.object({ id: z.uuid(), role: z.string() }).passthrough()) })
        .parse(await response.json());
      expect(body.tenants).toHaveLength(1);
      expect(body.tenants[0]).toMatchObject({ id: tenant, role: 'viewer' });
    },
  );
  it('fails closed on unavailable global authority', async () => {
    const f = await setup();
    f.fixture.faults.read = true;
    expect((await f.read()).status).toBe(503);
  });
  it('refuses malformed company records instead of inventing a complete global list', async () => {
    const f = await setup();
    f.fixture.rows('tenants')[1]!.id = 'invalid';
    expect((await f.read()).status).toBe(503);
  });
});
