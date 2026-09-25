import { Signer } from '@aws-sdk/rds-signer';
import pg from 'pg';
import { z } from 'zod';
import type { ConnectorInvocation } from '@axiom/types';
import type { SqlSession, SqlSessionFactory } from './postgres-read.js';

/** Reviewed, non-secret endpoint configuration keyed by a connector's endpointRef. */
export const SqlEndpointSchema = z
  .object({
    host: z.string().regex(/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/),
    port: z.number().int().min(1).max(65535),
    database: z.string().regex(/^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/),
    user: z.string().regex(/^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/),
    region: z.literal('ap-south-1'),
    /** PEM bundle pinning the server CA. Absent is refused outside tests. */
    caPem: z.string().min(1).max(65536),
  })
  .strict();
export type SqlEndpoint = z.infer<typeof SqlEndpointSchema>;

/** Returns a short-lived password for one connection. Never a stored secret. */
export interface SqlCredentialProvider {
  password(endpoint: SqlEndpoint): Promise<string>;
}

/** Cloud-IAM path: a 15-minute RDS IAM auth token signed by the workload's own
 * AWS role. Nothing is stored; the database role needs rds_iam and SELECT only. */
export function rdsIamCredentials(
  signer: (endpoint: SqlEndpoint) => { getAuthToken(): Promise<string> } = (endpoint) =>
    new Signer({
      hostname: endpoint.host,
      port: endpoint.port,
      username: endpoint.user,
      region: endpoint.region,
    }),
): SqlCredentialProvider {
  return { password: (endpoint) => signer(endpoint).getAuthToken() };
}

export class SqlEndpointRefused extends Error {
  constructor() {
    super('SQL endpoint is not configured for this connector.');
    this.name = 'SqlEndpointRefused';
  }
}

/**
 * Opens one TLS-verified Postgres session per invocation. The endpoint comes
 * from reviewed configuration via the invocation's connector, never from the
 * caller; the password is minted per connection by the credential provider.
 */
export function postgresSessions(options: {
  endpoint: (context: ConnectorInvocation) => SqlEndpoint | undefined;
  credentials: SqlCredentialProvider;
  connectTimeoutMs?: number;
}): SqlSessionFactory {
  return async (context) => {
    const candidate = options.endpoint(context);
    const parsed = SqlEndpointSchema.safeParse(candidate);
    if (!parsed.success) throw new SqlEndpointRefused();
    const endpoint = parsed.data;
    const client = new pg.Client({
      host: endpoint.host,
      port: endpoint.port,
      database: endpoint.database,
      user: endpoint.user,
      password: await options.credentials.password(endpoint),
      ssl: { ca: endpoint.caPem, rejectUnauthorized: true, servername: endpoint.host },
      connectionTimeoutMillis: options.connectTimeoutMs ?? 5000,
      application_name: 'axiom-drishti',
    });
    await client.connect();
    const session: SqlSession = {
      query: async (text, values) => client.query(text, values ? [...values] : undefined),
      end: () => client.end(),
    };
    return session;
  };
}
