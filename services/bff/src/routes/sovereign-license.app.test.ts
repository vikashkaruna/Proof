/** Licensing composition tests use synthetic session middleware; no real Auth acceptance claim. */
import type * as ActualConfig from '@axiom/config';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Variables } from '../types.js';
vi.hoisted(() =>
  Object.assign(process.env, {
    ENVIRONMENT: 'test',
    AXIOM_AUTH_MODE: 'strict',
    SUPABASE_URL: 'http://localhost:55321',
    SUPABASE_ANON_KEY: 'a'.repeat(40),
    SUPABASE_SERVICE_KEY: 'b'.repeat(40),
    APPROVAL_SIGNING_KEY: 'k'.repeat(48),
  }),
);
vi.mock('@axiom/config', async (importOriginal) => {
  const actual = await importOriginal<typeof ActualConfig>();
  return { ...actual, loadEnv: () => ({ ...actual.loadEnv(), ENVIRONMENT: 'onprem' as const }) };
});
vi.mock('../middleware/auth.js', async () => {
  const { createMiddleware } = await import('hono/factory');
  return {
    authMiddleware: createMiddleware<{ Variables: Variables }>(async (c, next) => {
      c.set('user', { id: '77777777-7777-4777-8777-777777777777' } as never);
      await next();
    }),
  };
});
vi.mock('../middleware/tenant.js', async () => {
  const { createMiddleware } = await import('hono/factory');
  return {
    tenantResolver: createMiddleware<{ Variables: Variables }>(async (c, next) => {
      c.set('tenantId', 'a0000000-0000-4000-8000-000000000001');
      await next();
    }),
  };
});
vi.mock('../services/kill-switch.js', () => ({
  createKillSwitchService: () => ({ isActive: async () => false }),
}));
vi.mock('../services/approval.js', () => ({ createApprovalEngine: () => ({}) }));
vi.mock('../services/ledger.js', () => ({ createLedgerService: () => ({}) }));
vi.mock('../services/mfa.js', () => ({
  createMfaService: () => ({
    sessionAccess: async () => ({ sessionCurrent: true, recovery: null }),
    requiresLoginMfa: async () => false,
  }),
}));
vi.mock('../services/realtime.js', () => ({ startRealtimeChannel: () => ({}) }));
vi.mock('../services/saakshi-staging-composition.js', () => ({
  createSaakshiComposition: () => null,
  evidenceControllerRpc: vi.fn(),
}));
import { createApp } from '../app.js';
import { mintOfflineLicense } from '@axiom/config';
const authority = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
beforeEach(() => {
  vi.stubEnv('ENVIRONMENT', 'onprem');
  vi.stubEnv('AXIOM_LICENSE_ROOT_PUBLIC_KEY', '');
  vi.stubEnv(
    'AXIOM_OFFLINE_LICENSE',
    mintOfflineLicense(
      {
        licenseId: 'SYNTHETIC-APP-COMPOSITION',
        licensee: 'Synthetic test',
        environment: 'onprem',
        tier: 'community',
        issuedAt: new Date(Date.now() - 60000).toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        maxTenants: 1,
        maxNodes: 1,
        features: [],
      },
      authority.privateKey,
    ),
  );
});
afterEach(() => vi.unstubAllEnvs());
it('passes the explicit ephemeral trust root to both request gate and mounted status route', async () => {
  const app = createApp({ licensePublicKeyPem: authority.publicKey, ownedSynthetic: null });
  expect((await app.request('/ready')).status).toBe(200);
  const response = await app.request('/v1/system/license');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    licensed: true,
    licenseId: 'SYNTHETIC-APP-COMPOSITION',
  });
});
it('refuses missing trust while leaving health and diagnostic status available', async () => {
  const app = createApp({ ownedSynthetic: null });
  expect((await app.request('/health')).status).toBe(200);
  expect((await app.request('/ready')).status).toBe(503);
  const response = await app.request('/v1/system/license');
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    licensed: false,
    error: 'Trusted license root public key is required',
  });
});
it('preserves explicit blank trust refusal even when process environment contains valid trust', async () => {
  vi.stubEnv('AXIOM_LICENSE_ROOT_PUBLIC_KEY', authority.publicKey);
  const app = createApp({ licensePublicKeyPem: '', ownedSynthetic: null });
  expect((await app.request('/ready')).status).toBe(503);
  expect((await app.request('/v1/system/license')).status).toBe(403);
});
