import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Privileged writes of SYNTHETIC fixture rows into the local parity database.
 *
 * Migration 0099 removed INSERT/UPDATE/DELETE on remediation plans and actions
 * from the shared service credential (no product path writes them through it),
 * so local persona and parity harnesses can no longer forge plan rows over
 * PostgREST with the service key. They connect as the database owner instead.
 * This only ever targets a loopback database read from the local parity state;
 * it refuses anything else, and it has no deployed-target mode.
 */
export const FIXTURE_TABLES = ['remediation_plans', 'remediation_actions'] as const;
export type FixtureTable = (typeof FIXTURE_TABLES)[number];

/** Where the repo is (to resolve `pg`) and where the local parity state lives. */
export type FixtureTarget = { repoRoot: string; stateDir: string };

type Client = {
  connect(): Promise<void>;
  query(text: string, values: unknown[]): Promise<{ rowCount: number | null }>;
  end(): Promise<void>;
};

const COLUMN = /^[a-z_][a-z0-9_]*$/;

export function localDatabaseUrl(stateDir: string): string {
  const url = (
    JSON.parse(readFileSync(resolve(stateDir, 'status.json'), 'utf8')) as { DB_URL?: string }
  ).DB_URL;
  if (!url) throw new Error('Local parity state has no DB_URL');
  const host = new URL(url).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]')
    throw new Error('Refusing to write fixtures into a non-loopback database');
  return url;
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
  const client = new PgClient({ connectionString: localDatabaseUrl(target.stateDir) });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
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
