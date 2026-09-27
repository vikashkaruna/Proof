import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)));
export const reviewSchema = z.object({
  id: z.uuid(),
  decision: z.enum(['approved', 'rejected']),
  reviewerId: z.uuid(),
  reviewerName: z.string(),
  reviewedAt: timestamp,
  note: z.string().nullable(),
  contentHash: hash,
});
const buildSchema = z.object({
  id: z.uuid(),
  operationKey: z.uuid(),
  status: z.enum(['pending', 'settled']),
  errorCode: z.string().nullable(),
  createdAt: timestamp,
  settledAt: timestamp.nullable(),
  retainUntil: timestamp,
});
const archiveSchema = z.object({
  id: z.uuid(),
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
  id: z.uuid(),
  kind: z.string(),
  title: z.string(),
  engagementId: z.uuid().nullable(),
  libraryVersion: z.string(),
  status: z.enum(['draft', 'approved', 'rejected', 'published', 'archived']),
  generatedAt: timestamp,
  generatedByAgent: z.string(),
  createdBy: z.uuid().nullable(),
  contentHash: hash.nullable(),
  reviewedContentHash: hash.nullable(),
  review: reviewSchema.nullable(),
  publishedAt: timestamp.nullable(),
  releasedBy: z.uuid().nullable(),
  releasedArchiveHash: hash.nullable(),
  assurance: z.enum(['legacy_unverified', 'digest_bound']),
  pack: z
    .object({
      id: z.uuid(),
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
      evidence_id: z.uuid(),
      receipt_id: z.uuid(),
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
