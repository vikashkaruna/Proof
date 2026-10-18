/** Server-owned PostgreSQL composition only. No process mount, grant issuance,
 * local-password mode, human proof custody or live startup activation here. */
import { z } from 'zod';
import { X509Certificate } from 'node:crypto';
import { createSupabaseAdmin } from '@axiom/supabase';
import { DiscoveryService } from './discovery.js';
import { connectorRegistry } from './registry.js';
import { SqlDiscoveryBindingSchema } from './sql/grant-gate.js';
import { SqlEndpointSchema, postgresSessions, rdsIamCredentials } from './sql/session.js';
import {
  JwtSvidVerifier,
  workloadTrustDomain,
  type JwtTrustSource,
} from '../workloads/jwt-svid.js';
import { WorkloadApiJwtTrust } from '../workloads/workload-api-trust.js';
import { controllerFilePath, readControllerFile } from '../workloads/controller-files.js';
import { parsePrativedanAssessmentJson } from '../services/prativedan-assessment-json.js';

const socketPath = z
  .string()
  .min(2)
  .max(100)
  .regex(/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/)
  .refine((value) => !value.split('/').some((part) => part === '.' || part === '..'));
export function validCaBundle(pem: string) {
  try {
    const certificates = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    if (
      !certificates?.length ||
      pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim()
    )
      return false;
    return certificates.every((value) => {
      const cert = new X509Certificate(value);
      return (
        cert.ca && Date.parse(cert.validFrom) <= Date.now() && Date.parse(cert.validTo) > Date.now()
      );
    });
  } catch {
    return false;
  }
}
const endpoint = SqlEndpointSchema.refine(
  (value) =>
    validCaBundle(value.caPem) &&
    value.host.endsWith('.ap-south-1.rds.amazonaws.com') &&
    value.host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)),
);
export const PostgresqlCompositionSchema = z
  .object({
    schemaVersion: z.literal(1),
    credentialMode: z.literal('aws_rds_iam'),
    workload: z
      .object({
        audience: z.literal('axiom-postgresql-discovery'),
        trustDomain: workloadTrustDomain,
        socketPath,
        timeoutMs: z.number().int().min(100).max(5000).default(2500),
        maxLifetimeSeconds: z.number().int().min(1).max(900).default(300),
      })
      .strict(),
    connections: z
      .array(
        z
          .object({
            binding: SqlDiscoveryBindingSchema.refine(
              (value) => value.targetBinding === 'production',
            ),
            endpoint,
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

/** Trusted process ports only, never an HTTP body or browser-supplied proof.
 * Optional trust/client injection is for isolated, explicitly IAM-mocked fixtures.
 * Runtime still verifies SVID and both live grants; this factory mints no tokens. */
export function composePostgresqlDiscovery(
  raw: unknown,
  ports: {
    trust?: JwtTrustSource;
    client?: typeof createSupabaseAdmin;
  } = {},
): Pick<DiscoveryService, 'run'> {
  try {
    const config = PostgresqlCompositionSchema.parse(raw);
    const entries = new Map<string, z.infer<typeof endpoint>>();
    const registry = new Map(
      [...connectorRegistry].filter(
        ([, manifest]) =>
          manifest.target === 'postgresql' &&
          manifest.transport === 'sql' &&
          manifest.auth === 'cloud_iam' &&
          manifest.targetBinding === 'production',
      ),
    );
    for (const entry of config.connections) {
      const { binding } = entry;
      if (!registry.has(binding.descriptorId)) throw new Error();
      const key = `${binding.tenantId}/${binding.connectorId}`;
      if (entries.has(key)) throw new Error();
      entries.set(key, Object.freeze(entry.endpoint));
    }
    const trust =
      ports.trust ??
      new WorkloadApiJwtTrust({
        socketPath: config.workload.socketPath,
        trustDomains: [config.workload.trustDomain],
        timeoutMs: config.workload.timeoutMs,
      });
    const identity = new JwtSvidVerifier(
      {
        audience: config.workload.audience,
        trustDomains: [config.workload.trustDomain],
        maxLifetimeSeconds: config.workload.maxLifetimeSeconds,
      },
      trust,
    );
    const service = new DiscoveryService(
      {
        sql: config.connections.map((entry) => ({
          tenantId: entry.binding.tenantId,
          connectorId: entry.binding.connectorId,
          binding: entry.binding,
          endpoint: entry.endpoint,
        })),
        http: [],
      },
      {
        identity,
        postgresqlOnly: true,
        client: ports.client,
        registry,
        sqlSessions: postgresSessions({
          endpoint: (context) =>
            entries.get(`${context.tenantId.toLowerCase()}/${context.connectorId.toLowerCase()}`),
          credentials: rdsIamCredentials(),
        }),
      },
    );
    return Object.freeze({ run: (input, proof, signal) => service.run(input, proof, signal) });
  } catch {
    throw new Error('PostgreSQL discovery configuration refused');
  }
}

/** Absence deliberately leaves the existing private route unavailable. Configured
 * invalid/unreadable files fail startup; no mocks, environment credentials or DSNs. */
export async function loadPostgresqlDiscovery(
  filename: string | undefined,
  ports: {
    trust?: JwtTrustSource;
    client?: typeof createSupabaseAdmin;
  } = {},
): Promise<Pick<DiscoveryService, 'run'> | undefined> {
  if (filename === undefined) return undefined;
  let bytes: Buffer | undefined;
  try {
    controllerFilePath.parse(filename);
    bytes = await readControllerFile(filename);
    return composePostgresqlDiscovery(
      parsePrativedanAssessmentJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      ports,
    );
  } catch {
    throw new Error('PostgreSQL discovery startup refused');
  } finally {
    bytes?.fill(0);
  }
}
