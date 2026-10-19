import {
  prativedanAssessmentDraftRequestSchema,
  prativedanAssessmentPreviewSchema,
  prativedanAssessmentReadbackSchema,
  prativedanAssessmentSourceSchema,
} from '@axiom/types';
import { z } from 'zod';
import type { DraftRequestIntent, DraftReviewIntent } from './draft-journal';
const resultSchema = z.object({
  findings: z
    .array(
      z.object({
        control_id: z.string().max(100),
        score: z.number().finite().min(0).max(100),
        rationale: z.string().max(4000),
      }),
    )
    .min(1)
    .max(500),
  questionnaire_provenance: z.object({
    controls: z
      .array(
        z.object({
          control_id: z.string().max(100),
          answer_state: z.string().max(100),
          applicability_state: z.string().max(100),
        }),
      )
      .min(1)
      .max(500),
  }),
});
export async function parseDraftPreview(
  raw: unknown,
  tenantId: string,
  engagementId: string,
  assessmentRunId: string,
) {
  const preview = prativedanAssessmentPreviewSchema.parse(raw);
  const source = prativedanAssessmentSourceSchema.parse(JSON.parse(preview.source_text));
  if (
    source.tenant_id !== tenantId ||
    source.engagement_id !== engagementId ||
    source.assessment_run_id !== assessmentRunId ||
    source.source_id !== assessmentRunId
  )
    throw new Error('Frozen source belongs to another selection.');
  if (typeof crypto.subtle?.digest !== 'function')
    throw new Error('Source commitment verification requires a secure supported browser.');
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(preview.source_text)),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
  if (digest !== preview.source_sha256)
    throw new Error('Frozen source does not match its commitment.');
  const result = resultSchema.parse(JSON.parse(source.result_text));
  return { preview, source, result };
}
export function parseRecordedDraft(
  raw: unknown,
  request: DraftRequestIntent,
  review: DraftReviewIntent | null,
) {
  const envelope = z
    .object({
      journal: z.unknown(),
      outcome: z.string().optional(),
      failureCode: z.string().nullable().optional(),
    })
    .safeParse(raw);
  const journal = prativedanAssessmentReadbackSchema.parse(
    envelope.success ? envelope.data.journal : raw,
  );
  const expected = prativedanAssessmentDraftRequestSchema.parse(
    JSON.parse(request.reviewedRequestText),
  );
  if (
    !('state' in journal) ||
    journal.tenant_id !== request.tenantId ||
    journal.actor_id !== request.actorId ||
    journal.request_text !== request.reviewedRequestText ||
    journal.operation_key !== expected.operationKey ||
    journal.engagement_id !== expected.engagementId ||
    journal.assessment_run_id !== expected.assessmentRunId ||
    journal.source_sha256 !== expected.expectedSourceSha256
  )
    throw new Error('Recorded draft does not match the retained original request.');
  if (review && journal.state === 'unpublished' && journal.review) {
    const saved = journal.review;
    if (
      saved.actor_id !== review.actorId ||
      saved.review_key !== review.reviewKey ||
      saved.response_output_sha256 !== review.expectedHash ||
      saved.decision !== review.decision ||
      saved.reason !== review.reason
    )
      throw new Error(
        'Recorded review differs from the retained original decision. Preserve both for review.',
      );
  }
  return {
    journal,
    outcome: envelope.success ? envelope.data.outcome : undefined,
    failureCode: envelope.success ? envelope.data.failureCode : undefined,
  };
}
