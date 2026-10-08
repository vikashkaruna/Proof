import { z } from 'zod';
import { canonicalJson, sha256 } from '@axiom/ledger';
import { createHumanActionWriter } from '@axiom/supabase';
import { validateSudhaarProposal, type SudhaarInput } from '@axiom/types';
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
    output_text: z.string().min(1).max(1048576),
    requested_receipt: receipt,
    started_receipt: receipt,
    completed_receipt: receipt,
    settled_receipt: receipt,
  })
  .strict();
export class SudhaarOutputRefused extends Error {
  constructor(readonly code: 'planning_output_uncertain' | 'planning_output_conflict') {
    super(code);
  }
}
type WriterFactory = NonNullable<GenericAgentInvocationDeps['writerFactory']>;
export async function recoverSudhaarOutput(
  tenantId: string,
  actorId: string,
  operationKey: string,
  input: SudhaarInput,
  writerFactory: WriterFactory = createHumanActionWriter,
) {
  const inputText = canonicalJson(input);
  const { data, error } = await writerFactory()
    .rpc('recover_sudhaar_output', {
      p_tenant_id: tenantId,
      p_actor_id: actorId,
      p_engagement_id: input.engagement_id,
      p_operation_key: operationKey,
      p_input_text: inputText,
    })
    .abortSignal(AbortSignal.timeout(10000));
  if (error) throw new SudhaarOutputRefused('planning_output_uncertain');
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
      throw new SudhaarOutputRefused('planning_output_uncertain');
    throw new SudhaarOutputRefused('planning_output_conflict');
  }
  const recorded = recordedSchema.parse(data);
  const proposal = validateSudhaarProposal(JSON.parse(recorded.output_text), input);
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
    throw new SudhaarOutputRefused('planning_output_conflict');
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
export function settleSudhaarOutput(
  writerFactory: WriterFactory = createHumanActionWriter,
): NonNullable<GenericAgentInvocationDeps['settleSudhaarSuccess']> {
  return async (context) => {
    if (
      context.agent !== 'sudhaar' ||
      !context.engagementId ||
      context.result.status !== 'succeeded'
    )
      throw new SudhaarOutputRefused('planning_output_conflict');
    validateSudhaarProposal(context.result.output, JSON.parse(context.canonicalInput));
    const { data, error } = await writerFactory()
      .rpc('settle_sudhaar_output', {
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
    if (error) throw new SudhaarOutputRefused('planning_output_uncertain');
    return data;
  };
}
