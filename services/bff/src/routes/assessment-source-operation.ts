import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { canonicalJson } from '@axiom/ledger';
import { parseCatalogueJson } from '@axiom/control-library';
import { createHumanActionWriter, createSupabaseAdmin } from '@axiom/supabase';
import {
  AssessmentRequestSchema,
  assessmentSourceOperationSchema,
  cancelAssessmentSourceIntentSchema,
  Capability,
  type AssessmentRequest,
} from '@axiom/types';
import { requireCapability } from '../middleware/authorize.js';
import { boundedJsonBody } from '../middleware/evidence-body-limit.js';
import type { Variables } from '../types.js';
const hash = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const uuid = z.uuid().transform((v) => v.toLowerCase());
const selection = z
  .object({
    engagementId: uuid,
    reviewId: uuid,
    requestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export function verifyAssessmentSourceOperation(
  raw: unknown,
  tenantId: string,
  actorId: string,
  request: AssessmentRequest,
) {
  const state = assessmentSourceOperationSchema.parse(raw);
  if (state.state === 'recorded') {
    if (state.jobId !== request.operationKey) throw new Error('source_operation_refused');
  } else if (state.state === 'cancelled') {
    const row = state.data;
    if (
      row.tenant_id !== tenantId ||
      row.actor_id !== actorId ||
      row.job_id !== request.operationKey ||
      row.engagement_id !== request.engagementId ||
      row.request_text !== canonicalJson(request) ||
      hash(row.request_text) !== row.request_sha256 ||
      hash(row.cancellation_text) !== row.cancellation_sha256 ||
      row.cancellation_text !==
        canonicalJson({
          version: 1,
          tenantId,
          actorId,
          jobId: row.job_id,
          engagementId: row.engagement_id,
          requestSha256: row.request_sha256,
          reason: row.reason,
        })
    )
      throw new Error('source_operation_refused');
  }
  return state;
}
export function assessmentSourceOperationRoutes() {
  const app = new Hono<{ Variables: Variables }>();
  app.get('/assessment/jobs/:jobId/source-operation', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.POSTURE_READ);
    if (denied) return denied;
    let request: AssessmentRequest;
    try {
      if (Object.values(c.req.queries()).some((v) => v.length !== 1)) throw new Error();
      const q = selection.parse(c.req.query());
      request = AssessmentRequestSchema.parse({
        operationKey: uuid.parse(c.req.param('jobId')),
        engagementId: q.engagementId,
        reviewRef: {
          reviewId: q.reviewId,
          requestSha256: q.requestSha256,
          snapshotSha256: q.snapshotSha256,
        },
      });
    } catch {
      return c.json({ error: { code: 'invalid_source_operation' } }, 400);
    }
    try {
      const tenant = c.get('tenantId').toLowerCase(),
        actor = c.get('user').id.toLowerCase();
      const result = await createSupabaseAdmin()
        .rpc('read_assessment_source_operation', {
          p_tenant_id: tenant,
          p_actor_id: actor,
          p_request_text: canonicalJson(request),
        })
        .abortSignal(AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(10000)]));
      if (result.error) throw new Error();
      return c.json({ data: verifyAssessmentSourceOperation(result.data, tenant, actor, request) });
    } catch {
      return c.json({ error: { code: 'assessment_source_operation_unconfirmed' } }, 503);
    }
  });
  app.use('/assessment/jobs/:jobId/cancel-source-intent', boundedJsonBody(16384));
  app.post('/assessment/jobs/:jobId/cancel-source-intent', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    for (const cap of [Capability.ASSESSMENT_RUN, Capability.AGENT_INVOKE]) {
      const denied = requireCapability(c, cap);
      if (denied) return denied;
    }
    const actor = c.get('user').id.toLowerCase();
    if (uuid.safeParse(c.req.header('X-Expected-Actor-Id')).data !== actor)
      return c.json({ error: { code: 'assessment_actor_changed' } }, 409);
    let body: z.infer<typeof cancelAssessmentSourceIntentSchema>;
    try {
      body = cancelAssessmentSourceIntentSchema.parse(
        parseCatalogueJson(await c.req.text(), 16384),
      );
      if (
        new URL(c.req.url).search ||
        c.req.param('jobId') !== body.request.operationKey ||
        c.req.header('Idempotency-Key') !== body.request.operationKey
      )
        throw new Error();
    } catch {
      return c.json({ error: { code: 'invalid_source_operation' } }, 400);
    }
    try {
      const tenant = c.get('tenantId').toLowerCase();
      const result = await createHumanActionWriter()
        .rpc('cancel_assessment_source_intent', {
          p_tenant_id: tenant,
          p_actor_id: actor,
          p_request_text: canonicalJson(body.request),
          p_reason: body.reason,
        })
        .abortSignal(AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(10000)]));
      if (result.error) throw new Error();
      const state = verifyAssessmentSourceOperation(result.data, tenant, actor, body.request);
      if (
        state.state === 'not_found' ||
        (state.state === 'cancelled' && state.data.reason !== body.reason)
      )
        throw new Error();
      return c.json({ data: state });
    } catch {
      return c.json({ error: { code: 'assessment_source_operation_unconfirmed' } }, 503);
    }
  });
  return app;
}
