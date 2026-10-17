import { beforeEach, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import type { Variables } from '../types.js';
const mock = vi.hoisted(() => {
  Object.assign(process.env, {
    ENVIRONMENT: 'test',
    AXIOM_AUTH_MODE: 'strict',
    SUPABASE_URL: 'http://localhost:55321',
    SUPABASE_ANON_KEY: 'a'.repeat(40),
    SUPABASE_SERVICE_KEY: 'b'.repeat(40),
    APPROVAL_SIGNING_KEY: 'k'.repeat(48),
  });
  return { adopt: vi.fn() };
});
vi.mock('../services/sudhaar-review-adoption.js', () => ({
  adoptSudhaarReview: mock.adopt,
  ReviewAdoptionRefused: class extends Error {
    code = 'review_adoption_uncertain';
  },
}));
import { sudhaarReviewAdoptionRoutes } from './sudhaar-review-adoption.js';
import { requireSessionMfa } from '../middleware/session-mfa.js';
import type { MfaService } from '../services/mfa.js';
const tenant = '11111111-1111-4111-8111-111111111111',
  actor = '22222222-2222-4222-8222-222222222222',
  operation = '33333333-3333-4333-8333-333333333333',
  key = '44444444-4444-4444-8444-444444444444';
const body = {
  adoptionKey: key,
  acknowledgeReviewOnly: true,
  reason: 'Review declarations with supporting evidence',
};
function app(role: UserRole = UserRole.OWNER, killed = false, mfa = false) {
  const a = new Hono<{ Variables: Variables }>();
  a.use('*', async (c, next) => {
    c.set('user', { id: actor } as never);
    c.set('tenantId', tenant);
    c.set('role', role);
    c.set('approvalScopes', []);
    await next();
  });
  if (mfa)
    a.use(
      '*',
      requireSessionMfa({
        sessionAccess: async () => ({ sessionCurrent: true, recovery: null }),
        requiresLoginMfa: async () => true,
        isEnrolled: async () => false,
      } as unknown as MfaService),
    );
  return a.route(
    '/v1',
    sudhaarReviewAdoptionRoutes({ killSwitch: { isActive: async () => killed } }),
  );
}
function request(
  a: ReturnType<typeof app>,
  payload: unknown = body,
  headers: Record<string, string> = {},
  suffix = '',
) {
  return a.request(`/v1/plans/proposals/${operation}/adopt${suffix}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Expected-Actor-Id': actor,
      'Idempotency-Key': key,
      ...headers,
    },
    body: JSON.stringify(payload),
  });
}
beforeEach(() => {
  mock.adopt.mockReset();
  mock.adopt.mockResolvedValue({ planId: key });
});
it('binds current actor and strict exact human body and prevents viewer writes', async () => {
  expect((await request(app())).status).toBe(201);
  expect(mock.adopt).toHaveBeenCalledWith(tenant, actor, operation, body, undefined);
  mock.adopt.mockClear();
  expect((await request(app(UserRole.VIEWER))).status).toBe(403);
  expect((await request(app(), body, { 'X-Expected-Actor-Id': tenant })).status).toBe(409);
  for (const payload of [
    { ...body, tasks: [] },
    { ...body, actions: [] },
    { ...body, title: 'forged' },
    { ...body, acknowledgeReviewOnly: false },
    { ...body, reason: 'short' },
  ])
    expect((await request(app(), payload)).status).toBe(400);
  expect((await request(app(), body, { 'Idempotency-Key': tenant })).status).toBe(400);
  expect((await request(app(), body, {}, '?actions=true')).status).toBe(400);
  expect(mock.adopt).not.toHaveBeenCalled();
});
it('global privileged-session MFA blocks before any adoption RPC', async () => {
  expect((await request(app(UserRole.OWNER, false, true))).status).toBe(403);
  expect(mock.adopt).not.toHaveBeenCalled();
});
it('kill switch and unreadable source fail closed with no success', async () => {
  expect((await request(app(UserRole.OWNER, true))).status).toBe(423);
  expect(mock.adopt).not.toHaveBeenCalled();
  mock.adopt.mockRejectedValue(new Error('source unavailable'));
  expect((await request(app())).status).toBe(503);
});
