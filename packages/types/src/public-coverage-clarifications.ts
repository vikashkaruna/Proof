import { z } from 'zod';

export const PUBLIC_COVERAGE_PAGES = ['root', 'privacy', 'contact', 'terms', 'consent'] as const;
const uuid = z.uuid().transform((v) => v.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const reason = z
  .string()
  .trim()
  .min(20)
  .max(2000)
  .refine((v) => !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(v));
export const publicCoverageClarificationSchema = z
  .object({
    page: z.enum(PUBLIC_COVERAGE_PAGES),
    sourceState: z.enum(['examined', 'unavailable', 'unexamined']),
    sourceTruncated: z.boolean(),
    reasonCategory: z.enum([
      'not_public',
      'not_found',
      'access_blocked',
      'interactive_content',
      'not_applicable',
      'needs_investigation',
      'other',
    ]),
    reason,
    proposedPublicUrl: z.string().url().max(2048).nullable(),
  })
  .strict();
export const publicCoverageClarificationRequestSchema = z
  .object({
    version: z.literal(1),
    operationKey: uuid,
    engagementId: uuid,
    checkId: uuid,
    payloadSha256: digest,
    expectedPreviousRevisionId: uuid.nullable(),
    clarifications: z.array(publicCoverageClarificationSchema).max(5),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.clarifications.map((p) => p.page)).size !== v.clarifications.length)
      ctx.addIssue({ code: 'custom', message: 'One declaration per source page is required' });
  });
export const publicCoverageClarificationSnapshotSchema = z
  .object({
    version: z.literal(1),
    disposition: z.literal('owner_declarations_unverified'),
    tenantId: uuid,
    actorId: uuid,
    revisionId: uuid,
    previousRevisionId: uuid.nullable(),
    recordedAt: z.iso.datetime({ offset: true }),
    request: publicCoverageClarificationRequestSchema,
  })
  .strict();
export const publicCoverageClarificationRecordSchema = z
  .object({
    id: uuid,
    tenantId: uuid,
    actorId: uuid,
    engagementId: uuid,
    checkId: uuid,
    payloadSha256: digest,
    operationKey: uuid,
    requestText: z.string().min(2).max(16384),
    requestSha256: digest,
    snapshotText: z.string().min(2).max(24576),
    snapshotSha256: digest,
    receiptId: z.string().regex(/^[1-9][0-9]*$/),
  })
  .strict();
export type PublicCoverageClarificationRequest = z.infer<
  typeof publicCoverageClarificationRequestSchema
>;
export type PublicCoverageClarificationRecord = z.infer<
  typeof publicCoverageClarificationRecordSchema
>;
export type PublicCoverageClarificationSnapshot = z.infer<
  typeof publicCoverageClarificationSnapshotSchema
>;
