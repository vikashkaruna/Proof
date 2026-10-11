import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { sovereignLicenseRoutes } from './sovereign-license.js';
import { mintOfflineLicense, type OfflineLicensePayload } from '@axiom/config';

const TEST_AUTHORITY = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const BURNED_PUBLIC_TEST_KEY =
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAjKalzxmYgARg00u6yaVSMF/2b1Q7BtNN8HMPR3XhIAc=\n-----END PUBLIC KEY-----\n';
const BURNED_EXPIRED_REGRESSION_TOKEN =
  'v1.eyJsaWNlbnNlSWQiOiJFWFBJUkVELUNPTVBST01JU0VELVJPT1QtUkVHUkVTU0lPTiIsImxpY2Vuc2VlIjoiU3ludGhldGljIHNlY3VyaXR5IHJlZ3Jlc3Npb24iLCJlbnZpcm9ubWVudCI6Im9ucHJlbSIsInRpZXIiOiJjb21tdW5pdHkiLCJpc3N1ZWRBdCI6IjE5OTktMDEtMDFUMDA6MDA6MDAuMDAwWiIsImV4cGlyZXNBdCI6IjIwMDAtMDEtMDFUMDA6MDA6MDAuMDAwWiIsIm1heFRlbmFudHMiOjEsIm1heE5vZGVzIjoxLCJmZWF0dXJlcyI6W119.W4C8MbFN3_B-m4WWxBNVjqABQ0JWEYxRW8Xyrz8Rj6QJN8MeJehYUFosaYh6gosu6hq52eGYvQy2-SWA4S-dDg';

interface SovereignLicenseResponse {
  status: string;
  licensed: boolean;
  environment?: string;
  error?: string;
  licenseId?: string;
  licensee?: string;
  tier?: string;
  maxTenants?: number;
  maxNodes?: number;
  features?: string[];
  daysRemaining?: number;
}

describe('Sovereign License BFF Route', () => {
  beforeEach(() => {
    vi.stubEnv('AXIOM_LICENSE_ROOT_PUBLIC_KEY', '');
    vi.stubEnv('AXIOM_OFFLINE_LICENSE', '');
  });
  afterEach(() => vi.unstubAllEnvs());
  it('returns cloud-managed status in non-onprem environments', async () => {
    const app = new Hono();
    app.route('/', sovereignLicenseRoutes({ env: 'production' }));

    const res = await app.request('/system/license');
    expect(res.status).toBe(200);

    const body = (await res.json()) as SovereignLicenseResponse;
    expect(body.status).toBe('cloud-managed');
    expect(body.licensed).toBe(true);
    expect(body.environment).toBe('production');
  });

  it('refuses request with 403 when onprem deployment has no license configured', async () => {
    const app = new Hono();
    app.route('/', sovereignLicenseRoutes({ env: 'onprem', licenseToken: undefined }));

    const res = await app.request('/system/license');
    expect(res.status).toBe(403);

    const body = (await res.json()) as SovereignLicenseResponse;
    expect(body.status).toBe('unlicensed');
    expect(body.licensed).toBe(false);
    expect(body.error).toContain('No offline license configured');
  });

  it('refuses request with 403 when onprem deployment has invalid license token', async () => {
    const app = new Hono();
    app.route('/', sovereignLicenseRoutes({ env: 'onprem', licenseToken: 'v1.invalid.token' }));

    const res = await app.request('/system/license');
    expect(res.status).toBe(403);

    const body = (await res.json()) as SovereignLicenseResponse;
    expect(body.status).toBe('invalid');
    expect(body.licensed).toBe(false);
  });

  it.each([
    { label: 'absent', key: '' },
    { label: 'malformed', key: 'not a key' },
    { label: 'revoked', key: BURNED_PUBLIC_TEST_KEY },
  ])('fails closed for $label trust', async ({ key: publicKeyPem }) => {
    const app = new Hono();
    app.route(
      '/',
      sovereignLicenseRoutes({
        env: 'onprem',
        licenseToken: BURNED_EXPIRED_REGRESSION_TOKEN,
        publicKeyPem,
      }),
    );
    const response = await app.request('/system/license');
    expect(response.status).toBe(403);
    expect(((await response.json()) as SovereignLicenseResponse).licensed).toBe(false);
  });

  it('returns 200 with full license metadata for verified sovereign token', async () => {
    const payload: OfflineLicensePayload = {
      licenseId: 'LIC-2026-TEST-SOVEREIGN',
      licensee: 'National Data Authority',
      environment: 'onprem',
      tier: 'enterprise-airgapped',
      issuedAt: new Date(Date.now() - 1000 * 60).toISOString(),
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 180).toISOString(), // 180 days
      maxTenants: 5,
      maxNodes: 20,
      features: ['evidence_vault_worm', 'offline_llm', 'airgapped_mfa'],
    };

    const token = mintOfflineLicense(payload, TEST_AUTHORITY.privateKey);

    const app = new Hono();
    app.route(
      '/',
      sovereignLicenseRoutes({
        env: 'onprem',
        licenseToken: token,
        publicKeyPem: TEST_AUTHORITY.publicKey,
      }),
    );

    const res = await app.request('/system/license');
    expect(res.status).toBe(200);

    const body = (await res.json()) as SovereignLicenseResponse;
    expect(body.status).toBe('valid');
    expect(body.licensed).toBe(true);
    expect(body.licenseId).toBe('LIC-2026-TEST-SOVEREIGN');
    expect(body.licensee).toBe('National Data Authority');
    expect(body.tier).toBe('enterprise-airgapped');
    expect(body.maxTenants).toBe(5);
    expect(body.maxNodes).toBe(20);
    expect(body.features).toContain('offline_llm');
    expect(body.daysRemaining).toBeGreaterThanOrEqual(179);
  });
});
