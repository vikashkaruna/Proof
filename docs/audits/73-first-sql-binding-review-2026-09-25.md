# Revision 84 — W4.6 first real SQL binding (read side)

## Scope and assumptions

Doc 11 defines W4.6 as the first live binding: PostgreSQL/MySQL over the SQL transport, using the cloud-IAM credential path, end to end against a live staging database, to support real Drishti discovery. Operator input was not received. The assumptions are:

1. **Read side only.** Drishti discovery (enumerate and sample) is delivered. SQL writes remain unavailable until W5 approved-action execution with dry-run and validated rollback (BR-2). The migration resolves read grants for Drishti only.
2. **Cloud IAM, not a stored secret.** The production PostgreSQL descriptor already declares `auth: cloud_iam`. The workload mints a 15-minute RDS IAM auth token with its own AWS role for each connection. Nothing enters the credential vault, which remains OAuth-only.
3. **Minimised output.** Discovery returns catalogue metadata and counts of value shapes, never sampled values. No raw value reaches a model provider, a log or the BFF response (AGENTS.md rule 5).
4. **PostgreSQL first.** MySQL follows the same contract. It is not delivered here.
5. **Staging database not yet provisioned.** No cloud provisioning is authorized, so "live" means a disposable PostgreSQL 16 server in CI with real roles and grants. Acceptance against a live RDS staging database in `ap-south-1` stays an operator gate.

## Change

- **Migration 0058:** adds `resolve_sql_read_grant`, a service-role-only, SECURITY DEFINER function. It resolves a Drishti `connector.read` grant only for `sql` descriptors with `auth = cloud_iam`. On every call it re-reads:
  - workload status and exact SPIFFE ID;
  - grant revocation and expiry;
  - connector, system and estate lifecycle;
  - the descriptor pin;
  - the tenant and global kill switches.

  OAuth descriptors and Karya grants never resolve on this path.

- **`PostgresReadConnector`** (`services/bff/src/connectors/sql/postgres-read.ts`):
  - Each call runs in its own `REPEATABLE READ READ ONLY` transaction, with a `search_path` of `pg_catalog` and a statement and idle timeout bounded by the invocation deadline. The transaction is always rolled back and the session always closed.
  - Before reading anything it refuses:
    - a non-read-only transaction;
    - a superuser role, or one with CREATEROLE, CREATEDB, REPLICATION or BYPASSRLS;
    - any role that holds INSERT, UPDATE, DELETE or TRUNCATE on a visible relation.

    Least privilege is checked, not assumed.

  - `enumerate` lists only relations and columns the role can SELECT, paged by a validated `schema.table` cursor, with column-name category hints.
  - `sample` accepts only a validated identifier that resolves through the catalogue to a relation the role can read. It quotes identifiers, caps rows at 200, and returns only per-column counts (email, Indian mobile, PAN, Aadhaar-like). `read` of raw records is refused.
- **`postgresSessions` and `rdsIamCredentials`** (`session.ts`):
  - The endpoint comes from reviewed configuration keyed by the connector. It must be `ap-south-1` and must carry a pinned CA bundle; TLS uses `rejectUnauthorized`.
  - The password is an RDS IAM token minted for each connection.
  - An unconfigured or non-Mumbai endpoint is refused before any credential is minted.
- **`SqlDiscoveryGate`** (`grant-gate.ts`):
  - verifies the Drishti JWT-SVID;
  - resolves the grant before the session opens and again before results are released, so a revocation between the two checkpoints withholds the result;
  - builds the invocation context from the resolved grant, not from the caller;
  - sets the deadline to the earliest of the SVID expiry, grant expiry and 30 seconds.
- **CI:** a new job, "Live SQL binding (W4.6)", runs the suite against a `postgres:16-alpine` service. `AXIOM_SQL_LIVE_REQUIRED=1` makes a missing database fail the job rather than skip it.

## Evidence

- `tests/database/sql-grant-resolution.test.sql` checks each resolution case:
  - no grant resolves nothing;
  - a cloud-IAM read grant resolves without a vault credential;
  - an OAuth descriptor, a Karya write grant and an unknown workload resolve nothing;
  - a kill switch or archived system blocks resolution, which returns once the input is live again;
  - a revoked grant resolves nothing;
  - `authenticated` cannot execute the function.
- `postgres-read.live.test.ts` runs against a real server:
  - enumeration hides a table without a grant and a schema without usage;
  - samples contain none of the seeded raw values;
  - bad identifiers, injection text, an oversized limit, a malformed cursor and an expired deadline are refused;
  - writer and superuser roles are refused with `write_privilege` and `privileged_role`;
  - DDL inside the transaction fails as read-only;
  - no backend for the role survives the call.
- `session.test.ts`:
  - refuses unconfigured, non-Mumbai, CA-less, malformed or extra-field endpoints before minting any credential;
  - signs a real RDS IAM token offline, checking `Action=connect`, `DBUser` and a 900-second expiry;
  - checks the always-rollback-and-close path, the deadline-bounded timeout, and that an unknown posture fails closed.
- `grant-gate.test.ts`: no session opens without a verified identity or a live grant, and results are withheld when the grant is revoked or changed mid-call.
- Results: BFF 1081 tests pass with the live database, and the database suite passes on fresh migrations.

## Not delivered (remaining W4.6 scope)

- A reviewed store for `endpointRef → SqlEndpoint` configuration, and an agent-runtime route that invokes the gate. Discovery is an internal library today.
- Live acceptance against RDS staging in `ap-south-1` (operator, provisioning not authorized). This needs a database role with `rds_iam` and SELECT only, and the pinned RDS CA bundle.
- MySQL.
- Persisting discovery results into the estate inventory and category suggestions.
