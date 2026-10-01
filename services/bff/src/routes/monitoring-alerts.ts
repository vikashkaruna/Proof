/**
 * W6 Continuous Alerting Routes
 *
 * Endpoints for listing, dispatching, and acknowledging continuous monitoring alerts.
 */
import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { Capability } from '@axiom/types';
import { createHumanActionWriter, createSupabaseAdmin } from '@axiom/supabase';
import { requireCapability } from '../middleware/authorize.js';
import type { Variables } from '../types.js';
import { EvidenceError, type EvidenceDatabase } from '../services/evidence-ingestion.js';
import { MonitoringAlertsService, listAlertsQuerySchema } from '../services/monitoring-alerts.js';

type Ctx = Context<{ Variables: Variables }>;

function failure(c: Ctx, cause: unknown) {
  if (cause instanceof EvidenceError) {
    return c.json({ error: { code: cause.code } }, cause.status);
  }
  return c.json({ error: { code: 'database_unavailable' } }, 503);
}

function invalid(c: Ctx, message?: string) {
  return c.json({ error: { code: 'validation_failed', message } }, 400);
}

export function monitoringAlertRoutes(
  dependencies: { db?: EvidenceDatabase; service?: MonitoringAlertsService } = {},
) {
  const app = new Hono<{ Variables: Variables }>();
  const service = () =>
    dependencies.service ??
    new MonitoringAlertsService(
      dependencies.db ?? createSupabaseAdmin(),
      dependencies.db ?? createHumanActionWriter(),
    );

  // ─── 1. List Alerts ──────────────────────────────────────────────────
  app.get('/monitoring/alerts', async (c) => {
    const denied = requireCapability(c, Capability.POSTURE_READ);
    if (denied) return denied;

    const parsed = listAlertsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return invalid(c, 'Invalid query parameters');

    try {
      const result = await service().listAlerts(c.get('tenantId'), parsed.data);
      return c.json({ data: result });
    } catch (cause) {
      return failure(c, cause);
    }
  });

  // ─── 2. Dispatch Alerts ──────────────────────────────────────────────
  app.post('/monitoring/alerts/dispatch', async (c) => {
    const denied = requireCapability(c, Capability.ESTATE_MANAGE);
    if (denied) return denied;

    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]);
    const correlationId = randomUUID();

    try {
      const result = await service().dispatchAlerts(c.get('tenantId'), correlationId, signal);
      return c.json({ data: result });
    } catch (cause) {
      return failure(c, cause);
    }
  });

  // ─── 3. Dismiss Alert ────────────────────────────────────────────────
  app.post('/monitoring/alerts/:id/dismiss', async (c) => {
    const denied = requireCapability(c, Capability.ESTATE_MANAGE);
    if (denied) return denied;

    const alertId = c.req.param('id');
    if (!z.string().uuid().safeParse(alertId).success) {
      return invalid(c, 'Invalid alert id');
    }

    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]);
    const correlationId = randomUUID();

    try {
      const result = await service().dismissAlert(
        c.get('tenantId'),
        alertId,
        c.get('user').id,
        correlationId,
        signal,
      );
      return c.json({ data: result });
    } catch (cause) {
      return failure(c, cause);
    }
  });

  return app;
}
