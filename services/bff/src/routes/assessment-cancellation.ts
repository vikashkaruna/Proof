import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { createSupabaseAdmin, createHumanActionWriter } from '@axiom/supabase';
import { AssessmentRequestSchema, ASSESSMENT_REQUEST_MAX_BYTES, Capability } from '@axiom/types';
import { requireCapability } from '../middleware/authorize.js';
import { boundedJsonBody } from '../middleware/evidence-body-limit.js';
import { canonicalAssessmentInput } from '../workloads/assessment-input.js';
import type { Variables } from '../types.js';

export function assessmentCancellationRoutes() {
  const app = new Hono<{ Variables: Variables }>();
  app.use('/assessment/jobs/:jobId/cancel', boundedJsonBody(ASSESSMENT_REQUEST_MAX_BYTES));
  app.post('/assessment/jobs/:jobId/cancel', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    for (const capability of [Capability.ASSESSMENT_RUN, Capability.AGENT_INVOKE]) {
      const denied = requireCapability(c, capability);
      if (denied) return denied;
    }
    const actorId = c.get('user').id.toLowerCase();
    const expected = z.uuid().safeParse(c.req.header('X-Expected-Actor-Id'));
    if (!expected.success) return c.json({ error: { code: 'expected_actor_required' } }, 400);
    if (expected.data.toLowerCase() !== actorId)
      return c.json({ error: { code: 'assessment_actor_changed' } }, 409);
    const input = AssessmentRequestSchema.safeParse(await c.req.json().catch(() => null));
    const jobId = z.uuid().safeParse(c.req.param('jobId'));
    const key = z.uuid().safeParse(c.req.header('Idempotency-Key'));
    if (
      !input.success ||
      !jobId.success ||
      !key.success ||
      [...new URL(c.req.url).searchParams].length ||
      input.data.operationKey.toLowerCase() !== jobId.data.toLowerCase() ||
      key.data.toLowerCase() !== jobId.data.toLowerCase()
    )
      return c.json({ error: { code: 'invalid_assessment_cancellation' } }, 400);
    const tenantId = c.get('tenantId').toLowerCase();
    const unavailable = { error: { code: 'assessment_cancellation_unconfirmed' } };
    try {
      const read = await createSupabaseAdmin()
        .from('engagements')
        .select('id,tenant_id,library_version')
        .eq('tenant_id', tenantId)
        .eq('id', input.data.engagementId.toLowerCase())
        .abortSignal(AbortSignal.timeout(10000))
        .maybeSingle();
      if (read.error) return c.json(unavailable, 503);
      if (!read.data) return c.json({ error: { code: 'assessment_engagement_not_found' } }, 404);
      const engagement = z
        .object({ id: z.uuid(), tenant_id: z.uuid(), library_version: z.string().min(1).max(200) })
        .parse(read.data);
      if (
        engagement.tenant_id !== tenantId ||
        engagement.id !== input.data.engagementId.toLowerCase()
      )
        return c.json(unavailable, 503);
      const body = canonicalAssessmentInput(
        tenantId,
        engagement.id,
        engagement.library_version,
        input.data,
      );
      if (Buffer.byteLength(body, 'utf8') > ASSESSMENT_REQUEST_MAX_BYTES)
        return c.json({ error: { code: 'invalid_assessment_cancellation' } }, 400);
      const result = await createHumanActionWriter()
        .rpc('cancel_unclaimed_assessment_request', {
          p_tenant_id: tenantId,
          p_actor_id: actorId,
          p_job_id: jobId.data.toLowerCase(),
          p_engagement_id: engagement.id,
          p_library_version: engagement.library_version,
          p_input_hash: createHash('sha256').update(body, 'utf8').digest('hex'),
        })
        .abortSignal(AbortSignal.timeout(10000));
      if (result.error) return c.json(unavailable, 503);
      const refused = z
        .object({
          error: z.enum([
            'invalid_cancellation',
            'forbidden',
            'kill_switch_engaged',
            'assessment_job_not_found',
            'cancellation_conflict',
            'cancellation_unavailable',
            'assessment_already_started',
            'assessment_not_unclaimed',
          ]),
        })
        .strict()
        .safeParse(result.data);
      if (refused.success)
        return c.json(
          { error: { code: refused.data.error } },
          refused.data.error === 'forbidden'
            ? 403
            : refused.data.error === 'assessment_job_not_found'
              ? 404
              : 409,
        );
      const receipt = z
        .object({
          job_id: z.uuid(),
          run_id: z.uuid(),
          cancellation_receipt: z.string().regex(/^[1-9][0-9]{0,18}$/),
          resolved_at: z.iso.datetime({ offset: true }),
        })
        .strict()
        .parse(result.data);
      if (receipt.job_id !== jobId.data.toLowerCase()) return c.json(unavailable, 503);
      return c.json(
        {
          jobId: receipt.job_id,
          runId: receipt.run_id,
          cancellationReceipt: receipt.cancellation_receipt,
          resolvedAt: receipt.resolved_at,
          status: 'cancellation_recorded',
        },
        202,
      );
    } catch {
      return c.json(unavailable, 503);
    }
  });
  return app;
}
