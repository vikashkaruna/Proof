/** Unmounted trusted generic settlement consumer; preserves original sealed bytes. */
import { canonicalJson, sha256 } from '@axiom/ledger';
import { modelAccountingBindingSchema } from '@axiom/types';
import { z } from 'zod';
import { AccountedResultRefused } from './accounted-agent-result.js';
import {
  readAndVerifyAccountedRuntimeResult,
  type AccountedResultReadPort,
} from './accounted-runtime-consumer.js';

export interface AccountedGenericSettlementPort {
  call(
    name: 'record_generic_agent_run_finish',
    arguments_: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
}
export async function settleAccountedGenericResult(
  wire: unknown,
  context: {
    readonly binding: unknown;
    readonly actorId: string;
    readonly engagementId: string | null;
  },
  deps: {
    readonly reader: AccountedResultReadPort;
    readonly settlement: AccountedGenericSettlementPort;
    readonly validateOutput?: (value: Readonly<Record<string, unknown>>) => void | Promise<void>;
  },
) {
  try {
    const binding = modelAccountingBindingSchema.parse(context.binding);
    const actor = z.uuid().parse(context.actorId);
    const engagement = z.uuid().nullable().parse(context.engagementId);
    const verified = await readAndVerifyAccountedRuntimeResult(wire, binding, deps.reader);
    const result = verified.result;
    if (result.status === 'succeeded') {
      if (verified.output === null) throw new AccountedResultRefused();
      await deps.validateOutput?.(verified.output);
    }
    // Legacy DB numeric projection is explicit; exact estimates stay in the seal.
    const responseHash =
      verified.output !== null ? await sha256(canonicalJson(verified.output)) : null;
    const acknowledgement = await deps.settlement.call('record_generic_agent_run_finish', {
      p_tenant_id: binding.tenant_id,
      p_actor_id: actor,
      p_run_id: binding.run_id,
      p_agent: binding.agent,
      p_engagement_id: engagement,
      p_correlation_id: binding.correlation_id,
      p_request_hash: binding.request_sha256,
      p_status: result.status,
      p_error_code: result.status === 'succeeded' ? null : 'agent_reported_failure',
      p_latency_ms: result.latency_ms,
      p_input_tokens: result.input_tokens,
      p_output_tokens: result.output_tokens,
      p_cost_usd: result.cost_usd === null ? null : Number(result.cost_usd),
      p_started_receipt: result.ledger_entry_ids[0],
      p_completed_receipt: result.ledger_entry_ids[1],
      p_response_hash: responseHash,
    });
    z.object({
      run_id: z.literal(binding.run_id),
      status: z.literal(result.status),
      replayed: z.boolean(),
    }).parse(acknowledgement);
    return { ...verified, responseHash };
  } catch {
    throw new AccountedResultRefused();
  }
}
