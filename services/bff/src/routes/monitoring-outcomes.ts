import { Hono } from 'hono';
import { Capability, monitoringOutcomeRequestSchema } from '@axiom/types';
import { requireCapability } from '../middleware/authorize.js';
import { loadMonitoringOutcomes } from '../services/monitoring-outcomes.js';
import type { Variables } from '../types.js';
export function monitoringOutcomeRoutes() {
  const app = new Hono<{ Variables: Variables }>();
  app.get('/monitoring/outcomes', async (c) => {
    const refusal = requireCapability(c, Capability.POSTURE_READ);
    if (refusal) return refusal;
    const query = c.req.queries();
    const ids = query.scheduleIds?.length === 1 ? query.scheduleIds[0] : undefined;
    const request = monitoringOutcomeRequestSchema.safeParse({
      tenantId: c.get('tenantId'),
      scheduleIds: ids === '' ? [] : ids?.split(','),
    });
    if (!request.success || Object.keys(query).some((k) => k !== 'scheduleIds'))
      return c.json(
        { error: { code: 'validation_failed', message: 'Invalid schedule selection' } },
        400,
      );
    const outcomes = await loadMonitoringOutcomes(
      request.data.tenantId,
      c.get('token'),
      request.data.scheduleIds,
    );
    if (!outcomes)
      return c.json(
        {
          error: {
            code: 'monitoring_outcomes_unavailable',
            message: 'Recorded monitoring outcomes are unavailable',
          },
        },
        503,
      );
    return c.json({ data: outcomes });
  });
  return app;
}
