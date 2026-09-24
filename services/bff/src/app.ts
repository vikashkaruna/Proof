import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { cors } from 'hono/cors';
import { loadEnv } from '@axiom/config';
import { authMiddleware } from './middleware/auth.js';
import { tenantResolver } from './middleware/tenant.js';
import { idempotency } from './middleware/idempotency.js';
import { requireSessionMfa } from './middleware/session-mfa.js';
import { errorHandler } from './middleware/error.js';
import { v1Routes } from './routes/v1.js';
import { publicRoutes } from './routes/public.js';
import { createApprovalEngine } from './services/approval.js';
import { createKillSwitchService } from './services/kill-switch.js';
import { createLedgerService } from './services/ledger.js';
import { createMfaService } from './services/mfa.js';
import { workloadToolsRoutes } from './routes/workload-tools.js';
import type { AssessmentTools } from './workloads/assessment-tools.js';
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
export function createApp(options: { assessmentTools?: AssessmentTools } = {}) {
  const env = loadEnv();
  const app = new Hono();

  // ─── Cross-cutting middleware ────────────────────────────────────────
  app.use('*', async (c, next) => {
    // Private tool traffic must never enter request logs, including query strings.
    if (c.req.path.startsWith('/internal/workload-tools')) return next();
    return logger()(c, next);
  });
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
  const mfa = createMfaService();
  const realtime = startRealtimeChannel({ ledger, killSwitch });

  // Health endpoints (no auth)
  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      environment: env.ENVIRONMENT ?? 'local',
      authMode: env.AXIOM_AUTH_MODE,
      revision: env.AXIOM_RELEASE_SHA ?? null,
    }),
  );
  // `isActive` reads shared state, so this must await it — it previously
  // serialised a pending Promise as `{}`.
  app.get('/ready', async (c) =>
    c.json({ status: 'ready', killSwitch: await killSwitch.isActive() }),
  );

  // Private workload authority is independent of human session middleware.
  app.route('/internal/workload-tools', workloadToolsRoutes(options.assessmentTools));

  // Public routes (no auth) — gap-scan, public marketing endpoints
  app.route('/public', publicRoutes());

  // Authenticated routes
  app.use('/v1/*', authMiddleware);
  app.use('/v1/*', tenantResolver);
  // Before idempotency, so a quarantined request does not burn a key it will
  // never get to use.
  app.use('/v1/*', requireSessionMfa(mfa));
  app.use('/v1/*', idempotency);

  app.route('/v1', v1Routes({ approvalEngine, killSwitch, ledger, mfa, realtime }));

  return app;
}
