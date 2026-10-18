/** Local/test disposable PostgreSQL only. Passwords remain in this private broker;
 * neither the agent nor discovery responses receive a credential or connection string. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '@axiom/ledger';
import { createSupabaseAdmin } from '@axiom/supabase';
import { DiscoveryService, DiscoveryRequestSchema } from './discovery.js';
import { connectorRegistry } from './registry.js';
import { SqlDiscoveryBindingSchema } from './sql/grant-gate.js';
import { SqlEndpointSchema, postgresSessions } from './sql/session.js';
import { PostgresDeadline } from './sql/postgres-deadline.js';
import { validCaBundle } from './postgresql-composition.js';
import { controllerFilePath, readControllerFile } from '../workloads/controller-files.js';
import { parsePrativedanAssessmentJson } from '../services/prativedan-assessment-json.js';
import { JwtSvidVerifier, type JwtTrustSource } from '../workloads/jwt-svid.js';
import {
  SyncedWorkloadTrust,
  IssuerSyncHealth,
  issuerNodeId,
} from '../workloads/issuer-sync-health.js';
import { WorkloadApiJwtTrust } from '../workloads/workload-api-trust.js';

const credentialPin = z
  .object({
    id: z.uuid(),
    revision: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    file: controllerFilePath,
  })
  .strict();
const endpoint = SqlEndpointSchema.refine(
  (value) =>
    validCaBundle(value.caPem) &&
    (['localhost', '127.0.0.1', 'host.docker.internal'].includes(value.host) ||
      /^axiom-pg-[a-z0-9-]{1,50}$/.test(value.host)),
);
export const SandboxPostgresqlConfiguration = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.literal('local_sandbox_password'),
    environment: z.enum(['local', 'test']),
    workload: z
      .object({
        socketPath: controllerFilePath,
        issuerNodeId,
        healthFile: controllerFilePath,
        trustDomain: z.literal('local.axiomproof.test'),
      })
      .strict(),
    connections: z
      .array(
        z
          .object({
            binding: SqlDiscoveryBindingSchema.refine((b) => b.targetBinding === 'sandbox'),
            endpoint,
            credential: credentialPin,
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
const passwordFile = z
  .object({
    schemaVersion: z.literal(1),
    tenantId: z.uuid(),
    connectorId: z.uuid(),
    credentialId: z.uuid(),
    revision: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    password: z.string().min(16).max(1024),
  })
  .strict();
export function sandboxConfigurationSha256(configuration: unknown) {
  return createHash('sha256')
    .update(canonicalJson(SandboxPostgresqlConfiguration.parse(configuration)))
    .digest('hex');
}

export function composeSandboxPostgresql(
  raw: unknown,
  environment: string,
  ports: {
    trust?: JwtTrustSource;
    client?: typeof createSupabaseAdmin;
    readCredential?: typeof readControllerFile;
  } = {},
): Pick<DiscoveryService, 'run'> {
  try {
    const config = SandboxPostgresqlConfiguration.parse(raw);
    if (!['local', 'test'].includes(environment) || environment !== config.environment)
      throw new Error();
    const digest = sandboxConfigurationSha256(config);
    const registry = new Map(
      [...connectorRegistry].filter(
        ([, m]) =>
          m.target === 'postgresql' && m.targetBinding === 'sandbox' && m.auth === 'legacy_static',
      ),
    );
    const entries = new Map<string, (typeof config.connections)[number]>();
    for (const entry of config.connections) {
      const key = entry.binding.tenantId + '/' + entry.binding.connectorId;
      if (entries.has(key) || !registry.has(entry.binding.descriptorId)) throw new Error();
      entries.set(key, entry);
    }
    const trust =
      ports.trust ??
      new SyncedWorkloadTrust(
        new WorkloadApiJwtTrust({
          socketPath: config.workload.socketPath,
          trustDomains: [config.workload.trustDomain],
        }),
        new IssuerSyncHealth(config.workload.issuerNodeId, config.workload.healthFile),
      );
    const identity = new JwtSvidVerifier(
      {
        audience: 'axiom-postgresql-discovery',
        trustDomains: [config.workload.trustDomain],
        maxLifetimeSeconds: 300,
      },
      trust,
    );
    const client = ports.client ?? createSupabaseAdmin;
    const service = new DiscoveryService(
      {
        sql: config.connections.map((c) => ({
          tenantId: c.binding.tenantId,
          connectorId: c.binding.connectorId,
          binding: c.binding,
          endpoint: c.endpoint,
        })),
        http: [],
      },
      {
        identity,
        client,
        registry,
        postgresqlOnly: true,
        sandboxConfigurations: new Map([...entries.keys()].map((key) => [key, digest])),
        sqlSessions: async (context, signal) => {
          const entry = entries.get(
            context.tenantId.toLowerCase() + '/' + context.connectorId.toLowerCase(),
          );
          if (!entry) throw new Error('Sandbox connector refused');
          const open = postgresSessions({
            endpoint: () => entry.endpoint,
            credentials: {
              async password() {
                let bytes: Buffer | undefined;
                try {
                  bytes = await (ports.readCredential ?? readControllerFile)(entry.credential.file);
                  const secret = passwordFile.parse(
                    parsePrativedanAssessmentJson(
                      new TextDecoder('utf8', { fatal: true }).decode(bytes),
                    ),
                  );
                  if (
                    secret.tenantId !== context.tenantId ||
                    secret.connectorId !== context.connectorId ||
                    secret.credentialId !== entry.credential.id ||
                    secret.revision !== entry.credential.revision ||
                    secret.expiresAt !== entry.credential.expiresAt ||
                    secret.expiresAt <= Date.now()
                  )
                    throw new Error();
                  // Repeat live enrollment/grant/stop checks AFTER the secret-file read
                  // and immediately before the native session allocates any socket.
                  const query = client().rpc('resolve_sandbox_postgresql_read_grant', {
                    p_tenant_id: context.tenantId,
                    p_estate_id: context.estateId,
                    p_connector_id: context.connectorId,
                    p_spiffe_id: context.workloadIdentity,
                    p_configuration_sha256: digest,
                  });
                  const { data, error } = await (signal ? query.abortSignal(signal) : query);
                  const current = z
                    .object({
                      grantId: z.literal(context.grantId),
                      spiffeId: z.literal(context.workloadIdentity),
                      agentName: z.literal('drishti'),
                      systemId: z.literal(context.systemId),
                      descriptorSha256: z.literal(entry.binding.descriptorSha256),
                      endpointRef: z.literal(entry.binding.endpointRef),
                      targetBinding: z.literal('sandbox'),
                      connectorVersion: z.literal(entry.binding.connectorVersion),
                      grantExpiresAt: z.string(),
                    })
                    .passthrough()
                    .safeParse(data);
                  if (
                    error ||
                    !current.success ||
                    !Number.isFinite(Date.parse(current.data.grantExpiresAt)) ||
                    Date.parse(current.data.grantExpiresAt) <= Date.now() ||
                    signal?.aborted
                  )
                    throw new Error();
                  return secret.password;
                } catch {
                  throw new Error('Sandbox credential unavailable');
                } finally {
                  bytes?.fill(0);
                }
              },
            },
          });
          return open(
            {
              ...context,
              deadline: new Date(
                Math.min(Date.parse(context.deadline), entry.credential.expiresAt),
              ).toISOString(),
            },
            signal,
          );
        },
      },
    );
    return Object.freeze({
      async run(input: unknown, proof: string, signal?: AbortSignal) {
        const scope = new PostgresDeadline(Date.now() + 30_000, Date.now, signal);
        try {
          const workload = await scope.run(() => identity.verify(proof));
          scope.tighten(workload.expiresAt);
          const selected = DiscoveryRequestSchema.parse(input);
          const configured = entries.get(
            selected.tenantId.toLowerCase() + '/' + selected.connectorId.toLowerCase(),
          );
          if (!configured) throw new Error('Sandbox connector refused');
          scope.tighten(configured.credential.expiresAt);
          const result = await scope.run(() => service.run(input, proof, scope.signal));
          const request = DiscoveryRequestSchema.parse(input);
          const entry = entries.get(
            request.tenantId.toLowerCase() + '/' + request.connectorId.toLowerCase(),
          );
          let bytes: Buffer | undefined;
          try {
            if (!entry || signal?.aborted) throw new Error();
            bytes = await scope.run(async () => {
              const value = await (ports.readCredential ?? readControllerFile)(
                entry.credential.file,
              );
              // A non-cancellable filesystem read can finish after the caller's
              // deadline. Its late private bytes still need explicit erasure.
              bytes = value;
              if (scope.signal.aborted) value.fill(0);
              return value;
            });
            const secret = passwordFile.parse(
              parsePrativedanAssessmentJson(new TextDecoder('utf8', { fatal: true }).decode(bytes)),
            );
            if (
              secret.tenantId !== entry.binding.tenantId ||
              secret.connectorId !== entry.binding.connectorId ||
              secret.credentialId !== entry.credential.id ||
              secret.revision !== entry.credential.revision ||
              secret.expiresAt !== entry.credential.expiresAt ||
              secret.expiresAt <= Date.now() ||
              signal?.aborted
            )
              throw new Error();
            return result;
          } catch {
            throw new Error('Sandbox credential changed before release');
          } finally {
            bytes?.fill(0);
          }
        } finally {
          scope.abort();
          scope.dispose();
        }
      },
    });
  } catch {
    throw new Error('Sandbox PostgreSQL configuration refused');
  }
}

export async function loadSandboxPostgresql(filename: string | undefined, environment: string) {
  if (filename === undefined) return undefined;
  let bytes: Buffer | undefined;
  try {
    bytes = await readControllerFile(filename);
    return composeSandboxPostgresql(
      parsePrativedanAssessmentJson(new TextDecoder('utf8', { fatal: true }).decode(bytes)),
      environment,
    );
  } catch {
    throw new Error('Sandbox PostgreSQL startup refused');
  } finally {
    bytes?.fill(0);
  }
}
