/** Actual createApp middleware/mount checks with synthetic Auth/controller ports; not live login. */
import { beforeEach, expect, it, vi } from 'vitest';
import type { Variables } from '../types.js';
import type { OwnedSyntheticRouteDeps } from './owned-synthetic-plans.js';
const state = vi.hoisted(() => {
  Object.assign(process.env, {
    ENVIRONMENT: 'test',
    AXIOM_AUTH_MODE: 'strict',
    SUPABASE_URL: 'http://localhost:55321',
    SUPABASE_ANON_KEY: 'a'.repeat(40),
    SUPABASE_SERVICE_KEY: 'b'.repeat(40),
    APPROVAL_SIGNING_KEY: 'k'.repeat(48),
  });
  return {
    role: 'owner' as Variables['role'],
    authenticated: true,
    mfa: true,
    cache: vi.fn(),
    lookup: vi.fn(),
    source: vi.fn(),
  };
});
const id = (n: number) => `89170000-0000-4000-8000-${String(n).padStart(12, '0')}`;
vi.mock('../middleware/auth.js', async () => {
  const { createMiddleware } = await import('hono/factory');
  return {
    authMiddleware: createMiddleware<{ Variables: Variables }>(async (c, next) => {
      if (!state.authenticated) return c.json({ error: { code: 'unauthorized' } }, 401);
      c.set('user', { id: id(2) } as Variables['user']);
      c.set('sessionId', id(3));
      return next();
    }),
  };
});
vi.mock('../middleware/tenant.js', async () => {
  const { createMiddleware } = await import('hono/factory');
  return {
    tenantResolver: createMiddleware<{ Variables: Variables }>(async (c, next) => {
      c.set('tenantId', id(1));
      c.set('role', state.role);
      c.set('approvalScopes', []);
      return next();
    }),
  };
});
vi.mock('../services/mfa.js', () => ({
  createMfaService: () => ({
    requiresLoginMfa: async () => true,
    isEnrolled: async () => true,
    sessionAttestation: async () =>
      state.mfa ? { factorId: id(3), validUntil: Date.now() + 10000 } : null,
  }),
}));
vi.mock('../services/kill-switch.js', () => ({
  createKillSwitchService: () => ({ isActive: async () => false }),
}));
vi.mock('../services/approval.js', () => ({ createApprovalEngine: () => ({}) }));
vi.mock('../services/ledger.js', () => ({ createLedgerService: () => ({}) }));
vi.mock('../services/realtime.js', () => ({ startRealtimeChannel: () => ({}) }));
vi.mock('../services/saakshi-staging-composition.js', () => ({
  createSaakshiComposition: () => null,
  evidenceControllerRpc: {
    call: () => {
      throw Error('Unrelated evidence source');
    },
  },
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ rpc: state.cache }) }));
vi.mock('@axiom/supabase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@axiom/supabase')>()),
  createSupabaseAdmin: () => ({ from: state.lookup }),
}));
import { createApp } from '../app.js';
function fixture(enabled = true) {
  const unavailable = () => {
    throw Error('Owned source port not installed in application mount test');
  };
  const owned: OwnedSyntheticRouteDeps = {
    isKilled: async () => false,
    planPorts: unavailable,
    cancellationPorts: unavailable,
    readOriginalOutcome: async () => unavailable(),
    readTargets: async () => state.source(),
  };
  const app = createApp({ ownedSynthetic: enabled ? owned : null });
  app.get('/v1/later-unrelated', (c) => c.json({ ok: true }));
  return app;
}
beforeEach(() => {
  state.role = 'owner';
  state.authenticated = true;
  state.mfa = true;
  state.cache.mockReset().mockImplementation(() => {
    throw Error('Generic response cache must not replace current owned source');
  });
  state.source
    .mockReset()
    .mockResolvedValue({ tenantId: id(1), actorId: id(2), engagementId: id(5), targets: [] });
  state.lookup.mockReset().mockImplementation(() => {
    const query = {
      select: () => query,
      eq: () => query,
      single: async () => ({ data: { id: id(99), title: 'Legacy plan' }, error: null }),
    };
    return query;
  });
});
it.each([true, false])(
  'application %s enabled source leaves unrelated and legacy later GET routes reachable for owner/viewer',
  async (enabled) => {
    for (const role of ['owner', 'viewer'] as const) {
      state.role = role;
      const app = fixture(enabled);
      expect((await app.request('/v1/later-unrelated')).status).toBe(200);
      const legacy = await app.request('/v1/plans/' + id(99));
      expect(legacy.status).toBe(200);
      expect(await legacy.json()).toMatchObject({ id: id(99) });
    }
    expect(state.source).not.toHaveBeenCalled();
  },
);
it('specific source GET precedes generic plan lookup and is unavailable when disabled', async () => {
  const path = '/v1/plans/owned-synthetic/targets/' + id(5),
    headers = { 'X-Expected-Actor-Id': id(2) };
  expect((await fixture().request(path, { headers })).status).toBe(200);
  expect(state.lookup).not.toHaveBeenCalled();
  const disabled = await fixture(false).request(path, { headers });
  expect(disabled.status).toBe(503);
  expect(await disabled.json()).toEqual({ error: { code: 'owned_source_not_configured' } });
  expect(state.lookup).not.toHaveBeenCalled();
});
it.each(['', '/cancel', '/outcome'])(
  'ingress bounds streamed owned POST%s before generic cache or source reader',
  async (suffix) => {
    const raw = new Request('http://localhost/v1/plans/owned-synthetic' + suffix, {
      method: 'POST',
      headers: { 'Content-Length': '1', 'Idempotency-Key': id(4), 'X-Expected-Actor-Id': id(2) },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(16385));
          c.close();
        },
      }),
      ...{ duplex: 'half' },
    });
    const result = await fixture().request(raw);
    expect(result.status).toBe(413);
    expect(state.cache).not.toHaveBeenCalled();
    expect(state.source).not.toHaveBeenCalled();
  },
);
it('normal Auth and MFA quarantine precede owned source work', async () => {
  const path = '/v1/plans/owned-synthetic/targets/' + id(5),
    headers = { 'X-Expected-Actor-Id': id(2) };
  state.authenticated = false;
  expect((await fixture().request(path, { headers })).status).toBe(401);
  state.authenticated = true;
  state.mfa = false;
  const quarantine = await fixture().request(path, { headers });
  expect(quarantine.status).toBe(401);
  expect(await quarantine.json()).toMatchObject({ error: { code: 'mfa_verification_required' } });
  expect(state.source).not.toHaveBeenCalled();
});
it('source outcome avoids generic cache but still requires its key and current actor', async () => {
  const app = fixture(false),
    path = '/v1/plans/owned-synthetic/outcome';
  expect((await app.request(path, { method: 'POST', body: '{}' })).status).toBe(400);
  expect(
    (
      await app.request(path, {
        method: 'POST',
        headers: { 'Idempotency-Key': id(4), 'X-Expected-Actor-Id': id(2) },
        body: '{}',
      })
    ).status,
  ).toBe(503);
  expect(state.cache).not.toHaveBeenCalled();
});

it('actual application ingress rejects oversized owned source before even the missing-key gate', async () => {
  const raw = new Request('http://localhost/v1/plans/owned-synthetic', {
    method: 'POST',
    headers: { 'X-Expected-Actor-Id': id(2) },
    body: new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(16385));
        c.close();
      },
    }),
    ...{ duplex: 'half' },
  });
  expect((await fixture().request(raw)).status).toBe(413);
  expect(state.cache).not.toHaveBeenCalled();
  expect(state.source).not.toHaveBeenCalled();
});
