import type { MiddlewareHandler } from 'hono';
import { verifyOfflineLicense } from '@axiom/config';

/** Recheck expiry on every on-prem request; bootstrap verification alone ages out. */
export function offlineLicenseGate(
  environment: string | undefined,
  token: string | undefined,
): MiddlewareHandler {
  return async (c, next) => {
    if (
      environment !== 'onprem' ||
      c.req.path === '/health' ||
      c.req.path === '/v1/system/license'
    ) {
      return next();
    }
    if (!token || !verifyOfflineLicense(token).valid) {
      return c.json({ error: 'offline_license_invalid' }, c.req.path === '/ready' ? 503 : 403);
    }
    return next();
  };
}
