import { z } from 'zod';
import {
  PUBLIC_WEBSITE_ASSET_MAX_BYTES,
  PUBLIC_WEBSITE_ASSET_REQUEST_CODEC,
  parsePublicWebsiteAssetRequestText,
  publicWebsiteAssetOperationSchema,
} from './public-website-assets';

const uuid = z
  .uuid()
  .transform((v) => v.toLowerCase())
  .refine((v) =>
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v),
  );
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const receipt = z
  .object({
    id: z
      .string()
      .regex(/^[1-9][0-9]{0,18}$/)
      .refine((v) => BigInt(v) <= 9223372036854775807n),
    entryHash: digest,
  })
  .strict();
const reason = z
  .string()
  .min(1)
  .max(2000)
  .refine((v) => /\S/u.test(v) && !/[\u0000\uD800-\uDFFF]/u.test(v));
export const PUBLIC_WEBSITE_ASSET_CANCELLATION_CODEC =
  'axiom-public-website-asset-cancellation-canonical-json-1' as const;
export const publicWebsiteAssetCancellationRequestSchema = z
  .object({
    requestText: z.string().min(2).max(PUBLIC_WEBSITE_ASSET_MAX_BYTES),
    reason,
    confirmed: z.literal(true),
  })
  .strict()
  .superRefine((v, ctx) => {
    try {
      parsePublicWebsiteAssetRequestText(v.requestText);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Exact retained website request is required' });
    }
  });
export type PublicWebsiteAssetCancellationRequest = z.infer<
  typeof publicWebsiteAssetCancellationRequestSchema
>;
export const publicWebsiteAssetCancellationSnapshotSchema = z
  .object({
    version: z.literal(1),
    id: uuid,
    tenantId: uuid,
    actorId: uuid,
    operationKey: uuid,
    requestSha256: digest,
    reason,
    confirmed: z.literal(true),
  })
  .strict();
export const publicWebsiteAssetCancellationSchema = z
  .object({
    state: z.literal('cancelled'),
    tenantId: uuid,
    actorId: uuid,
    operationKey: uuid,
    requestCodec: z.literal(PUBLIC_WEBSITE_ASSET_REQUEST_CODEC),
    requestText: z.string().min(2).max(PUBLIC_WEBSITE_ASSET_MAX_BYTES),
    requestSha256: digest,
    cancellationCodec: z.literal(PUBLIC_WEBSITE_ASSET_CANCELLATION_CODEC),
    cancellationText: z.string().min(2).max(16384),
    cancellationSha256: digest,
    receipt,
    replayed: z.boolean(),
  })
  .strict();
export type PublicWebsiteAssetCancellation = z.infer<typeof publicWebsiteAssetCancellationSchema>;
export const publicWebsiteAssetResolutionSchema = z.discriminatedUnion('state', [
  publicWebsiteAssetOperationSchema,
  publicWebsiteAssetCancellationSchema,
  z.object({ state: z.literal('not_found') }).strict(),
]);
export type PublicWebsiteAssetResolution = z.infer<typeof publicWebsiteAssetResolutionSchema>;
export const publicWebsiteAssetInventorySchema = z
  .object({
    estates: z
      .array(
        z
          .object({
            id: uuid,
            tenantId: uuid,
            name: z.string().min(1).max(200),
            status: z.enum(['active', 'archived']),
            version: z.number().int().positive(),
          })
          .strict(),
      )
      .max(1000),
    systems: z
      .array(
        z
          .object({
            id: uuid,
            tenantId: uuid,
            estateId: uuid,
            name: z.string().min(1).max(200),
            status: z.enum(['active', 'archived']),
            version: z.number().int().positive(),
          })
          .strict(),
      )
      .max(2000),
  })
  .strict();
export type PublicWebsiteAssetInventory = z.infer<typeof publicWebsiteAssetInventorySchema>;
export const publicWebsiteAssetTargetRowSchema = z
  .object({
    id: uuid,
    snapshotText: z.string().max(16384),
    snapshotSha256: digest,
    withdrawn: z.boolean(),
    inventoryCurrent: z.boolean(),
  })
  .strict();
export type PublicWebsiteAssetTargetRow = z.infer<typeof publicWebsiteAssetTargetRowSchema>;
export const publicWebsiteAssetCaptureRowSchema = z
  .object({
    tenantId: uuid,
    checkId: uuid,
    payloadSha256: digest,
    captureReceipt: receipt,
    requestedUrl: z.string().max(2048),
    finalUrl: z.string().max(2048),
    checkedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type PublicWebsiteAssetCaptureRow = z.infer<typeof publicWebsiteAssetCaptureRowSchema>;

export const publicWebsiteAssetAssociationRowSchema = z
  .object({
    id: uuid,
    snapshotText: z.string().max(16384),
    snapshotSha256: digest,
    operation: publicWebsiteAssetOperationSchema,
    withdrawn: z.boolean(),
  })
  .strict();
export type PublicWebsiteAssetAssociationRow = z.infer<
  typeof publicWebsiteAssetAssociationRowSchema
>;
export const publicWebsiteAssetSelectionSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('targets'), estateId: uuid, systemId: uuid, after: uuid.nullable() })
    .strict(),
  z.object({ kind: z.literal('associations'), targetId: uuid, after: uuid.nullable() }).strict(),
  z.object({ kind: z.literal('captures'), targetId: uuid, after: uuid.nullable() }).strict(),
]);
export type PublicWebsiteAssetSelection = z.infer<typeof publicWebsiteAssetSelectionSchema>;
export const publicWebsiteAssetSelectionPageSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('targets'),
      tenantId: uuid,
      actorId: uuid,
      estateId: uuid,
      systemId: uuid,
      rows: z.array(publicWebsiteAssetTargetRowSchema).max(50),
      nextCursor: uuid.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('associations'),
      tenantId: uuid,
      actorId: uuid,
      targetId: uuid,
      rows: z.array(publicWebsiteAssetAssociationRowSchema).max(50),
      nextCursor: uuid.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('captures'),
      tenantId: uuid,
      actorId: uuid,
      targetId: uuid,
      rows: z.array(publicWebsiteAssetCaptureRowSchema).max(50),
      nextCursor: uuid.nullable(),
    })
    .strict(),
]);
export type PublicWebsiteAssetSelectionPage = z.infer<typeof publicWebsiteAssetSelectionPageSchema>;
