import { z } from 'zod';
import { createSupabaseAdmin } from '@axiom/supabase';
import type { ConnectorInvocation, ConnectorResult } from '@axiom/types';
import type { JwtSvidVerifier } from '../../workloads/jwt-svid.js';
import {
  PostgresReadConnector,
  SqlConnectorRefused,
  type SqlSessionFactory,
} from './postgres-read.js';

const resolved = z
  .object({
    grantId: z.uuid(),
    workloadId: z.uuid(),
    agentName: z.literal('drishti'),
    spiffeId: z.string(),
    systemId: z.uuid(),
    grantExpiresAt: z.string(),
    connectorVersion: z.number().int().positive(),
    descriptorSha256: z.string().regex(/^[a-f0-9]{64}$/),
    endpointRef: z.string(),
    targetBinding: z.enum(['production', 'sandbox', 'reference-mock']),
  })
  .strict();
export type SqlGrant = z.infer<typeof resolved>;

export interface SqlDiscoveryRequest {
  tenantId: string;
  estateId: string;
  connectorId: string;
  correlationId: string;
  workloadProof: string;
}

/**
 * W4.6 authority for the SQL read path. A verified Drishti SVID plus a live
 * cloud-IAM read grant, re-resolved immediately before the session opens and
 * again before results are released, so revocation or the kill switch between
 * the two checkpoints withholds the result. The invocation context is built
 * from the resolved grant, never from caller-supplied fields.
 */
export class SqlDiscoveryGate {
  constructor(
    private readonly identity: Pick<JwtSvidVerifier, 'verify'>,
    private readonly sessions: SqlSessionFactory,
    private readonly deps: { client?: typeof createSupabaseAdmin; now?: () => number } = {},
  ) {}

  private async resolve(request: SqlDiscoveryRequest, spiffeId: string): Promise<SqlGrant | null> {
    const { data, error } = await (this.deps.client ?? createSupabaseAdmin)().rpc(
      'resolve_sql_read_grant',
      {
        p_tenant_id: request.tenantId,
        p_estate_id: request.estateId,
        p_connector_id: request.connectorId,
        p_spiffe_id: spiffeId,
      },
    );
    if (error || !data) return null;
    const parsed = resolved.safeParse(data);
    return parsed.success && parsed.data.spiffeId === spiffeId ? parsed.data : null;
  }

  private async run(
    request: SqlDiscoveryRequest,
    work: (
      connector: PostgresReadConnector,
      context: ConnectorInvocation,
    ) => Promise<ConnectorResult>,
  ): Promise<ConnectorResult> {
    const now = (this.deps.now ?? Date.now)();
    let workload;
    try {
      workload = await this.identity.verify(request.workloadProof);
    } catch {
      throw new SqlConnectorRefused('identity');
    }
    const grant = await this.resolve(request, workload.spiffeId);
    if (!grant) throw new SqlConnectorRefused('no_grant');
    const deadline = Math.min(workload.expiresAt, Date.parse(grant.grantExpiresAt), now + 30_000);
    if (!Number.isFinite(deadline) || deadline <= now) throw new SqlConnectorRefused('expired');
    const context: ConnectorInvocation = {
      tenantId: request.tenantId,
      estateId: request.estateId,
      systemId: grant.systemId,
      connectorId: request.connectorId,
      descriptorSha256: grant.descriptorSha256,
      grantId: grant.grantId,
      workloadIdentity: grant.spiffeId,
      correlationId: request.correlationId,
      deadline: new Date(deadline).toISOString(),
    };
    const result = await work(new PostgresReadConnector(this.sessions, this.deps.now), context);
    const after = await this.resolve(request, workload.spiffeId);
    if (
      !after ||
      after.grantId !== grant.grantId ||
      after.descriptorSha256 !== grant.descriptorSha256 ||
      after.connectorVersion !== grant.connectorVersion
    )
      throw new SqlConnectorRefused('grant_changed');
    return result;
  }

  enumerate(request: SqlDiscoveryRequest, cursor?: string): Promise<ConnectorResult> {
    return this.run(request, (connector, context) => connector.enumerate(context, cursor));
  }

  sample(request: SqlDiscoveryRequest, resource: string, limit: number): Promise<ConnectorResult> {
    return this.run(request, (connector, context) => connector.sample(context, resource, limit));
  }
}
