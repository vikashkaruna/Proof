import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { createSupabaseAdmin } from '@axiom/supabase';
import {
  Capability,
  CreateEstateRequestSchema,
  UpdateEstateRequestSchema,
  CreateEstateSystemRequestSchema,
  UpdateEstateSystemRequestSchema,
  AssignEngagementEstateRequestSchema,
} from '@axiom/types';
import { requireCapability } from '../middleware/authorize.js';
import type { Variables } from '../types.js';

type EstateContext = Context<{ Variables: Variables }>;
const idSchema = z.uuid();
const failures = {
  forbidden: [403, 'Your role cannot manage this estate.'],
  not_found: [404, 'The requested resource was not found in this tenant.'],
  version_conflict: [409, 'This record changed. Refresh before editing again.'],
  active_connectors: [409, 'Disable active connectors before archiving.'],
  estate_archived: [409, 'Restore the estate before changing its inventory.'],
  already_assigned: [409, 'This assessment already has an estate.'],
  assessment_started: [409, 'Only an unstarted intake assessment can be assigned.'],
  confirmation_required: [400, 'Confirm the assessment scope explicitly.'],
  invalid_operation: [400, 'Invalid estate operation.'],
} as const;

async function mutate(c: EstateContext, operation: string, schema: z.ZodType) {
  const refused = requireCapability(c, Capability.ESTATE_MANAGE);
  if (refused) return refused;
  const id = c.req.param('id');
  if (id && !idSchema.safeParse(id).success) return c.json({ error: { code: 'invalid_id' } }, 400);
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json(
      {
        error: {
          code: 'invalid_request',
          message: 'Check the supplied estate fields.',
          issues: parsed.error.issues,
        },
      },
      400,
    );
  const { data, error } = await createSupabaseAdmin().rpc('manage_estate', {
    p_tenant_id: c.get('tenantId'),
    p_actor_id: c.get('user').id,
    p_operation: operation,
    p_resource_id: id ?? null,
    p_payload: parsed.data,
    p_correlation_id: randomUUID(),
  });
  if (error) {
    if (error.code === '23505')
      return c.json(
        { error: { code: 'duplicate', message: 'That estate slug is already in use.' } },
        409,
      );
    return c.json(
      {
        error: {
          code: 'estate_unavailable',
          message: 'Estate storage is unavailable. Retry this same request.',
        },
      },
      503,
    );
  }
  if (data?.error) {
    const code = String(data.error);
    const failure = failures[code as keyof typeof failures];
    if (!failure) return c.json({ error: { code: 'estate_unavailable' } }, 503);
    return c.json({ error: { code, message: failure[1] } }, failure[0]);
  }
  if (!data?.resource) return c.json({ error: { code: 'estate_unavailable' } }, 503);
  return c.json({ data: data.resource }, operation.endsWith('.create') ? 201 : 200);
}

/** Human inventory management; does not issue agent or connector authority. */
export function estateRoutes() {
  const app = new Hono<{ Variables: Variables }>();
  app.get('/estates', async (c) => {
    const refused = requireCapability(c, Capability.POSTURE_READ);
    if (refused) return refused;
    const { data, error } = await createSupabaseAdmin()
      .from('estates')
      .select('*')
      .eq('tenant_id', c.get('tenantId'))
      .order('created_at', { ascending: false });
    if (error) return c.json({ error: { code: 'estate_unavailable' } }, 503);
    return c.json({ data });
  });
  app.get('/estates/:id', async (c) => {
    const refused = requireCapability(c, Capability.POSTURE_READ);
    if (refused) return refused;
    if (!idSchema.safeParse(c.req.param('id')).success)
      return c.json({ error: { code: 'invalid_id' } }, 400);
    const db = createSupabaseAdmin();
    const tenant = c.get('tenantId');
    const { data: estate, error } = await db
      .from('estates')
      .select('*')
      .eq('tenant_id', tenant)
      .eq('id', c.req.param('id'))
      .maybeSingle();
    if (error) return c.json({ error: { code: 'estate_unavailable' } }, 503);
    if (!estate) return c.json({ error: { code: 'not_found' } }, 404);
    const { data: systems, error: systemError } = await db
      .from('estate_systems')
      .select('*,system_data_categories(category_key,source)')
      .eq('tenant_id', tenant)
      .eq('estate_id', estate.id)
      .order('created_at');
    if (systemError) return c.json({ error: { code: 'estate_unavailable' } }, 503);
    return c.json({ data: { ...estate, systems } });
  });
  app.post('/estates', (c) => mutate(c, 'estate.create', CreateEstateRequestSchema));
  app.patch('/estates/:id', (c) => mutate(c, 'estate.update', UpdateEstateRequestSchema));
  app.post('/estates/:id/systems', (c) =>
    mutate(c, 'system.create', CreateEstateSystemRequestSchema),
  );
  app.patch('/estate-systems/:id', (c) =>
    mutate(c, 'system.update', UpdateEstateSystemRequestSchema),
  );
  app.post('/engagements/:id/estate', (c) =>
    mutate(c, 'engagement.assign', AssignEngagementEstateRequestSchema),
  );
  return app;
}
