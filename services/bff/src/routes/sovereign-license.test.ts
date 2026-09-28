import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { sovereignLicenseRoutes } from './sovereign-license.js';
import { mintOfflineLicense, type OfflineLicensePayload } from '@axiom/config';

const AXIOM_TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIM+Xo6dK7vqEwOeJ8a19E9qrLHsyqXCiAVJwJ7WpMsxg
-----END PRIVATE KEY-----`;

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

    const token = mintOfflineLicense(payload, AXIOM_TEST_PRIVATE_KEY);

    const app = new Hono();
    app.route('/', sovereignLicenseRoutes({ env: 'onprem', licenseToken: token }));

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
