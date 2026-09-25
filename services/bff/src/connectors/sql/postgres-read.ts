import type { ConnectorInvocation, ConnectorResult, ReadConnector } from '@axiom/types';

/** The subset of a node-postgres client this adapter uses. */
export interface SqlSession {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}
/** Opens one session for one invocation. The W4.6 credential path supplies it;
 * this adapter never sees a connection string or password. */
export type SqlSessionFactory = (context: ConnectorInvocation) => Promise<SqlSession>;

export class SqlConnectorRefused extends Error {
  constructor(readonly reason: string) {
    super(`SQL connector refused: ${reason}`);
    this.name = 'SqlConnectorRefused';
  }
}

const MAX_TABLES = 500;
const MAX_SAMPLE = 200;
const STATEMENT_TIMEOUT_MS = 5000;
const RESOURCE = /^([a-z_][a-z0-9_$]{0,62})\.([a-z_][a-z0-9_$]{0,62})$/;
// A catalogue cursor is the last "schema.table" returned, never SQL.
const CURSOR = RESOURCE;

/** Column-name hints only; a hint is a prompt for human review, not a finding. */
const NAME_HINTS: readonly [RegExp, string][] = [
  [/e_?mail/, 'contact'],
  [/phone|mobile|msisdn/, 'contact'],
  [/address|pincode|pin_code|postal|zip/, 'contact'],
  [
    /aadhaa?r|\bpan\b|pan_(no|number)|passport|voter|driving_?licen[cs]e|dob|date_of_birth|birth/,
    'identity',
  ],
  [/first_?name|last_?name|full_?name|^name$|surname/, 'identity'],
  [/account_?(no|number)|iban|ifsc|card|upi|salary|income/, 'financial'],
  [/diagnos|medical|health|blood|allerg|prescription/, 'health'],
  [/employee|designation|department|payroll/, 'employment'],
  [/guardian|parent|minor|child/, 'children'],
];
export function categoryHints(column: string): string[] {
  const name = column.toLowerCase();
  return [...new Set(NAME_HINTS.filter(([re]) => re.test(name)).map(([, key]) => key))].sort();
}

/** Value detectors. Only counts leave the adapter; matched values never do. */
const DETECTORS: readonly [string, RegExp][] = [
  ['email', /^[^\s@]+@[^\s@]+\.[^\s@]+$/],
  ['phone_in', /^(\+?91[\s-]?)?[6-9]\d{9}$/],
  ['pan', /^[A-Z]{5}\d{4}[A-Z]$/],
  ['aadhaar_like', /^[2-9]\d{3}\s?\d{4}\s?\d{4}$/],
];

function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * W4.6 first SQL binding, read side (Drishti discovery). Every call runs in
 * its own READ ONLY transaction with a statement timeout and is rolled back.
 * The session must not be a superuser or hold write privilege on any visible
 * table; otherwise the connector refuses before reading anything, because
 * least privilege is part of the binding rather than an operator promise.
 * No caller-supplied text is interpolated: resources are validated identifiers
 * that must resolve to a visible, SELECT-able relation first.
 */
export class PostgresReadConnector implements ReadConnector {
  constructor(
    private readonly open: SqlSessionFactory,
    private readonly now: () => number = Date.now,
  ) {}

  private async withReadOnly<T>(
    context: ConnectorInvocation,
    work: (session: SqlSession) => Promise<T>,
  ): Promise<T> {
    const deadline = Date.parse(context.deadline);
    if (!Number.isFinite(deadline) || deadline <= this.now())
      throw new SqlConnectorRefused('deadline');
    const timeout = Math.max(1, Math.min(STATEMENT_TIMEOUT_MS, deadline - this.now()));
    const session = await this.open(context);
    try {
      await session.query('begin transaction isolation level repeatable read read only');
      await session.query(`set local statement_timeout = ${timeout}`);
      await session.query(`set local idle_in_transaction_session_timeout = ${timeout}`);
      await session.query('set local search_path = pg_catalog');
      const [posture] = (
        await session.query(
          `select current_setting('transaction_read_only') = 'on' as read_only,
             (select rolsuper or rolcreaterole or rolcreatedb or rolreplication or rolbypassrls
                from pg_roles where rolname = current_user) as privileged,
             exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where c.relkind in ('r','p','v','m','f')
                 and n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_toast'
                 and (has_table_privilege(c.oid, 'INSERT') or has_table_privilege(c.oid, 'UPDATE')
                   or has_table_privilege(c.oid, 'DELETE') or has_table_privilege(c.oid, 'TRUNCATE'))
             ) as can_write`,
        )
      ).rows;
      if (posture?.read_only !== true) throw new SqlConnectorRefused('not_read_only');
      if (posture.privileged !== false) throw new SqlConnectorRefused('privileged_role');
      if (posture.can_write !== false) throw new SqlConnectorRefused('write_privilege');
      return await work(session);
    } finally {
      try {
        await session.query('rollback');
      } finally {
        await session.end();
      }
    }
  }

  /** Visible tables and their columns with category hints, paged by name. */
  async enumerate(context: ConnectorInvocation, cursor?: string): Promise<ConnectorResult> {
    if (cursor !== undefined && !CURSOR.test(cursor)) throw new SqlConnectorRefused('cursor');
    const [afterSchema, afterTable] = cursor ? cursor.split('.') : ['', ''];
    return this.withReadOnly(context, async (session) => {
      const { rows } = await session.query(
        `select n.nspname as schema, c.relname as table, c.relkind::text as kind,
           greatest(c.reltuples, 0)::bigint as estimated_rows,
           coalesce(jsonb_agg(jsonb_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
             'nullable', not a.attnotnull) order by a.attnum) filter (where a.attnum is not null), '[]') as columns
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         left join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
           and has_column_privilege(c.oid, a.attnum, 'SELECT')
         where c.relkind in ('r','p','v','m','f')
           and n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_toast'
           and has_schema_privilege(n.oid, 'USAGE')
           and (has_table_privilege(c.oid, 'SELECT') or has_any_column_privilege(c.oid, 'SELECT'))
           and (n.nspname, c.relname) > ($1::text, $2::text)
         group by n.nspname, c.relname, c.relkind, c.reltuples
         order by n.nspname, c.relname
         limit ${MAX_TABLES + 1}`,
        [afterSchema, afterTable],
      );
      const page = rows.slice(0, MAX_TABLES);
      const records = page.map((row) => {
        const columns = (row.columns as { name: string; type: string; nullable: boolean }[]).map(
          (column) => ({ ...column, categoryHints: categoryHints(column.name) }),
        );
        return {
          resource: `${String(row.schema)}.${String(row.table)}`,
          kind: row.kind,
          estimatedRows: Number(row.estimated_rows),
          columns,
          categoryHints: [...new Set(columns.flatMap((c) => c.categoryHints))].sort(),
        };
      });
      const last = page.at(-1);
      return rows.length > MAX_TABLES && last
        ? { records, cursor: `${String(last.schema)}.${String(last.table)}` }
        : { records };
    });
  }

  /** Profiles up to `limit` rows of one relation. Returns per-column counts of
   * detected value shapes; sampled values are discarded inside this process. */
  async sample(
    context: ConnectorInvocation,
    resource: string,
    limit: number,
  ): Promise<ConnectorResult> {
    const match = RESOURCE.exec(resource);
    if (!match) throw new SqlConnectorRefused('resource');
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SAMPLE)
      throw new SqlConnectorRefused('limit');
    const [, schema, table] = match as unknown as [string, string, string];
    return this.withReadOnly(context, async (session) => {
      const { rows: columns } = await session.query(
        `select a.attname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
         where n.nspname = $1 and c.relname = $2 and c.relkind in ('r','p','v','m','f')
           and has_schema_privilege(n.oid, 'USAGE') and has_column_privilege(c.oid, a.attnum, 'SELECT')
         order by a.attnum`,
        [schema, table],
      );
      if (columns.length === 0) throw new SqlConnectorRefused('resource');
      const names = columns.map((c) => String(c.name));
      // Identifiers come from the catalogue lookup above and are quoted; the
      // row limit is a validated integer.
      const { rows } = await session.query(
        `select ${names.map((n, i) => `${quoteIdent(n)}::text as c${i}`).join(', ')}
         from ${quoteIdent(schema)}.${quoteIdent(table)} limit ${limit}`,
      );
      const records = names.map((name, index) => {
        const detected: Record<string, number> = {};
        let nonNull = 0;
        for (const row of rows) {
          const value = row[`c${index}`];
          if (value === null || value === undefined) continue;
          nonNull += 1;
          const text = String(value).trim();
          for (const [key, re] of DETECTORS)
            if (re.test(text)) detected[key] = (detected[key] ?? 0) + 1;
        }
        return {
          column: name,
          sampled: rows.length,
          nonNull,
          detected,
          categoryHints: categoryHints(name),
        };
      });
      return { records };
    });
  }

  /** Raw record reads stay disabled until the redaction pipeline covers them. */
  async read(): Promise<ConnectorResult> {
    throw new SqlConnectorRefused('raw_read_disabled');
  }
}
