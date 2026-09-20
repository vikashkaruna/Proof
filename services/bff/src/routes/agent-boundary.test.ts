import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';

const state = vi.hoisted(() => {
  Object.assign(process.env, {
    ENVIRONMENT: 'test',
    AXIOM_AUTH_MODE: 'strict',
    SUPABASE_URL: 'http://localhost:55321',
    SUPABASE_ANON_KEY: 'a'.repeat(40),
    SUPABASE_SERVICE_KEY: 'b'.repeat(40),
    APPROVAL_SIGNING_KEY: 'k'.repeat(48),
    AGENT_RUNTIME_URL: 'http://runtime.invalid',
    AGENT_RUNTIME_INTERNAL_TOKEN: 't'.repeat(40),
  });
  return { db: null as FakeDb | null };
});
vi.mock('@axiom/supabase', () => ({ createSupabaseAdmin: () => state.db!.client }));
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ENGAGEMENT = '33333333-3333-4333-8333-333333333333';
const transport = vi.fn(
  async () => new Response(JSON.stringify({ status: 'succeeded' }), { status: 200 }),
);

async function request(role: UserRole, agent: string, body: Record<string, unknown>) {
  const { v1Routes } = await import('./v1.js');
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: 'test-user' } as never);
    c.set('tenantId', A as never);
    c.set('role', role);
    c.set('approvalScopes', []);
    await next();
  });
  app.route(
    '/',
    v1Routes({
      approvalEngine: {} as never,
      killSwitch: {} as never,
      ledger: {} as never,
      mfa: {} as never,
      realtime: { broadcast: vi.fn(), subscribe: vi.fn() },
    }),
  );
  return app.request(`/agents/${agent}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.db = createFakeDb();
  transport.mockClear();
  vi.stubGlobal('fetch', transport);
});

describe('agent invocation authority', () => {
  it.each([UserRole.VIEWER, UserRole.PARTNER, UserRole.APPROVER, UserRole.AGENT])(
    'denies %s before dispatch',
    async (role) => {
      expect((await request(role, 'drishti', {})).status).toBe(403);
      expect(transport).not.toHaveBeenCalled();
    },
  );
  it.each(['tenant_id', 'tenantId'])('rejects a foreign %s', async (field) => {
    expect((await request(UserRole.OWNER, 'drishti', { [field]: B })).status).toBe(403);
    expect(transport).not.toHaveBeenCalled();
  });
  it('rejects a foreign engagement', async () => {
    state.db!.seed('engagements', { id: ENGAGEMENT, tenant_id: B });
    expect((await request(UserRole.OWNER, 'drishti', { engagement_id: ENGAGEMENT })).status).toBe(
      404,
    );
    expect(transport).not.toHaveBeenCalled();
  });
  it('cannot invoke Karya even as founder', async () => {
    expect((await request(UserRole.FOUNDER, 'karya', {})).status).toBe(403);
    expect(transport).not.toHaveBeenCalled();
  });
  it.each(['sanket', 'nazar', 'lekha'])('denies customer invocation of %s', async (agent) => {
    expect((await request(UserRole.OWNER, agent, {})).status).toBe(403);
    expect(transport).not.toHaveBeenCalled();
  });
  it('dispatches the owned engagement under the authenticated tenant', async () => {
    state.db!.seed('engagements', { id: ENGAGEMENT, tenant_id: A });
    expect(
      (await request(UserRole.OWNER, 'drishti', { engagement_id: ENGAGEMENT, tenant_id: A }))
        .status,
    ).toBe(200);
    const call = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(call[1].body)).input.tenant_id).toBe(A);
    expect(state.db!.rows('agent_runs')[0]?.metadata).toEqual({ requested_by: 'test-user' });
  });
  it('fails closed when it cannot persist the invocation', async () => {
    state.db!.failNext('agent_runs');
    expect((await request(UserRole.OWNER, 'drishti', {})).status).toBe(503);
    expect(transport).not.toHaveBeenCalled();
  });
});
