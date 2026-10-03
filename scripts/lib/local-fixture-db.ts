import { createRequire } from 'node:module';
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AcceptanceTarget } from './acceptance-target.js';

/**
 * Privileged writes of SYNTHETIC fixture rows into the local parity database.
 *
 * Migration 0099 removed INSERT/UPDATE/DELETE on remediation plans and actions
 * from the shared service credential (no product path writes them through it),
 * so local persona and parity harnesses can no longer forge plan rows over
 * PostgREST with the service key. They connect as the database owner instead.
 * Both local parity and a remote target reached through an operator-owned
 * loopback database tunnel are supported. A remote write is bound to the
 * selected deployment and to freshly seeded engagement rows before any DML.
 */
export const FIXTURE_TABLES = ['remediation_plans', 'remediation_actions'] as const;
export type FixtureTable = (typeof FIXTURE_TABLES)[number];

/** Where the repo is (to resolve `pg`) and where the local parity state lives. */
export type FixtureTarget =
  | { repoRoot: string; stateDir: string; remote?: never }
  | {
      repoRoot: string;
      remote: {
        databaseUrl: string;
        proof: Array<{ tenantId: string; engagementId: string }>;
      };
      stateDir?: never;
    };

type Client = {
  connect(): Promise<void>;
  query(text: string, values: unknown[]): Promise<{ rowCount: number | null }>;
  end(): Promise<void>;
};

const COLUMN = /^[a-z_][a-z0-9_]*$/;

function loopbackDatabaseUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid fixture database URL');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol))
    throw new Error('Fixture database URL must use PostgreSQL');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname))
    throw new Error('Refusing to write fixtures into a non-loopback database');
  // node-postgres lets connection-string query parameters override the URL
  // hostname (for example ?host=remote.example), so the URL must be bare.
  if (parsed.search || parsed.hash)
    throw new Error('Fixture database URL must not contain query parameters or a fragment');
  return url;
}

export function localDatabaseUrl(stateDir: string): string {
  const url = (
    JSON.parse(readFileSync(resolve(stateDir, 'status.json'), 'utf8')) as { DB_URL?: string }
  ).DB_URL;
  if (!url) throw new Error('Local parity state has no DB_URL');
  return loopbackDatabaseUrl(url);
}

/** Read a private operator-supplied tunnel credential before seeding any data. */
export function remoteFixtureDatabaseUrl(
  target: AcceptanceTarget,
  file = process.env.AXIOM_ACCEPTANCE_FIXTURE_DB,
): string {
  if (target.topology !== 'remote' || target.environment === 'production')
    throw new Error('Remote fixture database writes require a non-production remote target');
  if (!file) throw new Error('AXIOM_ACCEPTANCE_FIXTURE_DB is required for remote plan fixtures');
  const fd = openSync(resolve(file), 'r');
  let config: Record<string, unknown>;
  try {
    if (process.platform !== 'win32' && (fstatSync(fd).mode & 0o077) !== 0)
      throw new Error('Remote fixture database file must be private (chmod 600)');
    try {
      config = JSON.parse(readFileSync(fd, 'utf8')) as Record<string, unknown>;
    } catch {
      throw new Error('Cannot parse remote fixture database file');
    }
  } finally {
    closeSync(fd);
  }
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    Object.keys(config).sort().join(',') !==
      'databaseUrl,deploymentId,environment,expectedRevision,schemaVersion' ||
    config.schemaVersion !== 1 ||
    config.deploymentId !== target.deploymentId ||
    config.environment !== target.environment ||
    config.expectedRevision !== target.expectedRevision ||
    typeof config.databaseUrl !== 'string'
  )
    throw new Error('Remote fixture database file does not match the acceptance target');
  return loopbackDatabaseUrl(config.databaseUrl);
}

function assertTable(table: string): asserts table is FixtureTable {
  if (!(FIXTURE_TABLES as readonly string[]).includes(table))
    throw new Error(`Unsupported fixture table: ${table}`);
}

function assertColumns(columns: string[]) {
  if (columns.length === 0 || columns.some((name) => !COLUMN.test(name)))
    throw new Error('Invalid fixture column name');
}

async function withClient<T>(
  target: FixtureTarget,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  // `pg` is a BFF dependency; resolve it from there rather than adding another.
  const requireFromBff = createRequire(resolve(target.repoRoot, 'services/bff/package.json'));
  const { Client: PgClient } = requireFromBff('pg') as { Client: new (config: object) => Client };
  const databaseUrl = target.remote
    ? loopbackDatabaseUrl(target.remote.databaseUrl)
    : localDatabaseUrl(target.stateDir!);
  const client = new PgClient({ connectionString: databaseUrl });
  await client.connect();
  try {
    if (target.remote) await verifyRemoteFixtureBinding(client, target.remote.proof);
    return await run(client);
  } finally {
    await client.end();
  }
}

export async function verifyRemoteFixtureBinding(
  client: Pick<Client, 'query'>,
  proof: Array<{ tenantId: string; engagementId: string }>,
): Promise<void> {
  if (proof.length === 0)
    throw new Error('Remote fixture write requires a seeded engagement proof');
  for (const { tenantId, engagementId } of proof) {
    const result = await client.query(
      'select 1 from public.engagements where tenant_id = $1 and id = $2',
      [tenantId, engagementId],
    );
    if (result.rowCount !== 1)
      throw new Error('Remote fixture database does not contain the selected engagement');
  }
}

export async function insertLocalFixtureRows(
  target: FixtureTarget,
  table: FixtureTable,
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  assertTable(table);
  // Validate everything before opening a connection.
  for (const row of rows) assertColumns(Object.keys(row));
  await withClient(target, async (client) => {
    for (const row of rows) {
      const columns = Object.keys(row);
      const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
      const result = await client.query(
        `insert into public.${table} (${columns.join(', ')}) values (${placeholders})`,
        columns.map((name) => row[name]),
      );
      if (result.rowCount !== 1) throw new Error(`Fixture insert into ${table} affected no row`);
    }
  });
}

export async function updateLocalFixtureRow(
  target: FixtureTarget,
  table: FixtureTable,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  assertTable(table);
  const columns = Object.keys(patch);
  assertColumns(columns);
  await withClient(target, async (client) => {
    const assignments = columns.map((name, index) => `${name} = $${index + 1}`).join(', ');
    const result = await client.query(
      `update public.${table} set ${assignments} where id = $${columns.length + 1}`,
      [...columns.map((name) => patch[name]), id],
    );
    if (result.rowCount !== 1) throw new Error(`Fixture update of ${table} affected no row`);
  });
}
