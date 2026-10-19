import { z } from 'zod';
import {
  publicControlCatalogueV2Manifest,
  publicEvidenceCatalogueRowsMatchV2,
} from '@axiom/control-library';
import { canonicalJson } from '@axiom/ledger';
import {
  cancelPublicControlReviewAnyOperationRequestSchema as cancelPublicControlReviewOperationRequestSchema,
  parsePublicControlReviewSetAnyRequestText as parsePublicControlReviewSetRequestText,
  publicControlReviewAnyCancellationRowSchema as publicControlReviewCancellationRowSchema,
  publicControlReviewCancellationSnapshotSchema,
  publicControlReviewSetRequestSchema,
  publicControlReviewSetAnyRowSchema as publicControlReviewSetRowSchema,
  publicControlReviewSetAnySnapshotSchema as publicControlReviewSetSnapshotSchema,
  publicControlAssessmentV2Schema,
  PUBLIC_CONTROL_REVIEW_REQUEST_CODEC,
  PUBLIC_CONTROL_REVIEW_SNAPSHOT_CODEC,
  PUBLIC_CONTROL_REVIEW_REQUEST_CODEC_V2,
  PUBLIC_CONTROL_REVIEW_SNAPSHOT_CODEC_V2,
  parsePublicWebsiteAssetSnapshotText,
  parsePublicWebsiteAssetRequestText,
  type PublicControlAssessmentV2,
} from '@axiom/types';
import {
  controlReviewOperationSchema,
  assertControlReviewOperation,
  type ControlReviewOperation,
} from './control-review-journal';

const uuid = z.uuid().transform((v) => v.toLowerCase());
const row = publicControlReviewSetRowSchema
  .safeExtend({ snapshot: publicControlReviewSetSnapshotSchema })
  .strict();
const head = z
  .object({
    data: z
      .object({
        tenantId: uuid,
        engagementId: uuid,
        checkId: uuid,
        estateId: uuid.nullable(),
        expectedSource: publicControlReviewSetRequestSchema.shape.expectedSource,
        review: row.nullable(),
      })
      .strict(),
  })
  .strict();
export type HumanControlReviewHead = z.infer<typeof head>['data'];
const resolved = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('recorded'),
      data: row,
      isCurrent: z.boolean(),
      contextCurrent: z.boolean(),
    })
    .strict(),
  z
    .object({ state: z.literal('cancelled'), data: publicControlReviewCancellationRowSchema })
    .strict(),
  z.object({ state: z.literal('not_found') }).strict(),
]);
export type ResolvedHumanControlReview = z.infer<typeof resolved>;
const recorded = z
  .object({
    data: z.object({ review: row, isCurrent: z.boolean(), contextCurrent: z.boolean() }).strict(),
    replayed: z.boolean(),
  })
  .strict();
const errorCode = z.object({ error: z.object({ code: z.string().regex(/^[a-z_]{1,100}$/) }) });

async function jsonResponse(response: Response) {
  if (!response.ok) {
    const error = errorCode.safeParse(await response.json().catch(() => null));
    throw new Error(
      `Human review could not be confirmed${error.success ? ` (${error.data.error.code})` : ''}. Keep the retained request and reconcile it.`,
    );
  }
  const raw = await response.text();
  if (new TextEncoder().encode(raw).byteLength > 2_000_000)
    throw new Error('Human review readback exceeded its supported size.');
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(
      'Human review readback is malformed. Preserve and reconcile the retained request.',
    );
  }
}
/** Compare the UTC second and complete decimal fraction; Date alone loses PostgreSQL microseconds. */
function sameReviewInstant(left: string, right: string) {
  const instant = (value: string) => {
    const fraction = /\.(\d+)(?=Z|[+-]\d{2}:\d{2}$)/.exec(value);
    return [
      Date.parse(value.replace(/\.\d+(?=Z|[+-]\d{2}:\d{2}$)/, '')),
      (fraction?.[1] ?? '').replace(/0+$/, ''),
    ] as const;
  };
  const a = instant(left),
    b = instant(right);
  return Number.isFinite(a[0]) && Number.isFinite(b[0]) && a[0] === b[0] && a[1] === b[1];
}
function validateRow(
  value: z.infer<typeof row>,
  scope: { tenantId: string; engagementId: string; checkId: string },
) {
  if (
    value.tenant_id !== scope.tenantId ||
    value.engagement_id !== scope.engagementId ||
    value.check_id !== scope.checkId ||
    value.snapshot.tenantId !== scope.tenantId ||
    value.snapshot.engagementId !== scope.engagementId ||
    value.snapshot.checkId !== scope.checkId ||
    value.snapshot.estateId !== value.estate_id ||
    canonicalJson(value.snapshot) !== value.snapshot_text ||
    canonicalJson(value.snapshot.request) !== value.request_text ||
    value.snapshot.request.operationKey !== value.operation_key ||
    value.snapshot.request.expectedPreviousReviewId !== value.previous_review_id
  )
    throw new Error('Human review readback does not match its saved context.');
  const request = parsePublicControlReviewSetRequestText(value.request_text);
  if (
    request.version !== value.snapshot.version ||
    value.request_codec !==
      (request.version === 2
        ? PUBLIC_CONTROL_REVIEW_REQUEST_CODEC_V2
        : PUBLIC_CONTROL_REVIEW_REQUEST_CODEC) ||
    value.snapshot_codec !==
      (request.version === 2
        ? PUBLIC_CONTROL_REVIEW_SNAPSHOT_CODEC_V2
        : PUBLIC_CONTROL_REVIEW_SNAPSHOT_CODEC)
  )
    throw Error('Human review codec pairing differs from its saved version.');
  if (request.version === 2 && value.snapshot.version === 2) {
    const asset = value.snapshot.assetProvenance;
    const target = parsePublicWebsiteAssetSnapshotText(asset.target.snapshot_text);
    const association = parsePublicWebsiteAssetSnapshotText(asset.association.snapshot_text);
    const targetRequest = parsePublicWebsiteAssetRequestText(asset.target.request_text);
    const associationRequest = parsePublicWebsiteAssetRequestText(asset.association.request_text);
    if (
      target.kind !== 'target' ||
      association.kind !== 'association' ||
      targetRequest.kind !== 'register_target' ||
      (associationRequest.kind !== 'capture' && associationRequest.kind !== 'associate_capture') ||
      asset.target.actor_id !== target.actorId ||
      asset.association.actor_id !== association.actorId ||
      asset.target.operation_key !== targetRequest.operationKey ||
      asset.association.operation_key !== associationRequest.operationKey ||
      association.captureReceipt.id !== value.snapshot.captureReceipt ||
      !sameReviewInstant(association.checkedAt, value.snapshot.checkedAt) ||
      asset.tenant_id !== scope.tenantId ||
      asset.estate_id !== value.estate_id ||
      target.tenantId !== scope.tenantId ||
      association.tenantId !== scope.tenantId ||
      target.estateId !== value.estate_id ||
      target.systemId !== asset.system_id ||
      target.id !== request.associationRef.targetId ||
      association.targetId !== target.id ||
      association.id !== request.associationRef.associationId ||
      association.checkId !== scope.checkId ||
      association.payloadSha256 !== request.expectedSource.payloadSha256 ||
      asset.target.snapshot_sha256 !== request.associationRef.targetSha256 ||
      asset.association.snapshot_sha256 !== request.associationRef.associationSha256 ||
      association.targetSha256 !== asset.target.snapshot_sha256 ||
      asset.association.receipt.id !== request.associationRef.associationReceipt.id ||
      asset.association.receipt.entry_hash !==
        request.associationRef.associationReceipt.entryHash ||
      canonicalJson(targetRequest) !== asset.target.request_text ||
      canonicalJson(associationRequest) !== asset.association.request_text ||
      targetRequest.estateId !== target.estateId ||
      targetRequest.systemId !== target.systemId ||
      targetRequest.expectedEstateVersion !== target.estateVersion ||
      targetRequest.expectedSystemVersion !== target.systemVersion ||
      targetRequest.url !== target.url ||
      associationRequest.targetId !== target.id ||
      associationRequest.expectedTargetSha256 !== asset.target.snapshot_sha256 ||
      (associationRequest.kind === 'associate_capture' &&
        (associationRequest.checkId !== scope.checkId ||
          associationRequest.expectedPayloadSha256 !== association.payloadSha256 ||
          associationRequest.expectedCaptureReceipt !== association.captureReceipt.id))
    )
      throw Error('Human review asset provenance differs from its saved association.');
  }
  const manifest = publicControlCatalogueV2Manifest(request.expectedSource.libraryVersion);
  for (const [controlId, questions] of Object.entries(request.answers)) {
    const control = manifest.controls.find((row) => row.control.id === controlId)?.control;
    if (
      !control ||
      Object.keys(questions).some(
        (id) => !control.assessmentQuestions.some((q) => q.id === id && q.type === 'boolean'),
      )
    )
      throw new Error('Human review references an unsupported control question.');
  }
}
/** The authenticated BFF verifies actual hashes; this client also rejects scope/byte substitution. */
export async function loadHumanControlReview(
  source: PublicControlAssessmentV2,
  signal?: AbortSignal,
) {
  source = publicControlAssessmentV2Schema.parse(source);
  if (!publicEvidenceCatalogueRowsMatchV2(source.controls, source.catalogue.libraryVersion))
    throw new Error('Human review controls do not match the reviewed catalogue.');
  const scope = source.source;
  const response = await fetch(
    `/api/bff/v1/public-control-review-sets/current?engagementId=${scope.engagementId}&checkId=${scope.checkId}`,
    {
      cache: 'no-store',
      headers: { 'X-Tenant-Id': scope.tenantId },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
        : AbortSignal.timeout(20000),
    },
  );
  const data = head.parse(await jsonResponse(response)).data;
  if (
    data.tenantId !== scope.tenantId ||
    data.engagementId !== scope.engagementId ||
    data.checkId !== scope.checkId ||
    data.expectedSource.payloadSha256 !== scope.projectionSha256 ||
    data.expectedSource.catalogueManifestSha256 !== source.catalogue.manifestSha256 ||
    data.expectedSource.mappingVersion !== source.catalogue.mappingVersion ||
    data.expectedSource.libraryVersion !== source.catalogue.libraryVersion
  )
    throw new Error('Human review source does not match the displayed website evidence.');
  if (data.review) {
    validateRow(data.review, scope);
    if (
      canonicalJson(data.review.snapshot.request.expectedSource) !==
      canonicalJson(data.expectedSource)
    )
      throw new Error('Saved human review does not match the displayed source.');
  }
  return data;
}
function verifyResolution(value: unknown, operation: ControlReviewOperation) {
  operation = controlReviewOperationSchema.parse(operation);
  const state = resolved.parse(value);
  if (state.state === 'not_found') return state;
  const request = parsePublicControlReviewSetRequestText(operation.requestText);
  if (
    state.data.tenant_id !== operation.tenantId ||
    state.data.actor_id !== operation.actorId ||
    state.data.engagement_id !== request.engagementId ||
    state.data.check_id !== request.checkId ||
    state.data.operation_key !== request.operationKey ||
    state.data.request_text !== operation.requestText
  )
    throw new Error('The receipt does not resolve this exact retained request.');
  if (state.state === 'recorded')
    validateRow(state.data, { tenantId: operation.tenantId, ...request });
  else {
    const snapshot = publicControlReviewCancellationSnapshotSchema.parse(
      JSON.parse(state.data.cancellation_text),
    );
    if (
      canonicalJson(snapshot) !== state.data.cancellation_text ||
      canonicalJson(snapshot) !==
        canonicalJson({
          version: 1,
          tenantId: operation.tenantId,
          actorId: operation.actorId,
          engagementId: request.engagementId,
          checkId: request.checkId,
          operationKey: request.operationKey,
          requestSha256: state.data.request_sha256,
          reason: state.data.reason,
        })
    )
      throw new Error('The cancellation receipt does not match this retained request.');
  }
  return state;
}
/** Read-only reconciliation. Not-found cannot prove an earlier request will not commit. */
export async function reconcileHumanControlReview(operation: ControlReviewOperation) {
  operation = controlReviewOperationSchema.parse(operation);
  const request = parsePublicControlReviewSetRequestText(operation.requestText);
  const response = await fetch(
    `/api/bff/v1/public-control-review-sets/operations/${request.operationKey}?engagementId=${request.engagementId}&checkId=${request.checkId}`,
    {
      cache: 'no-store',
      headers: { 'X-Tenant-Id': operation.tenantId },
      signal: AbortSignal.timeout(20000),
    },
  );
  const body = z
    .object({ data: z.unknown() })
    .strict()
    .parse(await jsonResponse(response));
  return verifyResolution(body.data, operation);
}
export async function sendHumanControlReview(
  storage: Storage,
  operation: ControlReviewOperation,
  cancellationReason?: string,
) {
  operation = controlReviewOperationSchema.parse(operation);
  assertControlReviewOperation(storage, operation);
  const request = parsePublicControlReviewSetRequestText(operation.requestText);
  const cancelling = cancellationReason !== undefined;
  const body = cancelling
    ? canonicalJson(
        cancelPublicControlReviewOperationRequestSchema.parse({
          request,
          reason: cancellationReason,
        }),
      )
    : operation.requestText;
  let response: Response;
  try {
    response = await fetch(
      cancelling
        ? `/api/bff/v1/public-control-review-sets/operations/${request.operationKey}/cancel`
        : '/api/bff/v1/public-control-review-sets',
      {
        method: 'POST',
        cache: 'no-store',
        signal: AbortSignal.timeout(20000),
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': operation.tenantId,
          'X-Expected-Actor-Id': operation.actorId,
          'Idempotency-Key': request.operationKey,
        },
        body,
      },
    );
  } catch {
    throw new Error(
      'Response interrupted. The human review outcome is uncertain. Reconcile the retained request before retrying.',
    );
  }
  const result = await jsonResponse(response);
  if (cancelling) {
    const state = verifyResolution(
      z.object({ data: z.unknown() }).strict().parse(result).data,
      operation,
    );
    if (state.state === 'cancelled' && state.data.reason !== cancellationReason)
      throw new Error(
        'The cancellation receipt does not match the confirmed cancellation reason. Reconcile the retained request.',
      );
    return state;
  }
  const saved = recorded.parse(result);
  return verifyResolution(
    {
      state: 'recorded',
      data: saved.data.review,
      isCurrent: saved.data.isCurrent,
      contextCurrent: saved.data.contextCurrent,
    },
    operation,
  );
}
