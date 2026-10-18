/** Pure retained-review validation shared by API readers and isolated producers.
 * Importing this module must not load HTTP middleware, logging or BFF env. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '@axiom/ledger';
import {
  buildLibrarySeedForVersion,
  parseCatalogueJson,
  publicControlCatalogueManifestText,
} from '@axiom/control-library';
import {
  PUBLIC_CONTROL_REVIEW_REQUEST_CODEC,
  PUBLIC_CONTROL_REVIEW_SNAPSHOT_CODEC,
  PUBLIC_CONTROL_REVIEW_REQUEST_CODEC_V2,
  PUBLIC_CONTROL_REVIEW_SNAPSHOT_CODEC_V2,
  parsePublicWebsiteAssetRequestText,
  parsePublicWebsiteAssetSnapshotText,
  parsePublicControlReviewSetAnyRequestText as parsePublicControlReviewSetRequestText,
  publicControlReviewSetAnyRowSchema as publicControlReviewSetRowSchema,
  publicControlReviewSetAnySnapshotSchema as publicControlReviewSetSnapshotSchema,
  publicControlReviewAnyCancellationRowSchema as publicControlReviewCancellationRowSchema,
  publicControlReviewCancellationSnapshotSchema,
} from '@axiom/types';
import { verifyWebsiteAssetOperation } from './public-website-assets.js';
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
type Scope = { tenantId: string; engagementId?: string; checkId?: string };
export function questionnaireHash(version: string) {
  const seed = buildLibrarySeedForVersion(version);
  return hash(
    canonicalJson({
      libraryVersion: seed.version,
      controls: seed.controls
        .map((control) => ({
          id: control.id,
          title: control.title,
          questions: control.assessment_questions.map(({ id, prompt, type }) => ({
            id,
            prompt,
            type,
          })),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    }),
  );
}
/** Compare instants without rewriting hashed strings or truncating PostgreSQL microseconds. */
function sameCaptureInstant(left: string, right: string) {
  const instant = (value: string) => {
    const fractional = /\.(\d+)(?=Z|[+-]\d{2}:\d{2}$)/.exec(value);
    return {
      seconds: Date.parse(value.replace(/\.\d+(?=Z|[+-]\d{2}:\d{2}$)/, '')),
      fraction: (fractional?.[1] ?? '').replace(/0+$/, ''),
    };
  };
  const a = instant(left),
    b = instant(right);
  return Number.isFinite(a.seconds) && a.seconds === b.seconds && a.fraction === b.fraction;
}

/** Validate exact retained bytes and relationships, not merely plausible JSON. */
export function verifyPublicControlReviewRow(value: unknown, scope: Scope) {
  const row = publicControlReviewSetRowSchema.parse(value);
  if (
    row.tenant_id !== scope.tenantId ||
    (scope.engagementId && row.engagement_id !== scope.engagementId) ||
    (scope.checkId && row.check_id !== scope.checkId) ||
    hash(row.request_text) !== row.request_sha256 ||
    hash(row.snapshot_text) !== row.snapshot_sha256
  )
    throw new Error('review_readback_refused');
  const request = parsePublicControlReviewSetRequestText(row.request_text);
  const snapshot = publicControlReviewSetSnapshotSchema.parse(
    parseCatalogueJson(row.snapshot_text, 524288),
  );
  if (
    canonicalJson(snapshot) !== row.snapshot_text ||
    canonicalJson(snapshot.request) !== row.request_text ||
    snapshot.tenantId !== row.tenant_id ||
    snapshot.engagementId !== row.engagement_id ||
    snapshot.checkId !== row.check_id ||
    snapshot.estateId !== row.estate_id ||
    request.operationKey !== row.operation_key ||
    request.expectedPreviousReviewId !== row.previous_review_id
  )
    throw new Error('review_readback_refused');
  if (
    row.request_codec !==
      (request.version === 2
        ? PUBLIC_CONTROL_REVIEW_REQUEST_CODEC_V2
        : PUBLIC_CONTROL_REVIEW_REQUEST_CODEC) ||
    row.snapshot_codec !==
      (snapshot.version === 2
        ? PUBLIC_CONTROL_REVIEW_SNAPSHOT_CODEC_V2
        : PUBLIC_CONTROL_REVIEW_SNAPSHOT_CODEC) ||
    request.version !== snapshot.version
  )
    throw new Error('review_codec_refused');
  if (snapshot.version === 2) {
    const asset = snapshot.assetProvenance;
    const targetRequest = parsePublicWebsiteAssetRequestText(asset.target.request_text);
    const associationRequest = parsePublicWebsiteAssetRequestText(asset.association.request_text);
    for (const bundle of [asset.target, asset.association]) {
      const parsed = parsePublicWebsiteAssetRequestText(bundle.request_text);
      verifyWebsiteAssetOperation(
        {
          state: 'recorded',
          tenantId: asset.tenant_id,
          actorId: bundle.actor_id,
          operationKey: bundle.operation_key,
          kind: parsed.kind,
          requestCodec: bundle.request_codec,
          requestText: bundle.request_text,
          requestSha256: bundle.request_sha256,
          snapshotCodec: bundle.snapshot_codec,
          snapshotText: bundle.snapshot_text,
          snapshotSha256: bundle.snapshot_sha256,
          receipt: { id: bundle.receipt.id, entryHash: bundle.receipt.entry_hash },
          replayed: true,
        },
        { tenantId: row.tenant_id, actorId: bundle.actor_id, operationKey: bundle.operation_key },
      );
    }
    const target = parsePublicWebsiteAssetSnapshotText(asset.target.snapshot_text);
    const association = parsePublicWebsiteAssetSnapshotText(asset.association.snapshot_text);
    const ref = snapshot.request.associationRef;
    if (
      targetRequest.kind !== 'register_target' ||
      target.kind !== 'target' ||
      association.kind !== 'association' ||
      (associationRequest.kind !== 'capture' && associationRequest.kind !== 'associate_capture')
    )
      throw new Error('review_asset_refused');
    if (
      asset.tenant_id !== row.tenant_id ||
      asset.estate_id !== row.estate_id ||
      target.estateId !== row.estate_id ||
      target.systemId !== asset.system_id ||
      target.id !== ref.targetId ||
      asset.target.snapshot_sha256 !== ref.targetSha256 ||
      association.id !== ref.associationId ||
      asset.association.snapshot_sha256 !== ref.associationSha256 ||
      asset.association.receipt.id !== ref.associationReceipt.id ||
      asset.association.receipt.entry_hash !== ref.associationReceipt.entryHash ||
      asset.target.receipt.id === asset.association.receipt.id ||
      association.targetId !== target.id ||
      association.targetSha256 !== asset.target.snapshot_sha256 ||
      association.requestedUrl !== target.url ||
      !sameCaptureInstant(association.checkedAt, snapshot.checkedAt) ||
      association.checkId !== row.check_id ||
      association.payloadSha256 !== snapshot.request.expectedSource.payloadSha256 ||
      association.captureReceipt.id !== snapshot.captureReceipt
    )
      throw new Error('review_asset_refused');
  }
  const seed = buildLibrarySeedForVersion(request.expectedSource.libraryVersion);
  const controls = seed.controls;
  if (
    request.expectedSource.catalogueManifestSha256 !==
      hash(publicControlCatalogueManifestText(request.expectedSource.libraryVersion)) ||
    request.expectedSource.libraryVersion !== seed.version ||
    request.expectedSource.questionnaireDigest !==
      questionnaireHash(request.expectedSource.libraryVersion)
  )
    throw new Error('review_catalogue_refused');
  if (
    canonicalJson(Object.keys(snapshot.normalizedAnswers).sort()) !==
    canonicalJson(controls.map((x) => x.id).sort())
  )
    throw new Error('review_questions_refused');
  for (const control of controls) {
    const expected = control.assessment_questions
      .filter((q) => q.type === 'boolean')
      .map((q) => q.id)
      .sort();
    if (
      canonicalJson(Object.keys(snapshot.normalizedAnswers[control.id] ?? {}).sort()) !==
      canonicalJson(expected)
    )
      throw new Error('review_questions_refused');
  }
  return { ...row, snapshot };
}

export function verifyPublicControlReviewCancellation(value: unknown, scope: Scope) {
  const row = publicControlReviewCancellationRowSchema.parse(value);
  const request = parsePublicControlReviewSetRequestText(row.request_text);
  const cancellation = publicControlReviewCancellationSnapshotSchema.parse(
    parseCatalogueJson(row.cancellation_text, 16384),
  );
  if (
    row.tenant_id !== scope.tenantId ||
    (scope.engagementId && row.engagement_id !== scope.engagementId) ||
    (scope.checkId && row.check_id !== scope.checkId) ||
    row.request_codec !==
      (request.version === 2
        ? PUBLIC_CONTROL_REVIEW_REQUEST_CODEC_V2
        : PUBLIC_CONTROL_REVIEW_REQUEST_CODEC) ||
    row.engagement_id !== request.engagementId ||
    row.check_id !== request.checkId ||
    row.operation_key !== request.operationKey ||
    hash(row.request_text) !== row.request_sha256 ||
    hash(row.cancellation_text) !== row.cancellation_sha256 ||
    canonicalJson(cancellation) !== row.cancellation_text ||
    canonicalJson(cancellation) !==
      canonicalJson({
        version: 1,
        tenantId: row.tenant_id,
        actorId: row.actor_id,
        engagementId: row.engagement_id,
        checkId: row.check_id,
        operationKey: row.operation_key,
        requestSha256: row.request_sha256,
        reason: row.reason,
      })
  )
    throw new Error('review_cancellation_refused');
  return row;
}
