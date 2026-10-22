import type { ConnectorManifest } from '@axiom/types';
import { MARIADB_DIALECT, MYSQL_DIALECT, MySqlReadConnector } from '../sql/mysql-read.js';
import { PostgresReadConnector } from '../sql/postgres-read.js';
import { mysqlSessions, postgresSessions } from '../sql/session.js';
import type {
  ConnectorCatalogueEntry,
  ConnectorPlugin,
  HttpConnectorPlugin,
  SqlConnectorPlugin,
} from './plugin.js';

/**
 * The single registration point for connector plug-ins. Adding a platform is
 * one entry here plus a reviewed descriptor and a conformance run; the gate,
 * broker, discovery records, catalogue and reports pick it up unchanged.
 * The table is frozen at module load: nothing registers a plug-in at runtime.
 */
const SQL_PLUGINS: readonly SqlConnectorPlugin[] = [
  {
    family: 'sql',
    target: 'postgresql',
    displayName: 'PostgreSQL',
    summary: 'Tables, columns and personal-data value shapes from a PostgreSQL database.',
    sessions: postgresSessions,
    reader: (sessions, now) => new PostgresReadConnector(sessions, now),
    abortableTransport: true,
    sandboxHost: /^axiom-pg-[a-z0-9-]{1,50}$/,
  },
  {
    family: 'sql',
    target: 'mysql',
    displayName: 'MySQL',
    summary: 'Tables, columns and personal-data value shapes from a MySQL 8 database.',
    sessions: mysqlSessions,
    reader: (sessions, now) => new MySqlReadConnector(sessions, now, MYSQL_DIALECT),
    abortableTransport: false,
    sandboxHost: /^axiom-mysql-[a-z0-9-]{1,50}$/,
  },
  {
    family: 'sql',
    target: 'mariadb',
    displayName: 'MariaDB',
    summary: 'Tables, columns and personal-data value shapes from a MariaDB 10.6+ database.',
    sessions: mysqlSessions,
    reader: (sessions, now) => new MySqlReadConnector(sessions, now, MARIADB_DIALECT),
    abortableTransport: false,
    sandboxHost: /^axiom-mariadb-[a-z0-9-]{1,50}$/,
  },
];

const HTTP_PLUGINS: readonly HttpConnectorPlugin[] = [
  {
    family: 'http',
    transport: 'rest',
    displayName: 'REST API',
    summary: 'Declared REST resources and their field shapes, read with a broker token.',
  },
  {
    family: 'http',
    transport: 'graphql',
    displayName: 'GraphQL API',
    summary: 'Declared GraphQL selections and their field shapes, read with a broker token.',
  },
];

const sqlByTarget = new Map(SQL_PLUGINS.map((plugin) => [plugin.target, Object.freeze(plugin)]));
const httpByTransport = new Map(
  HTTP_PLUGINS.map((plugin) => [plugin.transport, Object.freeze(plugin)]),
);
if (sqlByTarget.size !== SQL_PLUGINS.length || httpByTransport.size !== HTTP_PLUGINS.length)
  throw new Error('Duplicate connector plug-in');

/** The SQL plug-in for a reviewed descriptor target, or undefined. */
export function sqlPluginFor(target: string): SqlConnectorPlugin | undefined {
  return sqlByTarget.get(target);
}

/** The plug-in a reviewed descriptor runs on. SQL is chosen by `target`,
 * REST/GraphQL by transport; anything else has no plug-in and fails closed. */
export function pluginFor(manifest: ConnectorManifest): ConnectorPlugin | undefined {
  if (manifest.transport === 'sql') return sqlByTarget.get(manifest.target);
  if (manifest.transport === 'rest' || manifest.transport === 'graphql')
    return httpByTransport.get(manifest.transport);
  return undefined;
}

export const sqlTargets: readonly string[] = Object.freeze([...sqlByTarget.keys()]);

/** Ready-to-use catalogue rows for every reviewed descriptor with a plug-in. */
export function connectorCatalogue(
  registry: ReadonlyMap<string, ConnectorManifest>,
): ConnectorCatalogueEntry[] {
  const entries: ConnectorCatalogueEntry[] = [];
  for (const manifest of registry.values()) {
    const plugin = pluginFor(manifest);
    if (!plugin) continue;
    const isSql = plugin.family === 'sql';
    entries.push({
      descriptorId: manifest.id,
      target: manifest.target,
      version: manifest.version,
      family: plugin.family,
      transport: manifest.transport,
      targetBinding: manifest.targetBinding,
      auth: manifest.auth,
      assurance: manifest.assurance,
      displayName: isSql ? plugin.displayName : `${manifest.target} (${plugin.displayName})`,
      summary: plugin.summary,
      operations: Object.keys(manifest.capabilities).sort(),
      dataCategoryHints: [...manifest.dataCategoryHints].sort(),
    });
  }
  return entries.sort(
    (a, b) =>
      a.family.localeCompare(b.family) ||
      a.displayName.localeCompare(b.displayName) ||
      a.targetBinding.localeCompare(b.targetBinding),
  );
}
