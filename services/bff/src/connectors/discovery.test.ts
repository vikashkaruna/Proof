import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorManifest } from '@axiom/types';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
vi.mock('@axiom/supabase', () => ({ createSupabaseAdmin: vi.fn() }));
import { AcquiredToken } from './broker/oauth-grants.js';
import { DiscoveryService } from './discovery.js';
import { discoveryRoutes } from '../routes/discovery.js';
import type { SqlSession } from './sql/postgres-read.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ESTATE = '22222222-2222-4222-8222-222222222222';
const SQL_CONN = '33333333-3333-4333-8333-333333333333';
const REST_CONN = '44444444-4444-4444-8444-444444444444';
const MYSQL_CONN = '33333333-3333-4333-8333-333333333334';
const GRANT = '55555555-5555-4555-8555-555555555555';
const SPIFFE = 'spiffe://axiom.test/agent/drishti';
const SQL_DESCRIPTOR = '41410000-0000-4000-8000-000000000001';
const MYSQL_DESCRIPTOR = '41420000-0000-4000-8000-000000000001';
const CRM_DESCRIPTOR = '41410000-0000-4000-8000-000000000011';
const sqlEndpoint = {
  host: 'crm.cluster-x.ap-south-1.rds.amazonaws.com',
  port: 5432,
  database: 'crm',
  user: 'axiom_drishti',
  region: 'ap-south-1',
  caPem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
};
const config = {
  sql: [{ tenantId: TENANT, connectorId: SQL_CONN, endpoint: sqlEndpoint }],
  http: [
    {
      tenantId: TENANT,
      connectorId: REST_CONN,
      endpoint: { baseUrl: 'https://crm.reference.axiom.test/' },
    },
  ],
};

let fake: FakeDb;
let recorded: Record<string, unknown>[];
let recordAnswer: unknown;
const identity = { verify: vi.fn() };
const sqlSessions = async (): Promise<SqlSession> => ({
  query: async (text) =>
    text.includes('transaction_read_only')
      ? { rows: [{ read_only: true, privileged: false, can_write: false }] }
      : text.includes('select n.nspname as schema')
        ? {
            rows: [
              {
                schema: 'crm',
                table: 'customers',
                kind: 'r',
                estimated_rows: 3,
                columns: [{ name: 'email', type: 'text', nullable: true }],
              },
            ],
          }
        : { rows: [] },
  end: async () => undefined,
});
const broker = {
  acquire: vi.fn(async () => new AcquiredToken('bearer-x', ['crm.read'], Date.now() + 60_000)),
};
const fetchImpl = vi.fn(
  async () =>
    new Response(JSON.stringify({ data: [{ email: 'asha@example.in' }], next_cursor: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
);
const service = () =>
  new DiscoveryService(config, {
    identity,
    broker,
    sqlSessions,
    fetchImpl,
    client: () => fake.client as never,
  });

beforeEach(() => {
  fake = createFakeDb({
    connectors: [
      { id: SQL_CONN, tenant_id: TENANT, descriptor_id: SQL_DESCRIPTOR, status: 'active' },
      { id: REST_CONN, tenant_id: TENANT, descriptor_id: CRM_DESCRIPTOR, status: 'active' },
    ],
  });
  recorded = [];
  recordAnswer = { run: { id: 'run-1', recordCount: 1 } };
  const grant = {
    grantId: GRANT,
    workloadId: '66666666-6666-4666-8666-666666666666',
    agentName: 'drishti',
    spiffeId: SPIFFE,
    systemId: '77777777-7777-4777-8777-777777777777',
    grantExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    connectorVersion: 1,
    descriptorSha256: 'b'.repeat(64),
    endpointRef: 'crm_sql',
    targetBinding: 'production',
  };
  fake.onRpc('resolve_sql_read_grant', () => grant);
  fake.onRpc('resolve_broker_grant', () => ({ ...grant, scope: 'connector.read' }));
  fake.onRpc('record_connector_discovery', (args) => {
    recorded.push(args);
    return recordAnswer;
  });
  identity.verify.mockReset();
  identity.verify.mockResolvedValue({ spiffeId: SPIFFE, expiresAt: Date.now() + 600_000 });
});

describe('DiscoveryService (W4.6/W4.7)', () => {
  it('runs SQL discovery under the grant and records it before returning', async () => {
    const out = await service().run(
      { tenantId: TENANT, estateId: ESTATE, connectorId: SQL_CONN, operation: 'enumerate' },
      'svid',
    );
    expect(out.records.map((r) => r.resource)).toEqual(['crm.customers']);
    expect(recorded[0]).toMatchObject({
      p_grant_id: GRANT,
      p_spiffe_id: SPIFFE,
      p_operation: 'enumerate',
      p_resource: null,
    });
  });

  it('runs REST discovery with a broker token and records shape-only output', async () => {
    const out = await service().run(
      {
        tenantId: TENANT,
        estateId: ESTATE,
        connectorId: REST_CONN,
        operation: 'sample',
        resource: 'contacts',
        limit: 10,
      },
      'svid',
    );
    expect(broker.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'connector.read',
        workloadProof: 'svid',
        connectorId: REST_CONN,
      }),
    );
    expect(JSON.stringify(recorded[0]?.p_result)).not.toContain('asha@example.in');
    expect(out.records[0]).toMatchObject({ field: 'email', detected: { email: 1 } });
  });

  it('withholds results that could not be recorded, and refuses unconfigured or inactive connectors', async () => {
    recordAnswer = { error: 'invalid_result' };
    const req = {
      tenantId: TENANT,
      estateId: ESTATE,
      connectorId: SQL_CONN,
      operation: 'enumerate',
    };
    await expect(service().run(req, 'svid')).rejects.toMatchObject({ reason: 'unrecorded' });
    const bare = new DiscoveryService({}, { identity, client: () => fake.client as never });
    await expect(bare.run(req, 'svid')).rejects.toMatchObject({ reason: 'endpoint_unconfigured' });
    fake.seed('connectors', {
      id: GRANT,
      tenant_id: TENANT,
      descriptor_id: SQL_DESCRIPTOR,
      status: 'disabled',
    });
    await expect(service().run({ ...req, connectorId: GRANT }, 'svid')).rejects.toMatchObject({
      reason: 'connector_unavailable',
    });
    await expect(service().run({ ...req, operation: 'sample' }, 'svid')).rejects.toThrow();
    expect(
      () =>
        new DiscoveryService(
          { sql: [{ ...config.sql[0], endpoint: { ...sqlEndpoint, region: 'us-east-1' } }] },
          { identity },
        ),
    ).toThrow();
  });

  it('routes mysql-target descriptors through the MySQL connector and refuses unknown SQL engines', async () => {
    fake.seed('connectors', {
      id: MYSQL_CONN,
      tenant_id: TENANT,
      descriptor_id: MYSQL_DESCRIPTOR,
      status: 'active',
    });
    const mysqlSessions = async (): Promise<SqlSession> => ({
      query: async (text) =>
        text.includes('@@session.transaction_read_only')
          ? { rows: [{ read_only: 1, privileged: 0, can_write: 0 }] }
          : text.includes('from information_schema.tables')
            ? { rows: [{ tschema: 'crm', tname: 'customers', kind: 'r', estimated_rows: 3 }] }
            : { rows: [] },
      end: async () => undefined,
    });
    const mysqlService = new DiscoveryService(
      { sql: [{ tenantId: TENANT, connectorId: MYSQL_CONN, endpoint: sqlEndpoint }] },
      { identity, sqlSessions: mysqlSessions, client: () => fake.client as never },
    );
    const out = await mysqlService.run(
      { tenantId: TENANT, estateId: ESTATE, connectorId: MYSQL_CONN, operation: 'enumerate' },
      'svid',
    );
    expect(out.records.map((r) => r.resource)).toEqual(['crm.customers']);

    const oracleService = new DiscoveryService(config, {
      identity,
      client: () => fake.client as never,
      registry: new Map([
        [SQL_DESCRIPTOR, { transport: 'sql', target: 'oracle' } as ConnectorManifest],
      ]),
    });
    await expect(
      oracleService.run(
        { tenantId: TENANT, estateId: ESTATE, connectorId: SQL_CONN, operation: 'enumerate' },
        'svid',
      ),
    ).rejects.toMatchObject({ reason: 'engine_unsupported' });
  });

  it('route denies by default, requires the SVID header and hides refusal reasons', async () => {
    const body = JSON.stringify({
      tenantId: TENANT,
      estateId: ESTATE,
      connectorId: SQL_CONN,
      operation: 'enumerate',
    });
    const post = (
      app: ReturnType<typeof discoveryRoutes>,
      headers: Record<string, string>,
      path = '/run',
    ) =>
      app.request(path, {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json', ...headers },
      });
    expect((await post(discoveryRoutes(), { 'x-workload-svid': 'svid' })).status).toBe(503);
    const app = discoveryRoutes(service());
    expect((await post(app, {})).status).toBe(403);
    expect((await post(app, { 'x-workload-svid': 'svid' }, '/run?svid=x')).status).toBe(403);
    const ok = await post(app, { 'x-workload-svid': 'svid' });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { data: { run: unknown } }).data.run).toEqual({
      id: 'run-1',
      recordCount: 1,
    });
    identity.verify.mockRejectedValueOnce(new Error('bad'));
    const refused = await post(app, { 'x-workload-svid': 'svid' });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'discovery_refused' });
  });
});
