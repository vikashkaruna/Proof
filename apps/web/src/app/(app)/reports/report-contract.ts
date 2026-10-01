import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z
  .string()
  .regex(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
    'Invalid UUID',
  );
const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)));
export const reviewSchema = z.object({
  id: uuid,
  decision: z.enum(['approved', 'rejected']),
  reviewerId: uuid,
  reviewerName: z.string(),
  reviewedAt: timestamp,
  note: z.string().nullable(),
  contentHash: hash,
});
const buildSchema = z.object({
  id: uuid,
  operationKey: uuid,
  status: z.enum(['pending', 'settled']),
  errorCode: z.string().nullable(),
  createdAt: timestamp,
  settledAt: timestamp.nullable(),
  retainUntil: timestamp,
});
const archiveSchema = z.object({
  id: uuid,
  versionId: z.string(),
  contentHash: hash,
  byteSize: z
    .number()
    .int()
    .positive()
    .max(64 * 1024 * 1024),
  lockMode: z.literal('COMPLIANCE'),
  retainUntil: timestamp,
  readbackAt: timestamp,
  legalHold: z.boolean(),
  encryption: z.string(),
});
export const reportSchema = z.object({
  id: uuid,
  kind: z.string(),
  title: z.string(),
  engagementId: uuid.nullable(),
  libraryVersion: z.string(),
  status: z.enum(['draft', 'approved', 'rejected', 'published', 'archived']),
  generatedAt: timestamp,
  generatedByAgent: z.string(),
  createdBy: uuid.nullable(),
  contentHash: hash.nullable(),
  reviewedContentHash: hash.nullable(),
  review: reviewSchema.nullable(),
  publishedAt: timestamp.nullable(),
  releasedBy: uuid.nullable(),
  releasedArchiveHash: hash.nullable(),
  assurance: z.enum(['legacy_unverified', 'digest_bound']),
  pack: z
    .object({
      id: uuid,
      manifestHash: hash,
      memberCount: z.number().int(),
      totalMemberBytes: z.number().int(),
      build: buildSchema.nullable(),
      archive: archiveSchema.nullable(),
    })
    .nullable(),
});
export const detailSchema = reportSchema.extend({
  contentText: z.string().nullable(),
  content: z.unknown().optional(),
});
export const listSchema = z.object({
  data: z.array(reportSchema),
  meta: z.object({
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
    hasMore: z.boolean(),
  }),
});
export const manifestPreviewSchema = z.object({
  members: z.array(
    z.object({
      evidence_id: uuid,
      receipt_id: uuid,
      filename: z.string().nullable(),
      content_hash: hash,
      byte_size: z.number().int(),
      provenance: z.string(),
      control_ids: z.array(z.string()),
    }),
  ),
  limitations: z.array(z.string()),
});
export type ReportSummary = z.infer<typeof reportSchema>;
export type ReportDetail = z.infer<typeof detailSchema>;

/**
 * Page size for released source reports. The BFF refuses any list `limit`
 * above 50 with `validation_failed` (services/bff/src/routes/evidence*.ts and
 * statutory-reports.ts), which empties the dropdown that depends on it.
 */
export const SOURCE_REPORT_PAGE_SIZE = 50;
