/** Explicit local synthetic deployment only. No enrollment or credential minting. */
import { createSupabaseAdmin } from '@axiom/supabase';
import { z } from 'zod';
import type { ApprovalEngine } from '@axiom/approval-engine';
import { JwtSvidVerifier } from '../workloads/jwt-svid.js';
import { WorkloadApiJwtTrust } from '../workloads/workload-api-trust.js';
import {
  readOwnedSyntheticConfiguration,
  configuredOwnedTargetTransport,
} from './owned-synthetic-composition.js';
import { OwnedExecutionBroker } from './owned-execution-broker.js';
export function createConfiguredOwnedExecution(
  approval: Pick<ApprovalEngine, 'sign'>,
  source: NodeJS.ProcessEnv = process.env,
) {
  if (source.AXIOM_OWNED_EXECUTION_ENABLED !== 'true') return null;
  const config = readOwnedSyntheticConfiguration(source);
  if (!config || !source.AXIOM_OWNED_EXECUTION_TRUST_SOCKET) return null;
  try {
    const trust = new WorkloadApiJwtTrust({
      socketPath: source.AXIOM_OWNED_EXECUTION_TRUST_SOCKET,
      trustDomains: ['local.axiomproof.test'],
    });
    const targetRpc = configuredOwnedTargetTransport(config.credentialDirectory, source);
    return new OwnedExecutionBroker({
      approval,
      identity: new JwtSvidVerifier(
        {
          audience: 'axiom-owned-synthetic-execution',
          trustDomains: ['local.axiomproof.test'],
          maxLifetimeSeconds: 300,
        },
        trust,
      ),
      scopedRpc: async (input, name, args, signal) => {
        const result = await createSupabaseAdmin()
          .rpc('read_owned_deployment_action_binding', {
            p_tenant_id: input.tenantId,
            p_plan_id: input.planId,
            p_action_id: input.actionId,
          })
          .abortSignal(signal);
        if (result.error || signal.aborted) throw Error('Owned execution scope unavailable');
        const binding = z
          .object({ tenantId: z.literal(input.tenantId), bindingId: z.uuid() })
          .strict()
          .parse(result.data);
        return targetRpc(input.tenantId, binding.bindingId, name, args, signal);
      },
    });
  } catch {
    return null;
  }
}
