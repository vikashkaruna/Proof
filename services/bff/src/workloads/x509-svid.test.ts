import { EventEmitter } from 'node:events';
import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { prepareX509Material, X509Refused, type X509Material } from './x509-svid.js';
import { WorkloadApiX509Source, type OpenX509Stream } from './workload-api-x509.js';
import {
  fetchX509Svid,
  fetchJwtBundles,
  fetchJwtSvid,
  type X509SvidResponse,
} from './workload-api-protocol.js';

const grpc = vi.hoisted(() => ({ construct: vi.fn(), request: vi.fn(), close: vi.fn() }));
vi.mock('@grpc/grpc-js', () => ({
  Client: class {
    constructor(...args: unknown[]) {
      grpc.construct(...args);
    }
    makeServerStreamRequest(...args: unknown[]) {
      return grpc.request(...args);
    }
    close() {
      grpc.close();
    }
  },
  credentials: { createInsecure: () => 'owned-unix-only' },
  Metadata: class extends Map<string, string> {},
}));

const identity = 'spiffe://local.axiomproof.test/controller/assessment';
let directory: string;
let serial = 1;
const keys = new Map<string, Buffer>();
function key(name: string) {
  const generated = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
  writeFileSync(
    join(directory, name + '.key'),
    generated.export({ format: 'pem', type: 'pkcs8' }),
    { mode: 0o600 },
  );
  keys.set(name, Buffer.from(generated.export({ format: 'der', type: 'pkcs8' })));
}
function openssl(args: string[]) {
  execFileSync('openssl', args, { cwd: directory, stdio: 'ignore', timeout: 10000 });
}
function sign(name: string, issuer: string, extensions: string) {
  key(name);
  openssl([
    'req',
    '-new',
    '-key',
    name + '.key',
    '-subj',
    '/CN=Owned synthetic fixture',
    '-out',
    name + '.csr',
  ]);
  writeFileSync(join(directory, name + '.ext'), extensions, { mode: 0o600 });
  openssl([
    'x509',
    '-req',
    '-in',
    name + '.csr',
    '-CA',
    issuer + '.pem',
    '-CAkey',
    issuer + '.key',
    '-set_serial',
    String(serial++),
    '-days',
    '1',
    '-extfile',
    name + '.ext',
    '-out',
    name + '.pem',
  ]);
}
function der(name: string) {
  return new X509Certificate(readFileSync(join(directory, name + '.pem'))).raw;
}
const extensions = (san = `URI:${identity}`, purpose = 'clientAuth,serverAuth') =>
  `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=${purpose}\nsubjectAltName=${san}\n`;
function reply(name = 'leaf'): X509SvidResponse {
  return {
    svids: [
      {
        spiffeId: identity,
        x509Svid: Buffer.concat([der(name), der('intermediate')]),
        x509SvidKey: Buffer.from(keys.get(name)!),
        bundle: der('root'),
      },
    ],
    crl: [],
    federatedBundles: {},
  };
}
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'axiom-x509-'));
  key('root');
  key('foreign');
  key('expired-root');
  for (const name of ['root', 'foreign', 'expired-root'])
    openssl([
      'req',
      '-new',
      '-x509',
      '-key',
      name + '.key',
      '-subj',
      '/CN=' + name,
      '-days',
      '2',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
      '-out',
      name + '.pem',
    ]);
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
  sign(
    'intermediate',
    'root',
    'basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n',
  );
  openssl([
    'x509',
    '-req',
    '-in',
    'intermediate.csr',
    '-CA',
    'root.pem',
    '-CAkey',
    'root.key',
    '-set_serial',
    String(serial++),
    '-days',
    '0',
    '-extfile',
    'intermediate.ext',
    '-out',
    'expired-intermediate.pem',
  ]);
  writeFileSync(join(directory, 'future-index.txt'), '', { mode: 0o600 });
  writeFileSync(join(directory, 'future-serial.txt'), '1000\n', { mode: 0o600 });
  writeFileSync(
    join(directory, 'future-ca.cnf'),
    '[ca]\ndefault_ca=owned\n[owned]\ndatabase=future-index.txt\nserial=future-serial.txt\nnew_certs_dir=.\ncertificate=root.pem\nprivate_key=root.key\ndefault_md=sha256\npolicy=policy\n[policy]\ncommonName=supplied\n[authority]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n',
    { mode: 0o600 },
  );
  const futureDate = (delta: number) =>
    new Date(Date.now() + delta).toISOString().replace(/\D/g, '').slice(0, 14) + 'Z';
  openssl([
    'ca',
    '-config',
    'future-ca.cnf',
    '-batch',
    '-notext',
    '-in',
    'intermediate.csr',
    '-startdate',
    futureDate(86400000),
    '-enddate',
    futureDate(172800000),
    '-extensions',
    'authority',
    '-out',
    'future-root.pem',
  ]);
  sign('leaf', 'intermediate', extensions());
  sign('rotated', 'intermediate', extensions());
  sign('wrong-san', 'intermediate', extensions('URI:spiffe://foreign.test/controller/assessment'));
  sign('mixed-san', 'intermediate', extensions(`URI:${identity},DNS:example.test`));
  sign('server-only', 'intermediate', extensions(`URI:${identity}`, 'serverAuth'));
});
afterAll(() => {
  for (const value of keys.values()) value.fill(0);
  rmSync(directory, { recursive: true, force: true });
});
afterEach(() => vi.useRealTimers());

describe('bounded material, explicitly not peer PKIX authority', () => {
  it('verifies real generated intermediate chain, private-key match, exact URI and both purposes', () => {
    const input = reply();
    const original = Buffer.from(input.svids[0]!.x509SvidKey);
    for (const purpose of ['client', 'server'] as const) {
      const material = prepareX509Material(input, identity, purpose, Date.now());
      expect(material.spiffeId).toBe(identity);
      expect(material.revision).toMatch(/^[a-f0-9]{64}$/);
      expect(material.certificateExpiresAt).toBeGreaterThan(Date.now());
      expect(material.chainPem.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
      expect(material.bundlePem.match(/BEGIN CERTIFICATE/g)).toHaveLength(1);
      material.privateKeyDer.fill(0);
      expect(input.svids[0]!.x509SvidKey).toEqual(original);
    }
  });
  it.each(['wrong-san', 'mixed-san', 'server-only'])('rejects %s for client use', (name) => {
    expect(() => prepareX509Material(reply(name), identity, 'client', Date.now())).toThrow(
      X509Refused,
    );
  });
  it('accepts server-only purpose only for server material', () => {
    const material = prepareX509Material(reply('server-only'), identity, 'server', Date.now());
    material.privateKeyDer.fill(0);
  });
  it('rejects wrong key, missing intermediate, foreign anchor, corrupt signature and leaf-as-anchor', () => {
    const cases: X509SvidResponse[] = [];
    const wrongKey = reply();
    wrongKey.svids[0]!.x509SvidKey = Buffer.from(keys.get('rotated')!);
    cases.push(wrongKey);
    const missing = reply();
    missing.svids[0]!.x509Svid = der('leaf');
    cases.push(missing);
    const foreign = reply();
    foreign.svids[0]!.bundle = der('foreign');
    cases.push(foreign);
    const corrupt = reply();
    corrupt.svids[0]!.x509Svid[der('leaf').length - 1]! ^= 1;
    cases.push(corrupt);
    const anchor = reply();
    anchor.svids[0]!.bundle = der('leaf');
    cases.push(anchor);
    for (const value of cases)
      expect(() => prepareX509Material(value, identity, 'client', Date.now())).toThrow(
        'X509 workload material refused',
      );
  });
  it('uses current anchors while binding the complete rotated bundle revision', () => {
    const baseline = prepareX509Material(reply(), identity, 'client', Date.now());
    const input = reply();
    input.svids[0]!.bundle = Buffer.concat([der('expired-root'), der('root'), der('future-root')]);
    const material = prepareX509Material(input, identity, 'client', Date.now());
    try {
      expect(material.bundlePem).toBe(baseline.bundlePem);
      expect(material.bundlePem.match(/BEGIN CERTIFICATE/g)).toHaveLength(1);
      expect(material.certificateExpiresAt).toBe(baseline.certificateExpiresAt);
      expect(material.revision).not.toBe(baseline.revision);
      expect(material.certificateExpiresAt).toBeGreaterThan(Date.now());
    } finally {
      baseline.privateKeyDer.fill(0);
      material.privateKeyDer.fill(0);
    }
  });
  it.each(['expired-root', 'future-root', 'foreign'])(
    'refuses a bundle with only %s and no matching current anchor',
    (name) => {
      const input = reply();
      input.svids[0]!.bundle = der(name);
      expect(() => prepareX509Material(input, identity, 'client', Date.now())).toThrow(X509Refused);
    },
  );
  it('still parses, bounds and deduplicates inactive bundle entries and requires every entry to be a CA', () => {
    for (const suffix of [der('expired-root'), der('leaf'), Buffer.from([0x30, 0x80, 0, 0])]) {
      const input = reply();
      input.svids[0]!.bundle = Buffer.concat([der('root'), der('expired-root'), suffix]);
      expect(() => prepareX509Material(input, identity, 'client', Date.now())).toThrow(X509Refused);
    }
  });
  it('refuses an expired intermediate even with a matching current root', () => {
    const input = reply();
    input.svids[0]!.x509Svid = Buffer.concat([der('leaf'), der('expired-intermediate')]);
    expect(
      new X509Certificate(der('expired-intermediate')).validToDate.getTime(),
    ).toBeLessThanOrEqual(Date.now());
    expect(() => prepareX509Material(input, identity, 'client', Date.now())).toThrow(X509Refused);
  });
  it('rejects trailing and concatenated PKCS8 DER even when Node accepts its first key', () => {
    for (const suffix of [Buffer.from([0]), keys.get('leaf')!]) {
      const input = reply();
      input.svids[0]!.x509SvidKey = Buffer.concat([input.svids[0]!.x509SvidKey, suffix]);
      expect(() => prepareX509Material(input, identity, 'client', Date.now())).toThrow(X509Refused);
    }
  });
  it('rejects not-yet-valid/expired chains and changed expected identity', () => {
    const leaf = new X509Certificate(der('leaf'));
    for (const now of [Date.parse(leaf.validFrom) - 1, Date.parse(leaf.validTo)])
      expect(() => prepareX509Material(reply(), identity, 'client', now)).toThrow(X509Refused);
    expect(() =>
      prepareX509Material(
        reply(),
        'spiffe://local.axiomproof.test/service/assessment-dispatch-producer',
        'client',
        Date.now(),
      ),
    ).toThrow(X509Refused);
  });
  it('rejects unsupported CRL/federation, extra identities/keys and malformed bounded DER', () => {
    const cases: unknown[] = [
      { ...reply(), crl: [Buffer.from('revocations')] },
      { ...reply(), federatedBundles: { 'spiffe://foreign.test': der('foreign') } },
      { ...reply(), unknown: 'private-secret-must-not-echo' },
    ];
    const multiple = reply();
    multiple.svids.push(reply().svids[0]!);
    cases.push(multiple);
    for (const value of [
      Buffer.concat([der('leaf'), Buffer.from([0])]),
      Buffer.from([0x30, 0x80, 0, 0]),
      Buffer.alloc(128 * 1024 + 1),
      Buffer.concat(Array.from({ length: 9 }, () => der('leaf'))),
    ]) {
      const bad = reply();
      bad.svids[0]!.x509Svid = value;
      cases.push(bad);
    }
    for (const value of cases)
      expect(() => prepareX509Material(value, identity, 'client', Date.now())).toThrow(
        /^X509 workload material refused$/,
      );
  });
});

function sourceFixture(health = vi.fn(async (): Promise<number | null> => Date.now() + 10000)) {
  let emit: (value: unknown) => void = () => {};
  let fail = () => {};
  const close = vi.fn();
  const open: OpenX509Stream = vi.fn((_path, _deadline, data, unavailable) => {
    emit = data;
    fail = unavailable;
    queueMicrotask(() => emit(reply()));
    return { close };
  });
  return {
    source: new WorkloadApiX509Source(
      { socketPath: '/run/workload/api.sock', spiffeId: identity, purpose: 'client' },
      { domain: 'local.axiomproof.test', validUntil: health },
      open,
    ),
    emit: (value: unknown) => emit(value),
    fail: () => fail(),
    close,
    health,
    open,
  };
}
describe('fixed source lease without a server or network', () => {
  it('uses a bounded explicit original lease and erases held/received keys', async () => {
    const f = sourceFixture();
    let held: X509Material | undefined;
    const result = await f.source.withSnapshot(Date.now() + 1000, async (material, lease) => {
      held = material;
      expect(lease.validUntil).toBeLessThanOrEqual(Date.now() + 1000);
      expect(lease.epoch).toBeGreaterThan(0);
      return 'qualified-material-only';
    });
    expect(result).toBe('qualified-material-only');
    expect(held!.privateKeyDer.every((b) => b === 0)).toBe(true);
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.health).toHaveBeenCalledTimes(2);
    const late = reply();
    f.emit(late);
    expect(late.svids[0]!.x509SvidKey.every((b) => b === 0)).toBe(true);
  });
  it.each(['rotation', 'end', 'malformed', 'stale-health'])(
    'withholds result after %s',
    async (failure) => {
      const f = sourceFixture();
      await expect(
        f.source.withSnapshot(Date.now() + 1000, async () => {
          if (failure === 'rotation') f.emit(reply('rotated'));
          if (failure === 'end') f.fail();
          if (failure === 'malformed') f.emit({});
          if (failure === 'stale-health') f.health.mockResolvedValueOnce(null);
          return 'must-be-withheld';
        }),
      ).rejects.toThrow(X509Refused);
      expect(f.close).toHaveBeenCalledOnce();
    },
  );
  it('invalidates the pinned epoch when only an unused expired bundle anchor changes', async () => {
    const f = sourceFixture();
    await expect(
      f.source.withSnapshot(Date.now() + 1000, async () => {
        const rotated = reply();
        rotated.svids[0]!.bundle = Buffer.concat([der('root'), der('expired-root')]);
        f.emit(rotated);
        return 'withheld after bundle rotation';
      }),
    ).rejects.toThrow(X509Refused);
    expect(f.close).toHaveBeenCalledOnce();
  });
  it('rejects 65 identities before inspecting entries and wipes every received key', async () => {
    const f = sourceFixture();
    const entries = Array.from({ length: 65 }, () => reply().svids[0]!);
    const receivedKeys = entries.map((entry) => entry.x509SvidKey);
    const parseEntry = vi.fn(() => identity);
    Object.defineProperty(entries[0]!, 'spiffeId', { get: parseEntry });
    await expect(
      f.source.withSnapshot(Date.now() + 1000, async () => {
        f.emit({ ...reply(), svids: entries });
        return 'withheld';
      }),
    ).rejects.toThrow(X509Refused);
    expect(parseEntry).not.toHaveBeenCalled();
    expect(receivedKeys.every((key) => key.every((byte) => byte === 0))).toBe(true);
  });
  it('pins the first accepted epoch before await and refuses concurrent A-B-A before work', async () => {
    const streams: Array<{ data: (value: unknown) => void; fail: () => void }> = [];
    const open: OpenX509Stream = (_path, _deadline, data, fail) => {
      streams.push({ data, fail });
      if (streams.length === 3) {
        data(reply());
        streams[0]!.data(reply('rotated'));
        streams[1]!.data(reply());
      }
      return { close: vi.fn() };
    };
    const source = new WorkloadApiX509Source(
      { socketPath: '/run/workload/api.sock', spiffeId: identity, purpose: 'client' },
      { domain: 'local.axiomproof.test', validUntil: async () => Date.now() + 10000 },
      open,
    );
    const waiting = [0, 1].map(() =>
      source.withSnapshot(Date.now() + 1000, async () => 'irrelevant').catch(() => 'refused'),
    );
    await vi.waitFor(() => expect(streams).toHaveLength(2));
    const work = vi.fn(async () => 'must-not-release');
    await expect(source.withSnapshot(Date.now() + 1000, work)).rejects.toThrow(X509Refused);
    expect(work).not.toHaveBeenCalled();
    for (const stream of streams) stream.fail();
    await Promise.all(waiting);
  });
  it('publishes once only after final health checks and while the stream is held', async () => {
    const f = sourceFixture();
    const events: string[] = [];
    f.health.mockImplementation(async () => {
      events.push('health');
      return Date.now() + 10000;
    });
    const result = await f.source.withPublication(
      Date.now() + 1000,
      async () => {
        events.push('prepare');
        return 'owned';
      },
      (value) => {
        expect(value).toBe('owned');
        expect(f.close).not.toHaveBeenCalled();
        events.push('publish');
      },
      async () => {
        events.push('receive');
        return 'received';
      },
    );
    expect(result).toBe('received');
    expect(events).toEqual(['health', 'prepare', 'health', 'publish', 'receive', 'health']);
    expect(f.close).toHaveBeenCalledOnce();
  });
  it.each(['health', 'rotation', 'stream'])(
    'refuses publication if %s changes during the final read',
    async (kind) => {
      const f = sourceFixture();
      const publish = vi.fn();
      let calls = 0;
      f.health.mockImplementation(async () => {
        if (++calls === 2) {
          if (kind === 'health') return null;
          if (kind === 'rotation') f.emit(reply('rotated'));
          if (kind === 'stream') f.fail();
        }
        return Date.now() + 10000;
      });
      await expect(
        f.source.withPublication(
          Date.now() + 1000,
          async () => 'withheld',
          publish,
          async () => 'no',
        ),
      ).rejects.toThrow(X509Refused);
      expect(publish).not.toHaveBeenCalled();
      expect(f.close).toHaveBeenCalledOnce();
    },
  );
  it('pins a shortened final health window through receive instead of renewing it', async () => {
    vi.useFakeTimers();
    const now = Date.now(),
      f = sourceFixture();
    let reads = 0;
    f.health.mockImplementation(async () => (++reads === 2 ? now + 20 : now + 10000));
    const publish = vi.fn((_value: string, lease: Readonly<{ validUntil: number }>) => {
      expect(lease.validUntil).toBe(now + 20);
      return undefined;
    });
    await expect(
      f.source.withPublication(
        now + 1000,
        async () => 'owned',
        publish,
        async () => {
          vi.setSystemTime(now + 21);
          return 'too-late';
        },
      ),
    ).rejects.toThrow(X509Refused);
    expect(publish).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
  });
  it('refuses a dynamically malformed async publisher and never enters receive', async () => {
    const f = sourceFixture(),
      receive = vi.fn(async () => 'must-not-release');
    const asyncPublisher = async () => {};
    // This trusted-port misuse is also statically refused, rather than accepted
    // through TypeScript's special void callback assignment rule.
    // @ts-expect-error Promise<void> is not synchronous undefined.
    const publisher: (value: string) => undefined = asyncPublisher;
    await expect(
      f.source.withPublication(Date.now() + 1000, async () => 'owned', publisher, receive),
    ).rejects.toThrow(X509Refused);
    expect(receive).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledOnce();
  });
  it('observes a rejected native Promise from a malformed publisher before refusing misuse', async () => {
    const f = sourceFixture(),
      receive = vi.fn(async () => 'must-not-release');
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const rejectedPublisher = () => Promise.reject(new Error('Owned async publisher bug'));
      // @ts-expect-error A native Promise is not an allowed synchronous writer.
      const publisher: () => undefined = rejectedPublisher;
      await expect(
        f.source.withPublication(Date.now() + 1000, async () => 'owned', publisher, receive),
      ).rejects.toThrow(X509Refused);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect(receive).not.toHaveBeenCalled();
      expect(f.close).toHaveBeenCalledOnce();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
  it('withholds received result after post-send health loss without repeating publication', async () => {
    const f = sourceFixture();
    const publish = vi.fn();
    await expect(
      f.source.withPublication(
        Date.now() + 1000,
        async () => 'sent',
        publish,
        async () => {
          f.health.mockResolvedValue(null);
          return 'received-but-stale';
        },
      ),
    ).rejects.toThrow(X509Refused);
    expect(publish).toHaveBeenCalledOnce();
  });
  it('refuses absent health before touching Workload API and rejects oversized deadline', async () => {
    const f = sourceFixture(vi.fn(async () => 0));
    await expect(f.source.withSnapshot(Date.now() + 1000, async () => 'no')).rejects.toThrow(
      X509Refused,
    );
    expect(f.open).not.toHaveBeenCalled();
    await expect(f.source.withSnapshot(Date.now() + 10000, async () => 'no')).rejects.toThrow(
      X509Refused,
    );
  });
  it('aborts cooperative work at original deadline and closes stream', async () => {
    const f = sourceFixture();
    let aborted = false;
    await expect(
      f.source.withSnapshot(
        Date.now() + 30,
        async (_material, _lease, signal) =>
          new Promise((resolve) =>
            signal.addEventListener(
              'abort',
              () => {
                aborted = true;
                resolve('late');
              },
              { once: true },
            ),
          ),
      ),
    ).rejects.toThrow(X509Refused);
    expect(aborted).toBe(true);
    expect(f.close).toHaveBeenCalledOnce();
  });
  it('rejects foreign health domain and does not renew the original health window', async () => {
    expect(
      () =>
        new WorkloadApiX509Source(
          { socketPath: '/run/workload/api.sock', spiffeId: identity, purpose: 'client' },
          { domain: 'foreign.test', validUntil: async () => Date.now() + 10000 },
        ),
    ).toThrow(X509Refused);
    vi.useFakeTimers();
    const now = Date.now();
    const health = vi.fn(async (): Promise<number | null> => now + 1000);
    const f = sourceFixture(health);
    await expect(
      f.source.withSnapshot(now + 2000, async () => {
        health.mockResolvedValueOnce(now + 10000);
        vi.setSystemTime(now + 1001);
        return 'expired-original-window';
      }),
    ).rejects.toThrow(X509Refused);
    expect(f.close).toHaveBeenCalledOnce();
  });
  it('bounds a missing first snapshot and a never-settling health read', async () => {
    const open = vi.fn(() => ({ close: vi.fn() }));
    const f = new WorkloadApiX509Source(
      { socketPath: '/run/workload/api.sock', spiffeId: identity, purpose: 'client' },
      { domain: 'local.axiomproof.test', validUntil: async () => Date.now() + 10000 },
      open,
    );
    await expect(f.withSnapshot(Date.now() + 20, async () => 'no')).rejects.toThrow(X509Refused);
    expect(open.mock.results[0]!.value.close).toHaveBeenCalledOnce();
    const missingHealth = new WorkloadApiX509Source(
      { socketPath: '/run/workload/api.sock', spiffeId: identity, purpose: 'client' },
      { domain: 'local.axiomproof.test', validUntil: () => new Promise(() => {}) },
      open,
    );
    await expect(missingHealth.withSnapshot(Date.now() + 20, async () => 'no')).rejects.toThrow(
      X509Refused,
    );
    expect(open).toHaveBeenCalledOnce();
  });
  it('uses the fixed default gRPC wire configuration and closes its owned client/stream', async () => {
    const stream = Object.assign(new EventEmitter(), { cancel: vi.fn() });
    grpc.construct.mockClear();
    grpc.close.mockClear();
    grpc.request.mockImplementation(() => {
      queueMicrotask(() => stream.emit('data', reply()));
      return stream;
    });
    const source = new WorkloadApiX509Source(
      { socketPath: '/run/workload/api.sock', spiffeId: identity, purpose: 'client' },
      { domain: 'local.axiomproof.test', validUntil: async () => Date.now() + 10000 },
    );
    await expect(source.withSnapshot(Date.now() + 1000, async () => 'material-only')).resolves.toBe(
      'material-only',
    );
    expect(grpc.construct.mock.calls.at(-1)![0]).toBe('unix:/run/workload/api.sock');
    expect(grpc.construct.mock.calls.at(-1)![2]).toMatchObject({
      'grpc.enable_http_proxy': 0,
      'grpc.enable_retries': 0,
      'grpc.max_receive_message_length': 1024 * 1024,
    });
    expect(grpc.request.mock.calls.at(-1)![0]).toBe('/SpiffeWorkloadAPI/FetchX509SVID');
    expect(
      (grpc.request.mock.calls.at(-1)![4] as Map<string, string>).get('workload.spiffe.io'),
    ).toBe('true');
    expect(stream.cancel).toHaveBeenCalledOnce();
    expect(grpc.close).toHaveBeenCalledOnce();
  });
  it('closes a default client when stream creation throws without exposing its detail', async () => {
    grpc.close.mockClear();
    grpc.request.mockImplementationOnce(() => {
      throw Error('private-transport-detail');
    });
    const source = new WorkloadApiX509Source(
      { socketPath: '/run/workload/api.sock', spiffeId: identity, purpose: 'client' },
      { domain: 'local.axiomproof.test', validUntil: async () => Date.now() + 10000 },
    );
    await expect(source.withSnapshot(Date.now() + 1000, async () => 'no')).rejects.toThrow(
      /^X509 workload material refused$/,
    );
    expect(grpc.close).toHaveBeenCalledOnce();
  });
  it('zeroes held keys and sanitizes errors even when stream cleanup throws', async () => {
    const f = sourceFixture();
    let held: X509Material | undefined;
    f.close.mockImplementationOnce(() => {
      throw Error('private-close-detail');
    });
    await expect(
      f.source.withSnapshot(Date.now() + 1000, async (material) => {
        held = material;
        return 'no';
      }),
    ).rejects.toThrow(/^X509 workload material refused$/);
    expect(held!.privateKeyDer.every((b) => b === 0)).toBe(true);
    const stream = Object.assign(new EventEmitter(), {
      cancel: vi.fn(() => {
        throw Error('private-cancel-detail');
      }),
    });
    grpc.close.mockClear();
    grpc.request.mockImplementationOnce(() => {
      queueMicrotask(() => stream.emit('data', reply()));
      return stream;
    });
    const source = new WorkloadApiX509Source(
      { socketPath: '/run/workload/api.sock', spiffeId: identity, purpose: 'client' },
      { domain: 'local.axiomproof.test', validUntil: async () => Date.now() + 10000 },
    );
    await expect(source.withSnapshot(Date.now() + 1000, async () => 'no')).rejects.toThrow(
      /^X509 workload material refused$/,
    );
    expect(grpc.close).toHaveBeenCalledOnce();
  });
  it('pins protobuf field numbers and leaves existing JWT method contracts unchanged', () => {
    const value = {
      svids: [
        {
          spiffeId: 's',
          x509Svid: Buffer.from('a'),
          x509SvidKey: Buffer.from('b'),
          bundle: Buffer.from('c'),
        },
      ],
      crl: [],
      federatedBundles: {},
    };
    const bytes = fetchX509Svid.responseSerialize(value);
    expect(bytes.toString('hex')).toBe('0a0c0a01731201611a0162220163');
    expect(fetchX509Svid.responseDeserialize(bytes)).toEqual(value);
    expect(fetchX509Svid.path).toBe('/SpiffeWorkloadAPI/FetchX509SVID');
    expect(fetchX509Svid.responseStream).toBe(true);
    expect(fetchJwtBundles.path).toBe('/SpiffeWorkloadAPI/FetchJWTBundles');
    expect(fetchJwtBundles.responseStream).toBe(true);
    expect(fetchJwtSvid.path).toBe('/SpiffeWorkloadAPI/FetchJWTSVID');
    expect(fetchJwtSvid.responseStream).toBe(false);
  });
});
