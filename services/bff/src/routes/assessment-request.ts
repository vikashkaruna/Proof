import { canonicalJson } from '@axiom/ledger';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  AssessmentRequestSchema,
  AssessmentConfigurationSchema,
  AssessmentRequestReceiptSchema,
  ASSESSMENT_REQUEST_MAX_BYTES,
  Capability,
  AssessmentSourceRefusalSchema,
  AssessmentSourceRequirementSchema,
} from '@axiom/types';
import type { Variables } from '../types.js';
import { assessmentSourceOperationRoutes } from './assessment-source-operation.js';
import { assessmentCancellationRoutes } from './assessment-cancellation.js';
import { requireCapability } from '../middleware/authorize.js';
import { boundedJsonBody } from '../middleware/evidence-body-limit.js';
import {
  AssessmentQuestionnaireRefused,
  AssessmentContextRefused,
  type AssessmentRequestProducer,
} from '../workloads/assessment-producer.js';

/** Human request boundary only; a 202 is acknowledgment, never controller completion. */
export function assessmentRequestRoutes(producer?: AssessmentRequestProducer) {
  const app = new Hono<{ Variables: Variables }>();
  app.route('/', assessmentCancellationRoutes());
  app.route('/', assessmentSourceOperationRoutes());
  app.get('/assessment/configuration', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.POSTURE_READ);
    if (denied) return denied;
    if (new URL(c.req.url).search) return c.json({ error: { code: 'invalid_request' } }, 400);
    const tenantId = c.get('tenantId').toLowerCase();
    let configuration: 'configured' | 'unconfigured' | 'unknown' = 'unknown';
    try {
      configuration = !producer
        ? 'unconfigured'
        : !producer.configurationForTenant
          ? 'unknown'
          : producer.configurationForTenant(tenantId)
            ? 'configured'
            : 'unconfigured';
    } catch {
      configuration = 'unknown';
    }
    let sourceRequirement:
      'public_control_review_required' | 'questionnaire_or_public_review' | 'unknown' = 'unknown';
    try {
      sourceRequirement = AssessmentSourceRequirementSchema.parse(
        (await producer?.sourceRequirementForTenant?.(tenantId)) ?? 'unknown',
      );
    } catch {
      /* Unverified producer requirement stays unknown. */
    }
    return c.json(
      AssessmentConfigurationSchema.parse({
        tenantId,
        configuration,
        executionReadiness: 'not_verified',
        sourceRequirement,
      }),
    );
  });

  app.use('/assessment/jobs', boundedJsonBody(ASSESSMENT_REQUEST_MAX_BYTES));
  app.post('/assessment/jobs', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    for (const capability of [Capability.ASSESSMENT_RUN, Capability.AGENT_INVOKE]) {
      const denied = requireCapability(c, capability);
      if (denied) return denied;
    }
    const expected = z.uuid().safeParse(c.req.header('X-Expected-Actor-Id'));
    if (!expected.success) return c.json({ error: { code: 'expected_actor_required' } }, 400);
    const actorId = c.get('user').id.toLowerCase();
    if (expected.data.toLowerCase() !== actorId)
      return c.json({ error: { code: 'assessment_actor_changed' } }, 409);
    const parsed = AssessmentRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || [...new URL(c.req.url).searchParams].length)
      return c.json({ error: { code: 'invalid_assessment_request' } }, 400);
    const key = z.uuid().safeParse(c.req.header('Idempotency-Key'));
    if (!key.success || key.data.toLowerCase() !== parsed.data.operationKey.toLowerCase())
      return c.json({ error: { code: 'assessment_operation_key_mismatch' } }, 400);
    if (!producer)
      return c.json(
        {
          error: {
            code: 'assessment_requests_unavailable',
            message: 'Assessment requests are not configured for this deployment.',
          },
        },
        503,
      );
    try {
      const receipt = await producer.request(c.get('tenantId').toLowerCase(), actorId, parsed.data);
      if (receipt.job_id.toLowerCase() !== parsed.data.operationKey.toLowerCase())
        throw new Error();
      return c.json(
        AssessmentRequestReceiptSchema.parse({
          jobId: receipt.job_id,
          runId: receipt.run_id,
          expiresAt: receipt.expires_at,
          status: 'accepted',
          statusUrl: `/api/bff/v1/assessment/jobs/${receipt.job_id.toLowerCase()}`,
        }),
        202,
      );
    } catch (error) {
      if (error instanceof AssessmentQuestionnaireRefused)
        return c.json({ error: { code: 'assessment_questionnaire_mismatch' } }, 400);
      if (
        error instanceof AssessmentContextRefused &&
        error.code === 'assessment_public_control_review_required'
      )
        return c.json(
          {
            error: AssessmentSourceRefusalSchema.parse({
              code: error.code,
              tenantId: c.get('tenantId').toLowerCase(),
              actorId,
              engagementId: parsed.data.engagementId,
              operationKey: parsed.data.operationKey,
              requestText: canonicalJson(parsed.data),
              dispatchState: 'not_recorded',
              sourceRequirement: 'public_control_review_required',
            }),
          },
          409,
        );
      if (error instanceof AssessmentContextRefused)
        return c.json(
          { error: { code: error.code } },
          error.code === 'assessment_engagement_not_found' ? 404 : 409,
        );
      return c.json(
        {
          error: {
            code: 'assessment_request_unconfirmed',
            message:
              'The request could not be confirmed. Check its recorded job status with the same request ID before retrying.',
          },
        },
        503,
      );
    }
  });
  return app;
}
