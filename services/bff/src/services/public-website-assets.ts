import { createHash } from 'node:crypto';
import {
  parsePublicWebsiteAssetRequestText,
  parsePublicWebsiteAssetSnapshotText,
  publicWebsiteAssetOperationSchema,
  publicWebsiteTargetSnapshotSchema,
  type PublicWebsiteAssetRequest,
} from '@axiom/types';
import { z } from 'zod';

export const assetSha256 = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex');
export type AssetScope = { tenantId: string; actorId: string };
/** Decode only a positive immutable receipt. Never interpret not_found as clearance. */
export function verifyWebsiteAssetOperation(
  value: unknown,
  scope: AssetScope & { operationKey: string; requestText?: string },
) {
  const row = publicWebsiteAssetOperationSchema.parse(value);
  const request = parsePublicWebsiteAssetRequestText(row.requestText);
  const snapshot = parsePublicWebsiteAssetSnapshotText(row.snapshotText);
  if (
    row.tenantId !== scope.tenantId.toLowerCase() ||
    row.actorId !== scope.actorId.toLowerCase() ||
    row.operationKey !== scope.operationKey.toLowerCase() ||
    request.operationKey !== row.operationKey ||
    request.kind !== row.kind ||
    row.requestSha256 !== assetSha256(row.requestText) ||
    row.snapshotSha256 !== assetSha256(row.snapshotText) ||
    snapshot.tenantId !== row.tenantId ||
    snapshot.actorId !== row.actorId ||
    (scope.requestText !== undefined && row.requestText !== scope.requestText)
  )
    throw Error('website_asset_receipt_refused');
  if (request.kind === 'register_target') {
    if (
      snapshot.kind !== 'target' ||
      snapshot.estateId !== request.estateId ||
      snapshot.systemId !== request.systemId ||
      snapshot.estateVersion !== request.expectedEstateVersion ||
      snapshot.systemVersion !== request.expectedSystemVersion ||
      snapshot.url !== request.url
    )
      throw Error('website_asset_receipt_refused');
  } else if (request.kind === 'withdraw') {
    if (
      snapshot.kind !== 'withdrawal' ||
      snapshot.subjectType !== request.subjectType ||
      snapshot.subjectId !== request.subjectId ||
      snapshot.subjectSha256 !== request.expectedSubjectSha256 ||
      snapshot.reason !== request.reason
    )
      throw Error('website_asset_receipt_refused');
  } else {
    if (
      snapshot.kind !== 'association' ||
      snapshot.targetId !== request.targetId ||
      snapshot.targetSha256 !== request.expectedTargetSha256 ||
      (request.kind === 'associate_capture' &&
        (snapshot.checkId !== request.checkId ||
          snapshot.payloadSha256 !== request.expectedPayloadSha256 ||
          snapshot.captureReceipt.id !== request.expectedCaptureReceipt))
    )
      throw Error('website_asset_receipt_refused');
  }
  return row;
}
const targetRead = z
  .object({
    snapshotText: z.string().max(16384),
    snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
/** This validates the SQL read envelope; only the narrow current-target RPC may supply it. */
export function verifyWebsiteCaptureTarget(
  value: unknown,
  scope: AssetScope,
  request: Extract<PublicWebsiteAssetRequest, { kind: 'capture' }>,
) {
  const row = targetRead.parse(value);
  const snapshot = publicWebsiteTargetSnapshotSchema.parse(
    parsePublicWebsiteAssetSnapshotText(row.snapshotText),
  );
  if (
    snapshot.tenantId !== scope.tenantId.toLowerCase() ||
    snapshot.id !== request.targetId ||
    row.snapshotSha256 !== request.expectedTargetSha256 ||
    row.snapshotSha256 !== assetSha256(row.snapshotText)
  )
    throw Error('website_asset_target_refused');
  return snapshot;
}
