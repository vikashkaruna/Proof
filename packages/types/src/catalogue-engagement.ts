import { z } from 'zod';
import { ApprovedLibraryVersionSchema } from './catalogue-versions';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const receipt = z.string().regex(/^[1-9][0-9]*$/);
const deltaItem = z.object({ id: z.string(), title: z.string() }).strict();
export const CatalogueDeltaSchema = z
  .object({
    previousVersion: ApprovedLibraryVersionSchema.nullable(),
    sha256: hash,
    added: z.array(deltaItem).max(500),
    removed: z.array(deltaItem).max(500),
    changed: z.array(deltaItem.extend({ fields: z.array(z.string()).max(40) }).strict()).max(500),
  })
  .strict();
export const CatalogueEngagementResponseSchema = z
  .object({
    currentVersion: ApprovedLibraryVersionSchema,
    releasedVersions: z
      .array(
        z
          .object({
            libraryVersion: ApprovedLibraryVersionSchema,
            changeLog: z.string(),
            publishedAt: z.iso.datetime({ offset: true }),
            delta: CatalogueDeltaSchema,
          })
          .strict(),
      )
      .max(100),
    auditedBaselines: z
      .array(
        z
          .object({
            runId: z.uuid(),
            engagementId: z.uuid(),
            estateId: z.uuid().nullable(),
            libraryVersion: ApprovedLibraryVersionSchema,
            finalizedAt: z.iso.datetime({ offset: true }),
          })
          .strict(),
      )
      .max(1000),
    upgradeOptions: z
      .array(
        z
          .object({
            baselineRunId: z.uuid(),
            targetVersion: ApprovedLibraryVersionSchema,
            delta: CatalogueDeltaSchema,
          })
          .strict(),
      )
      .max(1000),
    requests: z
      .array(
        z
          .object({
            requestId: z.uuid(),
            baselineRunId: z.uuid(),
            targetVersion: ApprovedLibraryVersionSchema,
            deltaSha256: hash,
            ownerReason: z.string(),
            requestedAt: z.iso.datetime({ offset: true }),
            status: z.enum(['pending', 'approved', 'rejected']),
            decisionReason: z.string().nullable(),
            engagementId: z.uuid().nullable(),
            ownerReceiptId: receipt,
            decisionReceiptId: receipt.nullable(),
          })
          .strict(),
      )
      .max(1000),
    effectiveVersion: ApprovedLibraryVersionSchema,
    hasFinalizedAudit: z.boolean(),
    requiresOwnerRequest: z.boolean(),
    historicalAuditNeedsReview: z.boolean(),
  })
  .strict();
export const CatalogueReauditRequestSchema = z
  .object({
    version: z.literal(1),
    operationKey: z.uuid(),
    baselineRunId: z.uuid(),
    targetVersion: ApprovedLibraryVersionSchema,
    deltaSha256: hash,
    reason: z.string().trim().min(1).max(2000),
    confirmed: z.literal(true),
  })
  .strict();
export const CatalogueReauditDecisionSchema = z
  .object({
    version: z.literal(1),
    operationKey: z.uuid(),
    requestId: z.uuid(),
    decision: z.enum(['approve', 'reject']),
    reason: z.string().trim().min(1).max(2000),
    confirmed: z.literal(true),
  })
  .strict();
export const CatalogueReauditReceiptSchema = z
  .object({
    requestId: z.uuid(),
    status: z.enum(['pending', 'approved', 'rejected']),
    engagementId: z.uuid().nullable(),
    receiptId: receipt,
    replayed: z.boolean(),
  })
  .strict();
export type CatalogueEngagementResponse = z.infer<typeof CatalogueEngagementResponseSchema>;
export type CatalogueReauditRequest = z.infer<typeof CatalogueReauditRequestSchema>;
export type CatalogueReauditDecision = z.infer<typeof CatalogueReauditDecisionSchema>;
