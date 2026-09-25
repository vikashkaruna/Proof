# Revision 87 — Discovery route and persisted discovery runs (W4.6/W4.7)

## Scope and assumptions

This closes the shared W4.6/W4.7 gap: the endpoint configuration and an invocation route for the SQL, REST and GraphQL read adapters, plus persisting what discovery found. Operator input was not received. The assumptions are:

1. **Configuration, not a database store.** Endpoints are reviewed deployment configuration, the same model as the credential broker's pinned endpoints. They are never tenant-editable rows, request fields or operator-supplied URLs.
2. **An internal route.** Discovery is called by the Drishti workload, not by a browser. It follows the `/internal/workload-tools` pattern: it is off unless a trusted process controller supplies the service, it is authorized only by the workload SVID, and it is kept out of request logs.
3. **No unrecorded agent action.** A run is persisted and audited before its result is returned. If recording fails, the result is withheld.
4. **Metadata only.** The database itself refuses any stored result containing a string leaf that is not a short identifier-like token, or any non-integer number. This is defence in depth behind the adapters, which already emit only names and counts.

## Change

- **Migration 0059:**
  - the `connector_discovery_runs` table: append-only, with tenant-member and service reads only;
  - `record_connector_discovery`, which checks all of:
    - the grant is live, belongs to Drishti, is a read grant, and matches the tenant and connector;
    - the SVID matches the active workload;
    - the operation and resource agree;
    - the result is bounded to 1000 records and 256 KiB, and passes `discovery_result_is_metadata`;
  - ledger action `connector.discovery.completed`, recording actor `agent/drishti` and a hash of the result.
- **`@axiom/types`:** `LedgerActionType.CONNECTOR_DISCOVERY_COMPLETED`.
- **`DiscoveryService`** (`services/bff/src/connectors/discovery.ts`):
  - validates the request schema;
  - looks up the descriptor through the connector's stored id in the reviewed catalogue;
  - runs SQL through `SqlDiscoveryGate.discover`, which now returns the grant;
  - runs REST/GraphQL with a broker-acquired token, resolving the grant before and after the call;
  - records the run, then returns it.
- **`POST /internal/discovery/run`** (`routes/discovery.ts`): off by default (503), requires the `x-workload-svid` header, refuses a query string or a non-JSON body, returns a uniform `discovery_refused`, and is excluded from the request logger.

## Evidence

- **`tests/database/connector-discovery-runs.test.sql`:**
  - recorded and audited: metadata enumerate and sample runs;
  - refused as invalid results: an email value, free text, a decimal, and a sample with no resource;
  - refused as a workload mismatch: a different workload;
  - refused as an inactive grant: a Karya write grant, a revoked grant, and a cross-tenant record;
  - refusals are not audited as success;
  - updating or deleting a run is denied, and `authenticated` cannot execute the function.
- **`discovery.test.ts`:**
  - SQL and REST discovery each record before returning, and the recorded REST result contains no raw value;
  - a failed recording withholds the result;
  - unconfigured endpoints, inactive connectors, malformed requests and non-Mumbai SQL configuration are refused;
  - the route denies by default, requires the SVID header, refuses query strings, and hides refusal reasons.
- **Results:** BFF 1089 tests pass (the 5 live SQL tests run in CI), types 45, the database suite passes on fresh migrations, and lint, typecheck and format are clean.

## Not delivered

- A process-controller composition that enables the route in a deployment. This needs a SPIRE trust source and broker KMS configuration, which are operator-owned.
- A web view of discovery runs.
- Automatic category suggestions into `system_data_categories`, which are still human-confirmed.
