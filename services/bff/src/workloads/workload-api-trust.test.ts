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
  const source = new WorkloadApiJwtTrust({ socketPath, trustDomains: [domain], timeoutMs: 200 });
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
  });
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
