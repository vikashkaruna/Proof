import type { SupabaseClient } from '@supabase/supabase-js';
import { AgentName } from '@axiom/types';
import { z } from 'zod';
import { parseWorkloadSpiffeId } from './jwt-svid.js';

const command = z
  .object({
    tenantId: z.uuid(),
    actorId: z.uuid(),
    correlationId: z.uuid(),
    workloadId: z.uuid(),
    expectedVersion: z.number().int().min(0).max(2147483646),
    agent: z.nativeEnum(AgentName),
    spiffeId: z.string().min(1).max(2048),
    status: z.enum(['active', 'disabled']),
  })
  .strict();
const receipt = z
  .object({
    tenant_id: z.uuid(),
    workload_id: z.uuid(),
    version: z.number().int().positive().max(2147483647),
    status: z.enum(['active', 'disabled']),
    receipt: z.string().regex(/^[1-9][0-9]*$/),
  })
  .strict();

/** Trusted administration backend only. Actor must be authenticated and the
 * exact change human-reviewed before this call; SQL rechecks current membership.
 * This changes tenant app registration, never SPIRE enrollment or tool grants.
 */
export class WorkloadRegistrationLifecycle {
  constructor(private readonly db: SupabaseClient) {}
  async manage(input: z.input<typeof command>): Promise<z.infer<typeof receipt>> {
    try {
      const value = command.parse(input);
      if (value.expectedVersion === 0 || value.status === 'active') {
        const identity = parseWorkloadSpiffeId(value.spiffeId);
        if (
          identity.spiffeId !== `spiffe://${identity.trustDomain}/agent/${value.agent}` ||
          value.spiffeId.trim() !== value.spiffeId
        )
          throw new Error('invalid registration');
      }
      const { data, error } = await this.db
        .rpc('manage_workload_identity', {
          p_tenant_id: value.tenantId.toLowerCase(),
          p_actor_id: value.actorId.toLowerCase(),
          p_correlation_id: value.correlationId.toLowerCase(),
          p_workload_id: value.workloadId.toLowerCase(),
          p_expected_version: value.expectedVersion,
          p_agent: value.agent,
          p_spiffe_id: value.spiffeId,
          p_status: value.status,
        })
        .abortSignal(AbortSignal.timeout(10000));
      if (error) throw new Error('registration unavailable');
      const result = receipt.parse(data);
      if (
        result.tenant_id !== value.tenantId.toLowerCase() ||
        result.workload_id !== value.workloadId.toLowerCase() ||
        result.status !== value.status ||
        ![value.expectedVersion, value.expectedVersion + 1].includes(result.version)
      )
        throw new Error('registration receipt mismatch');
      return result;
    } catch {
      throw new Error('Workload registration change refused');
    }
  }
}
