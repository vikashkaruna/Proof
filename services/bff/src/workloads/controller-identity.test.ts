import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import {
  Server,
  ServerCredentials,
  status,
  type ServerUnaryCall,
  type sendUnaryData,
  type ServerWritableStream,
} from '@grpc/grpc-js';
import { SignJWT } from 'jose';
import { afterEach, expect, it } from 'vitest';
import { requireControllerIdentity } from './controller-identity.js';
import { WorkloadApiJwtTrust } from './workload-api-trust.js';
import {
  fetchJwtSvid,
  fetchJwtBundles,
  type SvidRequest,
  type SvidResponse,
  type BundleResponse,
} from './workload-api-protocol.js';
const domain = 'local.axiomproof.test';
const expected = `spiffe://${domain}/controller/assessment`;
const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const keys = {
  keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'one', use: 'jwt-svid' }],
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function token(overrides: Record<string, unknown> = {}, wrongKey = false) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: expected,
    aud: 'axiom-controller-startup',
    iat: now,
    exp: now + 60,
    ...overrides,
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'one' })
    .sign(
      wrongKey
        ? generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
        : pair.privateKey,
    );
}
async function fixture(reply?: SvidResponse, mode?: 'hang' | 'deny' | 'rotate') {
  const directory = await mkdtemp('/tmp/ax-role-');
  const socketPath = `${directory}/api.sock`;
  const server = new Server();
  const requests: SvidRequest[] = [];
  const metadata: unknown[] = [];
  let bundleReads = 0;
  const response = reply ?? { svids: [{ spiffeId: expected, svid: await token() }] };
  server.addService(
    { fetchJwtSvid, fetchJwtBundles },
    {
      fetchJwtSvid(
        call: ServerUnaryCall<SvidRequest, SvidResponse>,
        done: sendUnaryData<SvidResponse>,
      ) {
        requests.push(call.request);
        metadata.push(call.metadata.get('workload.spiffe.io'));
        if (mode === 'hang') return;
        if (mode === 'deny') {
          done({ code: status.PERMISSION_DENIED, details: 'private transport detail' });
          return;
        }
        done(null, response);
      },
      fetchJwtBundles(call: ServerWritableStream<Record<string, never>, BundleResponse>) {
        bundleReads++;
        call.write({
          bundles:
            mode === 'rotate' && bundleReads > 1
              ? {}
              : { [`spiffe://${domain}`]: Buffer.from(JSON.stringify(keys)) },
        });
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
  const trust = new WorkloadApiJwtTrust({ socketPath, trustDomains: [domain], timeoutMs: 250 });
  return {
    server,
    requests,
    metadata,
    reads: () => bundleReads,
    check: () =>
      requireControllerIdentity({ socketPath, trustDomain: domain, timeoutMs: 250 }, trust),
  };
}
it('requires the exact controller SVID and independently current signature trust over Unix gRPC', async () => {
  const f = await fixture();
  expect(await f.check()).toBeUndefined();
  expect(f.requests).toEqual([{ audience: ['axiom-controller-startup'], spiffeId: expected }]);
  expect(f.metadata).toEqual([['true']]);
  expect(f.reads()).toBe(2);
});
it.each([
  'sub',
  'aud',
  'expired',
  'future',
  'long',
  'signature',
  'malformed',
  'envelope',
  'empty',
  'ambiguous',
])('refuses %s without exposing the bearer', async (failure) => {
  const now = Math.floor(Date.now() / 1000);
  const overrides: Record<string, Record<string, unknown>> = {
    sub: { sub: `spiffe://${domain}/agent/parikshan` },
    aud: { aud: 'axiom-assessment-tools' },
    expired: { iat: now - 60, exp: now - 1 },
    future: { iat: now + 30, exp: now + 60 },
    long: { exp: now + 600 },
  };
  const svid =
    failure === 'malformed'
      ? 'private-not-a-jwt'
      : await token(overrides[failure], failure === 'signature');
  const entry = {
    spiffeId: failure === 'envelope' ? `spiffe://${domain}/agent/parikshan` : expected,
    svid,
  };
  const f = await fixture({
    svids: failure === 'empty' ? [] : failure === 'ambiguous' ? [entry, entry] : [entry],
  });
  await expect(f.check()).rejects.toThrow(/^Controller workload identity refused$/);
});
it.each(['deny', 'hang', 'rotate'] as const)('refuses %s without fallback', async (mode) => {
  const f = await fixture(undefined, mode);
  await expect(f.check()).rejects.toThrow(/^Controller workload identity refused$/);
});
it('refuses an unavailable socket without cached startup authority', async () => {
  const f = await fixture();
  await f.check();
  f.server.forceShutdown();
  await expect(f.check()).rejects.toThrow(/^Controller workload identity refused$/);
});
