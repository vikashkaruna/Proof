import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { AssessmentRequest } from '@axiom/types';
import { canonicalAssessmentInput } from './assessment-input.js';
import { verifyPublicControlReviewRow } from '../routes/public-control-review-sets.js';
import { DispatchRefused } from './dispatch-payload.js';

/** Server-owned immutable review lookup. A browser reference never supplies answers. */
export async function resolvePublicControlAssessmentSource(
  writer: SupabaseClient,
  tenantId: string,
  actorId: string,
  request: AssessmentRequest,
) {
  if (!request.reviewRef) throw new DispatchRefused();
  const ref = request.reviewRef;
  const result = await writer
    .rpc('resolve_public_control_assessment_source', {
      p_tenant_id: tenantId,
      p_actor_id: actorId,
      p_job_id: request.operationKey.toLowerCase(),
      p_engagement_id: request.engagementId.toLowerCase(),
      p_review_id: ref.reviewId,
      p_request_sha256: ref.requestSha256,
      p_snapshot_sha256: ref.snapshotSha256,
    })
    .abortSignal(AbortSignal.timeout(10000));
  if (result.error) throw new DispatchRefused();
  const source = z
    .object({
      review: z.unknown(),
      inputText: z.string().min(2).max(131072),
      inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict()
    .parse(result.data);
  const review = verifyPublicControlReviewRow(source.review, {
    tenantId,
    engagementId: request.engagementId.toLowerCase(),
  });
  if (
    review.id !== ref.reviewId ||
    review.request_sha256 !== ref.requestSha256 ||
    review.snapshot_sha256 !== ref.snapshotSha256
  )
    throw new DispatchRefused();
  const retained = review.snapshot.request;
  const derived: AssessmentRequest = {
    ...request,
    answers: review.snapshot.normalizedAnswers,
    applicability: {
      sdfSelfAttested: retained.applicability.sdfSelfAttested,
      processesChildren: retained.applicability.processesChildren,
      processesHealth: retained.applicability.processesHealth,
    },
    expectedQuestionnaire: {
      libraryVersion: retained.expectedSource.libraryVersion,
      questionnaireDigest: retained.expectedSource.questionnaireDigest,
    },
  };
  const inputText = canonicalAssessmentInput(
    tenantId,
    review.engagement_id,
    retained.expectedSource.libraryVersion,
    derived,
  );
  if (
    inputText !== source.inputText ||
    createHash('sha256').update(inputText, 'utf8').digest('hex') !== source.inputSha256
  )
    throw new DispatchRefused();
  return { review, derived, inputText, inputHash: source.inputSha256 };
}
