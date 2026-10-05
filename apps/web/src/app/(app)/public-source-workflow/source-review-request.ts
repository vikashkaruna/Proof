import { z } from 'zod';
import { createPublicSourceReviewSchema } from '@axiom/types';
import { SourceWorkflowError } from './source-request';
const uuid = z.uuid().transform((value) => value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const refusal = z.enum(['stale_review', 'digest_mismatch', 'target_refused']);
export type ReviewRefusal = z.infer<typeof refusal>;
export class ReviewRequestError extends SourceWorkflowError {
  constructor(
    message: string,
    readonly refusalCode?: ReviewRefusal,
  ) {
    super(message);
  }
}
export const reviewOperationSchema = z
  .object({
    version: z.literal(1),
    tenantId: uuid,
    actorId: uuid,
    operationKey: uuid,
    engagementId: uuid,
    bindingId: uuid,
    observationId: uuid,
    checkId: uuid,
    agent: z.enum(['drishti', 'vibhaag']),
    rootSha256: digest,
    outputSha256: digest,
    projectionSha256: digest,
    bodyUtf8: z.string().min(1).max(16000),
    refusalCode: refusal.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    try {
      const body = createPublicSourceReviewSchema.parse(JSON.parse(value.bodyUtf8));
      if (
        JSON.stringify(body) !== value.bodyUtf8 ||
        body.engagementId !== value.engagementId ||
        body.expectedOutputSha256 !== value.outputSha256 ||
        body.expectedProjectionSha256 !== value.projectionSha256 ||
        (value.agent === 'drishti' && body.target.kind !== 'whole_observation')
      )
        ctx.addIssue({ code: 'custom', message: 'Retained review differs from its source' });
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid retained review' });
    }
  });
export type ReviewOperation = z.infer<typeof reviewOperationSchema>;
export function reviewStorageKey(tenantId: string, actorId: string) {
  return `axiom.public-source.review.v1:${tenantId.toLowerCase()}:${actorId.toLowerCase()}`;
}
export function loadReviewOperation(
  storage: Storage,
  tenantId: string,
  actorId: string,
): ReviewOperation | null {
  const bytes = storage.getItem(reviewStorageKey(tenantId, actorId));
  if (bytes === null) return null;
  const op = reviewOperationSchema.parse(JSON.parse(bytes));
  if (op.tenantId !== tenantId.toLowerCase() || op.actorId !== actorId.toLowerCase())
    throw new SourceWorkflowError('This retained review belongs to another account or tenant.');
  return op;
}
function immutable(op: ReviewOperation) {
  const { refusalCode: _refusalCode, ...intent } = op;
  return JSON.stringify(intent);
}
export function saveReviewOperation(storage: Storage, operation: ReviewOperation) {
  const op = reviewOperationSchema.parse(operation),
    key = reviewStorageKey(op.tenantId, op.actorId);
  const existing = loadReviewOperation(storage, op.tenantId, op.actorId);
  if (existing && immutable(existing) !== immutable(op))
    throw new SourceWorkflowError('Reconcile the existing review before recording another.');
  const bytes = JSON.stringify(op);
  storage.setItem(key, bytes);
  if (storage.getItem(key) !== bytes)
    throw new SourceWorkflowError('Unable to retain this review safely. No request was sent.');
}
export function recordReviewRefusal(
  storage: Storage,
  operation: ReviewOperation,
  code: ReviewRefusal,
) {
  const current = loadReviewOperation(storage, operation.tenantId, operation.actorId);
  if (!current || immutable(current) !== immutable(operation))
    throw new SourceWorkflowError('The retained review changed. Reconcile it before continuing.');
  saveReviewOperation(storage, { ...current, refusalCode: refusal.parse(code) });
}
export function clearReviewOperation(storage: Storage, operation: ReviewOperation) {
  const current = loadReviewOperation(storage, operation.tenantId, operation.actorId);
  if (!current || immutable(current) !== immutable(operation))
    throw new SourceWorkflowError('The retained review changed. Reconcile it before continuing.');
  const key = reviewStorageKey(operation.tenantId, operation.actorId);
  storage.removeItem(key);
  if (storage.getItem(key) !== null)
    throw new SourceWorkflowError(
      'Unable to clear the retained review safely. Reconcile before continuing.',
    );
}
export function reviewOperationPath(operation: ReviewOperation) {
  return `/public-source-bindings/${operation.bindingId}/observations/${operation.observationId}/reviews`;
}
/** One explicit attempt, always the acknowledged journal bytes and original key. */
export async function dispatchReviewRequest(
  storage: Storage,
  operation: ReviewOperation,
): Promise<unknown> {
  const op = reviewOperationSchema.parse(operation),
    stored = loadReviewOperation(storage, op.tenantId, op.actorId);
  if (!stored || immutable(stored) !== immutable(op))
    throw new SourceWorkflowError('The retained review changed. No request was sent.');
  let response: Response;
  try {
    response = await fetch(`/api/bff/v1${reviewOperationPath(op)}`, {
      method: 'POST',
      cache: 'no-store',
      signal: AbortSignal.timeout(60000),
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': op.tenantId,
        'Idempotency-Key': op.operationKey,
      },
      body: op.bodyUtf8,
    });
  } catch {
    throw new ReviewRequestError(
      'Review response interrupted. Reconcile the retained review before any retry.',
    );
  }
  if (!response.ok) {
    let known: ReviewRefusal | undefined;
    if (response.status === 409 || response.status === 404) {
      try {
        const parsed = z
          .object({ error: z.object({ code: refusal }).strict() })
          .strict()
          .parse(await response.json());
        const code = parsed.error.code;
        if (
          (code === 'target_refused' && response.status === 404) ||
          (code !== 'target_refused' && response.status === 409)
        )
          known = code;
      } catch {
        /* Unknown outcomes remain held. */
      }
    }
    throw new ReviewRequestError(
      known
        ? 'The review was refused. Reconcile this exact request before changing it.'
        : 'Review outcome is unconfirmed. Reconcile the retained review before continuing.',
      known,
    );
  }
  return response.json() as Promise<unknown>;
}
