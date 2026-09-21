import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';
const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const db = vi.hoisted(() => ({ current: null as FakeDb | null }));
vi.mock('@axiom/supabase', () => ({ createSupabaseAdmin: () => db.current!.client }));
import { onboardingProposalRoutes } from './onboarding-proposals.js';
let fake: FakeDb;
let calls: Record<string, unknown>[];
beforeEach(() => {
  fake = createFakeDb({});
  db.current = fake;
  calls = [];
  for (const fn of ['prepare_onboarding_proposal', 'review_onboarding_proposal'])
    fake.onRpc(fn, (args) => {
      calls.push(args);
      return { data: { id: USER } };
    });
});
function app(role: UserRole) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: USER } as never);
    c.set('tenantId', TENANT as never);
    c.set('role', role);
    await next();
  });
  app.route('/v1', onboardingProposalRoutes());
  return app;
}
function post(role: UserRole, path: string, body: unknown) {
  return app(role).request(`/v1/onboarding/proposals${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const review = {
  contentSha256: 'a'.repeat(64),
  decision: 'approved',
  reason: 'Reviewed inventory',
};
describe('proposal authority', () => {
  it.each([UserRole.OWNER, UserRole.ADMIN])('%s can review the bound snapshot', async (role) => {
    const res = await post(role, `/${USER}/review`, review);
    expect(res.status).toBe(200);
    expect(calls[0]).toMatchObject({
      p_actor_id: USER,
      p_tenant_id: TENANT,
      p_content_sha256: review.contentSha256,
    });
  });
  it.each([
    UserRole.AXIOM_ANALYST,
    UserRole.FOUNDER,
    UserRole.VIEWER,
    UserRole.APPROVER,
    UserRole.AGENT,
  ])('%s cannot act as client proposal approver', async (role) => {
    expect((await post(role, `/${USER}/review`, review)).status).toBe(403);
    expect(calls).toHaveLength(0);
  });
  it('analyst prepares inventory without applying it', async () => {
    expect(
      (
        await post(UserRole.AXIOM_ANALYST, '', {
          estateId: TENANT,
          systems: [{ name: 'CRM', systemKind: 'saas' }],
        })
      ).status,
    ).toBe(201);
    expect(calls[0]).toMatchObject({
      p_estate_id: TENANT,
      p_systems: [
        { name: 'CRM', systemKind: 'saas', description: '', externalRef: null, dataCategories: [] },
      ],
    });
  });
  it('does not accept a tenant or preparer supplied by the browser', async () => {
    expect(
      (
        await post(UserRole.AXIOM_ANALYST, '', {
          tenantId: USER,
          estateId: TENANT,
          systems: [{ name: 'CRM', systemKind: 'saas' }],
        })
      ).status,
    ).toBe(400);
    expect(calls).toHaveLength(0);
  });
  it('refuses a reviewer who prepared it even after a role change', async () => {
    fake.onRpc('review_onboarding_proposal', () => ({ error: 'self_review' }));
    expect((await post(UserRole.ADMIN, `/${USER}/review`, review)).status).toBe(403);
  });
  it('fails closed on unavailable proposal storage', async () => {
    fake.failNextRpc('review_onboarding_proposal');
    expect((await post(UserRole.ADMIN, `/${USER}/review`, review)).status).toBe(503);
  });
});
