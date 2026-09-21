# W4.1 connector registry and lifecycle review — 22 September 2026

Baseline: staging `c79c303` (CI 35647963475 green), with no newer upstream work. Reviewed the original phase plan/BRD/architecture and current gap plan before implementing. The user's current priority advances W4.1 dependencies ahead of deferred W0/W1 items.

## Findings addressed

- `/connectors` asserted hardcoded connected infrastructure, health/access and residency. It now renders tenant-scoped registrations and latest recorded health with explicit absence/provenance. No invented live access is shown.
- 0033 was a database foundation, without a registry, strict descriptor contract or human lifecycle boundary. BFF now owns reviewed catalogue publication and mutations; SSR uses RLS-scoped reads and the browser uses the existing authenticated proxy.
- A lifecycle API must serialize with parent archival, invalidate stale edits and prevent re-enabling old grants. 0038 repeats/locks membership and orders parent/resource locks; disable revokes grants and archive revokes credential envelopes in the audit transaction.
- TypeScript/Python YAML implementations interpret some scalars differently. Shared catalogue fixtures and strict numeric/boolean rules prevent ambiguous descriptor interpretation. Both reject aliases/tags/duplicates/unknown fields; manifests carry no addresses or secrets.

A compiled-entry-point smoke check found the YAML catalogue absent from `dist`. The BFF build now copies the reviewed descriptor assets; both source and compiled registry imports are checked. Docker acceptance on the first implementation commit uses the established source entry point; final merge CI covers the packaging correction.

## Implementation boundary

Human registration is inventory management, not an agent action against a client system. No connector executes, no target identity is provisioned, and no token is minted by this milestone. ReadConnector and WriteConnector are separate interfaces; context fields are not authority. W4.2–W4.4 must authenticate the workload and re-check the live descriptor, connector, parents, grants, scopes and approval on every invocation. Future transports must reject non-production writes even if an old metadata row suggests otherwise.

The catalogue contains two immutable PostgreSQL descriptor definitions (production and reference-mock). These are declarations for future transport bindings, not tested working adapters. Legacy descriptor rows are preserved and may be disabled/archived; unknown or changed pins cannot be enabled through the API. Trusted service-role seed paths remain privileged; browser roles cannot invoke the lifecycle RPC or write tables.

## Evidence

- SQL: atomic lifecycle/audit, stale/foreign/demoted refusal, immutable publication, parent archive guards, revoke/no-resurrection, terminal archival and audit-failure rollback.
- Concurrent sessions: actual lock contention in both estate archive/connector enable orderings; the conflicting second action refuses.
- Populated upgrade from 0037: existing registration fields retained, version initialized, no inferred grants. Fresh series has 39 migrations through 0038, with no new tables.
- BFF/TS/Python: strict catalogue and role/tenant/request validation, error sanitization and separate interfaces. 362 BFF tests, 118 Python runtime tests and workspace TS/lint/typecheck/format pass before the committed acceptance lane. New Python files pass Ruff; an additional whole-runtime Ruff audit reports 65 pre-existing findings in unrelated files, outside the configured CI gate. The added YAML dependency was upgraded to patched 2.8.3 after audit flagged 2.8.2; production dependency audit then reports no known vulnerabilities.
- Real-Auth API and browser journeys: lifecycle/replay, non-secret references, non-production label, unknown health, disabled edits, terminal archival, tenant isolation and lost-response retry. Exact committed container/CI outcomes are saved in the private checkpoint; pending or failed runs do not establish closure.

Next implementation: W4.2 broker/vault/rotation, then W4.3 identity and W4.4 grants; complete W3 wizard/graph on those enforced boundaries. W4 execution and the full W3 roadmap remain open.

The first container browser run on `0e14602` was not green: a generic alert selector counted Next's empty route announcer, and `getByLabel` could not match the implicit label containing option text despite a visible, correctly named combobox. Tests now use the accessible combobox role and scope alerts to main content. The owner fixture is tenant-A-only, so a forged B preference is expected to be ignored and an explicit B API request refused. These fixture corrections retain strict auth and zero retries; the complete lane must be rerun.
