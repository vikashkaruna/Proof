import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { createSupabaseAdmin } from '@axiom/supabase';
import {
  Capability,
  CreateConnectorRequestSchema,
  UpdateConnectorRequestSchema,
} from '@axiom/types';
import { requireCapability } from '../middleware/authorize.js';
import type { Variables } from '../types.js';
import { connectorRegistry } from '../connectors/registry.js';

const fields =
  'id,tenant_id,system_id,descriptor_id,target_binding,name,endpoint_ref,assurance,status,version,created_at,updated_at';
const failures = {
  forbidden: [403, 'Your role cannot manage connectors.'],
  not_found: [404, 'Connector or system not found in this tenant.'],
  version_conflict: [409, 'This registration changed. Refresh before editing.'],
  parent_archived: [
    409,
    'Restore the estate and system before enabling or editing this registration.',
  ],
  descriptor_conflict: [
    409,
    'The pinned descriptor is unavailable or differs from the reviewed catalogue.',
  ],
  invalid_transition: [
    409,
    'This lifecycle transition is not allowed. Disable before archiving; archived registrations are final.',
  ],
  disable_before_edit: [409, 'Disable the registration before editing it.'],
  invalid_operation: [400, 'Check the supplied connector fields.'],
} as const;

export function connectorRoutes() {
  const app = new Hono<{ Variables: Variables }>();
  app.get('/connector-catalogue', (c) => {
    const refused = requireCapability(c, Capability.POSTURE_READ);
    if (refused) return refused;
    return c.json({ data: [...connectorRegistry.values()], executionAvailable: false });
  });
  app.get('/connectors', async (c) => {
    const refused = requireCapability(c, Capability.POSTURE_READ);
    if (refused) return refused;
    const { data, error } = await createSupabaseAdmin()
      .from('connectors')
      .select(fields)
      .eq('tenant_id', c.get('tenantId'))
      .order('created_at');
    if (error) return c.json({ error: { code: 'connector_unavailable' } }, 503);
    return c.json({ data });
  });
  app.on(['POST', 'PATCH'], ['/connectors', '/connectors/:id'], async (c) => {
    const refused = requireCapability(c, Capability.CONNECTOR_MANAGE);
    if (refused) return refused;
    const id = c.req.param('id');
    const creating = c.req.method === 'POST' && !id;
    if (!creating && (c.req.method !== 'PATCH' || !id || !z.uuid().safeParse(id).success))
      return c.json({ error: { code: 'invalid_request' } }, 400);
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = creating
      ? CreateConnectorRequestSchema.safeParse(body)
      : UpdateConnectorRequestSchema.safeParse(body);
    if (!parsed.success)
      return c.json(
        { error: { code: 'invalid_request', message: 'Check the supplied connector fields.' } },
        400,
      );
    const payload = parsed.data;
    const db = createSupabaseAdmin();
    let descriptorId: string;
    if ('descriptorId' in payload) descriptorId = payload.descriptorId;
    else {
      const result = await db
        .from('connectors')
        .select('descriptor_id')
        .eq('tenant_id', c.get('tenantId'))
        .eq('id', id!)
        .maybeSingle();
      if (result.error) return c.json({ error: { code: 'connector_unavailable' } }, 503);
      if (!result.data) return c.json({ error: { code: 'not_found' } }, 404);
      descriptorId = result.data.descriptor_id;
    }
    const descriptor = connectorRegistry.get(descriptorId);
    if (creating && !descriptor) return c.json({ error: { code: 'unknown_descriptor' } }, 400);
    const { data, error } = await db.rpc('manage_connector', {
      p_tenant_id: c.get('tenantId'),
      p_actor_id: c.get('user').id,
      p_operation: 'operation' in payload ? payload.operation : 'create',
      p_resource_id: id ?? null,
      p_payload: payload,
      p_descriptor: descriptor ?? null,
      p_correlation_id: randomUUID(),
    });
    if (error || !data)
      return c.json(
        {
          error: {
            code: 'connector_unavailable',
            message: 'Connector storage is unavailable. Retry this same request.',
          },
        },
        503,
      );
    if (data.error) {
      const code = String(data.error);
      const failure = failures[code as keyof typeof failures];
      if (!failure) return c.json({ error: { code: 'connector_unavailable' } }, 503);
      return c.json({ error: { code, message: failure[1] } }, failure[0]);
    }
    if (!data.resource) return c.json({ error: { code: 'connector_unavailable' } }, 503);
    return c.json({ data: data.resource }, creating ? 201 : 200);
  });
  return app;
}
