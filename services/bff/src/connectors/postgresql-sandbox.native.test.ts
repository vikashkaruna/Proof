/** Only run through tests/connectors/postgresql-sandbox.py: owns/disposes a TLS
 * PostgreSQL target. The control-plane RPC is an explicit in-memory stand-in;
 * real authority SQL is independently covered by the migration163 SQL suite. */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { rootCertificates } from 'node:tls';
import { SignJWT } from 'jose';
import pg from 'pg';
import { z } from 'zod';
import { discoveryRoutes } from '../routes/discovery.js';
import { readControllerFile } from '../workloads/controller-files.js';
import { createFakeDb } from '../test/fake-postgrest.js';
import { composeSandboxPostgresql, sandboxConfigurationSha256 } from './postgresql-sandbox.js';
import { postgresSessions } from './sql/session.js';
const fixturePath = process.env.AXIOM_OWNED_POSTGRESQL_FIXTURE;
const native = it.skipIf(!fixturePath);
const id = (n: number) => `52520000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const descriptor = '41410000-0000-4000-8000-000000000003';
const spiffeId = 'spiffe://local.axiomproof.test/agent/drishti';
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const fixtureShape = z
  .object({
    containerId: z.string().regex(/^[a-f0-9]{64}$/),
    ownerNonce: z.string().regex(/^[a-f0-9]{24}$/),
    image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    port: z.number().int().positive(),
    caFile: z.string(),
    password: z.string(),
    credentialFile: z.string(),
    expiresAt: z.number(),
  })
  .strict();
let fixture: z.infer<typeof fixtureShape>;
let ca: string;
let admin: pg.Client;
let proof: string;
const request = { tenantId: id(1), estateId: id(2), connectorId: id(3), operation: 'enumerate' };
function endpoint(user = 'axiom_reader', caPem = ca) {
  return {
    host: 'localhost',
    port: fixture.port,
    database: 'postgres',
    user,
    region: 'ap-south-1' as const,
    caPem,
  };
}
function composition(user = 'axiom_reader', caPem = ca) {
  const binding = {
    tenantId: id(1),
    estateId: id(2),
    connectorId: id(3),
    systemId: id(4),
    descriptorId: descriptor,
    descriptorSha256: 'b'.repeat(64),
    endpointRef: 'disposable_pg',
    targetBinding: 'sandbox',
    connectorVersion: 1,
  };
  const configuration = {
    schemaVersion: 1,
    mode: 'local_sandbox_password',
    environment: 'test',
    workload: {
      socketPath: '/run/workload/api.sock',
      healthFile: '/run/spire-health/status.json',
      trustDomain: 'local.axiomproof.test',
      issuerNodeId: 'spiffe://local.axiomproof.test/spire/agent/join_token/local',
    },
    connections: [
      {
        binding,
        endpoint: endpoint(user, caPem),
        credential: {
          id: id(5),
          revision: 1,
          expiresAt: fixture.expiresAt,
          file: fixture.credentialFile,
        },
      },
    ],
  };
  const grantExpiresAt = new Date(Date.now() + 120000).toISOString();
  const db = createFakeDb({
    connectors: [{ id: id(3), tenant_id: id(1), descriptor_id: descriptor, status: 'active' }],
  });
  db.onRpc('resolve_sandbox_postgresql_read_grant_for_operation', () => ({
    grantId: id(6),
    workloadId: id(7),
    agentName: 'drishti',
    spiffeId,
    systemId: id(4),
    grantExpiresAt,
    connectorVersion: 1,
    descriptorSha256: 'b'.repeat(64),
    endpointRef: 'disposable_pg',
    targetBinding: 'sandbox',
  }));
  db.onRpc('record_connector_discovery', () => ({ run: { id: id(8) } }));
  db.onRpc('claim_postgresql_discovery', () => ({
    tenantId: id(1),
    requestId: id(9),
    connectorId: id(3),
    estateId: id(2),
    configurationSha256: sandboxConfigurationSha256(configuration),
    operation: 'enumerate',
    resource: null,
    limit: null,
    cursor: null,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  }));
  db.onRpc('retain_postgresql_discovery', (args) => {
    expect(args).toEqual({ t: id(1), j: id(9), discovery: id(8) });
    return { requestId: id(9), discoveryRunId: id(8) };
  });

  return composeSandboxPostgresql(configuration, 'test', {
    client: () => db.client as never,
    trust: {
      async load() {
        return {
          revision: 'fixture',
          validUntil: Date.now() + 300000,
          jwks: { keys: [keys.publicKey.export({ format: 'jwk' })] },
        };
      },
      async stillCurrent() {
        return true;
      },
    },
  });
}
async function noSessions() {
  for (let n = 0; n < 120; n++) {
    const count = Number(
      (
        await admin.query(
          "select count(*)::int as n from pg_stat_activity where application_name='axiom-drishti'",
        )
      ).rows[0].n,
    );
    if (count === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Owned target session leaked after cancellation');
}
beforeAll(async () => {
  if (!fixturePath) return;
  const bytes = await readControllerFile(fixturePath);
  try {
    fixture = fixtureShape.parse(JSON.parse(bytes.toString('utf8')));
  } finally {
    bytes.fill(0);
  }
  // Refuse fixture metadata pointing at an existing/retained PostgreSQL stack.
  // A protected filename alone is not evidence that a target is disposable.
  const { stdout } = await promisify(execFile)('docker', ['inspect', fixture.containerId], {
    timeout: 5000,
  });
  const owned = z
    .array(
      z.object({
        Id: z.string(),
        Image: z.string(),
        State: z.object({ Running: z.boolean() }),
        Config: z.object({ Labels: z.record(z.string(), z.string()) }),
        HostConfig: z.object({ Tmpfs: z.record(z.string(), z.string()) }),
        NetworkSettings: z.object({
          Ports: z.record(
            z.string(),
            z.array(z.object({ HostIp: z.string(), HostPort: z.string() })).nullable(),
          ),
        }),
      }),
    )
    .length(1)
    .parse(JSON.parse(stdout))[0]!;
  const labels = owned.Config.Labels;
  expect(owned.Id).toBe(fixture.containerId);
  expect(owned.Image).toBe(fixture.image);
  expect(owned.State.Running).toBe(true);
  expect(labels['com.axiom.fixture']).toBe('postgresql-sandbox');
  expect(labels['com.axiom.fixture.project']).toBe('axiom-postgresql-discovery');
  expect(labels['com.axiom.owner-nonce']).toBe(fixture.ownerNonce);
  expect(labels['com.axiom.owner-worktree']).toBe(
    fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, ''),
  );
  expect(owned.HostConfig.Tmpfs['/var/lib/postgresql/data']).toBe('rw,size=268435456');
  expect(owned.NetworkSettings.Ports['5432/tcp']).toEqual([
    { HostIp: '127.0.0.1', HostPort: String(fixture.port) },
  ]);
  ca = await readFile(fixture.caFile, 'utf8');
  admin = new pg.Client({
    ...endpoint('postgres'),
    password: fixture.password,
    ssl: { ca, rejectUnauthorized: true, servername: 'localhost' },
    application_name: 'axiom-fixture-observer',
  });
  await admin.connect();
  await admin.query(
    'create role axiom_reader login password ' + pg.escapeLiteral(fixture.password),
  );
  await admin.query(
    "create table synthetic_fixture(id int primary key,email text);insert into synthetic_fixture values(1,'synthetic@example.invalid');create view slow_fixture as select 'synthetic'::text as label from pg_sleep(10);grant select on synthetic_fixture,slow_fixture to axiom_reader",
  );
  proof = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256' })
    .setSubject(spiffeId)
    .setAudience('axiom-postgresql-discovery')
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 120)
    .sign(keys.privateKey);
});
afterAll(async () => {
  await admin?.end();
});
native(
  'reads through the mounted sandbox composition using verified TLS and a protected password file',
  async () => {
    const service = composition();
    const response = await discoveryRoutes(service).request('/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workload-svid': proof },
      body: JSON.stringify(request),
    });
    expect(response.status).toBe(200);
    const enumeration = z
      .object({
        data: z
          .object({ records: z.array(z.object({ resource: z.string() }).passthrough()) })
          .passthrough(),
      })
      .parse(await response.json()).data;
    expect(
      enumeration.records.some((record) => record.resource === 'public.synthetic_fixture'),
    ).toBe(true);
    const result = await service.run(
      { ...request, operation: 'sample', resource: 'public.synthetic_fixture', limit: 1 },
      proof,
    );
    expect(JSON.stringify(result)).not.toContain('synthetic@example.invalid');
    expect(JSON.stringify(result)).not.toContain(fixture.password);
    await noSessions();
  },
);
native('refuses a write-capable target role before sampling and releases its session', async () => {
  await expect(composition('postgres').run(request, proof)).rejects.toThrow();
  await noSessions();
});
native('refuses an untrusted target CA', async () => {
  const wrongCa = rootCertificates[0]!;
  await expect(composition('axiom_reader', wrongCa).run(request, proof)).rejects.toThrow();
  await noSessions();
});
native(
  'propagates external cancellation through the composed read and confirms backend cleanup',
  async () => {
    const controller = new AbortController();
    const started = Date.now();
    const timer = setTimeout(() => controller.abort(), 250);
    try {
      await expect(
        composition().run(
          { ...request, operation: 'sample', resource: 'public.slow_fixture', limit: 1 },
          proof,
          controller.signal,
        ),
      ).rejects.toThrow();
    } finally {
      clearTimeout(timer);
    }
    expect(Date.now() - started).toBeLessThan(1500);
    // Transport closes immediately. PostgreSQL can observe EOF only after its
    // in-flight statement; the pre-set server statement timeout caps that work.
    await noSessions();
    expect(Date.now() - started).toBeLessThan(6500);
  },
  10000,
);
native(
  'bounds real stalled native queries by the original deadline and confirms cleanup',
  async () => {
    const factory = postgresSessions({
      endpoint: () => endpoint(),
      credentials: { password: async () => fixture.password },
    });
    const started = Date.now();
    const session = await factory({
      tenantId: id(1),
      estateId: id(2),
      systemId: id(4),
      connectorId: id(3),
      descriptorSha256: 'b'.repeat(64),
      grantId: id(6),
      workloadIdentity: spiffeId,
      correlationId: id(9),
      deadline: new Date(started + 600).toISOString(),
    });
    try {
      await expect(session.query('select pg_sleep(10)')).rejects.toThrow();
    } finally {
      await session.abort?.();
    }
    await noSessions();
    expect(Date.now() - started).toBeLessThan(2000);
  },
);

native(
  'serves a retained pointer through the real broker, private HTTP contract and TLS target',
  async () => {
    const response = await discoveryRoutes(composition()).request('/retained', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workload-svid': proof },
      body: JSON.stringify({ tenantId: id(1), requestId: id(9) }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { requestId: id(9), discoveryRunId: id(8) } });
    await noSessions();
  },
);
