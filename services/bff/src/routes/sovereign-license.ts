/**
 * Sovereign License API Route.
 * Verifies and reports on-premise air-gapped cryptographic license status (W10).
 */
import { Hono, type Context } from 'hono';
import { verifyOfflineLicense } from '@axiom/config';
import type { Variables } from '../types.js';

type Ctx = Context<{ Variables: Variables }>;

export function sovereignLicenseRoutes(
  dependencies: {
    env?: string;
    licenseToken?: string;
  } = {},
) {
  const app = new Hono<{ Variables: Variables }>();

  app.get('/system/license', async (c: Ctx) => {
    const environment = dependencies.env ?? process.env.ENVIRONMENT ?? 'development';

    if (environment !== 'onprem') {
      return c.json({
        environment,
        status: 'cloud-managed',
        licensed: true,
        tier: 'saas-enterprise',
        features: ['*'],
      });
    }

    const token = dependencies.licenseToken ?? process.env.AXIOM_OFFLINE_LICENSE;
    if (!token) {
      return c.json(
        {
          environment: 'onprem',
          status: 'unlicensed',
          licensed: false,
          error: 'No offline license configured. Set AXIOM_OFFLINE_LICENSE in .env.onprem',
        },
        403,
      );
    }

    const verification = verifyOfflineLicense(token);
    if (!verification.valid || !verification.payload) {
      return c.json(
        {
          environment: 'onprem',
          status: 'invalid',
          licensed: false,
          error: verification.error ?? 'Invalid license signature or expired license',
        },
        403,
      );
    }

    const { payload, daysRemaining } = verification;
    return c.json({
      environment: 'onprem',
      status: 'valid',
      licensed: true,
      licenseId: payload.licenseId,
      licensee: payload.licensee,
      tier: payload.tier,
      issuedAt: payload.issuedAt,
      expiresAt: payload.expiresAt,
      daysRemaining,
      maxTenants: payload.maxTenants,
      maxNodes: payload.maxNodes,
      features: payload.features,
    });
  });

  return app;
}
