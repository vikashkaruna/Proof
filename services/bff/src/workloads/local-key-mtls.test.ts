import { generateKeyPairSync, X509Certificate, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  mkdirSync,
  realpathSync,
  lstatSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, type TLSSocket } from 'node:tls';
import { connect as netConnect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  LocalKeyTlsIdentities,
  requestLocalKeyMtls,
  serveLocalKeyMtlsGeneration,
  type LocalKeyTlsEndpoint,
  type LocalKeyTlsRequest,
} from './local-key-mtls.js';
import { WorkloadApiX509Source, type OpenX509Stream } from './workload-api-x509.js';
import { dispatchWrappingContext } from './dispatch-payload.js';
import type { LocalKeyService } from './local-key-service.js';
import type { X509SvidResponse } from './workload-api-protocol.js';

let directory: string;
let serial = 1;
const tenant = 'a0a0a0a0-a0a0-40a0-80a0-a0a0a0a0a0a0',
  workload = 'b0b0b0b0-b0b0-40b0-80b0-b0b0b0b0b0b0',
  run = 'c0c0c0c0-c0c0-40c0-80c0-c0c0c0c0c0c0';
const uri = (name: string) => `spiffe://local.axiomproof.test/${name}`;
const mappings = new LocalKeyTlsIdentities(
  ['server', 'producer', 'controller'].map((name) => ({
    spiffeId: uri(name),
    servicePrincipal: uri(name),
    tenantId: tenant,
    workloadId: workload,
    role: name === 'server' ? 'key_service' : name === 'controller' ? 'controller' : 'producer',
  })),
);
const context = dispatchWrappingContext({
  jobId: run,
  tenantId: tenant,
  workloadId: workload,
  actorId: run,
  estateId: null,
  engagementId: run,
  correlationId: run,
  inputHash: 'a'.repeat(64),
});
const keyRef = `axiom-local-dispatch://${tenant}/${run}/versions/1`;
const request = {
  version: 1 as const,
  operation: 'wrap' as const,
  context: context.toString('base64'),
  key: Buffer.alloc(32, 7).toString('base64'),
};
function openssl(args: string[]) {
  execFileSync('openssl', args, { cwd: directory, stdio: 'ignore', timeout: 10000 });
}
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
function pem(name: string) {
  return readFileSync(join(directory, name + '.pem'));
}
function sign(
  name: string,
  san = `URI:${uri(name)}`,
  eku = 'clientAuth,serverAuth',
  root = 'root',
  days = '1',
  extra = '',
) {
  key(name);
  openssl([
    'req',
    '-new',
    '-key',
    name + '.key',
    '-subj',
    '/CN=Owned local mTLS fixture',
    '-out',
    name + '.csr',
  ]);
  writeFileSync(
    join(directory, name + '.ext'),
    `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=${eku}\nsubjectAltName=${san}\n${extra}`,
    { mode: 0o600 },
  );
  openssl([
    'x509',
    '-req',
    '-in',
    name + '.csr',
    '-CA',
    root + '.pem',
    '-CAkey',
    root + '.key',
    '-set_serial',
    String(serial++),
    '-days',
    days,
    '-extfile',
    name + '.ext',
    '-out',
    name + '.pem',
  ]);
}
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'axiom-mtls-'));
  for (const root of ['root', 'foreign', 'expired-root']) {
    key(root);
    openssl([
      'req',
      '-new',
      '-x509',
      '-key',
      root + '.key',
      '-subj',
      '/CN=' + root,
      '-days',
      '2',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
      '-out',
      root + '.pem',
    ]);
  }
  openssl([
    'x509',
    '-in',
    'expired-root.pem',
    '-signkey',
    'expired-root.key',
    '-days',
    '0',
    '-out',
    'expired-root.pem',
  ]);
  for (const name of ['server', 'producer', 'controller']) sign(name);
  sign('wrong-san', `URI:${uri('unmapped')}`);
  sign('mixed', `URI:${uri('producer')},DNS:localhost`);
  sign('wrong-purpose', `URI:${uri('producer')}`, 'serverAuth');
  sign('expired', `URI:${uri('producer')}`, 'clientAuth', 'root', '0');
  sign(
    'critical',
    `URI:${uri('producer')}`,
    'clientAuth',
    'root',
    '1',
    '1.2.3.4=critical,DER:05:00\n',
  );
  sign('foreign-client', `URI:${uri('producer')}`, 'clientAuth', 'foreign');
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));
function source(name: string, purpose: 'client' | 'server', certificate = name, bundle = ['root']) {
  let emit: (value: unknown) => void = () => {},
    fail = () => {};
  const health = vi.fn(async (): Promise<number | null> => Date.now() + 10000);
  const close = vi.fn();
  const reply = (): X509SvidResponse => ({
    svids: [
      {
        spiffeId: uri(name),
        x509Svid: new X509Certificate(pem(certificate)).raw,
        x509SvidKey: Buffer.from(generateKeyDer(certificate)),
        bundle: Buffer.concat(bundle.map((root) => new X509Certificate(pem(root)).raw)),
      },
    ],
    crl: [],
    federatedBundles: {},
  });
  const open: OpenX509Stream = (_path, _deadline, data, unavailable) => {
    emit = data;
    fail = unavailable;
    queueMicrotask(() => data(reply()));
    return { close };
  };
  return {
    value: new WorkloadApiX509Source(
      { socketPath: '/run/axiom/workload.sock', spiffeId: uri(name), purpose },
      { domain: 'local.axiomproof.test', validUntil: health },
      open,
    ),
    health,
    close,
    fail: () => fail(),
    emit: (input: unknown) => emit(input),
    reply,
  };
}
function generateKeyDer(name: string) {
  return execFileSync(
    'openssl',
    ['pkcs8', '-topk8', '-nocrypt', '-in', join(directory, name + '.key'), '-outform', 'DER'],
    { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 },
  );
}
function fixture(
  window = 1500,
  endpoint: LocalKeyTlsEndpoint = { host: '127.0.0.1', port: 0 },
  serverCertificate = 'server',
  bundle = ['root'],
) {
  const server = source('server', 'server', serverCertificate, bundle),
    client = source('producer', 'client', 'producer', bundle);
  const service = {
    wrap: vi.fn<LocalKeyService['wrap']>(async () => ({
      keyRef: keyRef,
      wrappedKey: Buffer.alloc(61, 3),
    })),
    unwrap: vi.fn<LocalKeyService['unwrap']>(async () => Buffer.alloc(32, 9)),
  };
  const resolveAcceptedRun = vi.fn(async (_c: unknown, _x: Buffer, _d: number, _k: string) => run);
  let ready: (endpoint: LocalKeyTlsEndpoint) => void = () => {};
  const listening = new Promise<LocalKeyTlsEndpoint>((resolve) => {
    ready = resolve;
  });
  const deadline = Date.now() + window;
  const done = serveLocalKeyMtlsGeneration({
    source: server.value,
    identities: mappings,
    service,
    endpoint,
    deadline,
    resolveAcceptedRun,
    listening: ready,
  });
  void done.catch(() => {});
  return { server, client, service, resolveAcceptedRun, done, listening, deadline };
}
async function raw(
  address: LocalKeyTlsEndpoint,
  name: string | undefined,
  body: LocalKeyTlsRequest = request,
  session?: Buffer,
): Promise<{ reused: boolean; session: Buffer | undefined }> {
  const endpoint = address as { host: '127.0.0.1'; port: number };
  let socket: TLSSocket | undefined;
  try {
    return await new Promise((resolve, reject) => {
      let data = Buffer.alloc(0);
      let reused = false;
      let saved: Buffer | undefined;
      socket = connect(
        {
          ...endpoint,
          ca: pem('root'),
          ...(name ? { cert: pem(name), key: readFileSync(join(directory, name + '.key')) } : {}),
          rejectUnauthorized: true,
          minVersion: 'TLSv1.3',
          maxVersion: 'TLSv1.3',
          ALPNProtocols: ['axiom-local-key/1'],
          checkServerIdentity: () => undefined,
          session,
        },
        () => {
          reused = socket!.isSessionReused();
          saved = socket!.getSession();
          socket!.write(JSON.stringify(body) + '\n');
        },
      );
      socket.setTimeout(1600, () => socket!.destroy(new Error('Owned test deadline')));
      socket.on('data', (chunk) => {
        data = Buffer.concat([data, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      });
      socket.on('error', reject);
      socket.on('close', () => {
        if (data.length) resolve({ reused, session: saved });
        else reject(new Error('Owned TLS refusal'));
      });
    });
  } finally {
    socket?.destroy();
  }
}
describe('unmounted real TLS, owned loopback ephemeral generation only', () => {
  it.each([{ bundle: ['root'] }, { bundle: ['expired-root', 'root'] }])(
    'uses real mutual PKIX with current anchors from bundle $bundle',
    async ({ bundle }) => {
      const f = fixture(1500, { host: '127.0.0.1', port: 0 }, 'server', bundle);
      try {
        const address = await f.listening;
        const result = await requestLocalKeyMtls({
          source: f.client.value,
          identities: mappings,
          serverIdentity: uri('server'),
          endpoint: address,
          deadline: f.deadline,
          request,
        });
        expect(result).toEqual({
          version: 1,
          keyRef: keyRef,
          key: Buffer.alloc(61, 3).toString('base64'),
        });
        await expect(f.done).resolves.toBeUndefined();
        expect(f.service.wrap).toHaveBeenCalledOnce();
        expect(f.service.wrap.mock.calls[0]?.[0]).toMatchObject({
          tenantId: tenant,
          workloadId: workload,
          servicePrincipal: uri('producer'),
          role: 'producer',
        });
      } finally {
        f.server.fail();
        f.client.fail();
        await f.done.catch(() => {});
      }
    },
  );
  it('refuses release if a real server leaf expires during deferred final client health', async () => {
    const name = 'short-server';
    key(name);
    openssl([
      'req',
      '-new',
      '-key',
      name + '.key',
      '-subj',
      '/CN=Owned local mTLS fixture',
      '-out',
      name + '.csr',
    ]);
    writeFileSync(join(directory, 'short-index.txt'), '');
    writeFileSync(join(directory, 'short-serial.txt'), '1000\n');
    writeFileSync(
      join(directory, 'short-ca.cnf'),
      `[ca]\ndefault_ca=owned\n[owned]\ndatabase=short-index.txt\nserial=short-serial.txt\nnew_certs_dir=.\ncertificate=root.pem\nprivate_key=root.key\ndefault_md=sha256\npolicy=policy\n[policy]\ncommonName=supplied\n[leaf]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth,serverAuth\nsubjectAltName=URI:${uri('server')}\n`,
      { mode: 0o600 },
    );
    const now = Date.now(),
      date = (ms: number) => new Date(ms).toISOString().replace(/\D/g, '').slice(0, 14) + 'Z';
    openssl([
      'ca',
      '-config',
      'short-ca.cnf',
      '-batch',
      '-notext',
      '-in',
      name + '.csr',
      '-out',
      name + '.pem',
      '-extensions',
      'leaf',
      '-startdate',
      date(now - 3600000),
      '-enddate',
      date(now + 2500),
    ]);
    const expiresAt = Date.parse(new X509Certificate(pem(name)).validTo);
    const f = fixture(4500, { host: '127.0.0.1', port: 0 }, name);
    let enter: () => void = () => {},
      release: (value: number) => void = () => {},
      clock: ReturnType<typeof vi.spyOn> | undefined;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let reads = 0;
    f.client.health.mockImplementation(async () =>
      ++reads === 3
        ? new Promise<number>((resolve) => {
            release = resolve;
            enter();
          })
        : Date.now() + 10000,
    );
    let response: Promise<unknown> | undefined;
    try {
      response = requestLocalKeyMtls({
        source: f.client.value,
        identities: mappings,
        serverIdentity: uri('server'),
        endpoint: await f.listening,
        deadline: f.deadline,
        request,
      });
      void response.catch(() => {});
      await Promise.race([
        entered,
        response.then(() => {
          throw new Error('Final health not reached');
        }),
      ]);
      await f.done;
      expect(expiresAt + 1).toBeLessThan(f.deadline);
      clock = vi.spyOn(Date, 'now').mockReturnValue(expiresAt + 1);
      release(expiresAt + 10000);
      await expect(response).rejects.toThrow();
      expect(f.service.wrap).toHaveBeenCalledOnce();
    } finally {
      release(Date.now() + 10000);
      clock?.mockRestore();
      f.server.fail();
      f.client.fail();
      await response?.catch(() => {});
      await f.done.catch(() => {});
    }
  });
  it('exchanges over the supported canonical private UDS and removes its owned socket', async () => {
    const parent = realpathSync('/tmp');
    const owned = join(parent, 'axiom-key-' + randomBytes(6).toString('hex'));
    mkdirSync(owned, { mode: 0o700 });
    const socketPath = join(owned, 'keys.sock');
    let f: ReturnType<typeof fixture> | undefined;
    try {
      expect(realpathSync(owned)).toBe(owned);
      expect(lstatSync(owned).uid).toBe(process.getuid!());
      expect(lstatSync(owned).mode & 0o7777).toBe(0o700);
      f = fixture(1500, { path: socketPath });
      const address = await f.listening;
      const info = lstatSync(socketPath);
      expect(info.isSocket()).toBe(true);
      expect(info.uid).toBe(process.getuid!());
      expect(info.mode & 0o7777).toBe(0o600);
      const result = await requestLocalKeyMtls({
        source: f.client.value,
        identities: mappings,
        serverIdentity: uri('server'),
        endpoint: address,
        deadline: f.deadline,
        request,
      });
      expect(result).toEqual({ version: 1, keyRef, key: Buffer.alloc(61, 3).toString('base64') });
      await f.done;
      expect(f.service.wrap).toHaveBeenCalledOnce();
      expect(existsSync(socketPath)).toBe(false);
    } finally {
      f?.server.fail();
      f?.client.fail();
      if (f) await f.done.catch(() => {});
      rmSync(owned, { recursive: true, force: true });
      expect(existsSync(owned)).toBe(false);
    }
  });
  it.each([
    undefined,
    'foreign-client',
    'wrong-san',
    'mixed',
    'wrong-purpose',
    'expired',
    'critical',
  ])('refuses %s before key service', async (name) => {
    const f = fixture();
    try {
      await expect(raw(await f.listening, name)).rejects.toThrow();
      await expect(f.done).rejects.toThrow();
      expect(f.service.wrap).not.toHaveBeenCalled();
    } finally {
      f.server.fail();
      await f.done.catch(() => {});
    }
  });
  it('attempted session reuse makes a fresh full handshake', async () => {
    const f = fixture();
    let session: Buffer | undefined;
    try {
      const outcome = await raw(await f.listening, 'producer');
      session = outcome.session;
      expect(Buffer.isBuffer(session)).toBe(true);
      expect(outcome.reused).toBe(false);
      await f.done;
    } finally {
      f.server.fail();
      await f.done.catch(() => {});
    }
    const next = fixture();
    try {
      const outcome = await raw(await next.listening, 'producer', request, session);
      expect(outcome.reused).toBe(false);
      await next.done;
    } finally {
      next.server.fail();
      await next.done.catch(() => {});
    }
  });
  it.each(['stream', 'health'])('withholds response when %s fails after crypto', async (kind) => {
    const f = fixture();
    f.service.wrap.mockImplementationOnce(async () => {
      if (kind === 'stream') f.server.fail();
      else f.server.health.mockResolvedValue(null);
      return { keyRef, wrappedKey: Buffer.alloc(61, 4) };
    });
    try {
      await expect(raw(await f.listening, 'producer')).rejects.toThrow();
      await expect(f.done).rejects.toThrow();
      expect(f.service.wrap).toHaveBeenCalledOnce();
    } finally {
      f.server.fail();
      await f.done.catch(() => {});
    }
  });
  it.each(['tenant', 'workload', 'role', 'unknown-field'])(
    'refuses %s before crypto or original-run lookup',
    async (kind) => {
      const f = fixture();
      const fields = JSON.parse(context.toString('utf8')) as unknown[];
      if (kind === 'tenant') fields[3] = run;
      if (kind === 'workload') fields[5] = run;
      const body = {
        ...request,
        context: Buffer.from(JSON.stringify(fields)).toString('base64'),
        ...(kind === 'unknown-field' ? { originalRunId: run } : {}),
        ...(kind === 'role'
          ? {
              operation: 'unwrap' as const,
              keyRef,
              key: Buffer.alloc(61).toString('base64'),
            }
          : {}),
      };
      try {
        await expect(raw(await f.listening, 'producer', body)).rejects.toThrow();
        await expect(f.done).rejects.toThrow();
        expect(f.service.wrap).not.toHaveBeenCalled();
        expect(f.service.unwrap).not.toHaveBeenCalled();
        expect(f.resolveAcceptedRun).not.toHaveBeenCalled();
      } finally {
        f.server.fail();
        await f.done.catch(() => {});
      }
    },
  );
  it('refuses unsafe endpoint configuration and files without overwriting them', async () => {
    const owned = mkdtempSync(join(directory, 'endpoint-'));
    const existing = join(owned, 'keys.sock');
    writeFileSync(existing, 'unchanged', { mode: 0o600 });
    const alias = join(directory, 'endpoint-alias');
    symlinkSync(owned, alias);
    const service = {
      wrap: vi.fn<LocalKeyService['wrap']>(),
      unwrap: vi.fn<LocalKeyService['unwrap']>(),
    };
    const cases: LocalKeyTlsEndpoint[] = [
      { path: 'relative.sock' },
      { path: `${owned}/../missing.sock` },
      { path: existing },
      { path: join(alias, 'keys.sock') },
      { path: join(owned, 'missing', 'keys.sock') },
      { host: '127.0.0.1', port: 0 },
    ];
    try {
      for (const value of cases) {
        const server = source('server', 'server');
        if ('port' in value) {
          await expect(
            requestLocalKeyMtls({
              source: server.value,
              identities: mappings,
              serverIdentity: uri('server'),
              endpoint: value,
              deadline: Date.now() + 100,
              request,
            }),
          ).rejects.toThrow();
        } else
          await expect(
            serveLocalKeyMtlsGeneration({
              source: server.value,
              identities: mappings,
              service,
              endpoint: value,
              deadline: Date.now() + 100,
              resolveAcceptedRun: async () => run,
              listening: () => {
                throw new Error('Unexpected listener');
              },
            }),
          ).rejects.toThrow();
        expect(server.close).not.toHaveBeenCalled();
      }
      chmodSync(owned, 0o755);
      await expect(
        requestLocalKeyMtls({
          source: source('producer', 'client').value,
          identities: mappings,
          serverIdentity: uri('server'),
          endpoint: { path: existing },
          deadline: Date.now() + 100,
          request,
        }),
      ).rejects.toThrow();
      expect(readFileSync(existing, 'utf8')).toBe('unchanged');
    } finally {
      chmodSync(owned, 0o700);
      rmSync(owned, { recursive: true, force: true });
      rmSync(alias, { force: true });
    }
  });
  it('rejects duplicate mapping identities and no implicit peer authorization', () => {
    expect(() => new LocalKeyTlsIdentities([])).toThrow();
    const row = {
      spiffeId: uri('producer'),
      servicePrincipal: uri('producer'),
      tenantId: tenant,
      workloadId: workload,
      role: 'producer',
    };
    expect(() => new LocalKeyTlsIdentities([row, row])).toThrow();
    expect(
      () => new LocalKeyTlsIdentities([{ ...row, servicePrincipal: uri('controller') }]),
    ).toThrow();
  });
  it.each(['idle', 'unfinished-handshake'])(
    'closes %s at the original deadline with no key work',
    async (kind) => {
      const f = fixture(80);
      let socket: ReturnType<typeof netConnect> | undefined;
      try {
        const address = await f.listening;
        if (!('port' in address)) throw new Error('Owned loopback required');
        if (kind === 'unfinished-handshake') {
          socket = netConnect({ host: address.host, port: address.port });
          socket.on('error', () => {});
          await new Promise<void>((resolve, reject) => {
            socket!.once('connect', resolve);
            socket!.once('error', reject);
          });
        }
        await expect(f.done).rejects.toThrow();
        expect(f.service.wrap).not.toHaveBeenCalled();
        socket?.destroy();
        await expect(
          new Promise<void>((resolve, reject) => {
            const probe = netConnect({ host: address.host, port: address.port });
            probe.once('connect', () => {
              probe.destroy();
              reject(new Error('Owned listener survived'));
            });
            probe.once('error', (error: NodeJS.ErrnoException) => {
              probe.destroy();
              if (error.code === 'ECONNREFUSED') resolve();
              else reject(error);
            });
          }),
        ).resolves.toBeUndefined();
      } finally {
        socket?.destroy();
        f.server.fail();
        await f.done.catch(() => {});
      }
    },
  );
  it('refuses before late async crypto completion, erases inputs and never writes its late secret', async () => {
    const f = fixture();
    let finish: (value: { keyRef: string; wrappedKey: Buffer }) => void = () => {};
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.service.wrap.mockImplementationOnce(async () => {
      entered();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const late = Buffer.alloc(61, 17);
    try {
      const response = raw(await f.listening, 'producer');
      void response.catch(() => {});
      await started;
      f.server.fail();
      await expect(f.done).rejects.toThrow();
      await expect(response).rejects.toThrow();
      const args = f.service.wrap.mock.calls[0]!;
      expect(args[1].every((byte) => byte === 0)).toBe(true);
      expect(args[2].every((byte) => byte === 0)).toBe(true);
      finish({ keyRef, wrappedKey: late });
      await vi.waitFor(() => expect(late.every((byte) => byte === 0)).toBe(true));
      expect(f.service.wrap).toHaveBeenCalledOnce();
    } finally {
      finish({ keyRef, wrappedKey: late });
      f.server.fail();
      await f.done.catch(() => {});
    }
  });
  it('derives original run through trusted lookup after authenticated context, never request claims', async () => {
    const f = fixture();
    try {
      await raw(await f.listening, 'controller', {
        ...request,
        operation: 'unwrap',
        keyRef,
        key: Buffer.alloc(61, 1).toString('base64'),
      });
      await f.done;
      expect(f.resolveAcceptedRun).toHaveBeenCalledOnce();
      expect(f.resolveAcceptedRun.mock.calls[0]?.[3]).toBe(keyRef);
      expect(f.service.unwrap.mock.calls[0]?.[0]).toMatchObject({
        originalRunId: run,
        role: 'controller',
      });
    } finally {
      f.server.fail();
      await f.done.catch(() => {});
    }
  });
});
