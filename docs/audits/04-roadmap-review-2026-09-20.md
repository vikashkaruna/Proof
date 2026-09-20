# Axiom Proof — independent roadmap and implementation review

**Reviewed:** 20 September 2026. **Reviewer:** Codex. **Verdict:** meaningful W0/W1 progress, but W1 is not closed and the build is not ready for production client execution.

## Scope and evidence boundary

Compared Docs 02, 03, 04 and 11, the prototype handoff map, architecture segregation guidance, migrations, deployment definitions, agent implementations and Claude's changes. This is a review and documentation change, not implementation authorisation. Instructions embedded in the documents are treated as historical planning context; the current user request governs this task. Existing additions and explicit TODOs are treated as intentional scope, not automatically as deviations.

| Snapshot                   | Evidence                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Documentation checkout     | `docs/phase0-5-gap-closure-plan` at `12bd02e`                                                                                 |
| Original code baseline     | `9575205`                                                                                                                     |
| Reviewed implementation    | `claude/phase-0-5-gap-closure-5fd349` at `2c54fcd`                                                                            |
| Implementation worktree    | `.claude/worktrees/phase-0-5-gap-closure-5fd349`                                                                              |
| Uncommitted implementation | `packages/types/src/enums.ts`, `packages/types/src/rbac.ts`, new `infra/supabase/migrations/0015_user_role_axiom_analyst.sql` |
| Local refs observed        | `origin/staging` and Claude's remote-tracking ref at `2c54fcd`; local `main`, local `staging`, `origin/main` at `9575205`     |
| Concurrent work            | User confirmed Claude stopped because its session limit was reached                                                           |

Remote-tracking refs were inspected locally, not refreshed from the server. No deployed service, real customer data, cloud configuration, migration application or CI run was independently inspected. File references below refer to the implementation worktree at this snapshot unless stated otherwise. SQL findings are established by source inspection, not a live exploit demonstration.

## Findings requiring closure

### R-01 · P0 · Users can grant themselves internal authority

`infra/supabase/migrations/0001_init_tenants_users.sql:15` grants broad table privileges. `users_insert_self` at line 204 and `users_update_self_or_axiom` at line 207 restrict identity but do not protect `is_axiom_internal`. An authenticated user can supply that field when inserting their own profile or update it afterward. `is_axiom_internal()` is then trusted by many tenant policies. No later reviewed migration removes this path.

**Impact:** switching web pages to user-scoped clients does not establish tenant isolation while the client can promote itself to an identity exempted by RLS. This is inherited from the baseline, not introduced by W1; the plan's repeated assertion that the database policies are already correct must be withdrawn.

**Close in W0/W1:** restrict profile writes to safe columns or a narrow service operation; reserve internal identity and role assignment to an audited operator workflow. Prove direct SQL/PostgREST self-insert and self-update attacks fail, and prove tenant A cannot read tenant B afterward.

### R-02 · P0 · Write policies check the selected tenant's role, not the target row's tenant

`current_tenant_roles()`/`has_role()` in migration 0001 use the JWT tenant claim. `tenant_users_modify_axiom_or_owner` (line 221), tenant updates and action/plan write policies in migration 0004 do not bind that check to the row's `tenant_id`. With a valid tenant A owner claim, a write may satisfy the policy for tenant B too. Without the expected claim, legitimate writes may instead fail. Broad internal overrides also contradict the plan's assigned-tenant boundary for analysts.

**Close in W1/W2:** row-bound membership and capability checks, explicit `WITH CHECK`, restricted privileged role assignment, protected safety/status columns and cross-tenant FK integrity. Add a role × tenant × operation matrix against real Postgres and direct REST access. Do not copy the 0003/0004 policies to new tables without correcting them. Test `axiom_analyst` without granting a blanket internal bypass.

### R-03 · P0 · Generic agent invocation bypasses both role and tenant binding

`services/bff/src/routes/v1.ts:1738` registers `/agents/:name/run` without `AGENT_INVOKE` authorisation. At the construction of `input`, `...body` follows the trusted `tenant_id`, so the caller can overwrite the runtime tenant while the BFF records the run against the header tenant. The route accepts all ten agents, including Karya and internal-only Sanket. A viewer can reach this route despite the capability matrix denying agent invocation.

**Close in W1:** validate a typed payload; derive tenant and permitted engagement from authenticated context after parsing; reject conflicting identifiers; enforce role and per-agent scopes. Keep Karya behind the durable execution gate, not a generic invocation route. Tests must cover viewer denial, foreign tenant/engagement IDs and direct Karya invocation. Also enforce the declared policies on `/ledger/verify`, ledger reads and `/plans/:id/execute` or explicitly define a separate token-authorised machine principal.

### R-04 · P1 · Multi-action execution conflicts with the database schema

`0004_remediation_actions.sql:116` declares `idempotency_key text unique`. The execute route around `v1.ts:1169` assigns the same request key to every accepted action. A real batch with two actions conflicts with that uniqueness constraint. The token is consumed before this update, so the failure also spends the token without scheduling execution.

**Close in W2/W5:** separate request/batch identity from per-action execution identity; design scoped unique keys and retry semantics. Make token consumption, execution claims, ledger intent and durable outbox atomic. Acceptance: two-action batch, retry, concurrent retry, crash after consumption and partial selection all behave correctly on real Postgres. Fake PostgREST tests do not model these constraints.

### R-05 · P1 · The BFF/runtime execution contract is incompatible

`v1.ts` sends camelCase keys to `/internal/execute`; `services/agent-runtime/src/axiom/app.py:195` requires snake_case fields and has no aliases. The BFF neither checks `response.ok` nor durably queues a retry; transport failures are logged after consuming the token. The runtime endpoint remains an intent-only stub.

**Close in W5:** version and contract-test the payload, validate acceptance, persist an outbox/workflow ID, and expose failed dispatch rather than successful execution. Add a real BFF-to-FastAPI contract test before connector execution.

### R-06 · P1 · The citation fix has not reached the runtime or publication pipeline

TypeScript `controls.ts:28` is `0.1.1`, but `services/agent-runtime/src/axiom/data/controls.json:2` is still `0.1.0`. Parikshan calls `load_default_library()`; the runtime Dockerfile copies this JSON without regeneration. The public BFF gap-scan route also writes a literal `0.1.0`. Existing immutable assessments must retain their pinned version, but new assessments need the deliberately published version consistently.

Migration 0011 creates baseline/provenance tables; `buildLibrarySeed()` and `packages/control-library/scripts/seed.ts` do not populate them or attach the declared baseline. Instrument and baseline hashes are nullable. The metadata uses `verifiedBy: 'Axiom Minds · Founder'`, but no human verification record was established in this review. An attributed string is not proof of human review.

**Close in W7:** deterministic TS-to-Python generation plus drift gate; version-aware lookup; immutable publication transaction with source bytes, hashes and per-control provenance; actual named reviewer sign-off. Test pinned old assessments and new-version assessments independently. W7.1 is a source-code correction, not yet a verified published end-to-end fix.

Use primary sources for the publication evidence: [MeitY Rules and corrigendum index](https://www.meity.gov.in/documents/act-and-policies/digital-personal-data-protection-rules-2025-gDOxUjMtQWa?pageTitle=Digital-Personal-Data-Protection-Rules-2025) and [official Rules PDF](https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf). These were located during review. This review does not certify every legal citation, commencement date or any claimed later deadline proposal. Keep proposed changes out of the operative baseline until verified against an official instrument.

### R-07 · P1 · Mandatory MFA configuration is absent from deployment wiring

`packages/config/src/index.ts:316` requires `AXIOM_MFA_ENCRYPTION_KEY` in deployed environments. The reviewed Compose, Cloud Run Terraform, Helm and environment examples contain no provisioning/injection for it. Deployment from these definitions cannot be assumed to boot successfully. This is distinct from whether an operator manually injected a secret into an existing deployment, which was not inspected.

**Close in W1/W0:** document and inject the key for every service that calls the shared validator; minimise secret distribution with service-specific validation where appropriate. Define rotation and recovery of encrypted factors. Boot a clean strict environment from the documented configuration, without printing secrets.

### R-08 · P1 · MFA and approval bindings need a complete threat boundary

TOTP, recovery codes, session attestations and single-use step-up are implemented and tested. Email OTP is not implemented despite W1/E.1 promising it. Migration 0012 describes self-managed TOTP as a founder decision: preserve that implementation choice rather than reverting it merely because the old plan says Supabase MFA.

Only founder MFA is unconditionally required; owner/approver requirements live in a mutable tenant array. The per-challenge attempt limit in `mfa.ts:761` can be reset by creating another challenge; no account-wide issuance/guess budget was found. `approvalBindingSha256()` binds plan ID, action IDs and mode, but not the version/content the human reviewed. The token includes concurrency and stop-on-failure, while the execute route forwards the request's values without comparing them to the signed values. Nullable dry-run expiry also passes the gate.

**Close in W1/W5:** record the intended role MFA policy; provide account/session/IP challenge budgets and revocation tests; pin plan/action/diff/rollback hashes and all execution conditions; enforce signed settings at dispatch; reject missing/invalid/expired dry-run expiry. Do not weaken MFA to make tests or deployments green.

### R-09 · P1 · Shared kill-switch state is not proof of stopping in-flight work

The new database state and fail-closed BFF reads are good progress. No kill-switch checks were found in the Python runtime/executor/Temporal execution loop. BFF request admission alone cannot stop an already running action or batch, and the current Karya stub cannot validate this guarantee.

**Close in W5:** define measurable stop latency and connector safe-interruption behaviour; check shared state before every mutation and between bounded chunks; cancel queued work and propagate stops across replicas. Keep SEC-4 partially open until a live controlled batch halts and is audited.

### R-10 · P1 · Storage parity does not yet establish immutable evidence

`infra/terraform/envs/preprod/storage.tf:25` deliberately sets `is_locked = false`. `packages/evidence/src/index.ts:225` skips lock validation for GCS, while seal metadata reports `COMPLIANCE`. This is an existing non-production arrangement, but contradicts claiming production-equivalent retention enforcement or proven WORM behaviour.

**Close in W0/W8:** explicitly distinguish unverified/test evidence from sealed compliance evidence. Validate the deployed provider's actual retention mode, deletion/overwrite denial and inability to shorten retention; establish equivalent hard-rule guarantees before asserting parity. Locking a real bucket is irreversible and requires a separate concrete deployment decision; no lock change was attempted in this review.

### R-11 · P1 · Planned verification gates are not yet implemented

The targeted unit suites are useful, but the BFF fixtures do not execute SQL policies or constraints. `.github/workflows/ci.yml` has no real-Postgres RLS, strict-environment parity or Playwright job, and no enforced coverage floor. It triggers for main pushes/PRs, not staging pushes. BFF lint is still an echo; several package tests retain `--passWithNoTests`; Python audit is allowed to fail. These are gaps against W9, not evidence that every existing test is inadequate.

**Close in W9:** gate the actual release path on fresh-install and upgrade migrations, direct RLS adversarial tests, API contract tests, strict persona E2E, and the eight PRD B.10 scenarios. Publish the commit, environment, command and result for each claim of completion.

## Roadmap and plan corrections

1. **Intentional additions preserved:** universal connection framework, SPIFFE, optional outbound MCP, inbound MCP removal, single connector identity, ER graph, reconciliation, regulatory baseline and on-prem work. These are recorded plan decisions. Splitting work into smaller deliverables is a recommendation, not cancellation of scope.
2. **Missing delivery ownership:** consent/withdrawal and EN/HI, DSAR verification and fulfilment, breach operations, classification correction feedback, general founder output review, RoPA/policy/playbook persistence, SMB self-service, TPRM, DPIA and full partner workflows need build-and-test work packages, not just table names or rows in a gap register.
3. **Phase 5 must remain visible:** enterprise SSO is not connector SAML token exchange. Split-plane, SLAs, certifications, second sector, Consent Manager registration and L4 each retain the roadmap's commercial/safety gates. Pulled-forward W10 does not silently remove those gates from other modules.
4. **Non-functional delivery:** per-tenant keys, India residency across backups/logs/telemetry/providers, TLS/at-rest settings, availability, RPO/RTO drills, report latency, discovery throughput, cost/ACV tracking and explainability need evidence owners. Unit tests do not establish these.
5. **Internal contradictions:** W5 starts after W4.4 (not W4.3); REST/OpenAPI is primary (not the stale E.1 MCP-primary text). Migration numbers 0009–0014 are already occupied. Global regulatory reference tables and user-scoped MFA tables are exceptions to the blanket tenant-column instruction.
6. **Status corrections:** Sanket explicitly returns an empty stub result, so M4.9 is pending. Typed plans and an approval console are partial foundations, not proof of Phase 3 delivery. The roadmap's master index omits M1.8 Delivery Playbook; track modules by their phase-table IDs instead of the advertised master total.
7. **Boundary decisions:** GCP/Mumbai deployment is an existing direction; the AWS-only wording in older hard rules needs a recorded provider-equivalence decision, not an inferred weakening of residency/WORM. Marketing currently writes through `gap-scan-store.ts` and owns server workflows; assign migration to the BFF if enforcing the segregation skill's API-only write rule. User-scoped SSR reads are deliberately specified in W1 and should not be reclassified as browser database access.
8. **Brand:** gold write-access graph edges conflict with the reserved sealed-proof colour. Use teal/indigo plus a write/lock label; reserve gold for sealed evidence/attestations. Hindi labels in a prototype are not working localisation.

The updated Doc 11 and [module handoff](../13_Roadmap_Traceability.md) turn these omissions into explicit pending or gated work. Original commercial phase exits remain applicable; no customer/revenue achievement can be inferred from a code repository.

## Verification performed

All commands ran in Claude's implementation worktree, including its uncommitted analyst changes. They were not run against the older documentation checkout's source.

| Check                                                                                     | Result                                                                                                                                |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @axiom/types test` (within initial filtered run)                           | **28 pass, 2 fail**: cross-tenant roles and workbench roles expected lists omit `axiom_analyst` (`rbac.test.ts:118,122`)              |
| `@axiom/config` tests                                                                     | 41 pass                                                                                                                               |
| `@axiom/approval-engine` tests                                                            | 13 pass                                                                                                                               |
| `@axiom/control-library` tests                                                            | 66 pass                                                                                                                               |
| `@axiom/mfa` tests                                                                        | 144 pass                                                                                                                              |
| `@axiom/bff` tests                                                                        | 114 pass                                                                                                                              |
| `@axiom/web` tests                                                                        | 31 pass                                                                                                                               |
| Types/BFF/web typecheck                                                                   | Pass                                                                                                                                  |
| `pnpm gate:security` and `pnpm gate:controls`                                             | Pass; these static gates do not establish RLS/runtime citation parity                                                                 |
| Agent runtime `uv run pytest -q`                                                          | 61 pass; local Python 3.14.6, not the deployment image's 3.11                                                                         |
| Disposable SQL reproduction attempt                                                       | Could not start: `initdb` reported missing `postgres` server binary beside the installed libpq tools. No database started or modified |
| Real RLS, migrations, strict persona E2E, build, deployed parity, cloud WORM, performance | **Not verified in this review**                                                                                                       |

Reproduction command for remaining targeted suites: `pnpm --filter @axiom/bff --filter @axiom/web --filter @axiom/mfa --filter @axiom/control-library --no-bail test`. The initial multi-package run stopped at the types failure; remaining packages were run separately and their results are recorded above.

No application code, schema, infrastructure, remote branch or deployed service was changed by this review. Existing dirty files were preserved.
