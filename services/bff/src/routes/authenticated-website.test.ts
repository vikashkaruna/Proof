import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';
const state = vi.hoisted(() => ({ db: null as FakeDb | null }));
vi.mock('@axiom/supabase', () => ({
  createSupabaseAdmin: () => state.db!.client,
  createHumanActionWriter: () => state.db!.client,
}));
import { authenticatedWebsiteRoutes } from './authenticated-website.js';
import { connectorScanReportRoutes } from './connector-scan-report.js';
import { AuthenticatedWebsiteRefused } from '../connectors/website-authenticated.js';

const id = (n: number) => `77770000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TENANT = id(1);
const WEBSITE_SANDBOX = '41440000-0000-4000-8000-000000000003';
const site = {
  tenantId: TENANT,
  connectorId: id(6),
  descriptorId: WEBSITE_SANDBOX,
  baseUrl: 'http://axiom-portal-nimbus:8080',
  startPaths: ['/account'],
  auth: {
    mode: 'form_login' as const,
    loginPath: '/login',
    usernameField: 'email',
    passwordField: 'password',
  },
  credential: { id: id(9), revision: 1, expiresAt: Date.now() + 600_000, file: '/run/c.json' },
  maxPages: 25,
};
const configuration = { schemaVersion: 1 as const, environment: 'local' as const, sites: [site] };
const scan = {
  version: 'authenticated-website-scan/1' as const,
  baseUrl: site.baseUrl,
  authMode: 'form_login' as const,
  checkedAt: '2026-10-22T11:00:00.000Z',
  pages: [
    {
      path: '/account',
      depth: 0,
      contentSha256: 'a'.repeat(64),
      forms: [
        {
          method: 'post',
          fields: [{ name: 'email', categories: ['contact'] }],
          consentControl: false,
          purposeText: false,
        },
      ],
    },
  ],
  skipped: [{ path: '/logout', reason: 'account_action_not_followed' }],
  evidence: {
    privacyNotice: ['/privacy'],
    consentControls: [],
    accessRequest: [],
    erasure: [],
    correction: [],
    grievance: [],
    cookiesBeforeLogin: [],
    cookiesAfterLogin: ['sid'],
    transportSecure: false,
    sessionLost: false,
  },
};
let db: FakeDb;
const crawl = vi.fn();
const readCredential = vi.fn();
const recorded: Record<string, unknown>[] = [];
beforeEach(() => {
  db = createFakeDb({
    tenants: [{ id: TENANT, name: 'Nimbus Stack Technologies (Demo · SaaS)' }],
    estate_systems: [{ id: id(5), tenant_id: TENANT, name: 'Customer portal' }],
    connectors: [
      {
        id: id(6),
        tenant_id: TENANT,
        system_id: id(5),
        name: 'Nimbus portal',
        descriptor_id: WEBSITE_SANDBOX,
        target_binding: 'sandbox',
        status: 'active',
      },
    ],
    authenticated_website_checks: [],
  });
  state.db = db;
  recorded.length = 0;
  db.onRpc('record_authenticated_website_check', (args) => {
    recorded.push(args);
    const row = {
      id: id(100 + recorded.length),
      tenant_id: args.p_tenant_id,
      connector_id: args.p_connector_id,
      correlation_id: args.p_correlation_id,
      status: args.p_status,
      error_code: args.p_error_code,
      result: args.p_result,
      checked_at: new Date(Date.now() + recorded.length).toISOString(),
    };
    db.seed('authenticated_website_checks', row);
    return row;
  });
  crawl.mockReset().mockResolvedValue(scan);
  readCredential.mockReset().mockResolvedValue({ secret: 'never-returned-secret' });
});
function app(
  role: UserRole = UserRole.OWNER,
  config: typeof configuration | undefined = configuration,
) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('tenantId', TENANT as never);
    c.set('user', { id: id(2) } as never);
    c.set('role', role);
    await next();
  });
  app.route('/v1', authenticatedWebsiteRoutes({ configuration: config, crawl, readCredential }));
  app.route('/v1', connectorScanReportRoutes());
  return app;
}
const post = (role?: UserRole, key = id(50), config?: typeof configuration) =>
  app(role, config).request(`/v1/connectors/${id(6)}/website-scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operationKey: key }),
  });

it('runs a configured signed-in check and records it with the human actor', async () => {
  const response = await post();
  expect(response.status).toBe(200);
  const body = JSON.stringify(await response.json());
  expect(body).not.toContain('never-returned-secret');
  expect(crawl).toHaveBeenCalledWith(
    expect.objectContaining({ connectorId: id(6) }),
    { secret: 'never-returned-secret' },
    'sandbox',
    'local',
    expect.any(AbortSignal),
  );
  expect(recorded[0]).toMatchObject({
    p_actor_id: id(2),
    p_status: 'checked',
    p_correlation_id: id(50),
    p_base_url: site.baseUrl,
  });
});

it('replays an operation key without crawling again', async () => {
  await post();
  const again = await post();
  expect(await again.json()).toMatchObject({ data: { replayed: true, status: 'checked' } });
  expect(crawl).toHaveBeenCalledTimes(1);
});

it('records a refused crawl as a failure with its code', async () => {
  crawl.mockRejectedValue(new AuthenticatedWebsiteRefused('login_failed'));
  const response = await post();
  expect(response.status).toBe(422);
  expect(recorded[0]).toMatchObject({
    p_status: 'failed',
    p_error_code: 'login_failed',
    p_result: null,
  });
});

it('refuses viewers, unconfigured sites and non-website connectors', async () => {
  expect((await post(UserRole.VIEWER)).status).toBe(403);
  expect(
    (await post(UserRole.OWNER, id(51), { ...configuration, sites: [] } as never)).status,
  ).toBe(503);
  db.seed('connectors', {
    id: id(7),
    tenant_id: TENANT,
    system_id: id(5),
    name: 'MariaDB',
    descriptor_id: '41430000-0000-4000-8000-000000000003',
    target_binding: 'sandbox',
    status: 'active',
  });
  const mismatched = await app(UserRole.OWNER, {
    ...configuration,
    sites: [{ ...site, connectorId: id(7) }],
  }).request(`/v1/connectors/${id(7)}/website-scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operationKey: id(52) }),
  });
  expect(mismatched.status).toBe(409);
  for (const field of ['baseUrl', 'password', 'cookie'])
    expect(
      (
        await app().request(`/v1/connectors/${id(6)}/website-scan`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ operationKey: id(53), [field]: 'untrusted' }),
        })
      ).status,
    ).toBe(400);
  expect(crawl).not.toHaveBeenCalled();
});

it('lists recent checks and builds the signed-in scan report', async () => {
  await post();
  const list = await app(UserRole.VIEWER).request(`/v1/connectors/${id(6)}/website-scan`);
  expect(await list.json()).toMatchObject({
    data: [{ status: 'checked', pagesRead: 1, pagesSkipped: 1 }],
    available: true,
  });
  const report = await app(UserRole.VIEWER).request(`/v1/connectors/${id(6)}/scan-report`);
  expect(report.status).toBe(200);
  const { data } = (await report.json()) as {
    data: { version: string; findings: { id: string }[] };
  };
  expect(data.version).toBe('authenticated-website-report/1');
  expect(data.findings.map((f) => f.id)).toContain('rights.no_consent_withdrawal');
});
