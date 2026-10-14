import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserRole } from '@axiom/types';
import type { Variables } from '../types.js';

const state = vi.hoisted(() => ({ read: vi.fn(), create: vi.fn() }));
vi.mock('@axiom/supabase', () => ({ createSupabaseAdmin: state.create }));
import { requireLiveStaffAuthority } from './staff-authority.js';
const actor = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';

function app(role: UserRole, id = actor) {
  const a = new Hono<{ Variables: Variables }>();
  const mutate = vi.fn();
  a.use('*', async (c, next) => {
    c.set('role', role);
    c.set('user', { id } as Variables['user']);
    await next();
  });
  a.use('*', requireLiveStaffAuthority);
  a.all('*', (c) => {
    mutate();
    return c.json({ accepted: true });
  });
  return { a, mutate };
}

beforeEach(() => {
  vi.clearAllMocks();
  const chain = {
    from: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    abortSignal: state.read,
  };
  state.create.mockReturnValue(chain);
  state.read.mockResolvedValue({ data: [{ id: actor, is_axiom_internal: true }], error: null });
});

describe('new staff action admission', () => {
  it.each(['founder', 'axiom_analyst'] as const)(
    'refuses revoked %s on every mutation method',
    async (role) => {
      state.read.mockResolvedValue({
        data: [{ id: actor, is_axiom_internal: false }],
        error: null,
      });
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const { a, mutate } = app(role);
        expect((await a.request('/v1/plans/approve', { method })).status).toBe(403);
        expect(mutate).not.toHaveBeenCalled();
      }
    },
  );
  it('rechecks status for each request using the same existing session', async () => {
    const { a, mutate } = app('founder');
    expect((await a.request('/v1/standing-policies', { method: 'POST' })).status).toBe(200);
    state.read.mockResolvedValue({ data: [{ id: actor, is_axiom_internal: false }], error: null });
    expect((await a.request('/v1/standing-policies', { method: 'POST' })).status).toBe(403);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(state.read).toHaveBeenCalledTimes(2);
  });
  it.each(['owner', 'admin', 'approver', 'viewer', 'reviewer', 'partner'] as const)(
    'leaves %s to existing capability/approval gates',
    async (role) => {
      const { a } = app(role);
      expect((await a.request('/v1/plans/approve', { method: 'POST' })).status).toBe(200);
      expect(state.create).not.toHaveBeenCalled();
    },
  );
  it.each([
    null,
    {},
    [{ id: actor, is_axiom_internal: 'true' }],
    [{ id: other, is_axiom_internal: true }],
    [
      { id: actor, is_axiom_internal: true },
      { id: actor, is_axiom_internal: true },
    ],
  ])('refuses unreadable/malformed identity without reaching mutation', async (data) => {
    state.read.mockResolvedValue({ data, error: null });
    const { a, mutate } = app('founder');
    expect((await a.request('/v1/plans/execute', { method: 'POST' })).status).toBe(503);
    expect(mutate).not.toHaveBeenCalled();
  });
  it('refuses missing profiles as revoked authority', async () => {
    state.read.mockResolvedValue({ data: [], error: null });
    const { a, mutate } = app('axiom_analyst');
    expect((await a.request('/v1/onboarding/proposals', { method: 'POST' })).status).toBe(403);
    expect(mutate).not.toHaveBeenCalled();
  });
  it('refuses lookup errors even with apparently valid data', async () => {
    state.read.mockResolvedValue({
      data: [{ id: actor, is_axiom_internal: true }],
      error: { message: 'synthetic' },
    });
    const { a, mutate } = app('founder');
    expect((await a.request('/v1/classification', { method: 'POST' })).status).toBe(503);
    expect(mutate).not.toHaveBeenCalled();
  });
  it('bounds unavailable authority reads and refuses transport failures', async () => {
    state.read.mockRejectedValue(new Error('synthetic transport'));
    const { a, mutate } = app('founder');
    const response = await a.request('/v1/plans/execute', { method: 'POST' });
    expect(response.status).toBe(503);
    expect(state.read.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    expect(mutate).not.toHaveBeenCalled();
  });
  it.each(['GET', 'HEAD', 'OPTIONS'])(
    'does not retroactively revoke token/history reads for %s',
    async (method) => {
      const { a } = app('founder');
      expect((await a.request('/v1/approvals/history', { method })).status).toBe(200);
      expect(state.create).not.toHaveBeenCalled();
    },
  );
  it('accepts equivalent UUID case while rejecting invalid actors before lookup', async () => {
    const upper = 'AAAAAAAA-0000-4000-8000-000000000001';
    state.read.mockResolvedValue({
      data: [{ id: upper.toLowerCase(), is_axiom_internal: true }],
      error: null,
    });
    expect((await app('founder', upper).a.request('/v1/test', { method: 'POST' })).status).toBe(
      200,
    );
    vi.clearAllMocks();
    expect((await app('founder', 'invalid').a.request('/v1/test', { method: 'POST' })).status).toBe(
      503,
    );
    expect(state.create).not.toHaveBeenCalled();
  });
});
