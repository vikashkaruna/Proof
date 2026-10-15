import { createConfiguredOwnedSynthetic } from './services/owned-synthetic-composition.js';
import type { OwnedSyntheticRouteDeps } from './routes/owned-synthetic-plans.js';
import { stagedEvidencePrivateRoutes } from './routes/staged-evidence-private.js';
import {
  createSaakshiComposition,
  evidenceControllerRpc,
} from './services/saakshi-staging-composition.js';
import { discoveryRoutes } from './routes/discovery.js';
import type { DiscoveryService } from './connectors/discovery.js';
import { Hono } from 'hono';
import { PUBLIC_CONTROL_REVIEW_MAX_BYTES } from '@axiom/types';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { cors } from 'hono/cors';
import { loadEnv } from '@axiom/config';
import { authMiddleware } from './middleware/auth.js';
import { tenantResolver } from './middleware/tenant.js';
import { requireLiveStaffAuthority } from './middleware/staff-authority.js';
import {
  boundedJsonBody,
  evidenceBodyLimit,
  reportBodyLimit,
} from './middleware/evidence-body-limit.js';
import { idempotency } from './middleware/idempotency.js';
import { reportAuthority } from './middleware/report-authority.js';
import { requireSessionMfa } from './middleware/session-mfa.js';
import { errorHandler } from './middleware/error.js';
import { v1Routes } from './routes/v1.js';
import { publicRoutes } from './routes/public.js';
import { createApprovalEngine } from './services/approval.js';
import { createKillSwitchService } from './services/kill-switch.js';
import { createLedgerService } from './services/ledger.js';
import { createMfaService } from './services/mfa.js';
import { workloadToolsRoutes } from './routes/workload-tools.js';
import type { AssessmentRequestProducer } from './workloads/assessment-producer.js';
import type { AssessmentTools } from './workloads/assessment-tools.js';
import { startRealtimeChannel } from './services/realtime.js';
import { offlineLicenseGate } from './middleware/offline-license.js';

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
export function createApp(
  options: {
    ownedSynthetic?: OwnedSyntheticRouteDeps | null;
    assessmentTools?: AssessmentTools;
    assessmentRequests?: AssessmentRequestProducer;
    discovery?: Pick<DiscoveryService, 'run'>;
    licensePublicKeyPem?: string;
  } = {},
) {
  const env = loadEnv();
  const app = new Hono();

  // ─── Cross-cutting middleware ────────────────────────────────────────
  app.use('*', async (c, next) => {
    // Private tool traffic must never enter request logs, including query strings.
    if (
      c.req.path.startsWith('/internal/workload-tools') ||
      c.req.path.startsWith('/internal/discovery') ||
      c.req.path === '/internal/staged-evidence/stage'
    )
      return next();
    return logger()(c, next);
  });
  app.use('*', secureHeaders());
  app.use(
    '*',
    cors({
      origin: env.BFF_CORS_ORIGINS.split(',').map((o) => o.trim()),
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: [
        'Content-Type',
        'Authorization',
        'Idempotency-Key',
        'X-Request-Id',
        'X-Tenant-Id',
        'X-Expected-Actor-Id',
      ],
      credentials: true,
    }),
  );
  app.use('*', errorHandler());
  app.use(
    '*',
    offlineLicenseGate(
      env.ENVIRONMENT,
      process.env.AXIOM_OFFLINE_LICENSE,
      options.licensePublicKeyPem,
    ),
  );

  // ─── Services (constructed once, attached to the app) ───────────────
  const approvalEngine = createApprovalEngine(env);
  const killSwitch = createKillSwitchService();
  const ledger = createLedgerService();
  const mfa = createMfaService();
  const realtime = startRealtimeChannel({ ledger, killSwitch });
  const stagedEvidence = createSaakshiComposition();
  const ownedSynthetic =
    options.ownedSynthetic === undefined
      ? createConfiguredOwnedSynthetic((tenantId) => killSwitch.isActive(tenantId))
      : options.ownedSynthetic;

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
  app.route('/internal/discovery', discoveryRoutes(options.discovery));
  app.route('/internal/staged-evidence', stagedEvidencePrivateRoutes(stagedEvidence?.internal));

  // Public routes (no auth) — gap-scan, public marketing endpoints
  app.route('/public', publicRoutes());

  // Authenticated routes
  app.use('/v1/*', authMiddleware);
  app.use('/v1/*', tenantResolver);
  // Revoked staff cannot start new mutations or burn an idempotency key.
  app.use('/v1/*', requireLiveStaffAuthority);
  // Before idempotency, so a quarantined request does not burn a key it will
  // never get to use.
  app.use('/v1/*', requireSessionMfa(mfa));
  app.use('/v1/evidence/ingestions', evidenceBodyLimit);
  app.use('/v1/evidence/staged-ingestions', evidenceBodyLimit);
  app.use('/v1/*', async (c, next) => {
    if (
      /^\/v1\/evidence\/staged-ingestions\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/expire$/.test(
        c.req.path,
      )
    )
      return boundedJsonBody(4096)(c, next);
    return next();
  });
  // Bound owned original-request bodies before idempotency can clone/buffer them.
  for (const path of [
    '/v1/plans/owned-synthetic',
    '/v1/plans/owned-synthetic/cancel',
    '/v1/plans/owned-synthetic/outcome',
  ])
    app.use(path, boundedJsonBody(16384));
  app.use('/v1/engagements', boundedJsonBody(4096));
  app.use('/v1/public-control-review-sets', boundedJsonBody(PUBLIC_CONTROL_REVIEW_MAX_BYTES));
  app.use('/v1/public-control-review-sets/*', async (c, next) => {
    if (
      /^\/v1\/public-control-review-sets\/operations\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/cancel$/.test(
        c.req.path,
      )
    )
      return boundedJsonBody(PUBLIC_CONTROL_REVIEW_MAX_BYTES + 8192)(c, next);
    return next();
  });
  app.use('/v1/*', reportBodyLimit);
  app.use('/v1/*', reportAuthority());
  app.use('/v1/*', idempotency);

  app.route(
    '/v1',
    v1Routes({
      licensePublicKeyPem: options.licensePublicKeyPem,
      approvalEngine,
      killSwitch,
      ledger,
      mfa,
      realtime,
      assessmentRequests: options.assessmentRequests,
      ownedSynthetic,
      stagedEvidence: {
        rpc: evidenceControllerRpc,
        configuration: stagedEvidence?.configuration,
        invocation: stagedEvidence ? { ...stagedEvidence.invocation, realtime } : undefined,
        killSwitch,
        mfa,
      },
    }),
  );

  return app;
}
