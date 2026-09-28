import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  DEFAULT_AXIOM_LICENSE_ROOT_PUBLIC_KEY,
  mintOfflineLicense,
  verifyOfflineLicense,
  hasLicenseFeature,
  type OfflineLicensePayload,
} from './license';

const TEST_AUTHORITY_KEYPAIR = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

describe('Axiom Proof — Offline Sovereign Licensing', () => {
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
    const rawPayload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'));
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
