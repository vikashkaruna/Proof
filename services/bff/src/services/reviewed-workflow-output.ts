import { z } from 'zod';
import { canonicalJson, sha256 } from '@axiom/ledger';
import { createHumanActionWriter } from '@axiom/supabase';
import {
  reviewedWorkflowInputSchema,
  validateReviewedWorkflowOutput,
  type ReviewedWorkflowInput,
} from '@axiom/types';
import type { GenericAgentInvocationDeps } from './generic-agent-invocation.js';

const receipt = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const recordedSchema = z
  .object({
    run_id: z.uuid(),
    input_hash: hash,
    output_hash: hash,
    output_text: z.string().min(1).max(524288),
    requested_receipt: receipt,
    started_receipt: receipt,
    completed_receipt: receipt,
    settled_receipt: receipt,
  })
  .strict();
export class ReviewedWorkflowRefused extends Error {
  constructor(readonly code: 'reviewed_output_uncertain' | 'reviewed_output_conflict') {
    super(code);
  }
}
type WriterFactory = NonNullable<GenericAgentInvocationDeps['writerFactory']>;
export async function readReviewedWorkflowSource(
  tenantId: string,
  actorId: string,
  engagementId: string,
  recordIds: readonly string[],
  writerFactory: WriterFactory = createHumanActionWriter,
): Promise<ReviewedWorkflowInput> {
  const { data, error } = await writerFactory()
    .rpc('read_reviewed_workflow_sources', {
      p_tenant_id: tenantId,
      p_actor_id: actorId,
      p_engagement_id: engagementId,
      p_record_ids: recordIds,
    })
    .abortSignal(AbortSignal.timeout(10000));
  if (error) throw new ReviewedWorkflowRefused('reviewed_output_uncertain');
  const result = z
    .object({ records: z.array(z.unknown()).min(1).max(20) })
    .strict()
    .safeParse(data);
  if (!result.success) throw new ReviewedWorkflowRefused('reviewed_output_conflict');
  const raw = {
    schema_version: 1,
    mode: 'reviewed_workflow',
    tenant_id: tenantId,
    engagement_id: engagementId,
    source_records_sha256: await sha256(canonicalJson(result.data.records)),
    records: result.data.records,
  };
  const input = reviewedWorkflowInputSchema.parse(raw);
  if (
    canonicalJson(input) !== canonicalJson(raw) ||
    input.records.length !== recordIds.length ||
    input.records.some((record, index) => record.id !== recordIds[index])
  )
    throw new ReviewedWorkflowRefused('reviewed_output_conflict');
  return input;
}

export function reviewedWorkflowTransport(
  input: ReviewedWorkflowInput,
  writerFactory: WriterFactory = createHumanActionWriter,
): NonNullable<GenericAgentInvocationDeps['reviewedWorkflow']> {
  return {
    start: async (context) => {
      if (
        context.agent !== 'vibhaag' ||
        context.engagementId !== input.engagement_id ||
        context.tenantId !== input.tenant_id ||
        context.canonicalInput !== canonicalJson(input) ||
        context.requestHash !== (await sha256(context.canonicalInput))
      )
        throw new ReviewedWorkflowRefused('reviewed_output_conflict');
      const { data, error } = await writerFactory()
        .rpc('start_reviewed_workflow_dispatch', {
          p_tenant_id: context.tenantId,
          p_actor_id: context.actorId,
          p_engagement_id: context.engagementId,
          p_operation_key: context.correlationId,
          p_input_text: context.canonicalInput,
          p_records_text: canonicalJson(input.records),
        })
        .abortSignal(AbortSignal.timeout(10000));
      if (error) throw new ReviewedWorkflowRefused('reviewed_output_uncertain');
      return data;
    },
    settleSuccess: settleReviewedWorkflowOutput(writerFactory),
  };
}
export async function recoverReviewedWorkflowOutput(
  tenantId: string,
  actorId: string,
  operationKey: string,
  input: ReviewedWorkflowInput,
  writerFactory: WriterFactory = createHumanActionWriter,
) {
  const inputText = canonicalJson(reviewedWorkflowInputSchema.parse(input));
  if (
    input.tenant_id !== tenantId ||
    (await sha256(canonicalJson(input.records))) !== input.source_records_sha256
  )
    throw new ReviewedWorkflowRefused('reviewed_output_conflict');
  const { data, error } = await writerFactory()
    .rpc('recover_reviewed_workflow_output', {
      p_tenant_id: tenantId,
      p_actor_id: actorId,
      p_engagement_id: input.engagement_id,
      p_operation_key: operationKey,
      p_input_text: inputText,
    })
    .abortSignal(AbortSignal.timeout(10000));
  if (error) throw new ReviewedWorkflowRefused('reviewed_output_uncertain');
  if (
    z
      .object({ missing: z.literal(true) })
      .strict()
      .safeParse(data).success
  )
    return null;
  if (!recordedSchema.safeParse(data).success) {
    if (
      z
        .object({ error: z.literal('output_unrecoverable') })
        .strict()
        .safeParse(data).success
    )
      throw new ReviewedWorkflowRefused('reviewed_output_uncertain');
    throw new ReviewedWorkflowRefused('reviewed_output_conflict');
  }
  const recorded = recordedSchema.parse(data);
  const proposal = validateReviewedWorkflowOutput(input, JSON.parse(recorded.output_text));
  if (
    recorded.input_hash !== (await sha256(inputText)) ||
    recorded.output_hash !== (await sha256(recorded.output_text)) ||
    canonicalJson(proposal) !== recorded.output_text ||
    !(
      BigInt(recorded.requested_receipt) < BigInt(recorded.started_receipt) &&
      BigInt(recorded.started_receipt) < BigInt(recorded.completed_receipt) &&
      BigInt(recorded.completed_receipt) < BigInt(recorded.settled_receipt)
    )
  )
    throw new ReviewedWorkflowRefused('reviewed_output_conflict');
  return {
    data: proposal,
    invocation: {
      runId: recorded.run_id,
      correlationId: operationKey,
      requestHash: recorded.input_hash,
      responseHash: recorded.output_hash,
    },
    outputProof: {
      kind: 'settled_output_recorded' as const,
      tenantId,
      actorId,
      operationKey,
      runId: recorded.run_id,
      requestHash: recorded.input_hash,
      responseHash: recorded.output_hash,
      requestedReceipt: recorded.requested_receipt,
      startedReceipt: recorded.started_receipt,
      completedReceipt: recorded.completed_receipt,
      settledReceipt: recorded.settled_receipt,
    },
  };
}
export function settleReviewedWorkflowOutput(
  writerFactory: WriterFactory = createHumanActionWriter,
): NonNullable<GenericAgentInvocationDeps['settleSudhaarSuccess']> {
  return async (context) => {
    if (
      context.agent !== 'vibhaag' ||
      !context.engagementId ||
      context.result.status !== 'succeeded'
    )
      throw new ReviewedWorkflowRefused('reviewed_output_conflict');
    validateReviewedWorkflowOutput(JSON.parse(context.canonicalInput), context.result.output);
    const { data, error } = await writerFactory()
      .rpc('settle_reviewed_workflow_output', {
        p_tenant_id: context.tenantId,
        p_actor_id: context.actorId,
        p_run_id: context.runId,
        p_engagement_id: context.engagementId,
        p_correlation_id: context.correlationId,
        p_request_hash: context.requestHash,
        p_input_text: context.canonicalInput,
        p_output_text: context.canonicalOutput,
        p_response_hash: context.responseHash,
        p_latency_ms: context.result.latency_ms,
        p_input_tokens: context.result.input_tokens,
        p_output_tokens: context.result.output_tokens,
        p_cost_usd: context.result.cost_usd,
        p_started_receipt: context.result.ledger_entry_ids[0],
        p_completed_receipt: context.result.ledger_entry_ids[1],
      })
      .abortSignal(AbortSignal.timeout(10000));
    if (error) throw new ReviewedWorkflowRefused('reviewed_output_uncertain');
    return data;
  };
}
