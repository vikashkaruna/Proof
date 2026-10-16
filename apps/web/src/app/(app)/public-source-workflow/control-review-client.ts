import { z } from 'zod';
import {
  publicControlCatalogueV2Manifest,
  publicEvidenceCatalogueRowsMatchV2,
} from '@axiom/control-library';
import { canonicalJson } from '@axiom/ledger';
import {
  cancelPublicControlReviewOperationRequestSchema,
  parsePublicControlReviewSetRequestText,
  publicControlReviewCancellationRowSchema,
  publicControlReviewCancellationSnapshotSchema,
  publicControlReviewSetRequestSchema,
  publicControlReviewSetRowSchema,
  publicControlReviewSetSnapshotSchema,
  publicControlAssessmentV2Schema,
  type PublicControlAssessmentV2,
} from '@axiom/types';
import {
  controlReviewOperationSchema,
  assertControlReviewOperation,
  type ControlReviewOperation,
} from './control-review-journal';

const uuid = z.uuid().transform((v) => v.toLowerCase());
const row = publicControlReviewSetRowSchema
  .extend({ snapshot: publicControlReviewSetSnapshotSchema })
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
  const manifest = publicControlCatalogueV2Manifest();
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
  if (!publicEvidenceCatalogueRowsMatchV2(source.controls))
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
