# Revision 88 — W4.6 MySQL SQL binding (read side)

## Scope and assumptions

Closes the "MySQL" line left open by [audit 73](73-first-sql-binding-review-2026-09-25.md):
the W4.6 read binding gains a MySQL engine with the same contract as the
PostgreSQL one. Assumptions:

1. **Same architecture, not a port to agent-runtime.** The Rev 84 template
   (`PostgresReadConnector`, `postgresSessions`, `SqlDiscoveryGate`) lives in
   the BFF as an internal library, and the grant resolution, SVID gate and
   discovery recording are BFF-side. Duplicating them in Python would create a
   second, untested authority path, so `MySqlReadConnector` mirrors the
   Postgres adapter in `services/bff/src/connectors/sql/` and reuses the gate
   end to end. Agent-runtime is unchanged.
2. **Dependency decision: `mysql2` (^3.24.4, pure JS) in `@axiom/bff`.** The
   brief suggested PyMySQL in agent-runtime under the assumption the binding
   lived there; the driver follows the binding, so the narrowest maintained
   driver for the BFF is mysql2 (promise API, TLS, prepared-protocol support,
   no native build).
3. **No manifest schema change and no migration.** Rev 84 added no `sql`
   manifest block: `transport: sql` + `auth: cloud_iam` + `target: mysql`
   already validate against `ConnectorManifestSchema`, and `resolve_sql_read_grant`
   (0058) is engine-agnostic (it checks transport and manifest auth only).
   The new `mysql-production.yaml` descriptor rides the existing schema.
4. **RDS IAM unchanged.** The same `rdsIamCredentials` provider mints tokens
   for RDS MySQL; the endpoint schema (ap-south-1, pinned CA) is shared.
5. **Read side only.** No SQL write path, unchanged from Rev 84.

## Change

- **`MySqlReadConnector`** (`services/bff/src/connectors/sql/mysql-read.ts`):
  - Each call sets the session `read only` and `repeatable read`, opens an
    explicit `start transaction read only`, bounds statements by
    `set session max_execution_time` from the invocation deadline, and always
    ends in `rollback` with the session closed.
  - Before reading anything it refuses (reasons unchanged): a non-read-only
    session; a privileged account (SUPER, GRANT OPTION, CREATE USER, SHUTDOWN,
    FILE, RELOAD, REPLICATION CLIENT/SLAVE, or any active role — roles can
    carry invisible grants, so `current_role() <> 'NONE'` fails closed); any
    account holding a write privilege (INSERT, UPDATE, DELETE, CREATE, DROP,
    ALTER, INDEX, TRIGGER, REFERENCES, CREATE TEMPORARY TABLES, LOCK TABLES,
    CREATE/ALTER ROUTINE, EVENT) at global, schema, table or column scope.
  - Posture is read from information_schema privilege views for the server-side
    grantee string built from `CURRENT_USER()`; the 1/0 server shape and the
    boolean fake shape are both accepted, anything else fails closed.
  - `enumerate` lists only relations the account can SELECT (global, schema,
    table or any-column grant), paged by a validated `schema.table` cursor,
    with column-name category hints; identifiers outside the conservative
    `[A-Za-z_][A-Za-z0-9_$]{0,62}` pattern are skipped rather than quoted.
  - `sample` resolves the relation through information_schema first, caps rows
    at 200, casts every column to CHAR, and returns only per-column value-shape
    counts (email, Indian mobile, PAN, Aadhaar-like). `read` of raw records is
    refused.
- **`mysqlSessions`** (`session.ts`): the same reviewed-endpoint contract as
  `postgresSessions` (ap-south-1 only, pinned CA, verified TLS with
  `rejectUnauthorized`, connect timeout), `dateStrings` so values reach the
  profiler as text, multi-statement text left disabled.
- **`SqlDiscoveryGate`** gains an `engine` option ('postgresql' default,
  'mysql'); `DiscoveryService` derives it from the reviewed descriptor's
  `target` and refuses unknown SQL targets (`engine_unsupported`). Grant
  resolution before/after each call is unchanged and shared.
- **CI:** a new job, "Live SQL binding (W4.6 MySQL)", runs
  `mysql-read.live.test.ts` against a `mysql:8` service with
  `AXIOM_MYSQL_LIVE_REQUIRED=1`.

## Evidence

- `mysql-read.live.test.ts` against a real MySQL 8 (5 tests, run live locally
  and in CI): least-privilege enumeration with hints; samples contain none of
  the seeded raw values; bad identifiers, injection text, oversized limit,
  malformed cursor and expired deadline refused; writer and superuser accounts
  refused with `write_privilege` and `privileged_role`; session verified
  read-only mid-call (`@@session.transaction_read_only = 1`), DML refused, no
  backend connection for the role survives the call.
- `session.test.ts` (+4): mysqlSessions refuses unconfigured, non-Mumbai,
  CA-less, malformed or extra-field endpoints before minting a credential;
  always-rollback-and-close; deadline-bounded `max_execution_time`; unknown
  posture fails closed; write-capable/privileged accounts refused before any
  catalogue query.
- `grant-gate.test.ts` (+2): the gate selects the MySQL connector for a
  mysql-target grant and withholds results on mid-invocation revocation.
- `discovery.test.ts` (+1): a mysql-target connector routes through the MySQL
  session factory and an unknown SQL target is refused.
- Results: BFF 1171 tests pass (incl. the 5 live MySQL tests against a local
  MySQL 8 container); agent-runtime 285 tests pass.

## Not delivered (remaining W4.6 scope)

- Reviewed store for `endpointRef → SqlEndpoint` configuration and RDS staging
  acceptance in `ap-south-1` (operator; provisioning not authorized) — for both
  engines alike.
- Persisting discovery results into the estate inventory and category
  suggestions (unchanged from audit 73).
