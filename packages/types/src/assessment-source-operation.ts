import { z } from 'zod';
import { AssessmentRequestSchema } from './assessment-request';
const uuid = z.uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const reason = z
  .string()
  .min(1)
  .refine((v) => [...v].length <= 2000 && /\S/u.test(v) && !/[\u0000\uD800-\uDFFF]/u.test(v));
export const cancelAssessmentSourceIntentSchema = z
  .object({
    request: AssessmentRequestSchema.refine((v) => v.reviewRef !== undefined),
    reason,
  })
  .strict();
export const assessmentSourceCancellationSchema = z
  .object({
    id: uuid,
    tenant_id: uuid,
    actor_id: uuid,
    job_id: uuid,
    engagement_id: uuid,
    request_text: z.string().min(2).max(131072),
    request_sha256: digest,
    reason,
    cancellation_text: z.string().min(2).max(16384),
    cancellation_sha256: digest,
    receipt_id: z
      .string()
      .regex(/^[1-9][0-9]{0,18}$/)
      .refine((v) => BigInt(v) <= 9223372036854775807n),
    created_at: z.iso.datetime({ offset: true }),
  })
  .strict();
export const assessmentSourceOperationSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('not_found') }).strict(),
  z.object({ state: z.literal('cancelled'), data: assessmentSourceCancellationSchema }).strict(),
  z
    .object({
      state: z.literal('recorded'),
      jobId: uuid,
      runId: uuid,
      expiresAt: z.iso.datetime({ offset: true }),
    })
    .strict(),
]);
export type AssessmentSourceOperation = z.infer<typeof assessmentSourceOperationSchema>;
