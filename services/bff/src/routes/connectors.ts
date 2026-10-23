import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { createHumanActionWriter, createSupabaseAdmin } from '@axiom/supabase';
import {
  Capability,
  CreateConnectorRequestSchema,
  UpdateConnectorRequestSchema,
} from '@axiom/types';
import { requireCapability } from '../middleware/authorize.js';
import type { Variables } from '../types.js';
import { connectorRegistry } from '../connectors/registry.js';
import { connectorCatalogue } from '../connectors/framework/plugins.js';

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
    // `entries` is the plug-in catalogue view of the same reviewed descriptors:
    // a display name and family per row, never an endpoint or credential.
    return c.json({
      data: [...connectorRegistry.values()],
      entries: connectorCatalogue(connectorRegistry),
      executionAvailable: false,
    });
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
  // A status refresh is read-only. In particular it never contacts a target,
  // unwraps a credential, or represents a registration as a live connection.
  app.get('/connectors/:id/readiness', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const refused = requireCapability(c, Capability.POSTURE_READ);
    if (refused) return refused;
    const id = c.req.param('id');
    if (!z.uuid().safeParse(id).success) return c.json({ error: { code: 'invalid_id' } }, 400);
    const db = createSupabaseAdmin();
    const { data: connector, error: connectorError } = await db
      .from('connectors')
      .select('id,status')
      .eq('tenant_id', c.get('tenantId'))
      .eq('id', id)
      .maybeSingle();
    if (connectorError) return c.json({ error: { code: 'connector_unavailable' } }, 503);
    if (!connector) return c.json({ error: { code: 'not_found' } }, 404);
    const [credentials, grants, checks] = await Promise.all([
      db
        .from('connector_credentials')
        .select('id,expires_at')
        .eq('tenant_id', c.get('tenantId'))
        .eq('connector_id', id)
        .is('revoked_at', null),
      db
        .from('connector_grants')
        .select('id,internal_scope,expires_at')
        .eq('tenant_id', c.get('tenantId'))
        .eq('connector_id', id)
        .is('revoked_at', null),
      db
        .from('connector_health_checks')
        .select('status,checked_at,error_code')
        .eq('tenant_id', c.get('tenantId'))
        .eq('connector_id', id)
        .order('checked_at', { ascending: false })
        .limit(1),
    ]);
    if (
      credentials.error ||
      grants.error ||
      checks.error ||
      !credentials.data ||
      !grants.data ||
      !checks.data
    )
      return c.json({ error: { code: 'connector_unavailable' } }, 503);
    const now = Date.now();
    const isCurrent = (expiresAt: string | null) =>
      expiresAt === null || Date.parse(expiresAt) > now;
    const credentialConfigured = credentials.data.some((row) => isCurrent(row.expires_at));
    const readGrantConfigured = grants.data.some(
      (row) => row.internal_scope === 'connector.read' && isCurrent(row.expires_at),
    );
    return c.json({
      data: {
        connectorId: id,
        registrationStatus: connector.status,
        credentialConfigured,
        readGrantConfigured,
        lastObservation: checks.data[0]
          ? {
              status: checks.data[0].status,
              checked_at: checks.data[0].checked_at,
              error_code: checks.data[0].error_code ?? null,
            }
          : null,
        liveCheckAvailable: false,
      },
    });
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
    const { data, error } = await createHumanActionWriter().rpc('manage_connector', {
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
