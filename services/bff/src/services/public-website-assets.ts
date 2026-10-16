import { canonicalJson } from '@axiom/ledger';
import { parseCatalogueJson } from '@axiom/control-library';
import { createHash } from 'node:crypto';
import {
  parsePublicWebsiteAssetRequestText,
  parsePublicWebsiteAssetSnapshotText,
  publicWebsiteAssetOperationSchema,
  publicWebsiteAssetSelectionPageSchema,
  publicWebsiteAssetResolutionSchema,
  publicWebsiteAssetCancellationSnapshotSchema,
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

/** Positive cancellation is a distinct outcome; it never means a capture ran. */
export function verifyWebsiteAssetOutcome(
  value: unknown,
  scope: AssetScope & { operationKey: string; requestText?: string; cancellationReason?: string },
) {
  const parsed = publicWebsiteAssetResolutionSchema.parse(value);
  if (parsed.state === 'not_found') throw Error('website_asset_receipt_missing');
  if (parsed.state === 'recorded') return verifyWebsiteAssetOperation(parsed, scope);
  const request = parsePublicWebsiteAssetRequestText(parsed.requestText);
  const snapshot = publicWebsiteAssetCancellationSnapshotSchema.parse(
    parseCatalogueJson(parsed.cancellationText, 16384),
  );
  if (
    parsed.tenantId !== scope.tenantId.toLowerCase() ||
    parsed.actorId !== scope.actorId.toLowerCase() ||
    parsed.operationKey !== scope.operationKey.toLowerCase() ||
    request.operationKey !== parsed.operationKey ||
    parsed.requestSha256 !== assetSha256(parsed.requestText) ||
    parsed.cancellationSha256 !== assetSha256(parsed.cancellationText) ||
    canonicalJson(snapshot) !== parsed.cancellationText ||
    snapshot.tenantId !== parsed.tenantId ||
    snapshot.actorId !== parsed.actorId ||
    snapshot.operationKey !== parsed.operationKey ||
    snapshot.requestSha256 !== parsed.requestSha256 ||
    (scope.requestText !== undefined && scope.requestText !== parsed.requestText) ||
    (scope.cancellationReason !== undefined && snapshot.reason !== scope.cancellationReason)
  )
    throw Error('website_asset_cancellation_refused');
  return parsed;
}

/** Current read authority is provided by the narrow SQL selector, not by this pure decoder. */
export function verifyWebsiteAssetSelection(
  value: unknown,
  scope: AssetScope,
  selection: import('@axiom/types').PublicWebsiteAssetSelection,
) {
  const page = publicWebsiteAssetSelectionPageSchema.parse(value);
  if (
    page.tenantId !== scope.tenantId.toLowerCase() ||
    page.actorId !== scope.actorId.toLowerCase() ||
    page.kind !== selection.kind
  )
    throw Error('website_asset_selection_refused');
  if (page.kind === 'targets' && selection.kind === 'targets') {
    if (page.estateId !== selection.estateId || page.systemId !== selection.systemId)
      throw Error('website_asset_selection_refused');
    for (const row of page.rows) {
      const s = parsePublicWebsiteAssetSnapshotText(row.snapshotText);
      if (
        s.kind !== 'target' ||
        s.id !== row.id ||
        s.tenantId !== page.tenantId ||
        s.estateId !== page.estateId ||
        s.systemId !== page.systemId ||
        assetSha256(row.snapshotText) !== row.snapshotSha256
      )
        throw Error('website_asset_selection_refused');
    }
  } else if (page.kind === 'associations' && selection.kind === 'associations') {
    if (page.targetId !== selection.targetId) throw Error('website_asset_selection_refused');
    for (const row of page.rows) {
      const o = verifyWebsiteAssetOperation(row.operation, {
        tenantId: page.tenantId,
        actorId: row.operation.actorId,
        operationKey: row.operation.operationKey,
      });
      const s = parsePublicWebsiteAssetSnapshotText(row.snapshotText);
      if (
        s.kind !== 'association' ||
        s.id !== row.id ||
        s.targetId !== page.targetId ||
        o.snapshotText !== row.snapshotText ||
        o.snapshotSha256 !== row.snapshotSha256
      )
        throw Error('website_asset_selection_refused');
    }
  } else if (page.kind === 'captures' && selection.kind === 'captures') {
    if (page.targetId !== selection.targetId || page.rows.some((r) => r.tenantId !== page.tenantId))
      throw Error('website_asset_selection_refused');
  } else throw Error('website_asset_selection_refused');
  const ids = page.rows.map((r) => ('id' in r ? r.id : r.checkId));
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id, i) => id <= (selection.after ?? '') || (i > 0 && id <= ids[i - 1]!)) ||
    (page.nextCursor !== null && (ids.length !== 50 || page.nextCursor !== ids.at(-1)))
  )
    throw Error('website_asset_selection_refused');
  return page;
}
