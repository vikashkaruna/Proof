import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { Server, ServerCredentials, status, type ServerWritableStream } from '@grpc/grpc-js';
import { SignJWT } from 'jose';
import { afterEach, expect, it } from 'vitest';
import { fetchJwtBundles, type BundleResponse } from './workload-api-protocol.js';
import { WorkloadApiJwtTrust } from './workload-api-trust.js';
import { JwtSvidVerifier, parseWorkloadSpiffeId } from './jwt-svid.js';

const domain = 'local.axiomproof.test';
const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const keys = {
  keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'one', use: 'jwt-svid' }],
};
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
const bundle = () => ({ bundles: { [`spiffe://${domain}`]: encode(keys) } });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture(
  handler?: (call: ServerWritableStream<Record<string, never>, BundleResponse>) => void,
  timeoutMs = 2500,
) {
  const directory = await mkdtemp('/tmp/ax-trust-');
  const socketPath = `${directory}/api.sock`;
  const server = new Server();
  let requests = 0;
  const metadata: unknown[] = [];
  let reply: BundleResponse = bundle();
  server.addService(
    { fetchJwtBundles },
    {
      fetchJwtBundles(call: ServerWritableStream<Record<string, never>, BundleResponse>) {
        requests++;
        metadata.push(call.metadata.get('workload.spiffe.io'));
        if (handler) handler(call);
        else call.write(reply);
      },
    },
  );
  await new Promise<void>((resolve, reject) =>
    server.bindAsync(`unix:${socketPath}`, ServerCredentials.createInsecure(), (error) =>
      error ? reject(error) : resolve(),
    ),
  );
  cleanups.push(async () => {
    server.forceShutdown();
    await rm(directory, { recursive: true, force: true });
  });
  const source = new WorkloadApiJwtTrust({ socketPath, trustDomains: [domain], timeoutMs });
  return {
    source,
    server,
    socketPath,
    metadata,
    requests: () => requests,
    change(value: BundleResponse) {
      reply = value;
    },
  };
}
it('fetches public bundles with required metadata, bound freshness and an independent currentness read', async () => {
  const f = await fixture();
  const before = Date.now();
  const result = await f.source.load(domain);
  expect(result?.jwks).toEqual(keys);
  expect(result?.validUntil).toBeGreaterThan(before);
  expect(result!.validUntil).toBeLessThanOrEqual(Date.now() + 10000);
  expect(result?.revision).toMatch(/^[a-f0-9]{64}$/);
  expect(await f.source.stillCurrent(domain, result!.revision)).toBe(true);
  expect(f.requests()).toBe(2);
  expect(f.metadata).toEqual([['true'], ['true']]);
});
it('composes with the actual JWT verifier and accepts a signed identity', async () => {
  const f = await fixture();
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: 'one' })
    .setSubject(`spiffe://${domain}/agent/parikshan`)
    .setAudience('assessment')
    .setIssuedAt()
    .setExpirationTime('1m')
    .sign(pair.privateKey);
  const verifier = new JwtSvidVerifier(
    { audience: 'assessment', trustDomains: [domain], maxLifetimeSeconds: 300 },
    f.source,
  );
  expect((await verifier.verify(token)).spiffeId).toBe(`spiffe://${domain}/agent/parikshan`);
  expect(f.requests()).toBe(2);
});
it('refuses unknown domains without contacting the socket', async () => {
  const f = await fixture();
  expect(await f.source.load('foreign.test')).toBeNull();
  expect(await f.source.stillCurrent('foreign.test', 'a'.repeat(64))).toBe(false);
  expect(f.requests()).toBe(0);
});
it('refuses a removed bundle instead of retaining a cached copy', async () => {
  const f = await fixture();
  const result = await f.source.load(domain);
  f.change({ bundles: {} });
  expect(await f.source.stillCurrent(domain, result!.revision)).toBe(false);
  expect(await f.source.load(domain)).toBeNull();
});
it('refuses a changed snapshot during validation', async () => {
  const f = await fixture();
  const result = await f.source.load(domain);
  f.change({
    bundles: { [`spiffe://${domain}`]: encode({ keys: [{ ...keys.keys[0], kid: 'rotated' }] }) },
  });
  expect(await f.source.stillCurrent(domain, result!.revision)).toBe(false);
  expect((await f.source.load(domain))?.revision).not.toBe(result!.revision);
});
it('refuses unavailable sockets after a previously successful read', async () => {
  const f = await fixture();
  const result = await f.source.load(domain);
  f.server.forceShutdown();
  expect(await f.source.stillCurrent(domain, result!.revision)).toBe(false);
  expect(await f.source.load(domain)).toBeNull();
});
it('bounds a silent stream and cancels it', async () => {
  let cancelled = false;
  const f = await fixture((call) => {
    call.on('cancelled', () => {
      cancelled = true;
    });
  }, 200);
  const start = Date.now();
  expect(await f.source.load(domain)).toBeNull();
  expect(Date.now() - start).toBeLessThan(1500);
  await new Promise((r) => setTimeout(r, 30));
  expect(cancelled).toBe(true);
});
it('refuses an empty ended stream', async () => {
  const f = await fixture((call) => call.end());
  expect(await f.source.load(domain)).toBeNull();
});
it('sanitizes attestation refusal without exposing transport details', async () => {
  const f = await fixture((call) =>
    call.destroy(
      Object.assign(new Error('private attestation detail'), { code: status.PERMISSION_DENIED }),
    ),
  );
  expect(await f.source.load(domain)).toBeNull();
});
it.each([
  Buffer.from('{'),
  Buffer.from([0xff]),
  encode({ keys: [] }),
  encode({ keys: [{ kty: 'oct', k: 'private' }] }),
  encode({ keys: [{ ...keys.keys[0], d: 'private' }] }),
  Buffer.alloc(128 * 1024 + 1, 32),
])('refuses malformed, private or oversized JWKS without throwing', async (bytes) => {
  const f = await fixture();
  f.change({ bundles: { [`spiffe://${domain}`]: bytes } });
  expect(await f.source.load(domain)).toBeNull();
});
it('bounds the entire protobuf response', async () => {
  const f = await fixture();
  f.change({ bundles: { [`spiffe://${domain}`]: Buffer.alloc(1024 * 1024 + 1) } });
  expect(await f.source.load(domain)).toBeNull();
});
it('does not trust a foreign bundle even when it contains a matching signing key', async () => {
  const f = await fixture();
  f.change({ bundles: { 'spiffe://foreign.test': encode(keys) } });
  expect(await f.source.load(domain)).toBeNull();
});
it('rejects unbounded bundle maps', async () => {
  const f = await fixture();
  f.change({
    bundles: Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => [`spiffe://d${i}.test`, encode(keys)]),
    ),
  });
  expect(await f.source.load(domain)).toBeNull();
});
it.each([
  'http://issuer.test',
  'unix:///tmp/socket',
  '/tmp/../socket',
  '/tmp/socket\n',
  'relative.sock',
])('rejects unsafe endpoint %j', (socketPath) => {
  expect(() => new WorkloadApiJwtTrust({ socketPath, trustDomains: [domain] })).toThrow();
});
it('rejects malformed trust configuration and unknown transport overrides', () => {
  for (const extra of [
    { trustDomains: [domain + '\n'] },
    { trustDomains: [domain, domain] },
    { timeoutMs: 5001 },
    { headers: {} },
  ])
    expect(
      () =>
        new WorkloadApiJwtTrust({
          socketPath: '/run/workload/api.sock',
          trustDomains: [domain],
          ...extra,
        }),
    ).toThrow();
});
it.each(['spiffe://local.test/agent/parikshan\n', 'spiffe://local.test\n/agent/parikshan'])(
  'refuses line terminators in SPIFFE identities',
  (value) => {
    expect(() => parseWorkloadSpiffeId(value)).toThrow();
  },
);

function permutations<T>(values: T[]): T[][] {
  return values.length === 0
    ? [[]]
    : values.flatMap((value, index) =>
        permutations(values.filter((_, selected) => selected !== index)).map((rest) => [
          value,
          ...rest,
        ]),
      );
}
const fourKeys = [
  { ...keys.keys[0]!, alg: 'ES256', key_ops: ['verify'] },
  ...Array.from({ length: 3 }, (_, index) => ({
    ...generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' }),
    kid: `additional-${index}`,
    use: 'jwt-svid',
    alg: 'ES256',
    key_ops: ['verify'],
  })),
];
const fourOrders = permutations(fourKeys);
const permutedBundle = (index: number): BundleResponse => ({
  bundles: {
    [`spiffe://${domain}`]: Buffer.from(
      JSON.stringify(
        {
          keys: fourOrders[index % fourOrders.length]!.map((key) =>
            index % 2 ? Object.fromEntries(Object.entries(key).reverse()) : key,
          ),
        },
        null,
        index % 3,
      ),
    ),
  },
});
it('keeps all 24 permutations of the same four complete public keys current across field order and whitespace', async () => {
  const f = await fixture();
  f.change(permutedBundle(0));
  const initial = await f.source.load(domain);
  expect(initial).not.toBeNull();
  for (let index = 1; index <= fourOrders.length; index++) {
    f.change(permutedBundle(index));
    expect(await f.source.stillCurrent(domain, initial!.revision)).toBe(true);
  }
});
it('verifies actual signatures while SPIRE changes bundle serialization on every fetch', async () => {
  let reads = 0;
  const f = await fixture((call) => call.write(permutedBundle(reads++)));
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: 'one', typ: 'JWT' })
    .setSubject(`spiffe://${domain}/controller/assessment`)
    .setAudience('axiom-controller-startup')
    .setIssuedAt()
    .setExpirationTime('1m')
    .sign(pair.privateKey);
  const verifier = new JwtSvidVerifier(
    { audience: 'axiom-controller-startup', trustDomains: [domain], maxLifetimeSeconds: 300 },
    f.source,
  );
  for (let index = 0; index < 12; index++)
    expect((await verifier.verify(token)).spiffeId).toBe(
      `spiffe://${domain}/controller/assessment`,
    );
  expect(reads).toBe(24);
});
it.each([
  ['removed key', fourKeys.slice(1)],
  ['new key', [...fourKeys, { ...fourKeys[0]!, kid: 'new-key' }]],
  ['changed material', fourKeys.map((key, index) => (index ? key : { ...key, x: fourKeys[1]!.x }))],
  ['changed kid', fourKeys.map((key, index) => (index ? key : { ...key, kid: 'changed' }))],
  ['changed use', fourKeys.map((key, index) => (index ? key : { ...key, use: 'sig' }))],
  ['changed algorithm', fourKeys.map((key, index) => (index ? key : { ...key, alg: 'ES384' }))],
  [
    'removed metadata',
    fourKeys.map((key, index) =>
      index
        ? key
        : Object.fromEntries(Object.entries(key).filter(([field]) => field !== 'key_ops')),
    ),
  ],
  ['identical duplicate multiplicity', [...fourKeys, fourKeys[0]!]],
])('invalidates %s despite otherwise equivalent serialization', async (_label, changed) => {
  const f = await fixture();
  f.change(permutedBundle(0));
  const original = await f.source.load(domain);
  f.change({ bundles: { [`spiffe://${domain}`]: encode({ keys: changed }) } });
  const current = await f.source.load(domain);
  expect(current).not.toBeNull();
  expect(current!.revision).not.toBe(original!.revision);
  expect(await f.source.stillCurrent(domain, original!.revision)).toBe(false);
});
it('preserves identical duplicate entries without deduplicating or changing their count', async () => {
  const f = await fixture();
  const duplicate = [fourKeys[0]!, fourKeys[0]!, fourKeys[1]!];
  f.change({ bundles: { [`spiffe://${domain}`]: encode({ keys: duplicate }) } });
  const initial = await f.source.load(domain);
  expect(initial?.jwks).toEqual({ keys: duplicate });
  f.change({ bundles: { [`spiffe://${domain}`]: encode({ keys: [...duplicate].reverse() }) } });
  expect(await f.source.stillCurrent(domain, initial!.revision)).toBe(true);
});
it.each([
  { ...fourKeys[1]!, kid: 'one' },
  { ...fourKeys[0]!, use: 'sig' },
  { ...fourKeys[0]!, alg: 'ES384' },
])(
  'refuses conflicting duplicate kid metadata or material without trusting a partial set',
  async (conflict) => {
    const f = await fixture();
    f.change({ bundles: { [`spiffe://${domain}`]: encode({ keys: [fourKeys[0]!, conflict] }) } });
    expect(await f.source.load(domain)).toBeNull();
  },
);
it.each([
  { keys: fourKeys, issuer: 'unexpected metadata' },
  { keys: [{ ...fourKeys[0]!, unknown: true }] },
  { keys: [{ ...fourKeys[0]!, key_ops: ['sign'] }] },
])('retains strict rejection of unsupported top-level and public-key metadata', async (value) => {
  const f = await fixture();
  f.change({ bundles: { [`spiffe://${domain}`]: encode(value) } });
  expect(await f.source.load(domain)).toBeNull();
});
