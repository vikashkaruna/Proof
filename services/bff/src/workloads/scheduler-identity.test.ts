import { generateKeyPairSync, sign } from 'node:crypto';
import { createLocalJWKSet } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleSchedulerIdentity, googleSchedulerKeys } from './scheduler-identity.js';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const foreign = generateKeyPairSync('rsa', { modulusLength: 2048 });
const config = {
  audience: 'https://controller.example.run.app',
  subject: '123456789012345678901',
  email: 'scheduler@synthetic.iam.gserviceaccount.com',
};
const jwks = {
  keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'current', alg: 'RS256', use: 'sig' }],
};
const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
function bearer(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  key = pair.privateKey,
) {
  const now = Math.floor(Date.now() / 1000);
  const body =
    encode({ alg: 'RS256', kid: 'current', typ: 'JWT', ...header }) +
    '.' +
    encode({
      iss: 'https://accounts.google.com',
      sub: config.subject,
      azp: config.subject,
      email: config.email,
      email_verified: true,
      aud: config.audience,
      iat: now,
      exp: now + 300,
      ...claims,
    });
  return 'Bearer ' + body + '.' + sign('RSA-SHA256', Buffer.from(body), key).toString('base64url');
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe('Google scheduler identity', () => {
  it('verifies immutable principal and audience, returning only expiry metadata', async () => {
    const result = await new GoogleSchedulerIdentity(config, createLocalJWKSet(jwks)).authorize(
      bearer(),
    );
    expect(Object.keys(result)).toEqual(['expiresAt']);
    expect(result.expiresAt > Date.now()).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });
  it.each([
    { iss: 'https://attacker.invalid' },
    { sub: '999' },
    { email: 'scheduler@other.iam.gserviceaccount.com' },
    { email_verified: 'true' },
    { email_verified: false },
    { email: undefined },
    { azp: '999' },
    { aud: 'https://other.example.run.app' },
    { aud: [config.audience, 'other'] },
    { aud: [config.audience] },
    { iat: Math.floor(Date.now() / 1000) + 60 },
    { exp: 1 },
    { iat: 1 },
    { exp: Math.floor(Date.now() / 1000) + 7200 },
    { exp: undefined },
  ])('refuses wrong identity, audience, lifetime and missing claims', async (claims) => {
    await expect(
      new GoogleSchedulerIdentity(config, createLocalJWKSet(jwks)).authorize(bearer(claims)),
    ).rejects.toThrow('Scheduler identity refused');
  });
  it.each([
    { jku: 'https://attacker.invalid' },
    { x5u: 'https://attacker.invalid' },
    { jwk: jwks.keys[0] },
    { alg: 'HS256' },
    { crit: ['unknown'] },
    { kid: '' },
  ])('rejects untrusted key/header selection before key resolution', async (header) => {
    const keys = vi.fn(createLocalJWKSet(jwks));
    await expect(
      new GoogleSchedulerIdentity(config, keys).authorize(bearer({}, header)),
    ).rejects.toThrow('Scheduler identity refused');
    expect(keys).not.toHaveBeenCalled();
  });
  it('refuses a wrong signature and never falls back to claimed identity', async () => {
    await expect(
      new GoogleSchedulerIdentity(config, createLocalJWKSet(jwks)).authorize(
        bearer({}, {}, foreign.privateKey),
      ),
    ).rejects.toThrow('Scheduler identity refused');
  });
  it.each([undefined, 'Basic private-marker', 'Bearer unsigned', 'Bearer ' + 'x'.repeat(8200)])(
    'sanitizes malformed authorization',
    async (token) => {
      await expect(
        new GoogleSchedulerIdentity(config, createLocalJWKSet(jwks)).authorize(token),
      ).rejects.toThrow('Scheduler identity refused');
    },
  );
  it('fetches only fixed Google keys with bounded cache and refuses stale-cache outage', async () => {
    vi.useFakeTimers();
    const fetched = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(jwks), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetched);
    const identity = new GoogleSchedulerIdentity(config, googleSchedulerKeys());
    await identity.authorize(bearer());
    await identity.authorize(bearer());
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(fetched.mock.calls[0]![0]).toBe('https://www.googleapis.com/oauth2/v3/certs');
    expect(fetched.mock.calls[0]![1]?.redirect).toBe('error');
    vi.setSystemTime(Date.now() + 61000);
    fetched.mockRejectedValue(new Error('private-marker'));
    await expect(identity.authorize(bearer())).rejects.toThrow('Scheduler identity refused');
    expect(fetched).toHaveBeenCalledTimes(2);
  });
  it.each(['redirect', 'oversized', 'invalid'])(
    'refuses unsafe remote key responses',
    async (fault) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(fault === 'oversized' ? 'x'.repeat(65537) : 'private-marker', {
              status: fault === 'redirect' ? 302 : 200,
            }),
        ),
      );
      await expect(new GoogleSchedulerIdentity(config).authorize(bearer())).rejects.toThrow(
        'Scheduler identity refused',
      );
    },
  );
  it.each([
    'http://controller.invalid',
    'https://controller.invalid/',
    'https://user@controller.invalid',
    'https://controller.invalid/path',
    'https://controller.invalid?x=1',
  ])('rejects ambiguous controller origins', (value) => {
    expect(() => new GoogleSchedulerIdentity({ ...config, audience: value })).toThrow();
  });
});
