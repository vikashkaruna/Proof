import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '00000000-0000-4000-8000-000000000001';
const db = vi.hoisted(() => ({ service: null as FakeDb | null }));

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SUPABASE_URL = 'https://local.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'a'.repeat(40);
  process.env.SUPABASE_SERVICE_KEY = 'b'.repeat(40);
  process.env.APPROVAL_SIGNING_KEY = 'k'.repeat(48);
});
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));
vi.mock('@axiom/supabase', () => ({
  createSupabaseAdmin: () => db.service!.client,
  createHumanActionWriter: () => db.service!.client,
}));

const verify = vi.fn(async () => ({ intact: true }));

async function app(role: UserRole) {
  const { v1Routes } = await import('./v1.js');
  const routes = v1Routes({
    approvalEngine: {} as never,
    killSwitch: { isActive: async () => false } as never,
    ledger: { verify } as never,
    mfa: {} as never,
    realtime: {} as never,
  });
  const server = new Hono<{ Variables: Variables }>();
  server.use('*', async (c, next) => {
    c.set('user', { id: USER } as never);
    c.set('tenantId', TENANT as never);
    c.set('role', role);
    await next();
  });
  server.route('/v1', routes);
  return server;
}

beforeEach(() => {
  vi.resetModules();
  verify.mockClear();
  db.service = createFakeDb({});
});

describe('ledger verification capability', () => {
  it('refuses a viewer, who reads the ledger but does not hold ledger.verify', async () => {
    const response = await (
      await app(UserRole.VIEWER)
    ).request('/v1/ledger/verify', {
      method: 'POST',
    });
    expect(response.status).toBe(403);
    expect(verify).not.toHaveBeenCalled();
  });

  it.each([UserRole.OWNER, UserRole.APPROVER, UserRole.REVIEWER])(
    'verifies for %s',
    async (role) => {
      const response = await (await app(role)).request('/v1/ledger/verify', { method: 'POST' });
      expect(response.status).toBe(200);
      expect(verify).toHaveBeenCalledWith(TENANT);
    },
  );
});
