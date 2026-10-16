import type * as ActualSupabase from '@axiom/supabase';
import { beforeEach, it, expect, vi } from 'vitest';
import { UserRole } from '@axiom/types';
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
    role: 'owner',
    available: true,
    authCalls: 0,
    killed: false,
    sourceCurrent: true,
    mfaRequired: false,
    domainRpc: vi.fn(),
    cacheRpc: vi.fn(),
    cache: null as null | { status: number; body: unknown; request: string; authority: string },
    claim: null as null | { request: string; authority: string },
  };
});
vi.mock('../middleware/auth.js', async () => {
  const { createMiddleware } = await import('hono/factory');
  return {
    authMiddleware: createMiddleware<{ Variables: Variables }>(async (c, next) => {
      state.authCalls += 1;
      c.set('user', { id: '77777777-7777-4777-8777-777777777777' } as never);
      c.set('sessionId', 'same-session');
      await next();
    }),
  };
});
vi.mock('../middleware/tenant.js', async () => {
  const { createMiddleware } = await import('hono/factory');
  return {
    tenantResolver: createMiddleware<{ Variables: Variables }>(async (c, next) => {
      c.set('tenantId', 'a0000000-0000-4000-8000-000000000001');
      c.set('role', state.role as UserRole);
      c.set('approvalScopes', []);
      await next();
    }),
  };
});
vi.mock('../services/kill-switch.js', () => ({
  createKillSwitchService: () => ({ isActive: async () => state.killed }),
}));
vi.mock('../services/approval.js', () => ({ createApprovalEngine: () => ({}) }));
vi.mock('../services/ledger.js', () => ({ createLedgerService: () => ({}) }));
vi.mock('../services/mfa.js', () => ({
  createMfaService: () => ({
    sessionAccess: async () => ({ sessionCurrent: true, recovery: null }),
    requiresLoginMfa: async () => state.mfaRequired,
    isEnrolled: async () => false,
    sessionAttestation: async () =>
      state.mfaRequired
        ? null
        : { factorId: '77777777-7777-4777-8777-777777777777', validUntil: Date.now() + 1000 },
  }),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ rpc: state.cacheRpc }) }));
vi.mock('@axiom/supabase', async (importOriginal) => ({
  ...(await importOriginal<typeof ActualSupabase>()),
  createHumanActionWriter: () => ({
    rpc: (...args: unknown[]) => {
      const pending = state.domainRpc(...args) as Promise<unknown> & {
        abortSignal?: (signal: AbortSignal) => Promise<unknown>;
      };
      pending.abortSignal = () => pending;
      return pending;
    },
  }),
}));
vi.mock('../services/saakshi-staging-composition.js', () => ({
  evidenceControllerRpc: { call: (...args: unknown[]) => state.domainRpc(...args) },
  createSaakshiComposition: () =>
    state.available
      ? {
          configuration: {
            key: { id: 'owned-key', key: Buffer.alloc(32, 1), otherKeys: [] },
            retention: {
              provider: 's3-compatible',
              bucket: 'owned-target',
              lockMode: 'COMPLIANCE',
              retentionPolicy: 'seven_years',
              encryption: 'AES256',
              legalHold: false,
            },
          },
          invocation: { runtimeUrl: 'http://runtime.invalid', runtimeToken: 'r'.repeat(48) },
        }
      : null,
}));
import { createApp } from '../app.js';
const actor = '77777777-7777-4777-8777-777777777777',
  key = '88888888-8888-4888-8888-888888888888';
const upload = '/v1/evidence/staged-ingestions',
  expiry = `${upload}/${key}/expire`;
const body = (path: string) =>
  path === expiry
    ? { bodyHash: 'a'.repeat(64), acknowledgeUnconfirmedPreservation: true }
    : {
        operationKey: key,
        filename: 'owned.txt',
        contentType: 'text/plain',
        evidenceType: 'document',
        description: 'owned bytes',
        controlIds: [],
        contentBase64: Buffer.from('owned bytes').toString('base64'),
        retentionApproval: {
          provider: 's3-compatible',
          bucket: 'owned-target',
          lockMode: 'COMPLIANCE',
          retentionPolicy: 'seven_years',
          encryption: 'AES256',
          legalHold: false,
          acknowledgesImmutableRetention: true,
        },
      };
function request(
  app: ReturnType<typeof createApp>,
  path: string,
  expected = actor,
  headerKey: string | null = key,
) {
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Expected-Actor-Id': expected,
      ...(headerKey ? { 'Idempotency-Key': headerKey } : {}),
    },
    body: JSON.stringify(body(path)),
  });
}
beforeEach(() => {
  state.role = 'owner';
  state.available = true;
  state.authCalls = 0;
  state.killed = false;
  state.mfaRequired = false;
  state.domainRpc.mockReset().mockResolvedValue({ error: 'source unavailable', data: null });
  state.cache = null;
  state.claim = null;
  state.cacheRpc
    .mockReset()
    .mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'claim_request') {
        if (
          state.cache &&
          state.cache.request === args.p_request_sha256 &&
          state.cache.authority === args.p_authority_sha256
        )
          return {
            data: { decision: 'replay', status: state.cache.status, body: state.cache.body },
            error: null,
          };
        state.claim = {
          request: String(args.p_request_sha256),
          authority: String(args.p_authority_sha256),
        };
        return { data: { decision: 'claimed', id: key }, error: null };
      }
      if (name === 'complete_request' && state.claim)
        state.cache = { ...state.claim, status: Number(args.p_status), body: args.p_body };
      return { data: true, error: null };
    });
});
it.each([upload, expiry])(
  'same-key corrected actor reaches live authority, never replaying its prior refusal: %s',
  async (path) => {
    const app = createApp();
    const wrong = await request(app, path, key);
    expect(wrong.status).toBe(409);
    const corrected = await request(app, path);
    expect(corrected.status).toBe(503);
    expect(await corrected.json()).toEqual({ error: { code: 'staged_evidence_unconfirmed' } });
    expect(state.domainRpc).toHaveBeenCalled();
    expect(state.cacheRpc).not.toHaveBeenCalled();
    expect(corrected.headers.get('cache-control')).toContain('no-store');
  },
);
it.each([upload, expiry])(
  'source confirmation/current authority is rechecked on each exact-body retry: %s',
  async (path) => {
    const app = createApp();
    expect((await request(app, path)).status).toBe(503);
    const calls = state.domainRpc.mock.calls.length;
    state.killed = true;
    expect((await request(app, path)).status).toBe(423);
    expect(state.domainRpc).toHaveBeenCalledTimes(calls);
    state.killed = false;
    state.role = 'viewer';
    expect((await request(app, path)).status).toBe(403);
    state.role = 'owner';
    state.mfaRequired = true;
    expect((await request(app, path)).status).toBe(403);
    state.mfaRequired = false;
    expect((await request(app, path)).status).toBe(503);
    expect(state.domainRpc.mock.calls.length).toBeGreaterThan(calls);
    expect(state.cacheRpc).not.toHaveBeenCalled();
  },
);
it.each([upload, expiry])(
  'missing or mismatched operation keys refuse without source or generic cache effects: %s',
  async (path) => {
    const app = createApp();
    expect((await request(app, path, actor, null)).status).toBe(400);
    expect((await request(app, path, actor, actor)).status).toBe(400);
    expect(state.domainRpc).not.toHaveBeenCalled();
    expect(state.cacheRpc).not.toHaveBeenCalled();
  },
);
it.each([
  `${upload}/neighbor`,
  `${upload}/${key}/expire/neighbor`,
  '/v1/evidence/staged-ingestions/not-a-uuid/expire',
])('neighbor paths retain ordinary generic cache semantics: %s', async (path) => {
  await request(createApp(), path);
  expect(state.cacheRpc).toHaveBeenCalledWith('claim_request', expect.anything());
  expect(state.domainRpc).not.toHaveBeenCalled();
});
it.each([
  [upload, 12 * 1024 * 1024],
  [expiry, 4096],
] as const)('bounds actual bytes before any cache/source clone: %s', async (path, limit) => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(limit + 1));
    },
  });
  const response = await createApp().request(path, {
    method: 'POST',
    headers: { 'content-length': '1', 'Idempotency-Key': key, 'X-Expected-Actor-Id': actor },
    body: stream,
    ...{ duplex: 'half' },
  });
  expect(response.status).toBe(413);
  expect(state.domainRpc).not.toHaveBeenCalled();
  expect(state.cacheRpc).not.toHaveBeenCalled();
});

it.each([true, false])(
  'staged capabilities do not intercept unrelated later routes for a viewer (configured=%s)',
  async (available) => {
    state.available = available;
    state.role = 'viewer';
    const response = await createApp().request('/v1/otherwise-unmatched-route');
    expect(response.status).toBe(404);
    const report = await createApp().request('/v1/reports/not-a-uuid');
    expect(report.status).toBe(400);
    expect(await report.json()).toEqual({ error: { code: 'validation_failed' } });
    expect(state.domainRpc).not.toHaveBeenCalled();
    const options = await createApp().request('/v1/evidence/staged-ingestion-options');
    expect(options.status).toBe(403);
  },
);

it.each([true, false])(
  'staged options are reachable before the legacy evidence ID route (configured=%s)',
  async (available) => {
    state.available = available;
    const response = await createApp().request('/v1/evidence/staged-ingestion-options');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ enabled: available });
    expect(state.domainRpc).not.toHaveBeenCalled();
  },
);

it('private stage configuration failure does not enter human-session auth or SQL', async () => {
  const response = await createApp().request('/internal/staged-evidence/stage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  expect(response.status).toBe(503);
  expect(response.headers.get('cache-control')).toContain('no-store');
  expect(state.authCalls).toBe(0);
  expect(state.domainRpc).not.toHaveBeenCalled();
  expect(state.cacheRpc).not.toHaveBeenCalled();
});
