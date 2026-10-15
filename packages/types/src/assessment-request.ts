import { z } from 'zod';

export const ASSESSMENT_REQUEST_MAX_BYTES = 128 * 1024;
const boundedId = z.string().min(1).max(200);
const answers = z
  .record(boundedId, z.record(boundedId, z.boolean().nullable()))
  .superRefine((value, context) => {
    if (
      Object.keys(value).length > 500 ||
      Object.values(value).reduce((count, row) => count + Object.keys(row).length, 0) > 5000
    )
      context.addIssue({ code: 'custom', message: 'Questionnaire exceeds the supported size' });
  });
export const ExpectedAssessmentQuestionnaireSchema = z
  .object({
    libraryVersion: boundedId,
    questionnaireDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const AssessmentReviewReferenceSchema = z
  .object({
    reviewId: z.uuid().transform((value) => value.toLowerCase()),
    requestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type AssessmentReviewReference = z.infer<typeof AssessmentReviewReferenceSchema>;
export const AssessmentRequestSchema = z
  .object({
    operationKey: z.uuid(),
    engagementId: z.uuid(),
    answers: answers.default({}),
    expectedQuestionnaire: ExpectedAssessmentQuestionnaireSchema.optional(),
    reviewRef: AssessmentReviewReferenceSchema.optional(),
    applicability: z
      .object({
        sdfSelfAttested: z.boolean().nullable().default(null),
        processesChildren: z.boolean().nullable().default(null),
        processesHealth: z.boolean().nullable().default(null),
      })
      .strict()
      .default({ sdfSelfAttested: null, processesChildren: null, processesHealth: null }),
  })
  .strict()
  .refine(
    (value) =>
      !value.reviewRef ||
      (Object.keys(value.answers).length === 0 &&
        Object.values(value.applicability).every((flag) => flag === null) &&
        value.expectedQuestionnaire === undefined),
    'A retained review supplies its own declarations and questionnaire.',
  );
export const AssessmentRequestReceiptSchema = z
  .object({
    jobId: z.uuid(),
    runId: z.uuid(),
    expiresAt: z.iso.datetime({ offset: true }),
    status: z.literal('accepted'),
    statusUrl: z.string().regex(/^\/api\/bff\/v1\/assessment\/jobs\/[0-9a-f-]{36}$/),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.statusUrl !== `/api/bff/v1/assessment/jobs/${receipt.jobId.toLowerCase()}`)
      context.addIssue({ code: 'custom', message: 'Status URL does not match the recorded job' });
  });
export type AssessmentRequest = z.infer<typeof AssessmentRequestSchema>;

export const AssessmentConfigurationSchema = z
  .object({
    tenantId: z.uuid(),
    configuration: z.enum(['configured', 'unconfigured', 'unknown']),
    executionReadiness: z.literal('not_verified'),
  })
  .strict();
export type AssessmentConfiguration = z.infer<typeof AssessmentConfigurationSchema>;
