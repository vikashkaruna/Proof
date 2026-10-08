import { beforeEach, it, expect, vi } from 'vitest';
import type { Variables } from '../types.js';
import { UserRole } from '@axiom/types';
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
    killed: false,
    sourceCurrent: true,
    mfaRequired: false,
    adopt: vi.fn(),
    rpc: vi.fn(),
    cache: null as null | { status: number; body: unknown; request: string; authority: string },
    claim: null as null | { request: string; authority: string },
  };
});
vi.mock('../middleware/auth.js', async () => {
  const { createMiddleware } = await import('hono/factory');
  return {
    authMiddleware: createMiddleware<{ Variables: Variables }>(async (c, next) => {
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
      c.set('tenantId', '11111111-1111-4111-8111-111111111111');
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
    requiresLoginMfa: async () => state.mfaRequired,
    isEnrolled: async () => false,
  }),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ rpc: state.rpc }) }));
vi.mock('../services/sudhaar-review-adoption.js', () => ({
  adoptSudhaarReview: state.adopt,
  ReviewAdoptionRefused: class extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
}));
import { createApp } from '../app.js';
import { ReviewAdoptionRefused } from '../services/sudhaar-review-adoption.js';
const actor = '77777777-7777-4777-8777-777777777777',
  key = '88888888-8888-4888-8888-888888888888',
  operation = '33333333-3333-4333-8333-333333333333';
const path = `/v1/plans/proposals/${operation}/adopt`,
  body = {
    adoptionKey: key,
    acknowledgeReviewOnly: true,
    reason: 'Review declarations with supporting evidence',
  };
function request(
  app: ReturnType<typeof createApp>,
  expectedActor = actor,
  target = path,
  method = 'POST',
  idempotency: string | null = key,
) {
  return app.request(target, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Expected-Actor-Id': expectedActor,
      ...(idempotency ? { 'Idempotency-Key': idempotency } : {}),
    },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  state.role = 'owner';
  state.killed = false;
  state.sourceCurrent = true;
  state.mfaRequired = false;
  state.cache = null;
  state.claim = null;
  state.rpc.mockReset();
  state.adopt.mockReset();
  state.adopt.mockImplementation(async () => {
    if (!state.sourceCurrent) throw new ReviewAdoptionRefused('review_source_unavailable');
    return { planId: key, purpose: 'source_review', actionCount: 0 };
  });
  state.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === 'claim_request') {
      if (state.cache) {
        if (
          state.cache.request !== args.p_request_sha256 ||
          state.cache.authority !== args.p_authority_sha256
        )
          return { data: { decision: 'conflict' }, error: null };
        return {
          data: { decision: 'replay', status: state.cache.status, body: state.cache.body },
          error: null,
        };
      }
      state.claim = {
        request: String(args.p_request_sha256),
        authority: String(args.p_authority_sha256),
      };
      return { data: { decision: 'claimed', id: key }, error: null };
    }
    if (name === 'complete_request') {
      state.cache = {
        status: Number(args.p_status),
        body: args.p_body,
        request: state.claim!.request,
        authority: state.claim!.authority,
      };
      return { data: true, error: null };
    }
    throw new Error('Unexpected generic cache RPC ' + name);
  });
});
it('real createApp chain never caches wrong expected actor or bypasses fresh kill/source/role checks', async () => {
  const app = createApp();
  expect((await request(app, key)).status).toBe(409);
  expect(state.adopt).not.toHaveBeenCalled();
  const first = await request(app);
  expect(first.status).toBe(201);
  expect(first.headers.get('cache-control')).toBe('private, no-store');
  const replay = await request(app);
  expect(replay.status).toBe(201);
  expect(replay.headers.get('idempotency-replayed')).toBeNull();
  state.killed = true;
  expect((await request(app)).status).toBe(423);
  state.killed = false;
  state.sourceCurrent = false;
  expect((await request(app)).status).toBe(503);
  state.sourceCurrent = true;
  state.role = 'viewer';
  expect((await request(app)).status).toBe(403);
  expect(state.rpc).not.toHaveBeenCalled();
  expect(state.adopt).toHaveBeenCalledTimes(3);
});
it('actual MFA and required key still run before durable adoption route', async () => {
  const app = createApp();
  state.mfaRequired = true;
  expect((await request(app)).status).toBe(403);
  state.mfaRequired = false;
  expect((await request(app, actor, path, 'POST', null)).status).toBe(400);
  expect(state.adopt).not.toHaveBeenCalled();
  expect(state.rpc).not.toHaveBeenCalled();
});
it.each([
  ['POST', `/v1/plans/proposals/${operation}/adopt-extra`],
  ['POST', `/v1/plans/proposals/not-a-uuid/adopt`],
  ['POST', `/v1/plans/proposals/${operation}/adopt/extra`],
  ['PUT', path],
])('retains generic middleware for nonmatching %s %s', async (method, target) => {
  const app = createApp();
  await request(app, actor, target, method);
  expect(state.rpc).toHaveBeenCalledWith('claim_request', expect.any(Object));
  expect(state.adopt).not.toHaveBeenCalled();
});
