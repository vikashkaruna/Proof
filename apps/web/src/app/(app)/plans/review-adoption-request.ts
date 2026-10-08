import { z } from 'zod';
import type { SudhaarReviewAdoptionReceipt } from '@axiom/types';
import type { ConfirmedProposal } from './proposal-request';
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
const verifiedAdoptions = new WeakMap<object, string>();
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
    verifiedAdoptions.set(receipt, canonicalJson({ journal: value, receipt }));
    return receipt;
  } catch (cause) {
    if (cause instanceof ReviewAdoptionRequestError) throw cause;
    throw new ReviewAdoptionRequestError(
      'The review response was interrupted or could not be verified. Keep the retained request and retry using the same request.',
    );
  }
}

export function completedReviewAdoptionKey(
  tenantId: string,
  actorId: string,
  operationKey: string,
) {
  return `${reviewAdoptionJournalKey(tenantId, actorId)}:completed:${operationKey}`;
}
/** Browser recovery context only. A deliberate server replay must confirm any saved work. */
export function readCompletedReviewAdoptionReference(
  storage: Pick<Storage, 'getItem'>,
  tenantId: string,
  actorId: string,
  operationKey: string,
) {
  const raw = storage.getItem(completedReviewAdoptionKey(tenantId, actorId, operationKey));
  if (raw === null) return null;
  if (raw.length > 16000)
    throw new ReviewAdoptionRequestError(
      'The saved reference is unreadable. Preserve it for review.',
    );
  const value = reviewAdoptionJournalSchema.parse(JSON.parse(raw));
  if (
    value.tenantId !== tenantId ||
    value.actorId !== actorId ||
    value.proposalOperationKey !== operationKey
  )
    throw new ReviewAdoptionRequestError('The saved reference belongs to another review.');
  return value;
}
export function confirmReviewAdoptionSource(
  receipt: SudhaarReviewAdoptionReceipt,
  confirmed: ConfirmedProposal,
) {
  const proof = confirmed.outputProof;
  if (
    canonicalJson(receipt.source) !== canonicalJson(confirmed.proposal.source) ||
    receipt.taskCount !== confirmed.proposal.review_tasks.length ||
    receipt.outputProof.runId !== proof.runId ||
    receipt.outputProof.inputHash !== proof.requestHash ||
    receipt.outputProof.outputHash !== proof.responseHash ||
    receipt.outputProof.requestedReceipt !== proof.requestedReceipt ||
    receipt.outputProof.startedReceipt !== proof.startedReceipt ||
    receipt.outputProof.completedReceipt !== proof.completedReceipt ||
    receipt.outputProof.settledReceipt !== proof.settledReceipt
  )
    throw new ReviewAdoptionRequestError(
      'The saved review source could not be confirmed. Keep the retained request.',
    );
}
/** Called deliberately under the same cross-tab lock as submission; never archives uncertain work. */
export function archiveConfirmedReviewAdoption(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  journal: ReviewAdoptionJournal,
  receipt: SudhaarReviewAdoptionReceipt,
  confirmed: ConfirmedProposal,
) {
  if (verifiedAdoptions.get(receipt) !== canonicalJson({ journal, receipt }))
    throw new ReviewAdoptionRequestError('Confirm the saved work before archiving its request.');
  confirmReviewAdoptionSource(receipt, confirmed);
  const key = reviewAdoptionJournalKey(journal.tenantId, journal.actorId);
  if (
    canonicalJson(readReviewAdoptionJournal(storage, journal.tenantId, journal.actorId)) !==
    canonicalJson(journal)
  )
    throw new ReviewAdoptionRequestError('The retained request changed. Preserve it for review.');
  const completedKey = completedReviewAdoptionKey(
    journal.tenantId,
    journal.actorId,
    journal.proposalOperationKey,
  );
  const previous = readCompletedReviewAdoptionReference(
    storage,
    journal.tenantId,
    journal.actorId,
    journal.proposalOperationKey,
  );
  if (previous && canonicalJson(previous) !== canonicalJson(journal))
    throw new ReviewAdoptionRequestError(
      'A different saved reference exists. Preserve both for review.',
    );
  const raw = JSON.stringify(journal);
  storage.setItem(completedKey, raw);
  if (storage.getItem(completedKey) !== raw)
    throw new ReviewAdoptionRequestError(
      'The saved reference could not be retained. Keep the pending request.',
    );
  // Recheck after write: storage implementations and another tab cannot replace pending authority.
  if (
    canonicalJson(readReviewAdoptionJournal(storage, journal.tenantId, journal.actorId)) !==
    canonicalJson(journal)
  )
    throw new ReviewAdoptionRequestError('The retained request changed. Preserve it for review.');
  storage.removeItem(key);
  if (storage.getItem(key) !== null)
    throw new ReviewAdoptionRequestError(
      'The confirmed request could not be archived. Keep it for review.',
    );
  window.dispatchEvent(new Event(REVIEW_ADOPTION_CHANGED));
}
