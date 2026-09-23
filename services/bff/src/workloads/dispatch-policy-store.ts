import type { SupabaseClient } from '@supabase/supabase-js';
import type { TenantId } from '@axiom/types';
import { z } from 'zod';
import { DispatchKeyPolicy } from './dispatch-key-policy.js';
import { DispatchRefused } from './dispatch-payload.js';
const policyReceipt = z
  .object({
    tenantId: z.uuid(),
    revision: z.number().int().positive().max(2147483647),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    receipt: z.string().regex(/^[1-9][0-9]*$/),
  })
  .strict();
/** Explicit trusted configuration publication, never a browser or worker route.
 * The backend must authenticate the human owner/admin and review this policy.
 * A successful publication fences old controllers; it does not deploy readers. */
export class DispatchPolicyStore {
  constructor(private readonly db: SupabaseClient) {}
  /** Startup/reconstruction only: match trusted local keys before recovering a
   * durable revision. Never silently refresh an in-flight controller's fence. */
  async currentRevision(policy: DispatchKeyPolicy, tenantId: TenantId): Promise<number> {
    try {
      tenantId = z.uuid().parse(tenantId).toLowerCase() as TenantId;
      const { data, error } = await this.db
        .from('assessment_dispatch_key_policies')
        .select('tenant_id,revision,fingerprint')
        .eq('tenant_id', tenantId)
        .abortSignal(AbortSignal.timeout(10000))
        .maybeSingle();
      if (error) throw new DispatchRefused();
      const row = z
        .object({
          tenant_id: z.literal(tenantId),
          revision: z.number().int().positive().max(2147483647),
          fingerprint: z.literal(policy.fingerprint(tenantId)),
        })
        .strict()
        .parse(data);
      return row.revision;
    } catch {
      throw new DispatchRefused();
    }
  }
  async publish(
    policy: DispatchKeyPolicy,
    tenantId: TenantId,
    actorId: string,
    correlationId: string,
    expectedRevision: number,
  ) {
    try {
      tenantId = z.uuid().parse(tenantId).toLowerCase() as TenantId;
      actorId = z.uuid().parse(actorId).toLowerCase();
      correlationId = z.uuid().parse(correlationId).toLowerCase();
      z.number().int().min(0).max(2147483646).parse(expectedRevision);
      const ring = policy.snapshot().get(tenantId);
      if (!ring) throw new DispatchRefused();
      const { data, error } = await this.db
        .rpc('publish_assessment_dispatch_key_policy', {
          p_tenant_id: tenantId,
          p_actor_id: actorId,
          p_correlation_id: correlationId,
          p_expected_revision: expectedRevision,
          p_provider: policy.provider,
          p_primary_ref: ring.primary,
          p_readable_refs: [ring.primary, ...ring.retiring].sort(),
        })
        .abortSignal(AbortSignal.timeout(10000));
      if (error) throw new DispatchRefused();
      const result = policyReceipt.parse(data);
      if (
        result.tenantId !== tenantId ||
        result.fingerprint !== policy.fingerprint(tenantId) ||
        ![expectedRevision, expectedRevision + 1].includes(result.revision)
      )
        throw new DispatchRefused();
      return Object.freeze(result);
    } catch {
      throw new DispatchRefused();
    }
  }
}
