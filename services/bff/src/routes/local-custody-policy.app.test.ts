import type * as ActualSupabase from '@axiom/supabase';
/** Actual createApp middleware/mount checks with synthetic Auth/controller ports; not live login. */
import { beforeEach, expect, it, vi } from 'vitest';
import type { Variables } from '../types.js';
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
    internal: true,
    cache: vi.fn(),
    lookup: vi.fn(),
    source: vi.fn(),
    reference: vi.fn(),
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
  ...(await importOriginal<typeof ActualSupabase>()),
  createSupabaseAdmin: () => ({ from: state.lookup, rpc: state.reference }),
}));
import { createApp } from '../app.js';

beforeEach(() => {
  state.authenticated = true;
  state.mfa = true;
  state.internal = true;
  state.role = 'owner';
  state.cache.mockReset().mockImplementation(() => {
    throw Error('Generic cache must not be touched');
  });
  state.reference.mockReset().mockImplementation(() => ({
    abortSignal: async () => ({
      data: {
        version: 1,
        tenantId: id(1),
        actorId: id(2),
        isDemo: false,
        canRequest: true,
        requestModes: ['operator_managed'],
        selectedPolicyId: null,
        rows: [],
        history: [],
        nextCursor: null,
        nextHistoryCursor: null,
      },
      error: null,
    }),
  }));
});
it('mounts custody context behind actual Auth/tenant/session-MFA middleware without generic response cache', async () => {
  const app = createApp({ ownedSynthetic: null });
  const response = await app.request('/v1/local-custody-policy/context', {
    headers: { 'X-Expected-Actor-Id': id(2) },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    data: { tenantId: id(1), actorId: id(2), rows: [] },
  });
  expect(state.cache).not.toHaveBeenCalled();
  expect(state.reference).toHaveBeenCalledWith(
    'read_local_custody_operator_context',
    expect.objectContaining({ p_session_id: id(3) }),
  );
});
it('refuses unauthorized and session-MFA requests before context RPC', async () => {
  const app = createApp({ ownedSynthetic: null });
  state.authenticated = false;
  expect((await app.request('/v1/local-custody-policy/context')).status).toBe(401);
  state.authenticated = true;
  state.mfa = false;
  expect((await app.request('/v1/local-custody-policy/context')).status).toBe(401);
  expect(state.reference).not.toHaveBeenCalled();
});
it.each(
  ['challenge', 'verify', 'record', 'recover'].flatMap((step) =>
    ['request', 'resolution'].map((envelope) => [step, envelope] as const),
  ),
)('bounds custody %s %s before generic idempotency buffering/RPC', async (step, envelope) => {
  const app = createApp({ ownedSynthetic: null });
  const response = await app.request('/v1/local-custody-policy/' + step, {
    method: 'POST',
    headers: {
      'Idempotency-Key': id(4),
      'X-Expected-Actor-Id': id(2),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ [envelope]: 'x'.repeat(65536) }),
  });
  expect(response.status).toBe(413);
  expect(state.cache).not.toHaveBeenCalled();
  expect(state.reference).not.toHaveBeenCalled();
});

it.each([
  ['record-extra', 400],
  ['%72ecord', 413],
  ['record/extra', 400],
] as const)(
  'refuses noncanonical custody POST %s before generic body caching',
  async (step, expected) => {
    const app = createApp({ ownedSynthetic: null });
    const response = await app.request('/v1/local-custody-policy/' + step, {
      method: 'POST',
      headers: { 'Idempotency-Key': id(4), 'Content-Type': 'application/json' },
      body: 'x'.repeat(70000),
    });
    expect(response.status).toBe(expected);
    expect(state.cache).not.toHaveBeenCalled();
    expect(state.reference).not.toHaveBeenCalled();
  },
);
