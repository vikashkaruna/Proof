import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';
import { PublicWebsiteRefused, type WebsiteCheck } from '../connectors/public-website.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const FOREIGN = '22222222-2222-4222-8222-222222222222';
const USER = '00000000-0000-4000-8000-000000000001';
const check: WebsiteCheck = {
  requestedUrl: 'https://public.org/',
  finalUrl: 'https://public.org/',
  checkedAt: '2026-10-04T00:00:00.000Z',
  status: 'checked',
  httpStatus: 200,
  bytes: 32,
  contentSha256: 'a'.repeat(64),
  title: 'Public notice',
  headings: ['Privacy'],
  publicLinks: [{ label: 'Privacy', url: 'https://public.org/privacy' }],
  auditPages: [
    {
      kind: 'privacy',
      requestedUrl: 'https://public.org/privacy',
      status: 'checked',
      finalUrl: 'https://public.org/privacy',
      title: 'Privacy',
      contentSha256: 'b'.repeat(64),
    },
  ],
  observations: [
    { kind: 'privacy', status: 'retrieved' },
    { kind: 'contact', status: 'not_linked' },
    { kind: 'terms', status: 'not_linked' },
  ],
};
const db = vi.hoisted(() => ({ current: null as FakeDb | null }));
vi.mock('@axiom/supabase', () => ({
  createSupabaseAdmin: () => db.current!.client,
  createHumanActionWriter: () => db.current!.client,
}));
import { publicWebsiteCheckRoutes } from './public-website-checks.js';

let fake: FakeDb;
let recorded: Record<string, unknown>[];
beforeEach(() => {
  fake = createFakeDb({
    public_website_checks: [
      {
        id: '1',
        tenant_id: FOREIGN,
        status: 'checked',
        checked_at: '2026-10-04',
        result: { ...check, title: 'Foreign' },
      },
      { id: '2', tenant_id: TENANT, status: 'checked', checked_at: '2026-10-04', result: check },
      { id: '3', tenant_id: TENANT, status: 'failed', checked_at: '2026-10-04', result: null },
    ],
  });
  db.current = fake;
  recorded = [];
  fake.onRpc('record_public_website_check', (args) => {
    recorded.push(args);
    return { id: 'new-check' };
  });
});
function app(role: UserRole, probe = async () => check) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: USER } as never);
    c.set('tenantId', TENANT as never);
    c.set('role', role);
    await next();
  });
  app.route('/v1', publicWebsiteCheckRoutes({ check: probe }));
  return app;
}
const post = (role: UserRole, probe?: () => Promise<WebsiteCheck>) =>
  app(role, probe).request('/v1/public-website-checks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://public.org/' }),
  });

describe('public website check API', () => {
  it('shows only current-tenant successful observations to read roles', async () => {
    const response = await app(UserRole.VIEWER).request('/v1/public-website-checks');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [{ id: '2', ...check }] });
  });

  it('fails closed on a malformed stored observation instead of showing partial evidence', async () => {
    fake.seed('public_website_checks', {
      id: '4',
      tenant_id: TENANT,
      status: 'checked',
      checked_at: '2026-10-05',
      result: { title: 'Partial' },
    });
    const response = await app(UserRole.VIEWER).request('/v1/public-website-checks');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'website_checks_unavailable' } });
  });

  it('records a human-triggered owner check and returns its exact metadata', async () => {
    const response = await post(UserRole.OWNER);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ data: { id: 'new-check', ...check } });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      p_tenant_id: TENANT,
      p_actor_id: USER,
      p_status: 'checked',
      p_requested_url: check.requestedUrl,
      p_final_url: check.finalUrl,
      p_result: check,
    });
  });

  it.each([UserRole.VIEWER, UserRole.PARTNER, UserRole.REVIEWER, UserRole.APPROVER])(
    'refuses %s before any outbound check',
    async (role) => {
      let probes = 0;
      const response = await post(role, async () => {
        probes++;
        return check;
      });
      expect(response.status).toBe(403);
      expect(probes).toBe(0);
      expect(recorded).toHaveLength(0);
    },
  );

  it('returns controlled fetch refusals without recording a false success', async () => {
    const response = await post(UserRole.OWNER, async () => {
      throw new PublicWebsiteRefused('non_public_target');
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: 'non_public_target' } });
    expect(recorded).toHaveLength(0);
  });

  it('refuses an exhausted or unavailable shared budget before outbound fetch', async () => {
    let probes = 0;
    fake.onRpc('take_rate_limit', () => ({ allowed: false, retry_after: 60 }));
    const limited = await post(UserRole.OWNER, async () => {
      probes++;
      return check;
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
    expect(probes).toBe(0);
    fake.failNextRpc('take_rate_limit');
    const unavailable = await post(UserRole.OWNER, async () => {
      probes++;
      return check;
    });
    expect(unavailable.status).toBe(503);
    expect(probes).toBe(0);
  });

  it('fails closed when the human audit writer is unavailable', async () => {
    fake.failNextRpc('record_public_website_check');
    const response = await post(UserRole.OWNER);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'website_check_record_unavailable' } });
  });
});
