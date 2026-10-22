import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';
const state = vi.hoisted(() => ({ db: null as FakeDb | null }));
vi.mock('@axiom/supabase', () => ({ createSupabaseAdmin: () => state.db!.client }));
import { connectorScanReportRoutes } from './connector-scan-report.js';

const id = (n: number) => `73730000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TENANT = id(1);
const MARIADB_SANDBOX = '41430000-0000-4000-8000-000000000003';
let db: FakeDb;

const catalogue = [
  {
    resource: 'app.users',
    kind: 'r',
    estimatedRows: 300,
    columns: [
      { name: 'id', type: 'int', nullable: false, categoryHints: [] },
      { name: 'email', type: 'varchar(200)', nullable: false, categoryHints: ['contact'] },
      { name: 'bio', type: 'text', nullable: true, categoryHints: [] },
    ],
    categoryHints: ['contact'],
  },
];
function request(
  role: UserRole = UserRole.VIEWER,
  path = `/v1/connectors/${id(6)}/scan-report`,
  tenant = TENANT,
) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('tenantId', tenant as never);
    c.set('user', { id: id(2) } as never);
    c.set('role', role);
    await next();
  });
  app.route('/v1', connectorScanReportRoutes());
  return app.request(path);
}
const completed = (n: number, operation: string, resource: string | null, run: number) => ({
  id: id(100 + n),
  tenant_id: TENANT,
  connector_id: id(6),
  operation,
  resource,
  status: 'completed',
  cleanup_confirmed: true,
  discovery_run_id: id(run),
  completed_at: `2026-10-22T10:0${n}:00.000Z`,
});

beforeEach(() => {
  db = createFakeDb({
    tenants: [{ id: TENANT, name: 'Nimbus Stack Technologies (Demo · SaaS)' }],
    estate_systems: [{ id: id(5), tenant_id: TENANT, name: 'Nimbus app database' }],
    connectors: [
      {
        id: id(6),
        tenant_id: TENANT,
        system_id: id(5),
        name: 'Nimbus MariaDB',
        descriptor_id: MARIADB_SANDBOX,
      },
    ],
    postgresql_discovery_requests: [
      completed(1, 'enumerate', null, 201),
      completed(2, 'sample', 'app.users', 202),
      // A newer unconfirmed read never feeds the report.
      { ...completed(3, 'sample', 'app.users', 203), cleanup_confirmed: false },
    ],
    connector_discovery_runs: [
      {
        id: id(201),
        tenant_id: TENANT,
        connector_id: id(6),
        result: catalogue,
        created_at: '2026-10-22T10:01:00.000Z',
      },
      {
        id: id(202),
        tenant_id: TENANT,
        connector_id: id(6),
        created_at: '2026-10-22T10:02:00.000Z',
        result: [
          { column: 'id', sampled: 50, nonNull: 50, detected: {}, categoryHints: [] },
          {
            column: 'email',
            sampled: 50,
            nonNull: 50,
            detected: { email: 50 },
            categoryHints: ['contact'],
          },
          { column: 'bio', sampled: 50, nonNull: 20, detected: { phone_in: 4 }, categoryHints: [] },
        ],
      },
      {
        id: id(203),
        tenant_id: TENANT,
        connector_id: id(6),
        created_at: '2026-10-22T10:03:00.000Z',
        result: [{ column: 'bio', sampled: 1, nonNull: 1, detected: {}, categoryHints: [] }],
      },
    ],
  });
  state.db = db;
});

it('builds the report from confirmed reads for any tenant member with posture access', async () => {
  const response = await request();
  expect(response.status).toBe(200);
  const { data } = (await response.json()) as {
    data: {
      engine: string;
      organisation: string;
      system: string;
      targetBinding: string;
      summary: { detectedShapes: Record<string, number> };
      findings: { id: string }[];
    };
  };
  expect(data).toMatchObject({
    engine: 'MariaDB',
    organisation: 'Nimbus Stack Technologies (Demo · SaaS)',
    system: 'Nimbus app database',
    targetBinding: 'sandbox',
  });
  // Only the confirmed sample (run 202) counts; the unconfirmed run 203 is ignored.
  expect(data.summary.detectedShapes).toEqual({ email: 50, phone_in: 4 });
  expect(data.findings.map((f) => f.id)).toContain('shape.unexpected_personal_values');
});

it('downloads a self-contained HTML report', async () => {
  const response = await request(
    UserRole.VIEWER,
    `/v1/connectors/${id(6)}/scan-report?format=html`,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/html');
  expect(response.headers.get('content-disposition')).toContain('attachment');
  expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  expect(await response.text()).toContain('Nimbus app database');
});

it('is tenant-scoped and refuses unsupported or unrun scans', async () => {
  expect((await request(UserRole.VIEWER, undefined, id(9))).status).toBe(404);
  expect((await request(UserRole.VIEWER, '/v1/connectors/not-a-uuid/scan-report')).status).toBe(
    400,
  );
  expect(
    (await request(UserRole.VIEWER, `/v1/connectors/${id(6)}/scan-report?format=pdf`)).status,
  ).toBe(400);
  db.seed('connectors', {
    id: id(7),
    tenant_id: TENANT,
    system_id: id(5),
    name: 'CRM',
    descriptor_id: '41410000-0000-4000-8000-000000000011',
  });
  expect((await request(UserRole.VIEWER, `/v1/connectors/${id(7)}/scan-report`)).status).toBe(409);
  db.seed('connectors', {
    id: id(8),
    tenant_id: TENANT,
    system_id: id(5),
    name: 'Fresh',
    descriptor_id: MARIADB_SANDBOX,
  });
  expect((await request(UserRole.VIEWER, `/v1/connectors/${id(8)}/scan-report`)).status).toBe(404);
});
