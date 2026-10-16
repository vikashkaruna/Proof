import { z } from 'zod';
import { AssessmentReviewReferenceSchema } from '@axiom/types';
const uuid = z.uuid().transform((value) => value.toLowerCase());
/** URL contains identifiers/digests only; it is a selection, never review authority. */
export const assessmentReviewSelectionSchema = z
  .object({
    engagement: uuid.optional(),
    reviewId: uuid.optional(),
    requestSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    snapshotSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .superRefine((v, c) => {
    const hasReviewSelection =
      v.reviewId !== undefined || v.requestSha256 !== undefined || v.snapshotSha256 !== undefined;
    if (
      hasReviewSelection &&
      (!v.engagement || !v.reviewId || !v.requestSha256 || !v.snapshotSha256)
    )
      c.addIssue({ code: 'custom', message: 'A complete recorded review selection is required.' });
  })
  .transform((v) => ({
    engagement: v.engagement,
    reviewRef: v.reviewId
      ? AssessmentReviewReferenceSchema.parse({
          reviewId: v.reviewId,
          requestSha256: v.requestSha256,
          snapshotSha256: v.snapshotSha256,
        })
      : undefined,
  }));
