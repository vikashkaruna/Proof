import { Signer } from '@aws-sdk/rds-signer';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { Socket } from 'node:net';
import { PostgresDeadline, PostgresDeadlineExceeded } from './postgres-deadline.js';
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

/** Returns one backend-only credential for one connection. Cloud credentials
 * are short-lived IAM tokens; the explicit local sandbox broker pins an expiring
 * protected password file. Neither credential reaches an agent or response. */
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
  return async (context, signal) => {
    const candidate = options.endpoint(context);
    const parsed = SqlEndpointSchema.safeParse(candidate);
    if (!parsed.success) throw new SqlEndpointRefused();
    const endpoint = parsed.data;
    const scope = new PostgresDeadline(Date.parse(context.deadline), Date.now, signal);
    let socket: Socket | undefined;
    let closed: Promise<void> | undefined;
    let aborting: Promise<void> | undefined;
    const abort = () => {
      scope.abort();
      aborting ??= (async () => {
        socket?.destroy();
        await closed;
        scope.dispose();
      })();
      return aborting;
    };
    const stop = () => {
      socket?.destroy();
    };
    scope.signal.addEventListener('abort', stop, { once: true });
    try {
      // AWS's signer has no cancellation API. Never allocate a socket after a
      // timed-out/late credential; its detached result grants no database access.
      const password = await scope.run(() => options.credentials.password(endpoint));
      const remaining = Date.parse(context.deadline) - Date.now();
      if (remaining <= 0 || scope.signal.aborted) throw new PostgresDeadlineExceeded();
      socket = new Socket();
      closed = new Promise<void>((resolve) => socket!.once('close', resolve));
      const client = new pg.Client({
        host: endpoint.host,
        port: endpoint.port,
        database: endpoint.database,
        user: endpoint.user,
        password,
        ssl: { ca: endpoint.caPem, rejectUnauthorized: true, servername: endpoint.host },
        stream: () => socket,
        pipeline: false,
        connectionTimeoutMillis: Math.min(options.connectTimeoutMs ?? 5000, remaining),
        query_timeout: Math.min(5000, remaining),
        statement_timeout: Math.min(5000, remaining),
        idle_in_transaction_session_timeout: Math.min(5000, remaining),
        application_name: 'axiom-drishti',
      });
      // Connection errors must not become unhandled events or disclose target data.
      client.on('error', () => undefined);
      await scope.run(() => client.connect());
      return {
        query: (text, values) =>
          scope.run(() => client.query(text, values ? [...values] : undefined)),
        abort,
        end: async () => {
          try {
            if (!scope.signal.aborted) await scope.run(() => client.end());
          } finally {
            scope.signal.removeEventListener('abort', stop);
            await abort();
          }
        },
      };
    } catch (error) {
      scope.signal.removeEventListener('abort', stop);
      await abort();
      throw error;
    }
  };
}

/**
 * Opens one TLS-verified MySQL session per invocation under the same contract
 * as `postgresSessions`: the endpoint comes from reviewed configuration via the
 * invocation's connector, never from the caller; the password is minted per
 * connection by the credential provider (an RDS IAM token works for RDS MySQL
 * unchanged); TLS verifies the server chain against the pinned CA. Dates
 * arrive as strings so sampled values reach the profiler as text, mirroring
 * the Postgres adapter's ::text casts. Multi-statement text is left disabled.
 */
export function mysqlSessions(options: {
  endpoint: (context: ConnectorInvocation) => SqlEndpoint | undefined;
  credentials: SqlCredentialProvider;
  connectTimeoutMs?: number;
}): SqlSessionFactory {
  return async (context) => {
    const candidate = options.endpoint(context);
    const parsed = SqlEndpointSchema.safeParse(candidate);
    if (!parsed.success) throw new SqlEndpointRefused();
    const endpoint = parsed.data;
    const connection = await mysql.createConnection({
      host: endpoint.host,
      port: endpoint.port,
      database: endpoint.database,
      user: endpoint.user,
      password: await options.credentials.password(endpoint),
      ssl: { ca: endpoint.caPem, rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      connectTimeout: options.connectTimeoutMs ?? 5000,
      dateStrings: true,
    });
    const session: SqlSession = {
      query: async (text, values) => {
        const [result] = await connection.query({
          sql: text,
          values: values ? [...values] : undefined,
        });
        // Session-control statements answer with an OkPacket, not rows.
        return { rows: Array.isArray(result) ? (result as Record<string, unknown>[]) : [] };
      },
      end: async () => {
        await connection.end();
      },
    };
    return session;
  };
}
