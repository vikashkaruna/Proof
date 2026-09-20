import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { cors } from 'hono/cors';
import { loadEnv } from '@axiom/config';
import { authMiddleware } from './middleware/auth.js';
import { tenantResolver } from './middleware/tenant.js';
import { idempotency } from './middleware/idempotency.js';
import { errorHandler } from './middleware/error.js';
import { v1Routes } from './routes/v1.js';
import { publicRoutes } from './routes/public.js';
import { createApprovalEngine } from './services/approval.js';
import { createKillSwitchService } from './services/kill-switch.js';
import { createLedgerService } from './services/ledger.js';
import { startRealtimeChannel } from './services/realtime.js';

/**
 * Builds the BFF application.
 *
 * Extracted from `index.ts` in W9 so the middleware chain — auth, tenant
 * resolution, idempotency and the execution gate — can be exercised by tests
 * without binding a port. `index.ts` is now only the process entrypoint.
 *
 * Middleware order is load-bearing and asserted by the suite:
 *   auth → tenantResolver → idempotency → routes
 * Idempotency reads `user` and `tenantId` from the context, so it cannot run
 * before the two middlewares that set them.
 */
export function createApp() {
  const env = loadEnv();
  const app = new Hono();

  // ─── Cross-cutting middleware ────────────────────────────────────────
  app.use('*', logger());
  app.use('*', secureHeaders());
  app.use(
    '*',
    cors({
      origin: env.BFF_CORS_ORIGINS.split(',').map((o) => o.trim()),
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id'],
      credentials: true,
    }),
  );
  app.use('*', errorHandler());

  // ─── Services (constructed once, attached to the app) ───────────────
  const approvalEngine = createApprovalEngine(env);
  const killSwitch = createKillSwitchService();
  const ledger = createLedgerService();
  const realtime = startRealtimeChannel({ ledger, killSwitch });

  // Health endpoints (no auth)
  app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));
  app.get('/ready', (c) => c.json({ status: 'ready', killSwitch: killSwitch.isActive() }));

  // Public routes (no auth) — gap-scan, public marketing endpoints
  app.route('/public', publicRoutes({ ledger }));

  // Authenticated routes
  app.use('/v1/*', authMiddleware);
  app.use('/v1/*', tenantResolver);
  app.use('/v1/*', idempotency);

  app.route('/v1', v1Routes({ approvalEngine, killSwitch, ledger, realtime }));

  return app;
}
