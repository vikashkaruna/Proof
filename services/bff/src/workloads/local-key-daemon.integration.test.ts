import { generateKeyPairSync, X509Certificate, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { LocalKeyTlsIdentities, serveLocalKeyMtlsGeneration } from './local-key-mtls.js';
import { WorkloadApiX509Source, type OpenX509Stream } from './workload-api-x509.js';
import { dispatchWrappingContext } from './dispatch-payload.js';
import { LocalKeyService } from './local-key-service.js';
import { LocalDispatchKeyWrapper } from './local-dispatch-key-wrapper.js';
import { runGenerations } from './local-key-daemon.js';
import type { LocalKeyAuthority } from './local-key-policy.js';

/** The daemon loop end to end over real mTLS with the real on-disk key
 * service: a producer wraps, a later generation lets the controller unwrap the
 * same key, and an unmapped client gets nothing. SQL admission is the one
 * substitute (an in-memory authority); local-key-daemon.test.ts covers it. */

let directory: string;
let serial = 1;
const tenant = 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1',
  workload = 'b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1',
  job = 'c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1',
  run = 'd1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1',
  policyId = 'e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1';
const uri = (name: string) => `spiffe://local.axiomproof.test/${name}`;
const keyRef = `axiom-local-dispatch://${tenant}/${policyId}/versions/1`;
const context = dispatchWrappingContext({
  jobId: job,
  tenantId: tenant,
  workloadId: workload,
  actorId: run,
  estateId: null,
  engagementId: run,
  correlationId: run,
  inputHash: 'a'.repeat(64),
});
const run$ = (args: string[]) =>
  execFileSync('openssl', args, { cwd: directory, stdio: 'ignore', timeout: 10000 });
function key(name: string) {
  writeFileSync(
    join(directory, name + '.key'),
    generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({
      format: 'pem',
      type: 'pkcs8',
    }),
    { mode: 0o600 },
  );
}
function sign(name: string) {
  key(name);
  run$(['req', '-new', '-key', `${name}.key`, '-subj', '/CN=fixture', '-out', `${name}.csr`]);
  writeFileSync(
    join(directory, `${name}.ext`),
    `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth,serverAuth\nsubjectAltName=URI:${uri(name)}\n`,
    { mode: 0o600 },
  );
  run$([
    'x509',
    '-req',
    '-in',
    `${name}.csr`,
    '-CA',
    'root.pem',
    '-CAkey',
    'root.key',
    '-set_serial',
    String(serial++),
    '-days',
    '1',
    '-extfile',
    `${name}.ext`,
    '-out',
    `${name}.pem`,
  ]);
}
function source(name: string, purpose: 'client' | 'server') {
  const der = execFileSync(
    'openssl',
    ['pkcs8', '-topk8', '-nocrypt', '-in', join(directory, `${name}.key`), '-outform', 'DER'],
    { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 },
  );
  const open: OpenX509Stream = (_path, _deadline, data) => {
    queueMicrotask(() =>
      data({
        svids: [
          {
            spiffeId: uri(name),
            x509Svid: new X509Certificate(readFileSync(join(directory, `${name}.pem`))).raw,
            x509SvidKey: Buffer.from(der),
            bundle: new X509Certificate(readFileSync(join(directory, 'root.pem'))).raw,
          },
        ],
        crl: [],
        federatedBundles: {},
      }),
    );
    return { close: () => {} };
  };
  return new WorkloadApiX509Source(
    { socketPath: '/run/axiom/workload.sock', spiffeId: uri(name), purpose },
    { domain: 'local.axiomproof.test', validUntil: async () => Date.now() + 10000 },
    open,
  );
}
const identities = new LocalKeyTlsIdentities(
  (['key-service', 'producer', 'controller'] as const).map((name) => ({
    spiffeId: uri(name),
    servicePrincipal: uri(name),
    tenantId: tenant,
    workloadId: workload,
    role: name === 'key-service' ? ('key_service' as const) : name,
  })),
);
async function freePort() {
  return new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

beforeAll(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'axiom-daemon-')));
  key('root');
  run$([
    'req',
    '-new',
    '-x509',
    '-key',
    'root.key',
    '-subj',
    '/CN=root',
    '-days',
    '2',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
    '-out',
    'root.pem',
  ]);
  for (const name of ['key-service', 'producer', 'controller', 'stranger']) sign(name);
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

it('serves a producer wrap and a later controller unwrap of the same key across generations', async () => {
  const keys = join(directory, 'keys');
  mkdirSync(keys, { mode: 0o700 });
  const required: string[] = [];
  // In-memory admission: role↔operation exactly as SQL enforces, and unwrap
  // only for the run the resolver derived.
  const authority: LocalKeyAuthority = {
    value: { primary: keyRef },
    async require(caller, operation) {
      required.push(`${caller.role}:${operation}:${caller.originalRunId ?? '-'}`);
      const role = { provision: 'operator', wrap: 'producer', unwrap: 'controller' }[operation];
      if (caller.role !== role || (operation === 'unwrap' && caller.originalRunId !== run))
        throw new Error('refused');
      return { kind: 'durable_local_custody_143', commitment: operation };
    },
  };
  const service = new LocalKeyService(keys, authority);
  await service.provision(
    { tenantId: tenant, workloadId: workload, role: 'operator', servicePrincipal: 'operator:x' },
    keyRef,
  );
  const endpoint = { host: '127.0.0.1' as const, port: await freePort() };
  const resolveAcceptedRun = vi.fn(async () => run);
  const stop = new AbortController();
  const server = source('key-service', 'server');
  const loop = runGenerations(
    (deadline) =>
      serveLocalKeyMtlsGeneration({
        source: server,
        identities,
        service,
        endpoint,
        deadline,
        resolveAcceptedRun,
        listening: () => {},
      }),
    stop.signal,
    { windowMs: 1500, pauseMs: 20 },
  );
  const client = (name: 'producer' | 'controller' | 'stranger') =>
    new LocalDispatchKeyWrapper({
      source: source(name, 'client'),
      identities,
      serverIdentity: uri('key-service'),
      endpoint,
      deadlineMs: 1400,
    });
  // Connection attempts before a generation is listening are refused; retry
  // only at that layer, as an operator supervisor would.
  async function retry<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await work();
      } catch (error) {
        if (attempt >= 20) throw error;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }
  try {
    const dek = randomBytes(32);
    const wrapped = await retry(() => client('producer').wrap(context, dek));
    expect(wrapped.keyRef).toBe(keyRef);
    expect(wrapped.wrappedKey.byteLength).toBe(61);
    const clear = await retry(() =>
      client('controller').unwrap(context, wrapped.keyRef, wrapped.wrappedKey),
    );
    expect(Buffer.from(clear).equals(dek)).toBe(true);
    expect(resolveAcceptedRun).toHaveBeenCalledOnce();
    expect(resolveAcceptedRun.mock.calls[0]).toContain(keyRef);
    // A producer cannot unwrap, and an unmapped identity gets nothing.
    await expect(
      client('producer').unwrap(context, wrapped.keyRef, wrapped.wrappedKey),
    ).rejects.toThrow();
    await expect(client('stranger').wrap(context, dek)).rejects.toThrow();
    expect(required.filter((r) => r.startsWith('producer:unwrap'))).toEqual([]);
    // The daemon is still serving after those refusals.
    const again = await retry(() => client('producer').wrap(context, randomBytes(32)));
    expect(again.keyRef).toBe(keyRef);
  } finally {
    stop.abort();
    await loop;
  }
}, 60_000);
