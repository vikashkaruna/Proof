import { z } from 'zod';
import { PostgresDeadline, PostgresDeadlineExceeded } from './postgres-deadline.js';
import { createSupabaseAdmin } from '@axiom/supabase';
import type { ConnectorInvocation, ConnectorResult } from '@axiom/types';
import type { JwtSvidVerifier } from '../../workloads/jwt-svid.js';
import { MySqlReadConnector } from './mysql-read.js';
import {
  PostgresReadConnector,
  SqlConnectorRefused,
  type RedactedScanResult,
  type SqlSessionFactory,
  type SqlSession,
} from './postgres-read.js';

/** The SQL engines the read binding covers. Selected from the reviewed
 * descriptor's target, never from the request. */
export type SqlEngine = 'postgresql' | 'mysql';
export type SqlReadConnector = PostgresReadConnector | MySqlReadConnector;

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

/** Optional additional deployment fence. It never replaces live grant resolution. */
const configuredUuid = z.uuid().transform((value) => value.toLowerCase());
export const SqlDiscoveryBindingSchema = z
  .object({
    tenantId: configuredUuid,
    estateId: configuredUuid,
    connectorId: configuredUuid,
    systemId: configuredUuid,
    descriptorId: configuredUuid,
    descriptorSha256: z.string().regex(/^[a-f0-9]{64}$/),
    endpointRef: z.string().min(1).max(200),
    targetBinding: z.enum(['production', 'sandbox', 'reference-mock']),
    connectorVersion: z.number().int().positive(),
  })
  .strict();
export type SqlDiscoveryBinding = z.infer<typeof SqlDiscoveryBindingSchema>;

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
  readonly #binding: SqlDiscoveryBinding | undefined;
  constructor(
    private readonly identity: Pick<JwtSvidVerifier, 'verify'>,
    private readonly sessions: SqlSessionFactory,
    private readonly deps: {
      client?: typeof createSupabaseAdmin;
      now?: () => number;
      engine?: SqlEngine;
      binding?: SqlDiscoveryBinding;
      originalDeadline?: number;
      sandboxConfigurationSha256?: string;
      operation?: 'enumerate' | 'sample';
      signal?: AbortSignal;
    } = {},
  ) {
    this.#binding =
      deps.binding === undefined
        ? undefined
        : Object.freeze(SqlDiscoveryBindingSchema.parse(deps.binding));
  }

  private async resolve(
    request: SqlDiscoveryRequest,
    spiffeId: string,
    signal?: AbortSignal,
  ): Promise<SqlGrant | null> {
    const pending = (this.deps.client ?? createSupabaseAdmin)().rpc(
      this.deps.sandboxConfigurationSha256
        ? 'resolve_sandbox_postgresql_read_grant_for_operation'
        : 'resolve_sql_read_grant',
      {
        ...(this.deps.sandboxConfigurationSha256
          ? {
              p_configuration_sha256: this.deps.sandboxConfigurationSha256,
              p_operation: this.deps.operation,
            }
          : {}),
        p_tenant_id: request.tenantId,
        p_estate_id: request.estateId,
        p_connector_id: request.connectorId,
        p_spiffe_id: spiffeId,
      },
    );
    const { data, error } = await (signal ? pending.abortSignal(signal) : pending);
    if (error || !data) return null;
    const parsed = resolved.safeParse(data);
    if (!parsed.success || parsed.data.spiffeId !== spiffeId) return null;
    const grant = parsed.data;
    const binding = this.#binding;
    if (
      binding &&
      (request.tenantId.toLowerCase() !== binding.tenantId ||
        request.estateId.toLowerCase() !== binding.estateId ||
        request.connectorId.toLowerCase() !== binding.connectorId ||
        grant.systemId.toLowerCase() !== binding.systemId ||
        grant.endpointRef !== binding.endpointRef ||
        grant.descriptorSha256 !== binding.descriptorSha256 ||
        grant.targetBinding !== binding.targetBinding ||
        grant.connectorVersion !== binding.connectorVersion)
    )
      return null;
    return grant;
  }

  /** Runs one operation and returns the result with the grant it ran under. */
  private async run<T>(
    request: SqlDiscoveryRequest,
    work: (connector: SqlReadConnector, context: ConnectorInvocation) => Promise<T>,
    originalDeadline = this.deps.originalDeadline,
  ): Promise<{ result: T; grant: SqlGrant; deadline: number }> {
    const now = (this.deps.now ?? Date.now)();
    const scope =
      this.deps.engine === 'mysql'
        ? undefined
        : new PostgresDeadline(
            Math.min(now + 30_000, originalDeadline ?? Infinity),
            this.deps.now,
            this.deps.signal,
          );
    const active = new Set<SqlSession>();
    const wait = <R>(operation: () => PromiseLike<R>): Promise<R> =>
      scope ? scope.run(operation) : Promise.resolve(operation());
    const sessions: SqlSessionFactory = !scope
      ? this.sessions
      : async (context) => {
          const pending = this.sessions(context, scope.signal, this.deps.operation).then(
            async (raw) => {
              let aborting: Promise<void> | undefined;
              const session: SqlSession = {
                query: (text, values) => scope.run(() => raw.query(text, values)),
                abort: () => {
                  aborting ??= Promise.resolve()
                    .then(() => (raw.abort ? raw.abort() : raw.end()))
                    .finally(() => active.delete(session));
                  return aborting;
                },
                end: async () => {
                  if (scope.signal.aborted || aborting) return session.abort!();
                  await raw.end();
                  active.delete(session);
                },
              };
              active.add(session);
              if (scope.signal.aborted) {
                await session.abort!();
                throw new PostgresDeadlineExceeded();
              }
              return session;
            },
          );
          return scope.run(() => pending);
        };
    try {
      let workload;
      try {
        workload = await wait(() => this.identity.verify(request.workloadProof));
      } catch (error) {
        if (error instanceof PostgresDeadlineExceeded) throw error;
        throw new SqlConnectorRefused('identity');
      }
      scope?.tighten(workload.expiresAt);
      const grant = await wait(() => this.resolve(request, workload.spiffeId, scope?.signal));
      if (!grant) throw new SqlConnectorRefused('no_grant');
      const deadline = Math.min(
        workload.expiresAt,
        Date.parse(grant.grantExpiresAt),
        now + 30_000,
        scope?.expiresAt ?? Infinity,
      );
      if (!Number.isFinite(deadline) || deadline <= now) throw new SqlConnectorRefused('expired');
      scope?.tighten(deadline);
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
      const connector: SqlReadConnector =
        this.deps.engine === 'mysql'
          ? new MySqlReadConnector(this.sessions, this.deps.now)
          : new PostgresReadConnector(sessions, this.deps.now);
      const result = await wait(() => work(connector, context));
      if ((this.deps.now ?? Date.now)() >= deadline) throw new SqlConnectorRefused('expired');
      const after = await wait(() => this.resolve(request, workload.spiffeId, scope?.signal));
      if (
        !after ||
        after.grantId !== grant.grantId ||
        after.workloadId !== grant.workloadId ||
        after.systemId !== grant.systemId ||
        after.endpointRef !== grant.endpointRef ||
        after.targetBinding !== grant.targetBinding ||
        after.descriptorSha256 !== grant.descriptorSha256 ||
        after.connectorVersion !== grant.connectorVersion
      )
        throw new SqlConnectorRefused('grant_changed');
      // The read and its cleanup/recheck may outlive the original SVID. Revalidate
      // current trust before releasing data, then check the deadline again after
      // both asynchronous authority checks. A renewed grant cannot extend it.
      let currentWorkload;
      try {
        currentWorkload = await wait(() => this.identity.verify(request.workloadProof));
      } catch (error) {
        if (error instanceof PostgresDeadlineExceeded) throw error;
        throw new SqlConnectorRefused('identity');
      }
      if (currentWorkload.spiffeId !== workload.spiffeId) throw new SqlConnectorRefused('identity');
      const releaseDeadline = Math.min(
        deadline,
        currentWorkload.expiresAt,
        Date.parse(after.grantExpiresAt),
      );
      if (!Number.isFinite(releaseDeadline) || (this.deps.now ?? Date.now)() >= releaseDeadline)
        throw new SqlConnectorRefused('expired');
      return { result, grant, deadline: releaseDeadline };
    } catch (error) {
      if (error instanceof PostgresDeadlineExceeded) throw new SqlConnectorRefused('expired');
      throw error;
    } finally {
      if (scope) {
        scope.abort();
        try {
          await Promise.all([...active].map((session) => session.abort!()));
        } finally {
          scope.dispose();
        }
      }
    }
  }

  discover(
    request: SqlDiscoveryRequest,
    work: (connector: SqlReadConnector, context: ConnectorInvocation) => Promise<ConnectorResult>,
  ): Promise<{ result: ConnectorResult; grant: SqlGrant; deadline: number }> {
    return this.run(request, work);
  }

  /** Authority-only release fence: never opens another target session. */
  async revalidate(
    request: SqlDiscoveryRequest,
    expected: SqlGrant,
    deadline: number,
  ): Promise<void> {
    const { grant } = await this.run(request, async () => undefined, deadline);
    if (Object.entries(expected).some(([field, value]) => grant[field as keyof SqlGrant] !== value))
      throw new SqlConnectorRefused('grant_changed');
  }

  /** Internal SQL processing gate. A caller must persist a validated scan run
   * before it exposes the aggregate, so this is not a public discovery op. */
  async scanRedacted(
    request: SqlDiscoveryRequest,
    resource: string,
    maxRows: number,
    pageSize: number,
  ): Promise<{ result: RedactedScanResult; grant: SqlGrant }> {
    if (this.deps.engine === 'mysql') throw new SqlConnectorRefused('engine_unsupported');
    return this.run(request, (connector, context) => {
      if (!(connector instanceof PostgresReadConnector))
        throw new SqlConnectorRefused('engine_unsupported');
      return connector.scanRedacted(context, resource, maxRows, pageSize);
    });
  }

  enumerate(request: SqlDiscoveryRequest, cursor?: string): Promise<ConnectorResult> {
    return this.discover(request, (connector, context) =>
      connector.enumerate(context, cursor),
    ).then((outcome) => outcome.result);
  }

  sample(request: SqlDiscoveryRequest, resource: string, limit: number): Promise<ConnectorResult> {
    return this.discover(request, (connector, context) =>
      connector.sample(context, resource, limit),
    ).then((outcome) => outcome.result);
  }
}
