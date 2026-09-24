import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { createSupabaseAdmin } from '@axiom/supabase';
import {
  AttestConnectorGrantRequestSchema,
  Capability,
  IssueConnectorGrantRequestSchema,
} from '@axiom/types';
import { requireCapability } from '../middleware/authorize.js';
import type { Variables } from '../types.js';

const failures: Record<string, [400 | 403 | 404 | 409, string]> = {
  forbidden: [403, 'Only owners and admins can review agent access.'],
  not_found: [404, 'Not found in this organization.'],
  invalid_decision: [400, 'Choose keep or revoke.'],
  not_active: [409, 'This grant is already revoked or expired.'],
  invalid_request: [400, 'Check the grant fields.'],
  connector_inactive: [409, 'Enable the connector, its system and its estate first.'],
  workload_inactive: [409, 'That workload identity is disabled.'],
  agent_scope_refused: [403, 'Only Drishti may read and only Karya may write.'],
  write_requires_production: [409, 'Write access needs a production connector binding.'],
  grant_exists: [409, 'That agent already holds an active grant on this connector.'],
};
const unavailable = {
  error: { code: 'sustenance_unavailable', message: 'Retry this same request.' },
};
const id = z.uuid();

/**
 * C-W3-6 sustenance: estate drift against the last completed onboarding and
 * periodic human re-attestation of agent grants. Revocation is the only
 * authority change; nothing here issues or extends a grant.
 */
export function sustenanceRoutes(deps: { client?: typeof createSupabaseAdmin } = {}) {
  const app = new Hono<{ Variables: Variables }>();
  const db = () => (deps.client ?? createSupabaseAdmin)();

  app.get('/estates/:id/drift', async (c) => {
    const denied = requireCapability(c, Capability.POSTURE_READ);
    if (denied) return denied;
    if (!id.safeParse(c.req.param('id')).success)
      return c.json({ error: { code: 'invalid_id' } }, 400);
    const { data, error } = await db().rpc('onboarding_estate_drift', {
      p_tenant_id: c.get('tenantId'),
      p_estate_id: c.req.param('id'),
    });
    if (error || !data) return c.json(unavailable, 503);
    if (data.error === 'not_found')
      return c.json({ error: { code: 'not_found', message: failures.not_found![1] } }, 404);
    return c.json({ data });
  });

  app.get('/connector-grants/review', async (c) => {
    const denied = requireCapability(c, Capability.POSTURE_READ);
    if (denied) return denied;
    const { data, error } = await db().rpc('connector_grant_review_queue', {
      p_tenant_id: c.get('tenantId'),
    });
    if (error || !Array.isArray(data)) return c.json(unavailable, 503);
    return c.json({ data });
  });

  app.post('/connector-grants/:id/attestations', async (c) => {
    const denied = requireCapability(c, Capability.CONNECTOR_MANAGE);
    if (denied) return denied;
    if (!id.safeParse(c.req.param('id')).success)
      return c.json({ error: { code: 'invalid_id' } }, 400);
    const parsed = AttestConnectorGrantRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json({ error: { code: 'invalid_request', message: 'Choose keep or revoke.' } }, 400);
    const { data, error } = await db().rpc('attest_connector_grant', {
      p_tenant_id: c.get('tenantId'),
      p_actor_id: c.get('user').id,
      p_grant_id: c.req.param('id'),
      p_decision: parsed.data.decision,
      p_correlation_id: randomUUID(),
    });
    if (error || !data) return c.json(unavailable, 503);
    if (data.error) {
      const failure = failures[String(data.error)];
      if (!failure) return c.json(unavailable, 503);
      return c.json({ error: { code: data.error, message: failure[1] } }, failure[0]);
    }
    return c.json({ data: data.attestation }, 201);
  });
  // W4.4: issuing access is a separate, audited human act. It obtains no
  // credential and contacts no target; the broker re-resolves it per call.
  app.post('/connector-grants', async (c) => {
    const denied = requireCapability(c, Capability.CONNECTOR_MANAGE);
    if (denied) return denied;
    const parsed = IssueConnectorGrantRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: { code: 'invalid_request', message: failures.invalid_request![1] } },
        400,
      );
    const { data, error } = await db().rpc('issue_connector_grant', {
      p_tenant_id: c.get('tenantId'),
      p_actor_id: c.get('user').id,
      p_connector_id: parsed.data.connectorId,
      p_workload_identity_id: parsed.data.workloadIdentityId,
      p_scope: parsed.data.scope,
      p_target_scopes: parsed.data.targetScopes,
      p_ttl_days: parsed.data.ttlDays,
      p_correlation_id: randomUUID(),
    });
    if (error || !data) return c.json(unavailable, 503);
    if (data.error) {
      const failure = failures[String(data.error)];
      if (!failure) return c.json(unavailable, 503);
      return c.json({ error: { code: data.error, message: failure[1] } }, failure[0]);
    }
    return c.json({ data: data.grant }, 201);
  });
  return app;
}
