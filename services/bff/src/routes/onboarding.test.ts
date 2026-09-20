import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { LIBRARY_VERSION } from '@axiom/control-library';
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
  return { rpc: vi.fn() };
});
vi.mock('@axiom/supabase', () => ({ createSupabaseAdmin: () => ({ rpc: state.rpc }) }));
const USER = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const ENGAGEMENT = '33333333-3333-4333-8333-333333333333';
async function request(body: Record<string, unknown> = { name: 'Organization' }) {
  const { v1Routes } = await import('./v1.js');
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: USER } as never);
    await next();
  });
  app.route(
    '/',
    v1Routes({
      approvalEngine: {} as never,
      killSwitch: {} as never,
      ledger: {} as never,
      mfa: {} as never,
      realtime: {} as never,
    }),
  );
  return app.request('/organizations/onboard', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  state.rpc.mockReset();
  state.rpc.mockImplementation(async (name: string) =>
    name === 'take_rate_limit'
      ? { data: { allowed: true, retry_after: 3600 }, error: null }
      : {
          data: {
            tenant: { id: TENANT },
            engagement: { id: ENGAGEMENT },
            intake: { proposed_system_count: 1, status: 'pending_estate_setup' },
          },
          error: null,
        },
  );
});
describe('atomic entitled onboarding', () => {
  it('takes authority from the session, pins the deployed library and preserves proposed intake', async () => {
    const response = await request({
      name: 'New client',
      user_id: TENANT,
      systems: [{ name: 'DB', type: 'postgres' }],
      dpo_name: 'DPO',
      dpo_email: 'dpo@example.test',
    });
    expect(response.status).toBe(201);
    expect(state.rpc).toHaveBeenNthCalledWith(
      1,
      'take_rate_limit',
      expect.objectContaining({ p_subject: USER }),
    );
    expect(state.rpc).toHaveBeenNthCalledWith(
      2,
      'onboard_organization',
      expect.objectContaining({
        p_user_id: USER,
        p_library_version: LIBRARY_VERSION,
        p_dpo_email: 'dpo@example.test',
        p_systems: [expect.objectContaining({ name: 'DB' })],
      }),
    );
    expect(await response.json()).toMatchObject({
      systems: [],
      intake: { status: 'pending_estate_setup' },
    });
  });
  it.each([
    ['onboarding_not_entitled', 403],
    ['tier_not_entitled', 403],
    ['tenant_quota_exceeded', 409],
    ['library_not_published', 503],
  ] as const)('maps %s without creating partial records', async (error, status) => {
    state.rpc
      .mockResolvedValueOnce({ data: { allowed: true, retry_after: 3600 }, error: null })
      .mockResolvedValueOnce({ data: { error }, error: null });
    expect((await request()).status).toBe(status);
  });
  it('refuses before creation when the shared limit is reached', async () => {
    state.rpc.mockResolvedValueOnce({ data: { allowed: false, retry_after: 321 }, error: null });
    const response = await request();
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('321');
    expect(state.rpc).toHaveBeenCalledTimes(1);
  });
  it('fails closed when rate limiting is unavailable', async () => {
    state.rpc.mockResolvedValueOnce({ data: null, error: { message: 'offline' } });
    expect((await request()).status).toBe(503);
    expect(state.rpc).toHaveBeenCalledTimes(1);
  });
  it('does not report creation when the database transaction fails', async () => {
    state.rpc
      .mockResolvedValueOnce({ data: { allowed: true, retry_after: 3600 }, error: null })
      .mockResolvedValueOnce({ data: null, error: { code: 'P0001' } });
    expect((await request()).status).toBe(503);
  });
  it('rejects unbounded intake before consuming quota', async () => {
    expect(
      (
        await request({
          name: 'Organization',
          systems: Array.from({ length: 101 }, () => ({ name: 'DB', type: 'postgres' })),
        })
      ).status,
    ).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});
