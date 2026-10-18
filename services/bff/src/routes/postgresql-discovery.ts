import { Hono } from 'hono';
import { z } from 'zod';
import { createHumanActionWriter, createSupabaseAdmin } from '@axiom/supabase';
import { Capability } from '@axiom/types';
import { requireCapability } from '../middleware/authorize.js';
import type { Variables } from '../types.js';
import type { DiscoveryOutcome } from '../workloads/discovery-channel.js';
export interface DiscoveryRequestController {
  run(tenantId: string, requestId: string): Promise<DiscoveryOutcome>;
}
export function postgresqlDiscoveryRoutes(controller?: DiscoveryRequestController) {
  const app = new Hono<{ Variables: Variables }>();
  app.get('/connectors/:id/discovery', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.POSTURE_READ);
    if (denied) return denied;
    const id = z.uuid().safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: { code: 'invalid_id' } }, 400);
    const db = createSupabaseAdmin();
    const rows = await db
      .from('postgresql_discovery_requests')
      .select(
        'id,connector_id,estate_id,engagement_id,operation,resource,status,requested_at,expires_at,completed_at,cleanup_confirmed,error_code,discovery_run_id',
      )
      .eq('tenant_id', c.get('tenantId'))
      .eq('connector_id', id.data)
      .order('requested_at', { ascending: false })
      .limit(30);
    if (rows.error || !rows.data) return c.json({ error: { code: 'discovery_unavailable' } }, 503);
    const ids = rows.data
      .filter((row) => row.status === 'completed' && typeof row.discovery_run_id === 'string')
      .map((row) => String(row.discovery_run_id));
    const results = ids.length
      ? await db
          .from('connector_discovery_runs')
          .select('id,record_count,result,created_at')
          .eq('tenant_id', c.get('tenantId'))
          .in('id', ids)
      : { data: [], error: null };
    if (results.error || !results.data)
      return c.json({ error: { code: 'discovery_unavailable' } }, 503);
    return c.json({
      data: rows.data.map((row) => ({
        ...row,
        result:
          row.status === 'completed'
            ? (results.data.find((result) => result.id === row.discovery_run_id) ?? null)
            : null,
      })),
      available: !!controller,
    });
  });
  app.post('/connectors/:id/discovery', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.CONNECTOR_MANAGE);
    if (denied) return denied;
    if (!controller) return c.json({ error: { code: 'discovery_unavailable' } }, 503);
    const id = z.uuid().safeParse(c.req.param('id'));
    const body = z
      .object({
        operationKey: z.uuid(),
        estateId: z.uuid(),
        engagementId: z.uuid(),
        operation: z.enum(['enumerate', 'sample']),
        resource: z
          .string()
          .regex(/^[a-z_][a-z0-9_$]{0,62}\.[a-z_][a-z0-9_$]{0,62}$/)
          .optional(),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().min(1).max(500).optional(),
      })
      .strict()
      .refine(
        (r) => (r.operation === 'sample') === (r.resource !== undefined && r.limit !== undefined),
      )
      .safeParse(await c.req.json().catch(() => null));
    if (!id.success || !body.success) return c.json({ error: { code: 'invalid_request' } }, 400);
    const t = c.get('tenantId'),
      a = c.get('user').id,
      j = body.data.operationKey.toLowerCase(),
      writer = createHumanActionWriter();
    const saved = await writer
      .rpc('request_postgresql_discovery', {
        t,
        a,
        c: id.data.toLowerCase(),
        j,
        e: body.data.estateId.toLowerCase(),
        engagement: body.data.engagementId.toLowerCase(),
        op: body.data.operation,
        resource: body.data.resource ?? null,
        lim: body.data.limit ?? null,
        cursor: body.data.cursor ?? null,
      })
      .abortSignal(AbortSignal.timeout(10000));
    const accepted = z
      .object({ requestId: z.literal(j), status: z.string(), replayed: z.boolean() })
      .strict()
      .safeParse(saved.error ? null : saved.data);
    if (!accepted.success)
      return c.json(
        {
          error: {
            code: 'discovery_refused',
            message: 'Check the active connector grant, sandbox enrollment and custody policy.',
          },
        },
        409,
      );
    if (accepted.data.replayed) return c.json({ data: accepted.data });
    let clean = false;
    try {
      const result = await controller.run(t, j);
      clean = result.cleanupConfirmed && result.workerStatus === 'read_completed';
    } catch {
      /* Same retained operation is inspectable; never launch a retry. */
    }
    const finished = await writer
      .rpc('finish_postgresql_discovery', { t, a, j, clean })
      .abortSignal(AbortSignal.timeout(10000));
    const result = z
      .object({ requestId: z.literal(j), status: z.enum(['completed', 'failed', 'unconfirmed']) })
      .strict()
      .safeParse(finished.error ? null : finished.data);
    if (!result.success) return c.json({ data: { requestId: j, status: 'unconfirmed' } }, 202);
    return c.json({ data: result.data }, result.data.status === 'completed' ? 200 : 202);
  });
  return app;
}
