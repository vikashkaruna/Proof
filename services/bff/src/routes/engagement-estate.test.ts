import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';

/** W2: API linkage; actual composite-FK isolation is tested on PostgreSQL. */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '00000000-0000-4000-8000-0000000000aa';
const ESTATE = '22222222-2222-4222-8222-222222222222';

const db = vi.hoisted(() => ({ current: null as FakeDb | null }));

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SUPABASE_URL = 'https://local.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'a'.repeat(40);
  process.env.SUPABASE_SERVICE_KEY = 'b'.repeat(40);
  process.env.APPROVAL_SIGNING_KEY = 'k'.repeat(48);
});

vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));
vi.mock('@axiom/supabase', () => ({
  createSupabaseAdmin: () => {
    if (!db.current) throw new Error('fake db not installed');
    return db.current.client;
  },
}));

let fake: FakeDb;
let ledgerAppend: ReturnType<typeof vi.fn>;

async function buildApp(role: UserRole = UserRole.OWNER) {
  const { v1Routes } = await import('./v1.js');
  ledgerAppend = vi.fn(async () => ({ sequenceNo: 1, entryHash: 'hash' }));

  const routes = v1Routes({
    approvalEngine: { verify: async () => ({ valid: true }), markNonceUsed: vi.fn() } as never,
    killSwitch: { isActive: async () => false } as never,
    ledger: { append: ledgerAppend } as never,
    mfa: {} as never,
    realtime: { broadcast: vi.fn() } as never,
  });

  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: USER, email: 'operator@example.com' } as never);
    c.set('tenantId', TENANT as never);
    c.set('role', role as never);
    c.set('approvalScopes', [] as never);
    c.set('idempotencyKey', 'idem-1' as never);
    await next();
  });
  app.route('/v1', routes);
  return app;
}

beforeEach(() => {
  fake = createFakeDb({});
  db.current = fake;
});
const create = (app: Awaited<ReturnType<typeof buildApp>>, body: Record<string, unknown>) =>
  app.request('/v1/engagements', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
describe('engagement estate linkage', () => {
  it('carries the optional estate into the tenant-scoped insert', async () => {
    const app = await buildApp();
    const res = await create(app, { libraryVersion: 'v1', title: 'Assessment', estateId: ESTATE });
    expect(res.status).toBe(201);
    expect(fake.rows('engagements')[0]).toMatchObject({ tenant_id: TENANT, estate_id: ESTATE });
  });
  it('preserves unassigned legacy creation without inventing an estate', async () => {
    const res = await create(await buildApp(), {
      libraryVersion: 'v1',
      title: 'Legacy assessment',
    });
    expect(res.status).toBe(201);
    expect(fake.rows('engagements')[0]?.estate_id).toBeNull();
  });
  it('rejects malformed references before writing', async () => {
    const res = await create(await buildApp(), {
      libraryVersion: 'v1',
      title: 'Assessment',
      estateId: 'wrong',
    });
    expect(res.status).toBe(400);
    expect(fake.rows('engagements')).toHaveLength(0);
  });
  it('does not let a viewer create an estate-scoped assessment', async () => {
    const res = await create(await buildApp(UserRole.VIEWER), {
      libraryVersion: 'v1',
      title: 'Assessment',
      estateId: ESTATE,
    });
    expect(res.status).toBe(403);
    expect(fake.rows('engagements')).toHaveLength(0);
  });
});
