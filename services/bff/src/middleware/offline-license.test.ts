import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { Hono } from 'hono';
import { mintOfflineLicense, type OfflineLicensePayload } from '@axiom/config';
import { offlineLicenseGate } from './offline-license.js';

const TRUSTED = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const BURNED_PUBLIC_TEST_KEY =
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAjKalzxmYgARg00u6yaVSMF/2b1Q7BtNN8HMPR3XhIAc=\n-----END PUBLIC KEY-----\n';
const BURNED_EXPIRED_REGRESSION_TOKEN =
  'v1.eyJsaWNlbnNlSWQiOiJFWFBJUkVELUNPTVBST01JU0VELVJPT1QtUkVHUkVTU0lPTiIsImxpY2Vuc2VlIjoiU3ludGhldGljIHNlY3VyaXR5IHJlZ3Jlc3Npb24iLCJlbnZpcm9ubWVudCI6Im9ucHJlbSIsInRpZXIiOiJjb21tdW5pdHkiLCJpc3N1ZWRBdCI6IjE5OTktMDEtMDFUMDA6MDA6MDAuMDAwWiIsImV4cGlyZXNBdCI6IjIwMDAtMDEtMDFUMDA6MDA6MDAuMDAwWiIsIm1heFRlbmFudHMiOjEsIm1heE5vZGVzIjoxLCJmZWF0dXJlcyI6W119.W4C8MbFN3_B-m4WWxBNVjqABQ0JWEYxRW8Xyrz8Rj6QJN8MeJehYUFosaYh6gosu6hq52eGYvQy2-SWA4S-dDg';

const payload: OfflineLicensePayload = {
  licenseId: 'SYNTHETIC-EPHEMERAL-TEST',
  licensee: 'Synthetic test',
  environment: 'onprem',
  tier: 'community',
  issuedAt: new Date(Date.now() - 60000).toISOString(),
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
  maxTenants: 1,
  maxNodes: 1,
  features: [],
};
const valid = mintOfflineLicense(payload, TRUSTED.privateKey);
function appFor(environment: string, token?: string, publicKeyPem?: string) {
  const app = new Hono();
  app.use('*', offlineLicenseGate(environment, token, publicKeyPem));
  app.get('/health', (c) => c.text('healthy'));
  app.get('/ready', (c) => c.text('ready'));
  app.get('/v1/system/license', (c) => c.text('license status'));
  app.post('/internal/workload-tools/execute', (c) => c.text('executed'));
  return app;
}

describe('on-prem runtime license gate', () => {
  beforeEach(() => vi.stubEnv('AXIOM_LICENSE_ROOT_PUBLIC_KEY', ''));
  afterEach(() => vi.unstubAllEnvs());
  it('fails closed for work and readiness but retains diagnostics without a trusted root', async () => {
    const app = appFor('onprem', valid);
    expect((await app.request('/health')).status).toBe(200);
    expect((await app.request('/ready')).status).toBe(503);
    expect((await app.request('/v1/system/license')).status).toBe(200);
    expect((await app.request('/internal/workload-tools/execute', { method: 'POST' })).status).toBe(
      403,
    );
    expect((await appFor('onprem').request('/ready')).status).toBe(503);
  });
  it('accepts ephemeral explicitly trusted signatures and leaves cloud requests unchanged', async () => {
    expect((await appFor('onprem', valid, TRUSTED.publicKey).request('/ready')).status).toBe(200);
    expect((await appFor('production').request('/ready')).status).toBe(200);
    vi.stubEnv('AXIOM_LICENSE_ROOT_PUBLIC_KEY', TRUSTED.publicKey.replace(/\n/g, '\\n'));
    expect((await appFor('onprem', valid).request('/ready')).status).toBe(200);
    expect((await appFor('onprem', valid, '').request('/ready')).status).toBe(503);
  });
  it('refuses expired, forged, malformed, non-Ed25519 and burned roots against real crypto', async () => {
    const expired = mintOfflineLicense(
      { ...payload, issuedAt: '1999-01-01T00:00:00.000Z', expiresAt: '2000-01-01T00:00:00.000Z' },
      TRUSTED.privateKey,
    );
    const attacker = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const forged = mintOfflineLicense(payload, attacker.privateKey);
    for (const token of [expired, forged, 'v1.invalid.token']) {
      expect((await appFor('onprem', token, TRUSTED.publicKey).request('/ready')).status).toBe(503);
    }
    expect((await appFor('onprem', valid, 'malformed').request('/ready')).status).toBe(503);
    const wrongAlgorithm = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    expect((await appFor('onprem', valid, wrongAlgorithm.publicKey).request('/ready')).status).toBe(
      503,
    );
    expect(
      (
        await appFor('onprem', BURNED_EXPIRED_REGRESSION_TOKEN, BURNED_PUBLIC_TEST_KEY).request(
          '/ready',
        )
      ).status,
    ).toBe(503);
  });
});
