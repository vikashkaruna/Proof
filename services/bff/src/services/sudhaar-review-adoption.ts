import { z } from 'zod';
import { canonicalJson, sha256 } from '@axiom/ledger';
import { createHumanActionWriter } from '@axiom/supabase';
import {
  sudhaarInputSchema,
  sudhaarReviewAdoptionReceiptSchema,
  type SudhaarReviewAdoptionRequest,
} from '@axiom/types';
import type { GenericAgentInvocationDeps } from './generic-agent-invocation.js';
import { recoverSudhaarOutput } from './sudhaar-proposal-output.js';
export type ReviewAdoptionWriterFactory = NonNullable<GenericAgentInvocationDeps['writerFactory']>;
export class ReviewAdoptionRefused extends Error {
  constructor(
    readonly code:
      'review_source_unavailable' | 'review_adoption_conflict' | 'review_adoption_uncertain',
  ) {
    super(code);
  }
}
/** Read only server-resolved immutable source; caller tasks/actions are never accepted. */
export async function adoptSudhaarReview(
  tenantId: string,
  actorId: string,
  proposalOperationKey: string,
  request: SudhaarReviewAdoptionRequest,
  writerFactory: ReviewAdoptionWriterFactory = createHumanActionWriter,
) {
  const { data: resolved, error: readError } = await writerFactory()
    .rpc('read_sudhaar_review_adoption_source', {
      p_tenant_id: tenantId,
      p_actor_id: actorId,
      p_operation_key: proposalOperationKey,
    })
    .abortSignal(AbortSignal.timeout(15000));
  const source = z
    .object({ input_text: z.string().min(1).max(524288) })
    .strict()
    .safeParse(resolved);
  if (readError || !source.success) throw new ReviewAdoptionRefused('review_source_unavailable');
  const input = sudhaarInputSchema.parse(JSON.parse(source.data.input_text));
  if (input.tenant_id !== tenantId || canonicalJson(input) !== source.data.input_text)
    throw new ReviewAdoptionRefused('review_source_unavailable');
  const saved = await recoverSudhaarOutput(
    tenantId,
    actorId,
    proposalOperationKey,
    input,
    writerFactory,
  );
  if (!saved) throw new ReviewAdoptionRefused('review_source_unavailable');
  const requestHash = await sha256(
    canonicalJson({ tenantId, actorId, proposalOperationKey, ...request }),
  );
  const { data, error } = await writerFactory()
    .rpc('adopt_sudhaar_review', {
      p_tenant_id: tenantId,
      p_actor_id: actorId,
      p_operation_key: proposalOperationKey,
      p_adoption_key: request.adoptionKey,
      p_reason: request.reason,
      p_acknowledge_review_only: request.acknowledgeReviewOnly,
      p_request_hash: requestHash,
      p_expected_input_hash: saved.invocation.requestHash,
      p_expected_output_hash: saved.invocation.responseHash,
    })
    .abortSignal(AbortSignal.timeout(15000));
  if (error) throw new ReviewAdoptionRefused('review_adoption_uncertain');
  const receipt = sudhaarReviewAdoptionReceiptSchema.safeParse(data);
  if (!receipt.success) throw new ReviewAdoptionRefused('review_adoption_conflict');
  const value = receipt.data;
  if (
    value.tenantId !== tenantId ||
    value.actorId !== actorId ||
    value.proposalOperationKey !== proposalOperationKey ||
    value.adoptionKey !== request.adoptionKey ||
    value.requestHash !== requestHash ||
    value.taskCount !== saved.data.review_tasks.length ||
    canonicalJson(value.source) !== canonicalJson(input.source) ||
    value.outputProof.runId !== saved.invocation.runId ||
    value.outputProof.inputHash !== saved.invocation.requestHash ||
    value.outputProof.outputHash !== saved.invocation.responseHash ||
    value.outputProof.requestedReceipt !== saved.outputProof.requestedReceipt ||
    value.outputProof.startedReceipt !== saved.outputProof.startedReceipt ||
    value.outputProof.completedReceipt !== saved.outputProof.completedReceipt ||
    value.outputProof.settledReceipt !== saved.outputProof.settledReceipt
  )
    throw new ReviewAdoptionRefused('review_adoption_conflict');
  return value;
}
