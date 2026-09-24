import { z } from 'zod';
import { createSupabaseAdmin } from '@axiom/supabase';
import type { JwtSvidVerifier, VerifiedWorkloadIdentity } from '../../workloads/jwt-svid.js';
import type { BrokerAuthority, BrokerLease, BrokerRequest } from './broker.js';

/** Verifies a signed action approval for a Karya write (W5). Absent → writes refused. */
export interface WriteApprovalVerifier {
  verify(input: {
    tenantId: string;
    actionId: string;
    proof: string;
    connectorId: string;
  }): Promise<{ tokenId: string; actionId: string; validUntil: number } | null>;
}
type IdentityVerifier = Pick<JwtSvidVerifier, 'verify'>;

const resolved = z
  .object({
    grantId: z.uuid(),
    workloadId: z.uuid(),
    agentName: z.enum(['drishti', 'karya']),
    spiffeId: z.string(),
    scope: z.enum(['connector.read', 'connector.write']),
    targetScopes: z.array(z.string()).min(1),
    grantExpiresAt: z.string(),
    connectorVersion: z.number().int().positive(),
    credentialId: z.uuid(),
    credentialRevision: z.number().int().positive(),
    descriptorSha256: z.string(),
    endpointRef: z.string(),
    targetBinding: z.enum(['production', 'sandbox', 'reference-mock']),
    grantType: z.enum(['client_credentials', 'jwt_bearer']),
  })
  .strict();

/**
 * W4.4 broker authority: a verified workload SVID plus a live grant resolved
 * from the database on every call. Identity alone grants nothing; the grant is
 * re-resolved in stillCurrent, so revocation, expiry, lifecycle changes and the
 * kill switch take effect between the broker's checkpoints. Writes also need a
 * signed action approval; with no approval verifier configured they are
 * refused. Nothing here reads caller-supplied agent or scope strings as
 * authority: the agent comes from the registered SPIFFE identity's grant.
 */
export class GrantBrokerAuthority implements BrokerAuthority {
  constructor(
    private readonly identity: IdentityVerifier,
    private readonly deps: {
      client?: typeof createSupabaseAdmin;
      approvals?: WriteApprovalVerifier;
      now?: () => number;
    } = {},
  ) {}

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  private async resolve(request: Readonly<BrokerRequest>, workload: VerifiedWorkloadIdentity) {
    const { data, error } = await (this.deps.client ?? createSupabaseAdmin)().rpc(
      'resolve_broker_grant',
      {
        p_tenant_id: request.tenantId,
        p_estate_id: request.estateId,
        p_connector_id: request.connectorId,
        p_spiffe_id: workload.spiffeId,
        p_scope: request.scope,
      },
    );
    if (error || !data) return null;
    const parsed = resolved.safeParse(data);
    if (!parsed.success || parsed.data.spiffeId !== workload.spiffeId) return null;
    return parsed.data;
  }

  async authorize(request: Readonly<BrokerRequest>): Promise<BrokerLease | null> {
    try {
      const workload = await this.identity.verify(request.workloadProof);
      const grant = await this.resolve(request, workload);
      if (!grant || grant.scope !== request.scope) return null;
      let approval: BrokerLease['approval'];
      if (grant.scope === 'connector.write') {
        if (!this.deps.approvals || !request.approvalProof || !request.actionId) return null;
        const verified = await this.deps.approvals.verify({
          tenantId: request.tenantId,
          actionId: request.actionId,
          proof: request.approvalProof,
          connectorId: request.connectorId,
        });
        if (!verified || verified.actionId !== request.actionId) return null;
        approval = verified;
      } else if (request.approvalProof || request.actionId) return null;
      const validUntil = Math.min(
        workload.expiresAt,
        Date.parse(grant.grantExpiresAt),
        approval?.validUntil ?? Number.MAX_SAFE_INTEGER,
      );
      if (!Number.isSafeInteger(validUntil) || validUntil <= this.now()) return null;
      return {
        tenantId: request.tenantId,
        estateId: request.estateId,
        connectorId: request.connectorId,
        credentialId: grant.credentialId,
        credentialRevision: grant.credentialRevision,
        connectorVersion: grant.connectorVersion,
        grantId: grant.grantId,
        workloadId: grant.workloadId,
        agentName: grant.agentName,
        spiffeId: grant.spiffeId,
        scope: grant.scope,
        targetScopes: grant.targetScopes,
        validUntil,
        descriptorSha256: grant.descriptorSha256,
        endpointRef: grant.endpointRef,
        targetBinding: grant.targetBinding,
        grantType: grant.grantType,
        ...(approval ? { approval } : {}),
      };
    } catch {
      return null;
    }
  }

  async stillCurrent(lease: BrokerLease, request: Readonly<BrokerRequest>): Promise<boolean> {
    try {
      if (lease.validUntil <= this.now()) return false;
      const workload = await this.identity.verify(request.workloadProof);
      if (workload.spiffeId !== lease.spiffeId) return false;
      const grant = await this.resolve(request, workload);
      return Boolean(
        grant &&
        grant.grantId === lease.grantId &&
        grant.workloadId === lease.workloadId &&
        grant.credentialId === lease.credentialId &&
        grant.credentialRevision === lease.credentialRevision &&
        grant.connectorVersion === lease.connectorVersion &&
        grant.descriptorSha256 === lease.descriptorSha256,
      );
    } catch {
      return false;
    }
  }
}
