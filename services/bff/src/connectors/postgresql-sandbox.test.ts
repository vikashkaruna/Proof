import { beforeEach, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomBytes, X509Certificate } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import { SignJWT } from 'jose';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import { composeSandboxPostgresql, sandboxConfigurationSha256 } from './postgresql-sandbox.js';
import { discoveryRoutes } from '../routes/discovery.js';
const state = vi.hoisted(() => ({
  clients: [] as Record<string, unknown>[],
  queries: [] as string[],
  ends: 0,
}));
vi.mock('@axiom/supabase', () => ({ createSupabaseAdmin: vi.fn() }));
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
        state.ends++;
      }
    },
  },
}));
const id = (n: number) => `51510000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const descriptor = '41410000-0000-4000-8000-000000000003';
const ca = rootCertificates.find((pem) => {
  const c = new X509Certificate(pem);
  return c.ca && Date.parse(c.validFrom) < Date.now() && Date.parse(c.validTo) > Date.now();
})!;
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const trust = { load: vi.fn(), stillCurrent: vi.fn() };
const expiresAt = () => Date.now() + 600_000;
function configuration() {
  return {
    schemaVersion: 1,
    mode: 'local_sandbox_password',
    environment: 'local',
    workload: {
      socketPath: '/run/workload/api.sock',
      healthFile: '/run/spire-health/status.json',
      trustDomain: 'local.axiomproof.test',
      issuerNodeId: 'spiffe://local.axiomproof.test/spire/agent/join_token/local',
    },
    connections: [
      {
        binding: {
          tenantId: id(1),
          estateId: id(2),
          connectorId: id(3),
          systemId: id(4),
          descriptorId: descriptor,
          descriptorSha256: 'b'.repeat(64),
          endpointRef: 'disposable_pg',
          targetBinding: 'sandbox',
          connectorVersion: 1,
        },
        endpoint: {
          host: 'localhost',
          port: 5432,
          database: 'disposable',
          user: 'axiom_reader',
          region: 'ap-south-1',
          caPem: ca,
        },
        credential: {
          id: id(5),
          revision: 1,
          expiresAt: expiry,
          file: '/run/secrets/sandbox-pg.json',
        },
      },
    ],
  };
}
let expiry: number,
  db: FakeDb,
  grant: Record<string, unknown> | null,
  secret: Record<string, unknown>,
  files: Buffer[];
const read = vi.fn<(path: string) => Promise<Buffer>>();
const request = { tenantId: id(1), estateId: id(2), connectorId: id(3), operation: 'enumerate' };
const ports = () => ({ trust, client: () => db.client as never, readCredential: read });
async function proof(
  audience = 'axiom-postgresql-discovery',
  subject = 'spiffe://local.axiomproof.test/agent/drishti',
) {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256' })
    .setSubject(subject)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 120)
    .sign(keys.privateKey);
}
beforeEach(() => {
  expiry = expiresAt();
  state.clients = [];
  state.queries = [];
  state.ends = 0;
  files = [];
  secret = {
    schemaVersion: 1,
    tenantId: id(1),
    connectorId: id(3),
    credentialId: id(5),
    revision: 1,
    expiresAt: expiry,
    password: randomBytes(24).toString('base64'),
  };
  grant = {
    grantId: id(6),
    workloadId: id(7),
    agentName: 'drishti',
    spiffeId: 'spiffe://local.axiomproof.test/agent/drishti',
    systemId: id(4),
    grantExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    connectorVersion: 1,
    descriptorSha256: 'b'.repeat(64),
    endpointRef: 'disposable_pg',
    targetBinding: 'sandbox',
  };
  db = createFakeDb({
    connectors: [{ id: id(3), tenant_id: id(1), descriptor_id: descriptor, status: 'active' }],
  });
  db.onRpc('resolve_sandbox_postgresql_read_grant_for_operation', () => grant);
  db.onRpc('record_connector_discovery', () => ({ run: { id: id(8) } }));
  read.mockReset().mockImplementation(async () => {
    const bytes = Buffer.from(JSON.stringify(secret));
    files.push(bytes);
    return bytes;
  });
  trust.load.mockReset().mockResolvedValue({
    revision: 'trusted',
    validUntil: Date.now() + 600_000,
    jwks: { keys: [keys.publicKey.export({ format: 'jwk' })] },
  });
  trust.stillCurrent.mockReset().mockResolvedValue(true);
});
it('runs a bounded authenticated read, uses broker-only file password, then clears both secret buffers', async () => {
  const config = configuration();
  const service = composeSandboxPostgresql(config, 'local', ports());
  const result = await service.run(request, await proof());
  expect(result.records[0]?.resource).toBe('public.fixture');
  expect(state.clients).toHaveLength(1);
  expect(state.clients[0]).toMatchObject({
    password: secret.password,
    ssl: { ca, servername: 'localhost', rejectUnauthorized: true },
  });
  expect(JSON.stringify(result)).not.toContain(String(secret.password));
  expect(state.ends).toBe(1);
  expect(files).toHaveLength(2);
  expect(files.every((b) => b.every((n) => n === 0))).toBe(true);
  expect(state.queries[0]).toContain('read only');
  expect(state.queries.at(-1)).toBe('rollback');
  expect(sandboxConfigurationSha256(config)).toMatch(/^[a-f0-9]{64}$/);
});
it.each(['production', 'preprod', 'staging', ''])(
  'refuses%s deployment independently of a forged local flag',
  (env) => {
    expect(() => composeSandboxPostgresql(configuration(), env, ports())).toThrow(
      'configuration refused',
    );
    expect(read).not.toHaveBeenCalled();
  },
);
it.each(['tenantId', 'connectorId', 'credentialId', 'revision', 'expiresAt'])(
  'refuses changed broker %s before allocating socket',
  async (field) => {
    secret = {
      ...secret,
      [field]: field === 'revision' ? 2 : field === 'expiresAt' ? expiry + 1 : id(99),
    };
    await expect(
      composeSandboxPostgresql(configuration(), 'local', ports()).run(request, await proof()),
    ).rejects.toThrow();
    expect(state.clients).toHaveLength(0);
    expect(files.every((b) => b.every((n) => n === 0))).toBe(true);
  },
);
it('requires enrolled grant and correct workload proof before reading the secret', async () => {
  const service = composeSandboxPostgresql(configuration(), 'local', ports());
  grant = null;
  await expect(service.run(request, await proof())).rejects.toThrow();
  await expect(service.run(request, await proof('wrong-audience'))).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
  expect(state.clients).toHaveLength(0);
});
it('rechecks grant after secret read before opening any socket', async () => {
  read.mockImplementation(async () => {
    grant = null;
    const b = Buffer.from(JSON.stringify(secret));
    files.push(b);
    return b;
  });
  await expect(
    composeSandboxPostgresql(configuration(), 'local', ports()).run(request, await proof()),
  ).rejects.toThrow();
  expect(state.clients).toHaveLength(0);
});
it('withholds the audited result when credential rotates while recording', async () => {
  db.onRpc('record_connector_discovery', () => {
    secret = { ...secret, revision: 2 };
    return { run: { id: id(8) } };
  });
  await expect(
    composeSandboxPostgresql(configuration(), 'local', ports()).run(request, await proof()),
  ).rejects.toThrow('changed before release');
  expect(state.ends).toBe(1);
});
it('passes HTTP cancellation into the bounded service and never accepts human proof in place of SVID', async () => {
  const route = discoveryRoutes(composeSandboxPostgresql(configuration(), 'local', ports()));
  const response = await route.request('/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer human-session' },
    body: JSON.stringify(request),
  });
  expect(response.status).toBe(403);
  expect(read).not.toHaveBeenCalled();
  const abort = new AbortController();
  abort.abort();
  await expect(
    composeSandboxPostgresql(configuration(), 'local', ports()).run(
      request,
      await proof(),
      abort.signal,
    ),
  ).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
});
it.each(['database.example.com', 'localhost.evil.test', 'prod.ap-south-1.rds.amazonaws.com'])(
  'refuses nonlocal target%s',
  (host) => {
    const config = configuration();
    config.connections[0]!.endpoint.host = host;
    expect(() => composeSandboxPostgresql(config, 'local', ports())).toThrow(
      'configuration refused',
    );
  },
);
it.each([
  ['postgresql sandbox', descriptor, 'axiom-pg-kosha-core', true],
  ['mysql sandbox', '41420000-0000-4000-8000-000000000003', 'axiom-mysql-sanjeevani-his', true],
  ['mariadb sandbox', '41430000-0000-4000-8000-000000000003', 'axiom-mariadb-nimbus-app', true],
  ['mysql loopback', '41420000-0000-4000-8000-000000000003', 'host.docker.internal', true],
  // A demo hostname must belong to the engine the reviewed descriptor names.
  ['mariadb on a mysql host', '41430000-0000-4000-8000-000000000003', 'axiom-mysql-x', false],
  ['mysql on a postgresql host', '41420000-0000-4000-8000-000000000003', 'axiom-pg-x', false],
  // Production and reference descriptors never compose into the sandbox.
  ['mysql production', '41420000-0000-4000-8000-000000000001', 'axiom-mysql-x', false],
  ['mariadb production', '41430000-0000-4000-8000-000000000001', 'axiom-mariadb-x', false],
  ['postgresql reference', '41410000-0000-4000-8000-000000000002', 'axiom-pg-x', false],
])('composes SQL plug-in sandboxes only on their own demo hosts: %s', (_, id, host, ok) => {
  const config = configuration();
  config.connections[0]!.binding.descriptorId = id;
  config.connections[0]!.endpoint.host = host;
  if (ok) expect(() => composeSandboxPostgresql(config, 'local', ports())).not.toThrow();
  else
    expect(() => composeSandboxPostgresql(config, 'local', ports())).toThrow(
      'configuration refused',
    );
});
it('refuses malformed refreshed authority before allocating a socket', async () => {
  let calls = 0;
  db.onRpc('resolve_sandbox_postgresql_read_grant_for_operation', () => {
    calls++;
    return calls === 1 ? grant : { ...grant, grantExpiresAt: 'not-an-expiry' };
  });
  await expect(
    composeSandboxPostgresql(configuration(), 'local', ports()).run(request, await proof()),
  ).rejects.toThrow();
  expect(state.clients).toHaveLength(0);
});
it('erases a final private read that completes after cancellation and withholds the result', async () => {
  const controller = new AbortController();
  let release: ((bytes: Buffer) => void) | undefined;
  let calls = 0;
  read.mockImplementation(async () => {
    calls++;
    if (calls === 1) return Buffer.from(JSON.stringify(secret));
    return new Promise<Buffer>((resolve) => {
      release = resolve;
    });
  });
  const pending = composeSandboxPostgresql(configuration(), 'local', ports()).run(
    request,
    await proof(),
    controller.signal,
  );
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
  controller.abort();
  await expect(pending).rejects.toThrow();
  const late = Buffer.from(JSON.stringify(secret));
  release(late);
  await new Promise((resolve) => setTimeout(resolve, 1));
  expect(late.every((byte) => byte === 0)).toBe(true);
});
it('retained worker invocation verifies identity before claiming any human request', async () => {
  const claim = vi.fn();
  db.onRpc('claim_postgresql_discovery', claim);
  await expect(
    composeSandboxPostgresql(configuration(), 'local', ports()).runRetained(
      id(1),
      id(9),
      await proof('wrong'),
    ),
  ).rejects.toThrow();
  expect(claim).not.toHaveBeenCalled();
  expect(state.clients).toHaveLength(0);
});
it('loads only a retained scoped request and binds the real discovery record to its operation key', async () => {
  const config = configuration();
  db.onRpc('claim_postgresql_discovery', () => ({
    tenantId: id(1),
    requestId: id(9),
    connectorId: id(3),
    estateId: id(2),
    configurationSha256: sandboxConfigurationSha256(config),
    operation: 'enumerate',
    resource: null,
    limit: null,
    cursor: null,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  }));
  db.onRpc('record_connector_discovery', (args) => {
    expect(args.p_correlation_id).toBe(id(9));
    return { run: { id: id(8) } };
  });
  db.onRpc('retain_postgresql_discovery', (args) => {
    expect(args).toEqual({ t: id(1), j: id(9), discovery: id(8) });
    return { requestId: id(9), discoveryRunId: id(8) };
  });
  expect(
    await composeSandboxPostgresql(config, 'local', ports()).runRetained(
      id(1),
      id(9),
      await proof(),
    ),
  ).toEqual({ requestId: id(9), discoveryRunId: id(8) });
});

it('does not burn a queued request for a valid SVID belonging to another local workload', async () => {
  const claim = vi.fn();
  db.onRpc('claim_postgresql_discovery', claim);
  await expect(
    composeSandboxPostgresql(configuration(), 'local', ports()).runRetained(
      id(1),
      id(9),
      await proof('axiom-postgresql-discovery', 'spiffe://local.axiomproof.test/agent/parikshan'),
    ),
  ).rejects.toThrow();
  expect(claim).not.toHaveBeenCalled();
  expect(state.clients).toHaveLength(0);
});
