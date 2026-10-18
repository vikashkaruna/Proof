import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import { SignJWT } from 'jose';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
const state = vi.hoisted(() => ({
  clients: [] as Record<string, unknown>[],
  queries: [] as string[],
  signers: [] as unknown[],
  tokenCalls: 0,
  ended: 0,
}));
vi.mock('@axiom/supabase', () => ({ createSupabaseAdmin: vi.fn() }));
vi.mock('@aws-sdk/rds-signer', () => ({
  Signer: class {
    constructor(options: unknown) {
      state.signers.push(options);
    }
    async getAuthToken() {
      state.tokenCalls++;
      return 'explicitly-IAM-mocked-fixture';
    }
  },
}));
vi.mock('pg', () => ({
  default: {
    Client: class {
      constructor(options: Record<string, unknown>) {
        state.clients.push(options);
      }
      on() {
        return this;
      }
      async connect() {}
      async query(text: string) {
        state.queries.push(text);
        return {
          rows: text.includes('transaction_read_only')
            ? [{ read_only: true, privileged: false, can_write: false }]
            : text.includes('select n.nspname as schema')
              ? [{ schema: 'public', table: 'fixture', kind: 'r', estimated_rows: 0, columns: [] }]
              : [],
        };
      }
      async end() {
        state.ended++;
      }
    },
  },
}));
import { composePostgresqlDiscovery, loadPostgresqlDiscovery } from './postgresql-composition.js';
import { discoveryRoutes } from '../routes/discovery.js';
const TENANT = '11111111-1111-4111-8111-111111111111',
  ESTATE = '22222222-2222-4222-8222-222222222222',
  CONNECTOR = '33333333-3333-4333-8333-333333333333',
  SYSTEM = '77777777-7777-4777-8777-777777777777';
const descriptor = '41410000-0000-4000-8000-000000000001';
const ca = rootCertificates.find((pem) => {
  const cert = new X509Certificate(pem);
  return (
    cert.ca && Date.parse(cert.validFrom) < Date.now() && Date.parse(cert.validTo) > Date.now()
  );
})!;
const endpoint = {
  host: 'fixture.cluster-123.ap-south-1.rds.amazonaws.com',
  port: 5432,
  database: 'fixture',
  user: 'axiom_drishti',
  region: 'ap-south-1',
  caPem: ca,
};
const binding = {
  tenantId: TENANT,
  estateId: ESTATE,
  connectorId: CONNECTOR,
  systemId: SYSTEM,
  descriptorId: descriptor,
  descriptorSha256: 'b'.repeat(64),
  endpointRef: 'reviewed_pg',
  targetBinding: 'production',
  connectorVersion: 1,
};
const configuration = () => ({
  schemaVersion: 1,
  credentialMode: 'aws_rds_iam',
  workload: {
    audience: 'axiom-postgresql-discovery',
    trustDomain: 'axiom.test',
    socketPath: '/run/spire/api.sock',
  },
  connections: [{ binding: { ...binding }, endpoint: { ...endpoint } }],
});
const request = {
  tenantId: TENANT,
  estateId: ESTATE,
  connectorId: CONNECTOR,
  operation: 'enumerate',
};
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = keys.publicKey.export({ format: 'jwk' });
const trust = { load: vi.fn(), stillCurrent: vi.fn() };
let db: FakeDb;
let grant: Record<string, unknown> | null;
let resolution = 0;
let after: Record<string, unknown> | null | undefined;
let recorded: Record<string, unknown>[];
const fixtureDirs: string[] = [];
async function proof(audience = 'axiom-postgresql-discovery') {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256' })
    .setSubject('spiffe://axiom.test/agent/drishti')
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 120)
    .sign(keys.privateKey);
}
const ports = () => ({ trust, client: () => db.client as never });
beforeEach(() => {
  state.clients = [];
  state.queries = [];
  state.signers = [];
  state.tokenCalls = 0;
  state.ended = 0;
  resolution = 0;
  after = undefined;
  recorded = [];
  db = createFakeDb({
    connectors: [{ id: CONNECTOR, tenant_id: TENANT, descriptor_id: descriptor, status: 'active' }],
  });
  grant = {
    grantId: '55555555-5555-4555-8555-555555555555',
    workloadId: '66666666-6666-4666-8666-666666666666',
    agentName: 'drishti',
    spiffeId: 'spiffe://axiom.test/agent/drishti',
    systemId: SYSTEM,
    grantExpiresAt: new Date(Date.now() + 600000).toISOString(),
    connectorVersion: 1,
    descriptorSha256: 'b'.repeat(64),
    endpointRef: 'reviewed_pg',
    targetBinding: 'production',
  };
  db.onRpc('resolve_sql_read_grant', () => {
    resolution++;
    return resolution > 1 && after !== undefined ? after : grant;
  });
  db.onRpc('record_connector_discovery', (args) => {
    recorded.push(args);
    return { run: { id: '88888888-8888-4888-8888-888888888888' } };
  });
  trust.load.mockReset().mockResolvedValue({
    revision: 'fixture-revision',
    validUntil: Date.now() + 600000,
    jwks: { keys: [jwk] },
  });
  trust.stillCurrent.mockReset().mockResolvedValue(true);
});
afterEach(async () => {
  for (const dir of fixtureDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function configFile(text: string) {
  const parent = resolve('.axiom-runtime');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(parent, 'pg-composition-fixture-'));
  fixtureDirs.push(dir);
  await chmod(dir, 0o700);
  const path = join(dir, 'configuration.json');
  await writeFile(path, text, { mode: 0o600 });
  return path;
}

describe('PostgreSQL-only server composition — IAM-mocked unit fixture, no live AWS/database', () => {
  it('uses verified SVID, live grants, IAM-mocked credential and TLS readonly session before audited release', async () => {
    const service = composePostgresqlDiscovery(configuration(), ports());
    expect(state.tokenCalls).toBe(0);
    const result = await service.run(request, await proof());
    expect(result.records[0]?.resource).toBe('public.fixture');
    expect(resolution).toBe(4);
    expect(state.clients).toHaveLength(1);
    expect(recorded).toHaveLength(1);
    expect(state.clients[0]).toMatchObject({
      host: endpoint.host,
      password: 'explicitly-IAM-mocked-fixture',
      ssl: { ca, servername: endpoint.host, rejectUnauthorized: true },
    });
    expect(state.signers[0]).toMatchObject({
      hostname: endpoint.host,
      region: 'ap-south-1',
      username: endpoint.user,
    });
    expect(state.tokenCalls).toBe(1);
    expect(state.queries[0]).toContain('read only');
    expect(state.queries.at(-1)).toBe('rollback');
    expect(state.ended).toBe(1);
  });
  it.each([
    'endpointRef',
    'descriptorSha256',
    'targetBinding',
    'systemId',
    'connectorVersion',
  ] as const)('opens no credential/session under mismatched%s', async (field) => {
    grant = {
      ...grant,
      [field]:
        field === 'connectorVersion'
          ? 2
          : field === 'systemId'
            ? '99999999-9999-4999-8999-999999999999'
            : field === 'descriptorSha256'
              ? 'c'.repeat(64)
              : 'other',
    };
    await expect(
      composePostgresqlDiscovery(configuration(), ports()).run(request, await proof()),
    ).rejects.toThrow();
    expect(state.tokenCalls).toBe(0);
    expect(state.clients).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });
  it('withholds a completed readonly result if grant/stop state changes before release', async () => {
    after = null;
    await expect(
      composePostgresqlDiscovery(configuration(), ports()).run(request, await proof()),
    ).rejects.toThrow();
    expect(state.ended).toBe(1);
    expect(state.queries.at(-1)).toBe('rollback');
    expect(recorded).toHaveLength(0);
  });
  it.each(['bad', 'wrong-audience', 'trust-unavailable', 'trust-revision-changed'])(
    'refuses%s identity before credential use',
    async (mode) => {
      if (mode === 'trust-unavailable') trust.load.mockResolvedValue(null);
      if (mode === 'trust-revision-changed') trust.stillCurrent.mockResolvedValue(false);
      const token =
        mode === 'bad'
          ? 'invalid'
          : await proof(mode === 'wrong-audience' ? 'wrong' : 'axiom-postgresql-discovery');
      await expect(
        composePostgresqlDiscovery(configuration(), ports()).run(request, token),
      ).rejects.toThrow();
      expect(state.tokenCalls).toBe(0);
      expect(state.clients).toHaveLength(0);
    },
  );
  it('does not interpret human Authorization or body fields as a workload SVID', async () => {
    const route = discoveryRoutes(composePostgresqlDiscovery(configuration(), ports()));
    const response = await route.request('/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer browser-session' },
      body: JSON.stringify(request),
    });
    expect(response.status).toBe(403);
    expect(state.tokenCalls).toBe(0);
  });
  it('rejects foreign connector/estate requests and descriptor changes before credential use', async () => {
    const service = composePostgresqlDiscovery(configuration(), ports());
    const token = await proof();
    for (const field of ['tenantId', 'estateId', 'connectorId'])
      await expect(
        service.run({ ...request, [field]: '99999999-9999-4999-8999-999999999999' }, token),
      ).rejects.toThrow();
    db.rows('connectors')[0]!.descriptor_id = '41420000-0000-4000-8000-000000000001';
    await expect(service.run(request, token)).rejects.toThrow();
    expect(state.tokenCalls).toBe(0);
  });
  it('does not permit browser-supplied endpoint/credentials or mutation operations', async () => {
    const service = composePostgresqlDiscovery(configuration(), ports());
    for (const extra of [
      { endpoint },
      { password: 'forbidden' },
      { operation: 'execute' },
      { workloadProof: 'caller' },
    ])
      await expect(service.run({ ...request, ...extra }, await proof())).rejects.toThrow();
    expect(state.clients).toHaveLength(0);
  });
  it.each(['local-password', 'non-Mumbai', 'non-RDS', 'bad-CA', 'MySQL', 'HTTP', 'duplicate'])(
    'fails closed on unsafe configured%s before constructing a session',
    async (mode) => {
      const config = configuration();
      if (mode === 'local-password') config.credentialMode = 'password';
      if (mode === 'non-Mumbai') config.connections[0]!.endpoint.region = 'us-east-1';
      if (mode === 'non-RDS') config.connections[0]!.endpoint.host = 'localhost';
      if (mode === 'bad-CA') config.connections[0]!.endpoint.caPem = 'not-a-certificate';
      if (mode === 'MySQL')
        config.connections[0]!.binding.descriptorId = '41420000-0000-4000-8000-000000000001';
      if (mode === 'HTTP')
        config.connections[0]!.binding.descriptorId = '41410000-0000-4000-8000-000000000011';
      if (mode === 'duplicate') config.connections.push(config.connections[0]!);
      expect(() => composePostgresqlDiscovery(config, ports())).toThrow(
        'PostgreSQL discovery configuration refused',
      );
      expect(state.clients).toHaveLength(0);
      expect(state.tokenCalls).toBe(0);
    },
  );
  it('clones configuration so later caller mutation cannot select a new endpoint', async () => {
    const config = configuration();
    const service = composePostgresqlDiscovery(config, ports());
    config.connections[0]!.endpoint.host = 'localhost';
    config.connections[0]!.binding.endpointRef = 'other';
    await service.run(request, await proof());
    expect(state.clients[0]?.host).toBe(endpoint.host);
  });
});
describe('protected PostgreSQL loader, deliberately unmounted', () => {
  it('keeps no-config discovery unavailable', async () => {
    expect(await loadPostgresqlDiscovery(undefined)).toBeUndefined();
    expect((await discoveryRoutes().request('/run', { method: 'POST' })).status).toBe(503);
    expect(state.clients).toHaveLength(0);
  });
  it('loads only protected reviewed files without contacting AWS or a target on construction', async () => {
    const file = await configFile(JSON.stringify(configuration()));
    expect(await loadPostgresqlDiscovery(file, ports())).toMatchObject({
      run: expect.any(Function),
    });
    expect(state.tokenCalls).toBe(0);
    expect(trust.load).not.toHaveBeenCalled();
  });
  it('refuses duplicate/escaped keys, malformed/unknown fields with no secret/path disclosure', async () => {
    const valid = JSON.stringify(configuration());
    for (const raw of [
      valid.replace('"schemaVersion":1', '"schemaVersion":2,"schemaVersion":1'),
      valid.replace('"schemaVersion":1', '"schemaVersion":2,"schema\\u0056ersion":1'),
      '{"password":"do-not-disclose"}',
      valid.slice(0, -1),
    ])
      await expect(loadPostgresqlDiscovery(await configFile(raw), ports())).rejects.toThrow(
        'PostgreSQL discovery startup refused',
      );
  });
  it('refuses relative, missing, readable-by-others or symlinked deployment files', async () => {
    for (const path of ['relative.json', '/nonexistent/pg-composition/configuration.json'])
      await expect(loadPostgresqlDiscovery(path, ports())).rejects.toThrow(
        'PostgreSQL discovery startup refused',
      );
    const file = await configFile(JSON.stringify(configuration()));
    await chmod(file, 0o644);
    await expect(loadPostgresqlDiscovery(file, ports())).rejects.toThrow();
    await chmod(file, 0o600);
    const link = join(fixtureDirs.at(-1)!, 'link.json');
    await symlink(file, link);
    await expect(loadPostgresqlDiscovery(link, ports())).rejects.toThrow();
    expect(state.clients).toHaveLength(0);
  });
});
it('constructs the real Workload-API trust adapter by default without issuing a credential', () => {
  expect(composePostgresqlDiscovery(configuration())).toMatchObject({ run: expect.any(Function) });
  expect(state.clients).toHaveLength(0);
  expect(state.tokenCalls).toBe(0);
});
