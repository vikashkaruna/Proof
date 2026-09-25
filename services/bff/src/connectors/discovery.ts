import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createSupabaseAdmin } from '@axiom/supabase';
import type { ConnectorInvocation, ConnectorManifest, ConnectorResult } from '@axiom/types';
import type { JwtSvidVerifier } from '../workloads/jwt-svid.js';
import type { CredentialBroker } from './broker/broker.js';
import { connectorRegistry } from './registry.js';
import { GraphqlReadConnector } from './rest/graphql-read.js';
import { RestEndpointSchema, RestReadConnector, type Fetch } from './rest/rest-read.js';
import { SqlDiscoveryGate } from './sql/grant-gate.js';
import type { SqlSessionFactory } from './sql/postgres-read.js';
import {
  SqlEndpointSchema,
  postgresSessions,
  rdsIamCredentials,
  type SqlCredentialProvider,
} from './sql/session.js';

export class DiscoveryRefused extends Error {
  constructor(readonly reason: string) {
    super(`Discovery refused: ${reason}`);
    this.name = 'DiscoveryRefused';
  }
}

export const DiscoveryRequestSchema = z
  .object({
    tenantId: z.uuid(),
    estateId: z.uuid(),
    connectorId: z.uuid(),
    operation: z.enum(['enumerate', 'sample']),
    resource: z
      .string()
      .regex(/^[A-Za-z0-9_.$-]{1,200}$/)
      .optional(),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(500).optional(),
  })
  .strict()
  .refine(
    (r) => (r.operation === 'sample') === (r.resource !== undefined && r.limit !== undefined),
  );
export type DiscoveryRequest = z.infer<typeof DiscoveryRequestSchema>;

/** Reviewed deployment configuration. Endpoints are never taken from a
 * request, a tenant user or the database; each is keyed by tenant and connector. */
export const DiscoveryConfigurationSchema = z
  .object({
    sql: z
      .array(
        z
          .object({ tenantId: z.uuid(), connectorId: z.uuid(), endpoint: SqlEndpointSchema })
          .strict(),
      )
      .max(1000)
      .default([]),
    http: z
      .array(
        z
          .object({ tenantId: z.uuid(), connectorId: z.uuid(), endpoint: RestEndpointSchema })
          .strict(),
      )
      .max(1000)
      .default([]),
  })
  .strict();

const grantShape = z.object({ grantId: z.uuid(), spiffeId: z.string() }).passthrough();
const key = (tenantId: string, connectorId: string) =>
  `${tenantId.toLowerCase()}/${connectorId.toLowerCase()}`;

/**
 * W4.6/W4.7 discovery composition for Drishti. The connector's descriptor
 * comes from the reviewed catalogue via its stored descriptor id; the grant is
 * resolved for the verified SVID; SQL uses the cloud-IAM gate and REST/GraphQL
 * use a broker token. A result is returned only after the run is recorded
 * append-only with its grant and audited, so no discovery goes unrecorded.
 */
export class DiscoveryService {
  readonly #sqlEndpoints = new Map<string, z.infer<typeof SqlEndpointSchema>>();
  readonly #httpEndpoints = new Map<string, z.infer<typeof RestEndpointSchema>>();

  constructor(
    configuration: unknown,
    private readonly deps: {
      identity: Pick<JwtSvidVerifier, 'verify'>;
      broker?: Pick<CredentialBroker, 'acquire'>;
      sqlCredentials?: SqlCredentialProvider;
      sqlSessions?: SqlSessionFactory;
      fetchImpl?: Fetch;
      client?: typeof createSupabaseAdmin;
      registry?: ReadonlyMap<string, ConnectorManifest>;
    },
  ) {
    const config = DiscoveryConfigurationSchema.parse(configuration);
    for (const entry of config.sql) {
      if (this.#sqlEndpoints.has(key(entry.tenantId, entry.connectorId)))
        throw new Error('duplicate endpoint');
      this.#sqlEndpoints.set(key(entry.tenantId, entry.connectorId), entry.endpoint);
    }
    for (const entry of config.http) {
      if (this.#httpEndpoints.has(key(entry.tenantId, entry.connectorId)))
        throw new Error('duplicate endpoint');
      this.#httpEndpoints.set(key(entry.tenantId, entry.connectorId), entry.endpoint);
    }
  }

  private db() {
    return (this.deps.client ?? createSupabaseAdmin)();
  }

  private async manifest(request: DiscoveryRequest): Promise<ConnectorManifest> {
    const { data, error } = await this.db()
      .from('connectors')
      .select('descriptor_id,status')
      .eq('tenant_id', request.tenantId)
      .eq('id', request.connectorId)
      .maybeSingle();
    if (error || !data || data.status !== 'active')
      throw new DiscoveryRefused('connector_unavailable');
    const manifest = (this.deps.registry ?? connectorRegistry).get(String(data.descriptor_id));
    if (!manifest) throw new DiscoveryRefused('descriptor_unreviewed');
    return manifest;
  }

  private async httpGrant(request: DiscoveryRequest, workloadProof: string) {
    const workload = await this.deps.identity.verify(workloadProof);
    const { data, error } = await this.db().rpc('resolve_broker_grant', {
      p_tenant_id: request.tenantId,
      p_estate_id: request.estateId,
      p_connector_id: request.connectorId,
      p_spiffe_id: workload.spiffeId,
      p_scope: 'connector.read',
    });
    const parsed = grantShape.safeParse(data);
    if (error || !parsed.success || parsed.data.spiffeId !== workload.spiffeId)
      throw new DiscoveryRefused('no_grant');
    return {
      grantId: parsed.data.grantId,
      spiffeId: workload.spiffeId,
      expiresAt: workload.expiresAt,
    };
  }

  async run(input: unknown, workloadProof: string) {
    const request = DiscoveryRequestSchema.parse(input);
    const correlationId = randomUUID();
    const manifest = await this.manifest(request);
    let outcome: { result: ConnectorResult; grantId: string; spiffeId: string };
    if (manifest.transport === 'sql') {
      const endpoint = this.#sqlEndpoints.get(key(request.tenantId, request.connectorId));
      if (!endpoint) throw new DiscoveryRefused('endpoint_unconfigured');
      const sessions =
        this.deps.sqlSessions ??
        postgresSessions({
          endpoint: () => endpoint,
          credentials: this.deps.sqlCredentials ?? rdsIamCredentials(),
        });
      const gate = new SqlDiscoveryGate(this.deps.identity, sessions, { client: this.deps.client });
      const { result, grant } = await gate.discover(
        { ...request, correlationId, workloadProof },
        (connector, context) =>
          request.operation === 'enumerate'
            ? connector.enumerate(context, request.cursor)
            : connector.sample(context, request.resource!, request.limit!),
      );
      outcome = { result, grantId: grant.grantId, spiffeId: grant.spiffeId };
    } else if (manifest.transport === 'rest' || manifest.transport === 'graphql') {
      const endpoint = this.#httpEndpoints.get(key(request.tenantId, request.connectorId));
      if (!endpoint || !this.deps.broker) throw new DiscoveryRefused('endpoint_unconfigured');
      const before = await this.httpGrant(request, workloadProof);
      const broker = this.deps.broker;
      const token = () =>
        broker.acquire({
          tenantId: request.tenantId,
          estateId: request.estateId,
          connectorId: request.connectorId,
          correlationId,
          scope: 'connector.read',
          workloadProof,
        });
      const connector =
        manifest.transport === 'rest'
          ? new RestReadConnector(manifest, endpoint, token, this.deps.fetchImpl)
          : new GraphqlReadConnector(manifest, endpoint, token, this.deps.fetchImpl);
      const context: ConnectorInvocation = {
        tenantId: request.tenantId,
        estateId: request.estateId,
        systemId: '',
        connectorId: request.connectorId,
        descriptorSha256: '',
        grantId: before.grantId,
        workloadIdentity: before.spiffeId,
        correlationId,
        deadline: new Date(Math.min(before.expiresAt, Date.now() + 30_000)).toISOString(),
      };
      const result =
        request.operation === 'enumerate'
          ? await connector.enumerate(context)
          : await connector.sample(
              context,
              request.resource!,
              Math.min(request.limit!, 100),
              request.cursor,
            );
      const after = await this.httpGrant(request, workloadProof);
      if (after.grantId !== before.grantId) throw new DiscoveryRefused('grant_changed');
      outcome = { result, grantId: before.grantId, spiffeId: before.spiffeId };
    } else throw new DiscoveryRefused('transport_unsupported');

    const { data, error } = await this.db().rpc('record_connector_discovery', {
      p_tenant_id: request.tenantId,
      p_connector_id: request.connectorId,
      p_grant_id: outcome.grantId,
      p_spiffe_id: outcome.spiffeId,
      p_operation: request.operation,
      p_resource: request.operation === 'sample' ? request.resource : null,
      p_result: outcome.result.records,
      p_correlation_id: correlationId,
    });
    if (error || !data || data.error || !data.run) throw new DiscoveryRefused('unrecorded');
    return { run: data.run, records: outcome.result.records, cursor: outcome.result.cursor };
  }
}
