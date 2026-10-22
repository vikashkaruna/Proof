import type { ConnectorInvocation, ConnectorManifest, ConnectorResult } from '@axiom/types';
import type { RedactedScanResult, SqlSessionFactory } from '../sql/postgres-read.js';
import type { SqlCredentialProvider, SqlEndpoint } from '../sql/session.js';

/**
 * W4 connector plug-in contract. A plug-in supplies only what is specific to
 * one platform: how to open a session against a reviewed endpoint and how to
 * read its catalogue and value shapes. Everything around it is shared and is
 * never re-implemented per platform: the reviewed descriptor catalogue, the
 * live Drishti grant gate, backend-only credentials (broker, cloud IAM or the
 * pinned local sandbox file), deadlines, append-only discovery records, the
 * ledger, the connector catalogue and the scan report.
 *
 * A plug-in never receives a request-supplied endpoint, credential or SQL.
 */
export type ConnectorFamily = 'sql' | 'http';

interface ConnectorPluginBase {
  readonly family: ConnectorFamily;
  /** Human name shown in the ready-to-use connector catalogue. */
  readonly displayName: string;
  /** One sentence for the catalogue: what the connector reads. */
  readonly summary: string;
}

/** The read surface every SQL plug-in exposes to the grant gate. */
export interface SqlReader {
  enumerate(context: ConnectorInvocation, cursor?: string): Promise<ConnectorResult>;
  sample(context: ConnectorInvocation, resource: string, limit: number): Promise<ConnectorResult>;
  read(): Promise<ConnectorResult>;
  /** Optional bounded whole-relation processing (aggregate counts only). */
  scanRedacted?(
    context: ConnectorInvocation,
    resource: string,
    maxRows: number,
    pageSize: number,
  ): Promise<RedactedScanResult>;
}

export interface SqlConnectorPlugin extends ConnectorPluginBase {
  readonly family: 'sql';
  /** The reviewed descriptor `target` this plug-in serves (e.g. `mariadb`). */
  readonly target: string;
  /** Opens one TLS-verified session per invocation from reviewed configuration. */
  sessions(options: {
    endpoint: (context: ConnectorInvocation) => SqlEndpoint | undefined;
    credentials: SqlCredentialProvider;
    connectTimeoutMs?: number;
  }): SqlSessionFactory;
  /** Wraps a session factory in the platform's read-only adapter. */
  reader(sessions: SqlSessionFactory, now?: () => number): SqlReader;
  /**
   * True when the transport can be force-closed on a deadline (the gate then
   * wraps each session in its abortable deadline scope). False transports are
   * bounded by their own server-side statement timeout.
   */
  readonly abortableTransport: boolean;
  /** Local/test hostnames a sandbox (synthetic demo) endpoint may use. */
  readonly sandboxHost: RegExp;
}

/** REST and GraphQL share one generic plug-in each, driven by the descriptor's
 * declared resources, so a new SaaS API is a descriptor rather than code. */
export interface HttpConnectorPlugin extends ConnectorPluginBase {
  readonly family: 'http';
  readonly transport: 'rest' | 'graphql';
}

export type ConnectorPlugin = SqlConnectorPlugin | HttpConnectorPlugin;

/** One ready-to-use catalogue row. Non-secret: no endpoint or credential. */
export interface ConnectorCatalogueEntry {
  descriptorId: string;
  target: string;
  version: string;
  family: ConnectorFamily;
  transport: ConnectorManifest['transport'];
  targetBinding: ConnectorManifest['targetBinding'];
  auth: ConnectorManifest['auth'];
  assurance: ConnectorManifest['assurance'];
  displayName: string;
  summary: string;
  operations: string[];
  dataCategoryHints: string[];
}
