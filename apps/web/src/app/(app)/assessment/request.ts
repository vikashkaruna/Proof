import { z } from 'zod';
import {
  AssessmentRequestSchema,
  AssessmentRequestReceiptSchema,
  ASSESSMENT_REQUEST_MAX_BYTES,
} from '@axiom/types';

export class AssessmentRequestError extends Error {}
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
    status.status !== 'finalization_recorded' ||
    status.jobId !== value.request.operationKey ||
    status.engagementId !== value.request.engagementId ||
    status.correlationId !== value.request.operationKey ||
    status.libraryVersion !== value.libraryVersion
  )
    throw new AssessmentRequestError('Only a confirmed finalized request may be archived.');
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
