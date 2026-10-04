import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { createHumanActionWriter } from '@axiom/supabase';
import { canonicalJson, sha256 } from '@axiom/ledger';
import {
  Capability,
  createPublicSourceBindingSchema,
  publicSourcePreviewSchema,
  recordedPublicSourceBindingSchema,
} from '@axiom/types';
import { requireCapability } from '../middleware/authorize.js';
import type { Variables } from '../types.js';

type Ctx = Context<{ Variables: Variables }>;
const uuid = z.uuid().transform((value) => value.toLowerCase());
const errorSchema = z
  .object({
    error: z.enum([
      'invalid_record',
      'forbidden',
      'context_refused',
      'source_refused',
      'stale_source',
      'binding_conflict',
    ]),
  })
  .strict();
const errorStatus = {
  invalid_record: 400,
  forbidden: 403,
  context_refused: 404,
  source_refused: 422,
  stale_source: 409,
  binding_conflict: 409,
} as const;

function refusal(c: Ctx, value: unknown) {
  const parsed = errorSchema.safeParse(value);
  return parsed.success
    ? c.json({ error: { code: parsed.data.error } }, errorStatus[parsed.data.error])
    : c.json({ error: { code: 'public_source_unavailable' } }, 503);
}

/** Source facts come only from the retained check; callers cannot supply inventory. */
export function publicSourceBindingRoutes() {
  const app = new Hono<{ Variables: Variables }>();
  app.get('/public-website-checks/:checkId/source-preview', async (c) => {
    const denied = requireCapability(c, Capability.POSTURE_READ);
    if (denied) return denied;
    c.header('Cache-Control', 'private, no-store');
    const check = uuid.safeParse(c.req.param('checkId'));
    const engagement = uuid.safeParse(c.req.query('engagementId'));
    if (!check.success || !engagement.success)
      return c.json({ error: { code: 'invalid_request' } }, 400);
    try {
      const { data, error } = await createHumanActionWriter().rpc('get_public_source_projection', {
        p_tenant_id: c.get('tenantId'),
        p_actor_id: c.get('user').id,
        p_engagement_id: engagement.data,
        p_check_id: check.data,
      });
      if (error) return refusal(c, null);
      const parsed = publicSourcePreviewSchema.safeParse(data);
      if (!parsed.success) return refusal(c, data);
      const binding = parsed.data.runtime_binding;
      if (
        binding.tenant_id !== c.get('tenantId').toLowerCase() ||
        binding.engagement_id !== engagement.data ||
        binding.check_id !== check.data
      )
        return refusal(c, null);
      return c.json({ data: parsed.data });
    } catch {
      return refusal(c, null);
    }
  });

  app.post('/public-source-bindings', async (c) => {
    const denied = requireCapability(c, Capability.AGENT_INVOKE);
    if (denied) return denied;
    c.header('Cache-Control', 'private, no-store');
    const body = createPublicSourceBindingSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: { code: 'invalid_request' } }, 400);
    const key = c.get('idempotencyKey');
    if (!key) return c.json({ error: { code: 'invalid_request' } }, 400);
    // Stable across a lost response, scoped to this operation and authenticated actor.
    // This UUID is a correlation identifier; it conveys no authority or source digest.
    const hex = await sha256(
      canonicalJson({
        version: 1,
        operation: 'public_source_binding',
        tenant: c.get('tenantId').toLowerCase(),
        actor: c.get('user').id.toLowerCase(),
        key,
      }),
    );
    const correlation = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    try {
      const { data, error } = await createHumanActionWriter().rpc('record_public_source_binding', {
        p_tenant_id: c.get('tenantId'),
        p_actor_id: c.get('user').id,
        p_engagement_id: body.data.engagementId,
        p_check_id: body.data.checkId,
        p_expected_root_sha256: body.data.expectedRootSha256,
        p_expected_projection_sha256: body.data.expectedProjectionSha256,
        p_correlation_id: correlation,
      });
      if (error) return refusal(c, null);
      const parsed = recordedPublicSourceBindingSchema.safeParse(data);
      if (!parsed.success) return refusal(c, data);
      const binding = parsed.data.runtime_binding;
      if (
        binding.tenant_id !== c.get('tenantId').toLowerCase() ||
        binding.engagement_id !== body.data.engagementId ||
        binding.check_id !== body.data.checkId ||
        binding.root_content_sha256 !== body.data.expectedRootSha256 ||
        binding.projection_sha256 !== body.data.expectedProjectionSha256
      )
        return refusal(c, null);
      return c.json({ data: parsed.data }, parsed.data.created ? 201 : 200);
    } catch {
      return refusal(c, null);
    }
  });
  return app;
}
