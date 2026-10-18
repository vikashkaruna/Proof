import { z } from 'zod';

/**
 * Control-library versions this codec can parse for public-control review, assessment and
 * report provenance. Mirrors public.approved_catalogue_versions (0159): the
 * database remains authoritative: parsing a candidate never approves it.
 * 0161 requires a recorded founder approval before 0.2.0 can be used.
 */
export const APPROVED_LIBRARY_VERSIONS = ['0.1.1', '0.2.0'] as const;
export const ApprovedLibraryVersionSchema = z.enum(APPROVED_LIBRARY_VERSIONS);
export type ApprovedLibraryVersion = z.infer<typeof ApprovedLibraryVersionSchema>;

const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Source-readable candidates remain unusable until the SQL registry approves them. */
export const CatalogueVersionSummarySchema = z
  .object({
    libraryVersion: ApprovedLibraryVersionSchema,
    rowsHash: digest,
    questionnaireDigest: digest,
    manifestSha256: digest,
    mappingVersion: z.literal('public-evidence-1'),
    controlCount: z.number().int().positive().max(500),
    publishedBy: z.string(),
    publishedAt: z.iso.datetime({ offset: true }),
    changeLog: z.string(),
    isCurrent: z.boolean(),
    approved: z.boolean(),
    approvedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();
export const CatalogueVersionApprovalRequestSchema = z
  .object({
    version: z.literal(1),
    operationKey: z.uuid(),
    libraryVersion: z.literal('0.2.0'),
    rowsHash: digest,
    questionnaireDigest: digest,
    manifestSha256: digest,
    mappingVersion: z.literal('public-evidence-1'),
    reason: z.string().trim().min(1).max(2000),
    confirmed: z.literal(true),
  })
  .strict();
export type CatalogueVersionSummary = z.infer<typeof CatalogueVersionSummarySchema>;
