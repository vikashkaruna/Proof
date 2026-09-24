import type { SupabaseClient } from '@supabase/supabase-js';
import { AGENT_CONTRACTS, AgentName } from '@axiom/types';
import { z } from 'zod';
import {
  JwtSvidVerifier,
  WorkloadIdentityRefused,
  type VerifiedWorkloadIdentity,
} from './jwt-svid.js';
const registration = z
  .object({
    id: z.uuid(),
    tenant_id: z.uuid(),
    agent_name: z.nativeEnum(AgentName),
    spiffe_id: z.string().max(2048),
    status: z.literal('active'),
  })
  .strict();
export type WorkloadRegistration = z.infer<typeof registration>;
export interface WorkloadRegistrationStore {
  find(tenantId: string, spiffeId: string): Promise<WorkloadRegistration | null>;
}
export class SupabaseWorkloadRegistrationStore implements WorkloadRegistrationStore {
  constructor(private readonly db: SupabaseClient) {}
  async find(tenantId: string, spiffeId: string): Promise<WorkloadRegistration | null> {
    try {
      const { data, error } = await this.db
        .from('workload_identities')
        .select('id,tenant_id,agent_name,spiffe_id,status')
        .eq('tenant_id', tenantId)
        .eq('spiffe_id', spiffeId)
        .eq('status', 'active')
        .maybeSingle();
      if (error || !data) return null;
      return registration.parse(data);
    } catch {
      throw new WorkloadIdentityRefused();
    }
  }
}
export interface RegisteredWorkload extends VerifiedWorkloadIdentity {
  readonly tenantId: string;
  readonly workloadId: string;
  readonly agentName: AgentName;
  readonly declaredScopes: readonly string[];
}
/** Identity and declaration check ONLY; not tenant task delegation or grant
 * authorization. The caller must still resolve the task/estate/connector grant,
 * kill switch and approval. Re-authenticate on every tool invocation. No management route
 * is enabled publicly by this adapter; private assessment tools use it explicitly.
 * The connector broker factory remains deny-all. */
export class WorkloadAuthenticator {
  readonly #scopes = new Map(
    Object.entries(AGENT_CONTRACTS).map(([name, contract]) => [
      name,
      Object.freeze([...contract.toolScopes]),
    ]),
  );
  constructor(
    private readonly verifier: Pick<JwtSvidVerifier, 'verify'>,
    private readonly registrations: WorkloadRegistrationStore,
  ) {}
  async authenticate(
    token: string,
    tenant: string,
    agent: AgentName,
    requiredScope: string,
  ): Promise<RegisteredWorkload> {
    try {
      const tenantId = z.uuid().parse(tenant).toLowerCase();
      const expected = z.nativeEnum(AgentName).parse(agent);
      const scopes = this.#scopes.get(expected);
      if (!scopes?.includes(requiredScope)) throw new WorkloadIdentityRefused();
      const identity = await this.verifier.verify(token);
      const row = registration.parse(await this.registrations.find(tenantId, identity.spiffeId));
      if (
        row.tenant_id !== tenantId ||
        row.spiffe_id !== identity.spiffeId ||
        row.agent_name !== expected ||
        identity.expiresAt <= Date.now()
      )
        throw new WorkloadIdentityRefused();
      return Object.freeze({
        ...identity,
        tenantId,
        workloadId: row.id,
        agentName: row.agent_name,
        declaredScopes: scopes,
      });
    } catch {
      throw new WorkloadIdentityRefused();
    }
  }
}
