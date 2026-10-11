import { Hono } from 'hono';
import { z } from 'zod';
import { createHumanActionWriter } from '@axiom/supabase';
import { Capability, workflowRecordSchema } from '@axiom/types';
import { requireCapability } from '../middleware/authorize.js';
import type { Variables } from '../types.js';
import type { EvidenceDatabase } from '../services/evidence-ingestion.js';
import { composePolicyPreview, generatedPolicyKindSchema } from '../services/policy-preview.js';

const querySchema = z
  .object({
    ropaId: z.uuid().transform((v) => v.toLowerCase()),
    category: generatedPolicyKindSchema,
  })
  .strict();
export function policyPreviewRoutes(deps: { writer?: Pick<EvidenceDatabase, 'rpc'> } = {}) {
  const app = new Hono<{ Variables: Variables }>();
  app.get('/operator-workflows/policy-preview', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.POSTURE_READ);
    if (denied) return denied;
    const query = querySchema.safeParse(c.req.query());
    if (!query.success || Object.values(c.req.queries()).some((v) => v.length !== 1))
      return c.json({ error: { code: 'invalid_request' } }, 400);
    try {
      const writer = deps.writer ?? createHumanActionWriter();
      const { data, error } = await writer
        .rpc('read_operator_workflow', {
          p_tenant_id: c.get('tenantId'),
          p_actor_id: c.get('user').id,
          p_record_id: query.data.ropaId,
        })
        .abortSignal(AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]));
      if (error) return c.json({ error: { code: 'policy_preview_unavailable' } }, 503);
      const refusal = z
        .object({
          error: z.enum(['forbidden', 'context_refused', 'source_refused', 'record_not_found']),
        })
        .strict()
        .safeParse(data);
      if (refusal.success)
        return c.json(
          { error: { code: refusal.data.error } },
          refusal.data.error === 'forbidden' ? 403 : 404,
        );
      const result = z.object({ data: workflowRecordSchema }).strict().safeParse(data);
      if (!result.success) return c.json({ error: { code: 'processing_source_refused' } }, 404);
      const record = result.data.data;
      if (
        record.tenant_id !== c.get('tenantId').toLowerCase() ||
        record.id !== query.data.ropaId ||
        record.kind !== 'ropa'
      )
        return c.json({ error: { code: 'processing_source_refused' } }, 404);
      return c.json({ data: composePolicyPreview(record, query.data.category) });
    } catch {
      return c.json({ error: { code: 'policy_preview_unavailable' } }, 503);
    }
  });
  return app;
}
