import { z } from 'zod';
import { canonicalJson } from '@axiom/ledger';
import {
  AssessmentRequestSchema,
  AssessmentSourceRefusalSchema,
  type AssessmentSourceRefusal,
  assessmentSourceOperationSchema,
  cancelAssessmentSourceIntentSchema,
  type AssessmentSourceOperation,
  AssessmentRequestReceiptSchema,
  ASSESSMENT_REQUEST_MAX_BYTES,
} from '@axiom/types';

export class AssessmentRequestError extends Error {}
export class AssessmentSourceRequiredError extends AssessmentRequestError {
  constructor(readonly refusal: AssessmentSourceRefusal) {
    super(
      'This deployment requires a saved public-control human review. No assessment job was recorded for this request. Open Discovery, complete source review, and use its exact assessment link.',
    );
  }
}
function matchSourceRefusal(value: RetainedAssessment, raw: unknown) {
  const refusal = AssessmentSourceRefusalSchema.parse(raw);
  if (
    value.request.reviewRef ||
    refusal.requestText !== canonicalJson(value.request) ||
    refusal.tenantId !== value.tenantId ||
    refusal.actorId !== value.actorId ||
    refusal.operationKey !== value.request.operationKey ||
    refusal.engagementId !== value.request.engagementId
  )
    throw new AssessmentRequestError(
      'The refusal does not match the retained request. Keep its browser reference.',
    );
  return refusal;
}
export const ASSESSMENT_JOURNAL_CHANGED = 'axiom:assessment-request-changed';
const uuid = z.uuid();
export const retainedAssessmentSchema = z
  .object({
    tenantId: uuid,
    actorId: uuid,
    libraryVersion: z.string().min(1).max(200),
    request: AssessmentRequestSchema,
    questionnaireDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      (Object.keys(value.request.answers).length === 0 &&
        Object.values(value.request.applicability).every((flag) => flag === null)) ||
      value.questionnaireDigest !== undefined,
  )
  .refine(
    (value) =>
      !value.request.expectedQuestionnaire ||
      (value.request.expectedQuestionnaire.libraryVersion === value.libraryVersion &&
        value.request.expectedQuestionnaire.questionnaireDigest === value.questionnaireDigest),
    'The retained questionnaire does not match the reviewed source.',
  )
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value.request)).length <=
      ASSESSMENT_REQUEST_MAX_BYTES,
    'The questionnaire exceeds the supported request size.',
  );
export type RetainedAssessment = z.infer<typeof retainedAssessmentSchema>;
export const assessmentJournalKey = (tenant: string, actor: string) =>
  `axiom.assessment-request.v1:${uuid.parse(tenant)}:${uuid.parse(actor)}`;
export function readAssessmentJournal(storage: Storage, tenant: string, actor: string) {
  const raw = storage.getItem(assessmentJournalKey(tenant, actor));
  if (raw === null) return null;
  if (new TextEncoder().encode(raw).length > ASSESSMENT_REQUEST_MAX_BYTES + 1024)
    throw new AssessmentRequestError('Retained request could not be verified.');
  const value = retainedAssessmentSchema.parse(JSON.parse(raw));
  if (value.tenantId !== tenant || value.actorId !== actor)
    throw new AssessmentRequestError(
      'The retained request belongs to another account or organisation.',
    );
  return value;
}
export function retainAssessmentJournal(storage: Storage, value: RetainedAssessment) {
  const parsed = retainedAssessmentSchema.parse(value);
  const old = readAssessmentJournal(storage, parsed.tenantId, parsed.actorId);
  const raw = JSON.stringify(parsed);
  if (
    new TextEncoder().encode(raw).length > ASSESSMENT_REQUEST_MAX_BYTES + 1024 ||
    new TextEncoder().encode(JSON.stringify(parsed.request)).length > ASSESSMENT_REQUEST_MAX_BYTES
  )
    throw new AssessmentRequestError(
      'The questionnaire exceeds the supported request size. Nothing was submitted.',
    );
  if (old && JSON.stringify(old) !== raw)
    throw new AssessmentRequestError(
      'Resolve the retained assessment request before starting another.',
    );
  const key = assessmentJournalKey(parsed.tenantId, parsed.actorId);
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw)
    throw new AssessmentRequestError('The request could not be retained. Nothing was submitted.');
  window.dispatchEvent(new Event(ASSESSMENT_JOURNAL_CHANGED));
}
export function clearFinalizedAssessmentJournal(
  storage: Storage,
  value: RetainedAssessment,
  readout: AssessmentJobReadout,
) {
  const status = assessmentJobReadoutSchema.parse(readout);
  if (
    (status.status !== 'finalization_recorded' && status.status !== 'resolution_recorded') ||
    (status.status === 'resolution_recorded' && status.resolution.actorId !== value.actorId) ||
    status.jobId !== value.request.operationKey ||
    status.engagementId !== value.request.engagementId ||
    status.correlationId !== value.request.operationKey ||
    status.libraryVersion !== value.libraryVersion
  )
    throw new AssessmentRequestError(
      'Only a matching finalized or resolved request may be archived.',
    );
  const old = readAssessmentJournal(storage, value.tenantId, value.actorId);
  if (!old || JSON.stringify(old) !== JSON.stringify(value))
    throw new AssessmentRequestError('Retained request changed. Reload before continuing.');
  storage.removeItem(assessmentJournalKey(value.tenantId, value.actorId));
  window.dispatchEvent(new Event(ASSESSMENT_JOURNAL_CHANGED));
}
async function responseBody(response: Response) {
  if (!response.ok) {
    const error = z
      .object({
        error: z.object({
          code: z
            .string()
            .max(100)
            .regex(/^[a-z0-9_]+$/),
        }),
      })
      .safeParse(await response.json().catch(() => null));
    throw new AssessmentRequestError(
      error.success
        ? `The request could not be confirmed (${error.data.error.code}). Check the retained request before continuing.`
        : 'The request could not be confirmed. Check the retained request before continuing.',
    );
  }
  return response.json() as Promise<unknown>;
}
export async function submitAssessmentRequest(value: RetainedAssessment) {
  const retained = retainedAssessmentSchema.parse(value);
  let response: Response;
  try {
    response = await fetch('/api/bff/v1/assessment/jobs', {
      method: 'POST',
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': retained.tenantId,
        'X-Expected-Actor-Id': retained.actorId,
        'Idempotency-Key': retained.request.operationKey,
      },
      body: JSON.stringify(retained.request),
    });
  } catch {
    throw new AssessmentRequestError(
      'The response was interrupted. Check the retained request; do not start another.',
    );
  }
  if (response.status === 409) {
    const body: unknown = await response.json().catch(() => null);
    const refusal = AssessmentSourceRefusalSchema.safeParse(
      (body as { error?: unknown } | null)?.error,
    );
    if (refusal.success)
      throw new AssessmentSourceRequiredError(matchSourceRefusal(retained, refusal.data));
    throw new AssessmentRequestError(
      'The request could not be confirmed. Keep its browser reference and check recorded status.',
    );
  }
  const parsed = AssessmentRequestReceiptSchema.safeParse(await responseBody(response));
  if (response.status !== 202 || !parsed.success)
    throw new AssessmentRequestError(
      'The returned assessment receipt could not be verified. Check the retained request.',
    );
  const receipt = parsed.data;
  if (
    receipt.jobId !== retained.request.operationKey ||
    receipt.statusUrl !== `/api/bff/v1/assessment/jobs/${receipt.jobId}`
  )
    throw new AssessmentRequestError('The returned receipt does not match the retained request.');
  return receipt;
}
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const receiptId = z
  .string()
  .max(19)
  .regex(/^[1-9][0-9]*$/);
const baseStatus = z.object({
  jobId: uuid,
  runId: uuid,
  engagementId: uuid,
  correlationId: uuid,
  libraryVersion: z.string().min(1),
  recordedRunStatus: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out']),
  schedulingStatus: z.enum(['pending', 'submitted', 'needs_review']),
  createdAt: z.iso.datetime({ offset: true }),
  claimedAt: z.iso.datetime({ offset: true }).nullable(),
  allAgentEndToEndAccepted: z.literal(false),
});
export const assessmentJobReadoutSchema = z
  .discriminatedUnion('status', [
    baseStatus
      .extend({
        status: z.literal('resolution_recorded'),
        phase: z.literal('cancelled_unclaimed'),
        finalization: z.null(),
        resolution: z
          .object({
            actorId: uuid,
            requestedReceipt: receiptId,
            cancellationReceipt: receiptId,
            resolvedAt: z.iso.datetime({ offset: true }),
            verification: z.literal('persisted_human_unclaimed_cancellation_bindings'),
            workerCleanupVerified: z.literal(false),
          })
          .strict(),
      })
      .strict(),
    baseStatus
      .extend({
        status: z.literal('unconfirmed'),
        phase: z.enum(['queued', 'running', 'result_recorded', 'terminal_unconfirmed']),
        finalization: z.null(),
      })
      .strict(),
    baseStatus
      .extend({
        status: z.literal('finalization_recorded'),
        phase: z.literal('finalized'),
        finalization: z
          .object({
            startedReceipt: receiptId,
            completedReceipt: receiptId,
            finalizedReceipt: receiptId,
            resultDigest: digest,
            completedAt: z.iso.datetime({ offset: true }),
            finalizedAt: z.iso.datetime({ offset: true }),
            verification: z.literal('persisted_controller_receipt_bindings'),
          })
          .strict(),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (
      value.status === 'resolution_recorded' &&
      (value.recordedRunStatus !== 'cancelled' ||
        value.claimedAt !== null ||
        value.resolution.requestedReceipt === value.resolution.cancellationReceipt ||
        Date.parse(value.resolution.resolvedAt) < Date.parse(value.createdAt))
    )
      context.addIssue({ code: 'custom', message: 'Resolved status is inconsistent' });
    if (value.status !== 'finalization_recorded') return;
    const final = value.finalization;
    if (
      value.recordedRunStatus !== 'succeeded' ||
      value.claimedAt === null ||
      new Set([final.startedReceipt, final.completedReceipt, final.finalizedReceipt]).size !== 3 ||
      Date.parse(final.finalizedAt) < Date.parse(final.completedAt)
    )
      context.addIssue({ code: 'custom', message: 'Finalized status is inconsistent' });
  });
export type AssessmentJobReadout = z.infer<typeof assessmentJobReadoutSchema>;
export async function readAssessmentRequest(value: RetainedAssessment) {
  const retained = retainedAssessmentSchema.parse(value);
  let response: Response;
  try {
    response = await fetch(`/api/bff/v1/assessment/jobs/${retained.request.operationKey}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
      headers: { 'X-Tenant-Id': retained.tenantId },
    });
  } catch {
    throw new AssessmentRequestError(
      'Recorded status is unavailable. Keep the retained request and check again.',
    );
  }
  const parsed = assessmentJobReadoutSchema.safeParse(await responseBody(response));
  if (!parsed.success)
    throw new AssessmentRequestError('Saved assessment status could not be verified.');
  const status = parsed.data;
  if (
    status.jobId !== retained.request.operationKey ||
    status.correlationId !== retained.request.operationKey ||
    status.engagementId !== retained.request.engagementId ||
    status.libraryVersion !== retained.libraryVersion
  )
    throw new AssessmentRequestError(
      'Saved status does not match the retained assessment request.',
    );
  return status;
}

/** Backward-compatible unknown-draft caller; full intake uses the same fenced endpoint. */
export const submitUnknownAssessment = submitAssessmentRequest;

export async function cancelUnclaimedAssessmentRequest(
  value: RetainedAssessment,
  readout: AssessmentJobReadout,
) {
  const retained = retainedAssessmentSchema.parse(value),
    status = assessmentJobReadoutSchema.parse(readout);
  if (
    status.status !== 'unconfirmed' ||
    status.recordedRunStatus !== 'queued' ||
    status.phase !== 'queued' ||
    status.claimedAt !== null ||
    status.jobId !== retained.request.operationKey ||
    status.correlationId !== retained.request.operationKey ||
    status.engagementId !== retained.request.engagementId ||
    status.libraryVersion !== retained.libraryVersion
  )
    throw new AssessmentRequestError(
      'Only the matching recorded unclaimed request may be cancelled.',
    );
  let response: Response;
  try {
    response = await fetch(`/api/bff/v1/assessment/jobs/${retained.request.operationKey}/cancel`, {
      method: 'POST',
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': retained.tenantId,
        'X-Expected-Actor-Id': retained.actorId,
        'Idempotency-Key': retained.request.operationKey,
      },
      body: JSON.stringify(retained.request),
    });
  } catch {
    throw new AssessmentRequestError(
      'Cancellation response was interrupted. Keep the original reference and check its recorded status.',
    );
  }
  const receipt = z
    .object({
      jobId: uuid,
      runId: uuid,
      cancellationReceipt: receiptId,
      resolvedAt: z.iso.datetime({ offset: true }),
      status: z.literal('cancellation_recorded'),
    })
    .strict()
    .safeParse(await responseBody(response));
  if (
    response.status !== 202 ||
    !receipt.success ||
    receipt.data.jobId !== status.jobId ||
    receipt.data.runId !== status.runId
  )
    throw new AssessmentRequestError(
      'Cancellation receipt could not be verified. Keep the original reference and check again.',
    );
  return receipt.data;
}

/** Positive server proof only; not_found/refusal never clears an unknown intent. */
export async function resolveAssessmentSourceIntent(value: RetainedAssessment, reason?: string) {
  const retained = retainedAssessmentSchema.parse(value),
    request = retained.request;
  if (!request.reviewRef)
    throw new AssessmentRequestError('This request has no recorded review reference.');
  if (reason !== undefined) cancelAssessmentSourceIntentSchema.parse({ request, reason });
  const params = new URLSearchParams({ engagementId: request.engagementId, ...request.reviewRef });
  const response = await fetch(
    `/api/bff/v1/assessment/jobs/${request.operationKey}/${reason === undefined ? `source-operation?${params}` : 'cancel-source-intent'}`,
    {
      method: reason === undefined ? 'GET' : 'POST',
      cache: 'no-store',
      signal: AbortSignal.timeout(20000),
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': retained.tenantId,
        'X-Expected-Actor-Id': retained.actorId,
        'Idempotency-Key': request.operationKey,
      },
      ...(reason === undefined ? {} : { body: JSON.stringify({ request, reason }) }),
    },
  );
  const raw = await responseBody(response);
  const envelope = z.object({ data: assessmentSourceOperationSchema }).strict().parse(raw);
  const state = envelope.data;
  if (state.state === 'recorded' && state.jobId !== request.operationKey)
    throw new AssessmentRequestError('Recorded operation does not match the retained request.');
  if (state.state === 'cancelled') {
    const row = state.data;
    if (
      row.tenant_id !== retained.tenantId ||
      row.actor_id !== retained.actorId ||
      row.job_id !== request.operationKey ||
      row.engagement_id !== request.engagementId ||
      row.request_text !== canonicalJson(request) ||
      row.cancellation_text !==
        canonicalJson({
          version: 1,
          tenantId: row.tenant_id,
          actorId: row.actor_id,
          jobId: row.job_id,
          engagementId: row.engagement_id,
          requestSha256: row.request_sha256,
          reason: row.reason,
        }) ||
      (reason !== undefined && row.reason !== reason)
    )
      throw new AssessmentRequestError(
        'Cancellation proof does not match the retained source request.',
      );
  }
  return state;
}
export function clearCancelledAssessmentSourceJournal(
  storage: Storage,
  value: RetainedAssessment,
  state: AssessmentSourceOperation,
) {
  if (
    state.state !== 'cancelled' ||
    state.data.tenant_id !== value.tenantId ||
    state.data.actor_id !== value.actorId ||
    state.data.job_id !== value.request.operationKey ||
    state.data.request_text !== canonicalJson(value.request)
  )
    throw new AssessmentRequestError(
      'Only matching positive cancellation proof can archive the browser reference.',
    );
  const old = readAssessmentJournal(storage, value.tenantId, value.actorId);
  if (!old || JSON.stringify(old) !== JSON.stringify(value))
    throw new AssessmentRequestError('Retained request changed. Reload before continuing.');
  storage.removeItem(assessmentJournalKey(value.tenantId, value.actorId));
  window.dispatchEvent(new Event(ASSESSMENT_JOURNAL_CHANGED));
}

/** Archiving requires BOTH a matching definite pre-dispatch server refusal and
 * a fresh authenticated exact-job 404. Network failure or absence alone cannot
 * discard an ambiguous/in-flight request. Preserve the rejection receipt first. */
export async function archiveRejectedAssessmentJournal(
  storage: Storage,
  value: RetainedAssessment,
  raw: unknown,
) {
  const retained = retainedAssessmentSchema.parse(value),
    refusal = matchSourceRefusal(retained, raw);
  const check = () => {
    if (
      JSON.stringify(readAssessmentJournal(storage, retained.tenantId, retained.actorId)) !==
      JSON.stringify(retained)
    )
      throw new AssessmentRequestError('Retained request changed. Reload before continuing.');
  };
  check();
  const response = await fetch(`/api/bff/v1/assessment/jobs/${retained.request.operationKey}`, {
    method: 'GET',
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
    headers: { 'X-Tenant-Id': retained.tenantId, 'X-Expected-Actor-Id': retained.actorId },
  });
  const missing = z
    .object({ error: z.object({ code: z.literal('assessment_job_not_found') }).strict() })
    .strict()
    .safeParse(await response.json().catch(() => null));
  if (response.status !== 404 || !missing.success)
    throw new AssessmentRequestError(
      'The exact job absence could not be confirmed. Keep the retained browser reference.',
    );
  check();
  const archiveKey =
    assessmentJournalKey(retained.tenantId, retained.actorId) +
    ':rejected:' +
    retained.request.operationKey;
  const archived = JSON.stringify({
    schemaVersion: 1,
    retained,
    refusal,
    checkedJobState: 'not_found',
  });
  const old = storage.getItem(archiveKey);
  if (old !== null && old !== archived)
    throw new AssessmentRequestError(
      'An archived rejection conflicts with this request. Keep the active reference.',
    );
  storage.setItem(archiveKey, archived);
  check();
  storage.removeItem(assessmentJournalKey(retained.tenantId, retained.actorId));
  window.dispatchEvent(new Event(ASSESSMENT_JOURNAL_CHANGED));
}
