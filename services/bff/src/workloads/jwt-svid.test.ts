import { constants, generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JwtSvidVerifier, WorkloadIdentityRefused, type JwtTrustSource } from './jwt-svid.js';
const config = {
  audience: 'axiom-credential-broker',
  trustDomains: ['local.axiomproof.test'],
  maxLifetimeSeconds: 300,
};
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
function token(
  claims: Record<string, unknown> = {},
  headers: Record<string, unknown> = {},
  key = ec.privateKey,
) {
  const now = Math.floor(Date.now() / 1000);
  const hdr = { alg: 'ES256', kid: 'current', typ: 'JWT', ...headers };
  const input =
    encode(hdr) +
    '.' +
    encode({
      sub: 'spiffe://local.axiomproof.test/agent/drishti',
      aud: [config.audience],
      iat: now,
      exp: now + 300,
      ...claims,
    });
  return (
    input +
    '.' +
    sign('sha' + String(hdr.alg).slice(-3), Buffer.from(input), {
      key,
      dsaEncoding: 'ieee-p1363',
      ...(String(hdr.alg).startsWith('PS')
        ? { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }
        : {}),
    }).toString('base64url')
  );
}
function fixture() {
  const bundle = {
    revision: 'current',
    validUntil: Date.now() + 600000,
    jwks: {
      keys: [{ ...ec.publicKey.export({ format: 'jwk' }), kid: 'current', use: 'jwt-svid' }],
    },
  };
  const trust = {
    load: vi.fn<JwtTrustSource['load']>(async () => bundle),
    stillCurrent: vi.fn(async () => true),
  };
  return { bundle, trust, verifier: new JwtSvidVerifier(config, trust) };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe('JWT-SVID identity verification', () => {
  it('verifies signatures and returns only immutable identity metadata, ignoring claimed authority', async () => {
    const f = fixture();
    const identity = await f.verifier.verify(
      token({
        scope: 'connector.write',
        agent: 'karya',
        tenantId: 'untrusted',
        act: { sub: 'untrusted' },
      }),
    );
    expect(identity).toEqual({
      spiffeId: 'spiffe://local.axiomproof.test/agent/drishti',
      trustDomain: 'local.axiomproof.test',
      audience: config.audience,
      expiresAt: expect.any(Number),
      bundleRevision: 'current',
    });
    expect(Object.isFrozen(identity)).toBe(true);
    expect(f.trust.stillCurrent).toHaveBeenCalledWith('local.axiomproof.test', 'current');
  });
  it('defaults to refusing every identity without a configured trusted source', async () => {
    await expect(new JwtSvidVerifier(config).verify(token())).rejects.toThrow(
      WorkloadIdentityRefused,
    );
  });
  it.each(['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512'])(
    'supports the permitted RSA signature family (%s)',
    async (alg) => {
      const f = fixture();
      f.trust.load.mockResolvedValue({
        ...f.bundle,
        jwks: { keys: [{ ...rsa.publicKey.export({ format: 'jwk' }), kid: 'current' }] },
      });
      await expect(f.verifier.verify(token({}, { alg }, rsa.privateKey))).resolves.toHaveProperty(
        'spiffeId',
      );
    },
  );
  it.each([
    ['ES384', 'secp384r1'],
    ['ES512', 'secp521r1'],
  ])('supports the other permitted EC curves (%s)', async (alg, namedCurve) => {
    const pair = generateKeyPairSync('ec', { namedCurve });
    const f = fixture();
    f.trust.load.mockResolvedValue({
      ...f.bundle,
      jwks: { keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'current' }] },
    });
    await expect(f.verifier.verify(token({}, { alg }, pair.privateKey))).resolves.toHaveProperty(
      'spiffeId',
    );
  });
  it.each([
    { sub: 'spiffe://foreign.test/agent/drishti' },
    { sub: 'https://local.axiomproof.test/agent/drishti' },
    { sub: 'spiffe://local.axiomproof.test:443/agent/drishti' },
    { sub: 'spiffe://local.axiomproof.test/agent/../karya' },
    { sub: 'spiffe://local.axiomproof.test/agent/%6barya' },
    { sub: 'spiffe://local.axiomproof.test//agent/drishti' },
  ])('rejects foreign or noncanonical subjects before loading trust', async (claims) => {
    const f = fixture();
    await expect(f.verifier.verify(token(claims))).rejects.toThrow(WorkloadIdentityRefused);
    expect(f.trust.load).not.toHaveBeenCalled();
  });
  it.each([
    { jku: 'https://evil.test/keys' },
    { jwk: {} },
    { x5u: 'https://evil.test/cert' },
    { crit: [] },
    { typ: 'at+jwt' },
  ])('rejects every forbidden JOSE header before private IO', async (headers) => {
    const f = fixture();
    await expect(f.verifier.verify(token({}, headers))).rejects.toThrow(WorkloadIdentityRefused);
    expect(f.trust.load).not.toHaveBeenCalled();
  });
  it('rejects symmetric/unsigned algorithms, malformed, oversized and forged signatures', async () => {
    const f = fixture();
    const signed = token();
    const parts = signed.split('.');
    for (const candidate of [
      '',
      'abc',
      'x'.repeat(16385),
      encode({ alg: 'none' }) + '.' + parts[1] + '.',
      encode({ alg: 'HS256' }) + '.' + parts[1] + '.' + parts[2],
      parts[0] + '.' + parts[1] + '.' + Buffer.alloc(64).toString('base64url'),
    ])
      await expect(f.verifier.verify(candidate)).rejects.toThrow(WorkloadIdentityRefused);
  });
  it('requires exact service audience, issuance time, expiry, acceptable lifetime and validity', async () => {
    const now = Math.floor(Date.now() / 1000);
    const f = fixture();
    for (const claims of [
      { aud: undefined },
      { aud: 'foreign-service' },
      { aud: [config.audience, 'other'] },
      { exp: undefined },
      { iat: undefined },
      { exp: now - 1 },
      { iat: now + 10 },
      { exp: now + 301 },
      { iat: now - 301, exp: now + 1 },
      { nbf: now + 30 },
      { exp: now + 1.5 },
    ])
      await expect(f.verifier.verify(token(claims))).rejects.toThrow(WorkloadIdentityRefused);
  });
  it('loads current bundles each time and refuses removed keys or a revision changed during validation', async () => {
    const f = fixture();
    const signed = token();
    await f.verifier.verify(signed);
    f.bundle.jwks.keys[0]!.kid = 'replacement';
    await expect(f.verifier.verify(signed)).rejects.toThrow(WorkloadIdentityRefused);
    f.bundle.jwks.keys[0]!.kid = 'current';
    f.trust.stillCurrent.mockResolvedValue(false);
    await expect(f.verifier.verify(signed)).rejects.toThrow(WorkloadIdentityRefused);
    expect(f.trust.load).toHaveBeenCalledTimes(3);
  });
  it('refuses unavailable, stale, ambiguous, private or non-signing trust material', async () => {
    const f = fixture();
    for (const bundle of [
      null,
      { ...f.bundle, validUntil: Date.now() - 1 },
      { ...f.bundle, jwks: { keys: [] } },
      { ...f.bundle, jwks: { keys: [f.bundle.jwks.keys[0], f.bundle.jwks.keys[0]] } },
      {
        ...f.bundle,
        jwks: { keys: [{ ...ec.privateKey.export({ format: 'jwk' }), kid: 'current' }] },
      },
      { ...f.bundle, jwks: { keys: [{ ...f.bundle.jwks.keys[0], use: 'x509-svid' }] } },
    ]) {
      f.trust.load.mockResolvedValue(bundle);
      await expect(f.verifier.verify(token())).rejects.toThrow(WorkloadIdentityRefused);
    }
    f.trust.load.mockRejectedValue(new Error('private-adapter-diagnostic'));
    await expect(f.verifier.verify(token())).rejects.toThrow('Workload identity was refused.');
  });
  it('bounds verified identity by trust freshness and rechecks expiry after an awaited freshness check', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.bundle.validUntil = Date.now() + 1000;
    expect((await f.verifier.verify(token())).expiresAt).toBe(f.bundle.validUntil);
    f.trust.stillCurrent.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 2000);
      return true;
    });
    await expect(f.verifier.verify(token())).rejects.toThrow(WorkloadIdentityRefused);
  });
});
