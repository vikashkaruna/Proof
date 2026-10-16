import { z } from 'zod';

export const PUBLIC_WEBSITE_ASSET_REQUEST_CODEC =
  'axiom-public-website-asset-request-canonical-json-1' as const;
export const PUBLIC_WEBSITE_ASSET_SNAPSHOT_CODEC =
  'axiom-public-website-asset-snapshot-canonical-json-1' as const;
export const PUBLIC_WEBSITE_ASSET_MAX_BYTES = 16384;
const uuid = z
  .uuid()
  .transform((v) => v.toLowerCase())
  .refine((v) =>
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v),
  );
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const receiptId = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((v) => BigInt(v) <= 9223372036854775807n);
const safeText = z
  .string()
  .min(1)
  .max(2000)
  .refine((v) => /\S/u.test(v) && !/[\u0000\uD800-\uDFFF]/u.test(v));
function assetUrl(allowHttp = false) {
  return z
    .string()
    .min(1)
    .max(2048)
    .refine((v) => !/[\u0000\uD800-\uDFFF]/u.test(v))
    .transform((value, ctx) => {
      try {
        const url = new URL(value);
        if (
          !['https:', ...(allowHttp ? ['http:'] : [])].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          url.port ||
          url.href.length > 2048 ||
          /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$/.test(url.hostname) ||
          !/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname)
        )
          throw Error();
        return url.href;
      } catch {
        ctx.addIssue({
          code: 'custom',
          message:
            'Use a public HTTPS page without credentials, query parameters, fragments or a custom port.',
        });
        return z.NEVER;
      }
    });
}
export const publicWebsiteAssetUrlSchema = assetUrl();
const capturedPublicUrl = assetUrl(true);
const common = { version: z.literal(1), operationKey: uuid, confirmed: z.literal(true) };
export const publicWebsiteAssetRequestSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...common,
      kind: z.literal('register_target'),
      estateId: uuid,
      systemId: uuid,
      expectedEstateVersion: z.number().int().positive().max(999999999),
      expectedSystemVersion: z.number().int().positive().max(999999999),
      url: publicWebsiteAssetUrlSchema,
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal('associate_capture'),
      targetId: uuid,
      expectedTargetSha256: digest,
      checkId: uuid,
      expectedPayloadSha256: digest,
      expectedCaptureReceipt: receiptId,
    })
    .strict(),
  z
    .object({ ...common, kind: z.literal('capture'), targetId: uuid, expectedTargetSha256: digest })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal('withdraw'),
      subjectType: z.enum(['target', 'association']),
      subjectId: uuid,
      expectedSubjectSha256: digest,
      reason: safeText,
    })
    .strict(),
]);
export type PublicWebsiteAssetRequest = z.infer<typeof publicWebsiteAssetRequestSchema>;
// Same restricted canonical JSON contract as the existing human-review codec;
// schemas admit no unknown keys, undefined, floating point or invalid Unicode.
function canonical(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (key) => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key]),
        )
        .join(',') +
      '}'
    );
  throw Error('public_website_asset_request_refused');
}
export function encodePublicWebsiteAssetRequest(value: unknown): string {
  return canonical(publicWebsiteAssetRequestSchema.parse(value));
}
export function parsePublicWebsiteAssetRequestText(text: string): PublicWebsiteAssetRequest {
  try {
    if (new TextEncoder().encode(text).byteLength > PUBLIC_WEBSITE_ASSET_MAX_BYTES) throw Error();
    const value = publicWebsiteAssetRequestSchema.parse(JSON.parse(text));
    if (canonical(value) !== text) throw Error();
    return value;
  } catch {
    throw Error('public_website_asset_request_refused');
  }
}
const snapshotCommon = {
  version: z.literal(1),
  id: uuid,
  tenantId: uuid,
  actorId: uuid,
  ownershipVerified: z.literal(false),
  connectorAccessGranted: z.literal(false),
};
export const publicWebsiteTargetSnapshotSchema = z
  .object({
    ...snapshotCommon,
    kind: z.literal('target'),
    estateId: uuid,
    systemId: uuid,
    estateVersion: z.number().int().positive(),
    systemVersion: z.number().int().positive(),
    targetVersion: z.number().int().positive(),
    estateName: safeText.max(200),
    systemName: safeText.max(200),
    url: publicWebsiteAssetUrlSchema,
  })
  .strict();
export const publicWebsiteAssociationSnapshotSchema = z
  .object({
    ...snapshotCommon,
    kind: z.literal('association'),
    targetId: uuid,
    targetSha256: digest,
    checkId: uuid,
    payloadSha256: digest,
    captureReceipt: z.object({ id: receiptId, entryHash: digest }).strict(),
    requestedUrl: publicWebsiteAssetUrlSchema,
    finalUrl: capturedPublicUrl,
    checkedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export const publicWebsiteWithdrawalSnapshotSchema = z
  .object({
    ...snapshotCommon,
    kind: z.literal('withdrawal'),
    subjectType: z.enum(['target', 'association']),
    subjectId: uuid,
    subjectSha256: digest,
    reason: safeText,
  })
  .strict();
export const publicWebsiteAssetSnapshotSchema = z.discriminatedUnion('kind', [
  publicWebsiteTargetSnapshotSchema,
  publicWebsiteAssociationSnapshotSchema,
  publicWebsiteWithdrawalSnapshotSchema,
]);
export type PublicWebsiteAssetSnapshot = z.infer<typeof publicWebsiteAssetSnapshotSchema>;
export function parsePublicWebsiteAssetSnapshotText(text: string): PublicWebsiteAssetSnapshot {
  try {
    if (new TextEncoder().encode(text).byteLength > PUBLIC_WEBSITE_ASSET_MAX_BYTES) throw Error();
    const value = publicWebsiteAssetSnapshotSchema.parse(JSON.parse(text));
    if (canonical(value) !== text) throw Error();
    return value;
  } catch {
    throw Error('public_website_asset_snapshot_refused');
  }
}
export const publicWebsiteAssetOperationSchema = z
  .object({
    state: z.literal('recorded'),
    tenantId: uuid,
    actorId: uuid,
    operationKey: uuid,
    kind: z.enum(['register_target', 'associate_capture', 'capture', 'withdraw']),
    requestCodec: z.literal(PUBLIC_WEBSITE_ASSET_REQUEST_CODEC),
    requestText: z.string().max(PUBLIC_WEBSITE_ASSET_MAX_BYTES),
    requestSha256: digest,
    snapshotCodec: z.literal(PUBLIC_WEBSITE_ASSET_SNAPSHOT_CODEC),
    snapshotText: z.string().max(PUBLIC_WEBSITE_ASSET_MAX_BYTES),
    snapshotSha256: digest,
    receipt: z.object({ id: receiptId, entryHash: digest }).strict(),
    replayed: z.boolean(),
  })
  .strict();
export type PublicWebsiteAssetOperation = z.infer<typeof publicWebsiteAssetOperationSchema>;
