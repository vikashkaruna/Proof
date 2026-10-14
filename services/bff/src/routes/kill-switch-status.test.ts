import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import {
  createKillSwitchService,
  KillSwitchStateUnavailable,
  type KillSwitchService,
} from '../services/kill-switch.js';
import type { Variables } from '../types.js';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SUPABASE_URL = 'https://local.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'a'.repeat(40);
  process.env.SUPABASE_SERVICE_KEY = 'b'.repeat(40);
  process.env.APPROVAL_SIGNING_KEY = 'k'.repeat(48);
});
const tenantId = '11111111-1111-4111-8111-111111111111';
async function request(
  service: KillSwitchService,
  role: UserRole = UserRole.OWNER,
  release = false,
) {
  const { v1Routes } = await import('./v1.js');
  const mutations = {
    engage: vi.spyOn(service, 'engage'),
    release: vi.spyOn(service, 'release'),
    ledger: vi.fn(),
  };
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('tenantId', tenantId as never);
    c.set('role', role);
    c.set('user', { id: tenantId } as never);
    await next();
  });
  app.route(
    '/v1',
    v1Routes({
      approvalEngine: {} as never,
      killSwitch: service,
      ledger: { append: mutations.ledger } as never,
      mfa: {} as never,
      realtime: {} as never,
    }),
  );
  const response = await app.request(
    release ? '/v1/kill-switch/release' : '/v1/kill-switch/status',
    release
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope: 'tenant' }),
        }
      : undefined,
  );
  expect(mutations.engage).not.toHaveBeenCalled();
  expect(mutations.release).toHaveBeenCalledTimes(release ? 1 : 0);
  expect(mutations.ledger).not.toHaveBeenCalled();
  return response;
}
function clearService() {
  return createKillSwitchService(
    () =>
      ({
        from: () => ({
          select: () => ({ abortSignal: () => ({ eq: async () => ({ data: [], error: null }) }) }),
        }),
      }) as never,
  );
}

describe('kill-switch status read boundary', () => {
  it.each([UserRole.OWNER, UserRole.VIEWER])(
    'returns a current read to %s without caching or mutation',
    async (role) => {
      const service = clearService();
      const state = vi.spyOn(service, 'state');
      const response = await request(service, role);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(await response.json()).toMatchObject({ engaged: false });
      expect(state).toHaveBeenCalledWith(tenantId);
    },
  );
  it.each([UserRole.OWNER, UserRole.VIEWER])(
    'returns sanitized unavailable to %s rather than a false disengaged state',
    async (role) => {
      const service = createKillSwitchService(
        () =>
          ({
            from: () => ({
              select: () => ({
                abortSignal: () => ({
                  eq: async () => ({
                    data: null,
                    error: { message: 'private connection details' },
                  }),
                }),
              }),
            }),
          }) as never,
      );
      const response = await request(service, role);
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      const body = await response.json();
      expect(body).toMatchObject({ error: { code: 'kill_switch_status_unavailable' } });
      expect(body).not.toHaveProperty('engaged');
      expect(JSON.stringify(body)).not.toContain('private connection details');
      expect(await service.isActive(tenantId)).toBe(true);
    },
  );
  it('maps the typed service refusal without leaking a changed internal exception message', async () => {
    const service = clearService();
    const unavailable = new KillSwitchStateUnavailable();
    unavailable.message = 'private adapter values';
    vi.spyOn(service, 'state').mockRejectedValue(unavailable);
    const response = await request(service);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private adapter values');
  });
});

describe('kill-switch tenant release read outage', () => {
  it.each([null, {}])(
    'returns safe503 without state update or audit success for malformed read %j',
    async (data) => {
      const update = vi.fn();
      const service = createKillSwitchService(
        () =>
          ({
            from: () => ({
              select: () => ({ abortSignal: () => ({ eq: async () => ({ data, error: null }) }) }),
              update,
            }),
          }) as never,
      );
      const response = await request(service, UserRole.OWNER, true);
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(await response.json()).toEqual({
        error: {
          code: 'kill_switch_status_unavailable',
          message:
            'Kill switch status is unavailable. Execution remains halted until its status can be verified.',
        },
      });
      expect(update).not.toHaveBeenCalled();
    },
  );
});
