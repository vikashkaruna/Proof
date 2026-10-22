import type { ConnectorInvocation, ConnectorResult, ReadConnector } from '@axiom/types';
import { categoryHints, profileField } from '../profile.js';
import { SqlConnectorRefused, type SqlSession, type SqlSessionFactory } from './postgres-read.js';

const MAX_TABLES = 500;
const MAX_SAMPLE = 200;
const STATEMENT_TIMEOUT_MS = 5000;
// A catalogue cursor is the last "schema.table" returned, never SQL. MySQL does
// not fold identifier case, so the pattern allows both cases; quoted-identifier
// characters (backtick, dot, whitespace, semicolon) stay forbidden, and the
// enumerate query skips identifiers outside this conservative set entirely.
const IDENT_SOURCE = '[A-Za-z_][A-Za-z0-9_$]{0,62}';
const IDENT_ANCHORED = `^${IDENT_SOURCE}$`;
const RESOURCE = new RegExp(`^(${IDENT_SOURCE})\\.(${IDENT_SOURCE})$`);
const CURSOR = RESOURCE;

function quoteIdent(identifier: string): string {
  return `\`${identifier.replaceAll('`', '``')}\``;
}

/** The current account in information_schema privilege views: 'user'@'host'.
 * Built server-side from CURRENT_USER(), never from caller-supplied text. */
const GRANTEE = "concat('''', replace(current_user(), '@', '''@'''), '''')";

/** Global privileges that make an account unusable for the read binding:
 * SUPER (superuser), CREATE USER (role admin), GRANT OPTION (self-escalation),
 * FILE (server file access), SHUTDOWN, RELOAD, REPLICATION (data egress). */
const PRIVILEGED_GLOBAL: readonly string[] = [
  'SUPER',
  'GRANT OPTION',
  'CREATE USER',
  'SHUTDOWN',
  'FILE',
  'RELOAD',
  'REPLICATION CLIENT',
  'REPLICATION SLAVE',
];

/** Anything that could change data, at global, schema, table or routine scope.
 * Includes CREATE TEMPORARY TABLES and LOCK TABLES: both are write-shaped. */
const WRITE_PRIVILEGES: readonly string[] = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'DROP',
  'ALTER',
  'INDEX',
  'TRIGGER',
  'REFERENCES',
  'CREATE TEMPORARY TABLES',
  'LOCK TABLES',
  'CREATE ROUTINE',
  'ALTER ROUTINE',
  'EVENT',
  // A view or a definer-rights routine can write on the account's behalf.
  'CREATE VIEW',
  'EXECUTE',
];

/**
 * The parts of the read binding that differ between MySQL-protocol engines.
 * Everything else (catalogue SQL, privilege views, quoting, profiling) is
 * shared, so a new MySQL-compatible engine is one more dialect value.
 */
export interface MySqlDialect {
  readonly engine: 'mysql' | 'mariadb';
  /** Server-side per-statement timeout for this session. */
  timeoutStatement(ms: number): string;
  /** True when the session (and so every transaction in it) is read-only. */
  readonly readOnlyExpression: string;
  /** True when any role is active; role privileges are not visible per grantee. */
  readonly roleActiveExpression: string;
  /** True when `column` is a whole identifier in the conservative set. */
  identifierMatches(column: string): string;
  /** Engine-specific administrative privileges, on top of the shared set. */
  readonly extraPrivileged: readonly string[];
  /** Engine-specific write-shaped privileges, on top of the shared set. */
  readonly extraWrite: readonly string[];
}

/** MySQL 8: CURRENT_ROLE() answers 'NONE' and REGEXP_LIKE is available. */
export const MYSQL_DIALECT: MySqlDialect = Object.freeze({
  engine: 'mysql',
  timeoutStatement: (ms: number) => `set session max_execution_time = ${ms}`,
  readOnlyExpression: '@@session.transaction_read_only = 1',
  roleActiveExpression: "current_role() <> 'NONE'",
  identifierMatches: (column: string) => `regexp_like(${column}, '${IDENT_ANCHORED}', 'c')`,
  extraPrivileged: ['SYSTEM_VARIABLES_ADMIN', 'ROLE_ADMIN', 'CONNECTION_ADMIN'],
  extraWrite: [],
});

/** MariaDB 10.6+/11: CURRENT_ROLE() is NULL without a role, the timeout is in
 * seconds, there is no REGEXP_LIKE, and administrative rights are split into
 * named privileges (BINLOG ADMIN, READ_ONLY ADMIN, SET USER and others). */
export const MARIADB_DIALECT: MySqlDialect = Object.freeze({
  engine: 'mariadb',
  timeoutStatement: (ms: number) =>
    `set session max_statement_time = ${(Math.max(1, ms) / 1000).toFixed(3)}`,
  readOnlyExpression: '@@session.tx_read_only = 1',
  roleActiveExpression: 'current_role() is not null',
  identifierMatches: (column: string) => `cast(${column} as binary) regexp '${IDENT_ANCHORED}'`,
  extraPrivileged: [
    'BINLOG ADMIN',
    'BINLOG MONITOR',
    'BINLOG REPLAY',
    'CONNECTION ADMIN',
    'FEDERATED ADMIN',
    'READ_ONLY ADMIN',
    'REPLICATION MASTER ADMIN',
    'REPLICA MONITOR',
    'SLAVE MONITOR',
    'SET USER',
  ],
  extraWrite: ['DELETE HISTORY'],
});

const privilegeList = (privileges: readonly string[]): string =>
  privileges.map((privilege) => `'${privilege}'`).join(',');

/** Whether the account holds SELECT on the whole table: any global, schema or
 * table-level SELECT grant (the MySQL analogue of has_table_privilege). */
function canSelectTable(schema: string, table: string): string {
  return `(exists (select 1 from information_schema.user_privileges gu
             where gu.grantee = ${GRANTEE} and gu.privilege_type = 'SELECT')
          or exists (select 1 from information_schema.schema_privileges su
             where su.grantee = ${GRANTEE} and su.privilege_type = 'SELECT'
               and su.table_schema = ${schema})
          or exists (select 1 from information_schema.table_privileges tu
             where tu.grantee = ${GRANTEE} and tu.privilege_type = 'SELECT'
               and tu.table_schema = ${schema} and tu.table_name = ${table})
          or exists (select 1 from information_schema.column_privileges cu
             where cu.grantee = ${GRANTEE} and cu.privilege_type = 'SELECT'
               and cu.table_schema = ${schema} and cu.table_name = ${table}))`;
}

/** Whether one column is readable: table-level SELECT, or a column-level grant
 * (the MySQL analogue of has_column_privilege). */
function canSelectColumn(schema: string, table: string, column: string): string {
  return `(${canSelectTable(schema, table)}
          or exists (select 1 from information_schema.column_privileges vu
             where vu.grantee = ${GRANTEE} and vu.privilege_type = 'SELECT'
               and vu.table_schema = ${schema} and vu.table_name = ${table}
               and vu.column_name = ${column}))`;
}

const postureSql = (dialect: MySqlDialect) => `select (${dialect.readOnlyExpression}) as read_only,
   (exists (select 1 from information_schema.user_privileges u
      where u.grantee = ${GRANTEE}
        and u.privilege_type in (${privilegeList([...PRIVILEGED_GLOBAL, ...dialect.extraPrivileged])}))
    or coalesce(${dialect.roleActiveExpression}, false)) as privileged,
   (exists (select 1 from information_schema.user_privileges u
      where u.grantee = ${GRANTEE}
        and u.privilege_type in (${privilegeList([...WRITE_PRIVILEGES, ...dialect.extraWrite])}))
   or exists (select 1 from information_schema.schema_privileges s
      where s.grantee = ${GRANTEE}
        and s.privilege_type in (${privilegeList([...WRITE_PRIVILEGES, ...dialect.extraWrite])}))
   or exists (select 1 from information_schema.table_privileges p
      where p.grantee = ${GRANTEE}
        and p.privilege_type in (${privilegeList([...WRITE_PRIVILEGES, ...dialect.extraWrite])}))
   or exists (select 1 from information_schema.column_privileges p
      where p.grantee = ${GRANTEE} and p.privilege_type in ('INSERT','UPDATE'))) as can_write`;

/**
 * W4.6 SQL binding, read side, MySQL (Drishti discovery): the honest adaptation
 * of the Rev 84 PostgreSQL binding. Every call runs in a read-only session and
 * an explicit `start transaction read only` with a statement timeout bounded by
 * the invocation deadline, and always ends in a rollback with the session
 * closed. The session must not be privileged or hold write privilege at any
 * scope; otherwise the connector refuses before reading anything, because
 * least privilege is part of the binding rather than an operator promise.
 * No caller-supplied text is interpolated: resources are validated identifiers
 * that must resolve to a visible, SELECT-able relation first, and identifiers
 * reaching SQL are backtick-quoted. Requires MySQL 8 or MariaDB 10.6+; the
 * engine differences live in a `MySqlDialect`.
 */
export class MySqlReadConnector implements ReadConnector {
  constructor(
    private readonly open: SqlSessionFactory,
    private readonly now: () => number = Date.now,
    private readonly dialect: MySqlDialect = MYSQL_DIALECT,
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
      // The whole session is read-only, so no transaction in it can write; the
      // explicit read-only transaction then also pins a consistent snapshot.
      await session.query('set session transaction read only');
      await session.query('set session transaction isolation level repeatable read');
      await session.query(this.dialect.timeoutStatement(timeout));
      await session.query('start transaction read only');
      const [posture] = (await session.query(postureSql(this.dialect))).rows;
      // The server answers with 1/0; unit fakes answer with true/false. Any
      // other shape fails closed.
      const isSet = (value: unknown) => value === true || value === 1;
      const isUnset = (value: unknown) => value === false || value === 0;
      if (!isSet(posture?.read_only)) throw new SqlConnectorRefused('not_read_only');
      if (!isUnset(posture?.privileged)) throw new SqlConnectorRefused('privileged_role');
      if (!isUnset(posture?.can_write)) throw new SqlConnectorRefused('write_privilege');
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
        `select t.table_schema as tschema, t.table_name as tname,
           case when t.table_type = 'VIEW' then 'v' else 'r' end as kind,
           cast(coalesce(t.table_rows, 0) as signed) as estimated_rows
         from information_schema.tables t
         where t.table_type in ('BASE TABLE', 'VIEW')
           and t.table_schema not in ('mysql', 'information_schema', 'performance_schema', 'sys')
           and ${this.dialect.identifierMatches('t.table_schema')}
           and ${this.dialect.identifierMatches('t.table_name')}
           and (t.table_schema > ? or (t.table_schema = ? and t.table_name > ?))
           and ${canSelectTable('t.table_schema', 't.table_name')}
         order by t.table_schema, t.table_name
         limit ${MAX_TABLES + 1}`,
        [afterSchema, afterSchema, afterTable],
      );
      const page = rows.slice(0, MAX_TABLES);
      const records = page.length === 0 ? [] : await this.columnsFor(session, page);
      const last = page.at(-1);
      return rows.length > MAX_TABLES && last
        ? { records, cursor: `${String(last.tschema)}.${String(last.tname)}` }
        : { records };
    });
  }

  /** Reads the visible columns of one page of tables in ordinal order. */
  private async columnsFor(
    session: SqlSession,
    page: readonly Record<string, unknown>[],
  ): Promise<ConnectorResult['records']> {
    const values = page.flatMap((row) => [String(row.tschema), String(row.tname)]);
    const { rows: columnRows } = await session.query(
      `select c.table_schema as tschema, c.table_name as tname, c.column_name as cname,
         c.column_type as ctype, (c.is_nullable = 'YES') as nullable
       from information_schema.columns c
       where (c.table_schema, c.table_name) in (${page.map(() => '(?, ?)').join(', ')})
         and ${canSelectColumn('c.table_schema', 'c.table_name', 'c.column_name')}
       order by c.table_schema, c.table_name, c.ordinal_position`,
      values,
    );
    return page.map((row) => {
      const columns = columnRows
        .filter((c) => c.tschema === row.tschema && c.tname === row.tname)
        .map((column) => ({
          name: String(column.cname),
          type: String(column.ctype),
          nullable: column.nullable === true || column.nullable === 1,
          categoryHints: categoryHints(String(column.cname)),
        }));
      return {
        resource: `${String(row.tschema)}.${String(row.tname)}`,
        kind: row.kind,
        estimatedRows: Number(row.estimated_rows),
        columns,
        categoryHints: [...new Set(columns.flatMap((c) => c.categoryHints))].sort(),
      };
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
        `select c.column_name as cname from information_schema.columns c
         where c.table_schema = ? and c.table_name = ?
           and ${canSelectColumn('c.table_schema', 'c.table_name', 'c.column_name')}
         order by c.ordinal_position`,
        [schema, table],
      );
      if (columns.length === 0) throw new SqlConnectorRefused('resource');
      const names = columns.map((c) => String(c.cname));
      // Identifiers come from the catalogue lookup above and are backtick-
      // quoted; the row limit is a validated integer.
      const { rows } = await session.query(
        `select ${names.map((n, i) => `cast(${quoteIdent(n)} as char) as c${i}`).join(', ')}
         from ${quoteIdent(schema)}.${quoteIdent(table)} limit ${limit}`,
      );
      const records = names.map((name, index) => {
        const { field, ...profile } = profileField(
          name,
          rows.map((row) => row[`c${index}`]),
        );
        return { column: field, ...profile };
      });
      return { records };
    });
  }

  /** Raw record reads stay disabled until the redaction pipeline covers them. */
  async read(): Promise<ConnectorResult> {
    throw new SqlConnectorRefused('raw_read_disabled');
  }
}
