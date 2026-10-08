import { z } from 'zod';
import { canonicalJson, sha256 } from '@axiom/ledger';
import {
  sudhaarReviewAdoptionRequestSchema,
  sudhaarReviewAdoptionReceiptSchema,
} from '@axiom/types';

export const reviewAdoptionJournalSchema = z
  .object({
    version: z.literal(1),
    tenantId: z.uuid(),
    actorId: z.uuid(),
    proposalOperationKey: z.uuid(),
    request: sudhaarReviewAdoptionRequestSchema,
  })
  .strict();
export type ReviewAdoptionJournal = z.infer<typeof reviewAdoptionJournalSchema>;
export class ReviewAdoptionRequestError extends Error {}
export const REVIEW_ADOPTION_CHANGED = 'axiom-review-adoption-changed';
export function reviewAdoptionJournalKey(tenantId: string, actorId: string) {
  return `axiom:review-adoption:v1:${tenantId}:${actorId}`;
}
export function readReviewAdoptionJournal(
  storage: Pick<Storage, 'getItem'>,
  tenantId: string,
  actorId: string,
) {
  const raw = storage.getItem(reviewAdoptionJournalKey(tenantId, actorId));
  if (raw === null) return null;
  if (raw.length > 16000)
    throw new ReviewAdoptionRequestError(
      'The saved review request is unreadable. Preserve it for review.',
    );
  const value = reviewAdoptionJournalSchema.parse(JSON.parse(raw));
  if (value.tenantId !== tenantId || value.actorId !== actorId)
    throw new ReviewAdoptionRequestError('The saved request belongs to another session.');
  return value;
}
export function retainReviewAdoptionJournal(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  input: ReviewAdoptionJournal,
) {
  const value = reviewAdoptionJournalSchema.parse(input);
  const previous = readReviewAdoptionJournal(storage, value.tenantId, value.actorId);
  if (previous && canonicalJson(previous) !== canonicalJson(value))
    throw new ReviewAdoptionRequestError(
      'Confirm the retained review request before creating another.',
    );
  const key = reviewAdoptionJournalKey(value.tenantId, value.actorId),
    raw = JSON.stringify(value);
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw)
    throw new ReviewAdoptionRequestError(
      'The review request could not be retained. Nothing was submitted.',
    );
  window.dispatchEvent(new Event(REVIEW_ADOPTION_CHANGED));
  return value;
}
/** Call only under the panel's manual-submit lock after durable exact readback. */
export async function submitReviewAdoption(input: ReviewAdoptionJournal) {
  const value = reviewAdoptionJournalSchema.parse(input);
  try {
    const response = await fetch(
      `/api/bff/v1/plans/proposals/${value.proposalOperationKey}/adopt`,
      {
        method: 'POST',
        cache: 'no-store',
        signal: AbortSignal.timeout(20000),
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': value.tenantId,
          'X-Expected-Actor-Id': value.actorId,
          'Idempotency-Key': value.request.adoptionKey,
        },
        body: JSON.stringify(value.request),
      },
    );
    if (response.status !== 201)
      throw new ReviewAdoptionRequestError(
        'Review work is unconfirmed. Keep the retained request and retry using the same request.',
      );
    const receipt = sudhaarReviewAdoptionReceiptSchema.parse(await response.json());
    const requestHash = await sha256(
      canonicalJson({
        tenantId: value.tenantId,
        actorId: value.actorId,
        proposalOperationKey: value.proposalOperationKey,
        ...value.request,
      }),
    );
    if (
      receipt.tenantId !== value.tenantId ||
      receipt.actorId !== value.actorId ||
      receipt.proposalOperationKey !== value.proposalOperationKey ||
      receipt.adoptionKey !== value.request.adoptionKey ||
      receipt.requestHash !== requestHash
    )
      throw new Error('Unbound review receipt');
    return receipt;
  } catch (cause) {
    if (cause instanceof ReviewAdoptionRequestError) throw cause;
    throw new ReviewAdoptionRequestError(
      'The review response was interrupted or could not be verified. Keep the retained request and retry using the same request.',
    );
  }
}
