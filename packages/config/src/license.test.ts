import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  mintOfflineLicense,
  verifyOfflineLicense,
  hasLicenseFeature,
  type OfflineLicensePayload,
} from './license';

const TEST_AUTHORITY_KEYPAIR = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const BURNED_PUBLIC_TEST_KEY =
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAjKalzxmYgARg00u6yaVSMF/2b1Q7BtNN8HMPR3XhIAc=\n-----END PUBLIC KEY-----\n';
const BURNED_EXPIRED_REGRESSION_TOKEN =
  'v1.eyJsaWNlbnNlSWQiOiJFWFBJUkVELUNPTVBST01JU0VELVJPT1QtUkVHUkVTU0lPTiIsImxpY2Vuc2VlIjoiU3ludGhldGljIHNlY3VyaXR5IHJlZ3Jlc3Npb24iLCJlbnZpcm9ubWVudCI6Im9ucHJlbSIsInRpZXIiOiJjb21tdW5pdHkiLCJpc3N1ZWRBdCI6IjE5OTktMDEtMDFUMDA6MDA6MDAuMDAwWiIsImV4cGlyZXNBdCI6IjIwMDAtMDEtMDFUMDA6MDA6MDAuMDAwWiIsIm1heFRlbmFudHMiOjEsIm1heE5vZGVzIjoxLCJmZWF0dXJlcyI6W119.W4C8MbFN3_B-m4WWxBNVjqABQ0JWEYxRW8Xyrz8Rj6QJN8MeJehYUFosaYh6gosu6hq52eGYvQy2-SWA4S-dDg';

describe('Axiom Proof — Offline Sovereign Licensing', () => {
  beforeEach(() => vi.stubEnv('AXIOM_LICENSE_ROOT_PUBLIC_KEY', ''));
  afterEach(() => vi.unstubAllEnvs());
  const validPayload: OfflineLicensePayload = {
    licenseId: 'LIC-2026-SOVEREIGN-001',
    licensee: 'Bharat Defense Systems Ltd',
    environment: 'onprem',
    tier: 'enterprise-airgapped',
    issuedAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(), // 1 hour ago
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString(), // 1 year later
    maxTenants: 10,
    maxNodes: 50,
    features: ['evidence_vault_worm', 'offline_llm', 'airgapped_mfa', 'multi_regulator_bfsi'],
    hardwareFingerprint: 'NODE-SHA256-4b892a01ef',
  };

  it('mints and verifies an offline license successfully with asymmetric Ed25519 keys', () => {
    const token = mintOfflineLicense(validPayload, TEST_AUTHORITY_KEYPAIR.privateKey);
    expect(token).toMatch(/^v1\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/);

    const result = verifyOfflineLicense(token, {
      publicKeyPem: TEST_AUTHORITY_KEYPAIR.publicKey,
    });

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.payload?.licenseId).toBe('LIC-2026-SOVEREIGN-001');
    expect(result.payload?.licensee).toBe('Bharat Defense Systems Ltd');
    expect(result.payload?.tier).toBe('enterprise-airgapped');
    expect(result.daysRemaining).toBeGreaterThanOrEqual(364);
  });

  it('refuses license with altered payload (tampering detection)', () => {
    const token = mintOfflineLicense(validPayload, TEST_AUTHORITY_KEYPAIR.privateKey);
    const [version, payloadB64, sigB64] = token.split('.');

    // Tamper with payload (change maxTenants from 10 to 999)
    const rawPayload = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString('utf-8'));
    rawPayload.maxTenants = 999;
    const tamperedPayloadB64 = Buffer.from(JSON.stringify(rawPayload)).toString('base64url');

    const tamperedToken = `${version}.${tamperedPayloadB64}.${sigB64}`;

    const result = verifyOfflineLicense(tamperedToken, {
      publicKeyPem: TEST_AUTHORITY_KEYPAIR.publicKey,
    });

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Cryptographic signature verification failed');
  });

  it('refuses expired license', () => {
    const expiredPayload: OfflineLicensePayload = {
      ...validPayload,
      issuedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 60).toISOString(), // 60 days ago
      expiresAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 10).toISOString(), // expired 10 days ago
    };

    const token = mintOfflineLicense(expiredPayload, TEST_AUTHORITY_KEYPAIR.privateKey);
    const result = verifyOfflineLicense(token, {
      publicKeyPem: TEST_AUTHORITY_KEYPAIR.publicKey,
    });

    expect(result.valid).toBe(false);
    expect(result.error).toContain('License has expired');
    expect(result.daysRemaining).toBe(0);
  });

  it('refuses license with future issuance date', () => {
    const futurePayload: OfflineLicensePayload = {
      ...validPayload,
      issuedAt: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(), // 1 day in the future
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString(),
    };

    const token = mintOfflineLicense(futurePayload, TEST_AUTHORITY_KEYPAIR.privateKey);
    const result = verifyOfflineLicense(token, {
      publicKeyPem: TEST_AUTHORITY_KEYPAIR.publicKey,
    });

    expect(result.valid).toBe(false);
    expect(result.error).toContain('is in the future');
  });

  it('refuses malformed tokens', () => {
    expect(verifyOfflineLicense('')).toEqual({
      valid: false,
      error: 'License token is required',
    });
    expect(verifyOfflineLicense('v2.foo.bar').valid).toBe(false);
    expect(verifyOfflineLicense('not-a-token').valid).toBe(false);
  });

  it('refuses the published burned authority even during its historical valid interval', () => {
    const result = verifyOfflineLicense(BURNED_EXPIRED_REGRESSION_TOKEN, {
      publicKeyPem: BURNED_PUBLIC_TEST_KEY,
      now: new Date('1999-06-01T00:00:00.000Z'),
    });
    expect(result).toEqual({ valid: false, error: 'License root public key is revoked' });
  });

  it('rejects the burned key across PEM formatting and escaped environment configuration', () => {
    const differentlyWrapped = BURNED_PUBLIC_TEST_KEY.replace(
      'MCowBQYDK2VwAyEA',
      'MCowBQYD\nK2VwAyEA',
    );
    expect(
      verifyOfflineLicense(BURNED_EXPIRED_REGRESSION_TOKEN, {
        publicKeyPem: differentlyWrapped,
        now: new Date('1999-06-01T00:00:00.000Z'),
      }),
    ).toEqual({ valid: false, error: 'License root public key is revoked' });
    vi.stubEnv('AXIOM_LICENSE_ROOT_PUBLIC_KEY', BURNED_PUBLIC_TEST_KEY.replace(/\n/g, '\\n'));
    expect(
      verifyOfflineLicense(BURNED_EXPIRED_REGRESSION_TOKEN, {
        now: new Date('1999-06-01T00:00:00.000Z'),
      }),
    ).toEqual({ valid: false, error: 'License root public key is revoked' });
  });

  it('requires an explicit root and never restores the burned default', () => {
    expect(
      verifyOfflineLicense(BURNED_EXPIRED_REGRESSION_TOKEN, {
        now: new Date('1999-06-01T00:00:00.000Z'),
      }),
    ).toEqual({ valid: false, error: 'Trusted license root public key is required' });
    const token = mintOfflineLicense(validPayload, TEST_AUTHORITY_KEYPAIR.privateKey);
    expect(verifyOfflineLicense(token).valid).toBe(false);
    vi.stubEnv(
      'AXIOM_LICENSE_ROOT_PUBLIC_KEY',
      TEST_AUTHORITY_KEYPAIR.publicKey.replace(/\n/g, '\\n'),
    );
    expect(verifyOfflineLicense(token).valid).toBe(true);
    expect(verifyOfflineLicense(token, { publicKeyPem: '' }).valid).toBe(false);
    expect(verifyOfflineLicense(token, { publicKeyPem: '  ' }).valid).toBe(false);
  });

  it('rejects malformed, private and non-Ed25519 trust roots without disclosing key material', () => {
    const token = mintOfflineLicense(validPayload, TEST_AUTHORITY_KEYPAIR.privateKey);
    for (const publicKeyPem of [
      'not a public key',
      '-----BEGIN PUBLIC KEY-----\ninvalid\n-----END PUBLIC KEY-----',
      TEST_AUTHORITY_KEYPAIR.privateKey,
    ]) {
      const result = verifyOfflineLicense(token, { publicKeyPem });
      expect(result.valid).toBe(false);
      expect(result.error).not.toContain(publicKeyPem);
    }
    const wrongAlgorithm = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    expect(verifyOfflineLicense(token, { publicKeyPem: wrongAlgorithm.publicKey })).toEqual({
      valid: false,
      error: 'License root must be an Ed25519 public key',
    });
  });

  it('refuses a signature from a different ephemeral authority', () => {
    const attacker = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const token = mintOfflineLicense(validPayload, attacker.privateKey);
    expect(
      verifyOfflineLicense(token, { publicKeyPem: TEST_AUTHORITY_KEYPAIR.publicKey }).valid,
    ).toBe(false);
  });

  it('checks enabled features correctly with explicit and wildcard permissions', () => {
    expect(hasLicenseFeature(validPayload, 'evidence_vault_worm')).toBe(true);
    expect(hasLicenseFeature(validPayload, 'offline_llm')).toBe(true);
    expect(hasLicenseFeature(validPayload, 'unlicensed_feature')).toBe(false);

    const wildcardLicense: OfflineLicensePayload = {
      ...validPayload,
      features: ['*'],
    };
    expect(hasLicenseFeature(wildcardLicense, 'any_future_feature')).toBe(true);
  });
});
