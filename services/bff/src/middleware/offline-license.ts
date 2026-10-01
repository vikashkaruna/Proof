import type { MiddlewareHandler } from 'hono';
import { verifyOfflineLicense } from '@axiom/config';

/** Recheck expiry on every on-prem request; bootstrap verification alone ages out. */
export function offlineLicenseGate(
  environment: string | undefined,
  token: string | undefined,
  /** In-process test trust root only; deployments always verify against the Axiom root key. */
  publicKeyPem?: string,
): MiddlewareHandler {
  return async (c, next) => {
    if (
      environment !== 'onprem' ||
      c.req.path === '/health' ||
      c.req.path === '/v1/system/license'
    ) {
      return next();
    }
    if (!token || !verifyOfflineLicense(token, publicKeyPem ? { publicKeyPem } : undefined).valid) {
      return c.json({ error: 'offline_license_invalid' }, c.req.path === '/ready' ? 503 : 403);
    }
    return next();
  };
}
