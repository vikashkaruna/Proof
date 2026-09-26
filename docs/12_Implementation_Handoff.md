# Axiom Proof — implementation handoff

## Session close-out and handoff — Revision 91 (2026-09-26)

**Where to continue:**

- Work from branch **`codex/revision75-controller-generation-transition`**, cut fresh from `origin/staging` (currently at Revision 90, merge commit `5ad1adc` of PR #62; Revision 91 is this branch's open PR).
- Open every PR into **`staging`** with a merge commit, and merge only when all checks are green.
- **Promotion to `main` is paused by the operator.** Main was last promoted at Revision 84 (PR #55, 52 checks green). Staging is ahead with Revisions 85–90 (PRs #61, #62 merged); Revision 91 lands via this branch's PR. Promote only when the operator asks, using a staging → main PR merged with a merge commit.
- To start: `git fetch origin staging && git checkout -B codex/revision75-controller-generation-transition origin/staging`.

**State at close:**

- Schema is **0000–0062: 63 migrations, 66 public tables** (Rev 89 added the five W5 execution-detail tables; Rev 90 the executor's four functions; Rev 91 the rollback function). The next migration is **0063**; never edit an applied migration.
- Latest audit is **79**.
- No PRs are open and no check-ins are scheduled.

**Build and test status** (staging, PR #56 head `bc176d5`, 21 of 21 CI checks green):

| Suite                                 | Result                                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| BFF (vitest)                          | 1112 passed, plus 5 live PostgreSQL tests that run in the "Live SQL binding (W4.6)" job |
| Web                                   | 89                                                                                      |
| MFA                                   | 180                                                                                     |
| Control library                       | 83                                                                                      |
| Config                                | 68                                                                                      |
| Types                                 | 45                                                                                      |
| Evidence                              | 19                                                                                      |
| UI                                    | 17                                                                                      |
| Approval engine                       | 13                                                                                      |
| Supabase                              | 11                                                                                      |
| Ledger                                | 8                                                                                       |
| Marketing                             | 6                                                                                       |
| Database suite                        | Fresh migrations with `service_role nobypassrls`, every `tests/database/*.test.sql`     |
| Browser persona journeys (W1)         | Green, including the tool-registry, PNG/SVG export and grant journeys                   |
| SPIRE (W4.3)                          | Isolated, protected-host and native-runner jobs green                                   |
| Strict Auth/PostgREST parity          | Green                                                                                   |
| Container API/browser acceptance (W0) | Green                                                                                   |
| Python                                | Agent runtime, temporal workers and model gateway suites green                          |
| Security                              | CodeQL, Bandit, Trivy, semgrep and gitleaks green                                       |

The local gate `scripts/security-scan.sh` runs on the husky pre-push hook.

**Operator decisions in force (2026-09-25):**

1. The three held historical secrets stay held, not ignored, until the operator confirms rotation. They are two JWT secrets in `infra/docker/docker-compose.supabase.yml` (commit `7719f0c`) and `APPROVAL_SIGNING_KEY` in `infra/docker/environments/.env.preprod.example` (commit `7631b1f`).
2. `main` branch protection is done.
3. Stale branches are deleted together after plan completion.
4. Dependabot #32–36 are closed out and their updates landed via PR #57. `tailwindcss` 4 and ESLint 10 are held back: the major-version migration and `scopeManager.addGlobals` breakage respectively.
5. `saml2_bearer` is a TODO, not a blocker.
6. Sector pack #1 will be chosen when W7 is reached.
7. Promotion to `main` is paused.

When operator input is missing, take the recommended option and record the assumptions in the revision's audit.

**Standing constraints:**

- Never provision or apply cloud resources.
- Keep all of the following:
  - tenant-bound approval with dry-run and validated rollback (BR-2);
  - Sudhaar holds no write credentials;
  - the append-only ledger, written only via `append_ledger`;
  - WORM Compliance mode;
  - `ap-south-1` data locality.
- Never print credentials.
- Every new ledger action must also be added to `LedgerActionType` in `packages/types/src/enums.ts`, or the compatibility test fails.
- E2E workload fixtures use `registerWorkload()`. The `manage_workload_identity` RPC is the only registration path.

**Recommended next order:**

1. **W5 execution loop (XL):** an executor that consumes the dispatch outbox under a signed token, a dry-run simulator, rollback, and post-verification. It adds the 5 execution-detail tables, with PRD B.10 as the acceptance criteria. Its write path needs a W4.6/W4.7 write adapter bound to the approved plan.
2. **W6 continuous compliance (XL):** scheduler and scheduled drift and discovery, reusing `onboarding_estate_drift` and `/internal/discovery/run`; standing policies; monitor health; 4 tables.
3. **W8 rights, consent, breach, and review/release (XL).**
4. **W7 multi-regulator tables and packs (L)**, which needs the sector pack #1 decision.
5. **W9 performance and restore drills, and W10 on-prem (L each)**, which need a deployment.

Smaller leftovers:

- MySQL SQL binding;
- an RDS staging acceptance run (operator);
- vendor-verified descriptors (need client tenants);
- `saml2_bearer`;
- W3.5 derivation edges (need a lineage model), live updates and branded export;
- a web view of discovery runs;
- five web screens that still fabricate values (queued task);
- the unused `SUPABASE_SERVICE_KEY` in the Helm web and marketing charts;
- Bandit medium findings in the test-harness SQL.

**Revision 91 — the rollback engine (GLM session):**

M3.5 lands: migration 0062 adds `record_rollback_execution`, the only write path into `rollback_executions`. It executes Sudhaar's stored definition — re-read and compared against the row (`definition_mismatch`), so a reconstructed definition cannot be reversed with — and only against an action the batch actually completed and only once (`action_not_reversible`), with batch membership enforced (`batch_mismatch`). The action lands `rolled_back` with the definition hash computed server-side, and both ledger phases (`execution.rollback.started`/`completed`) commit atomically with the record. The rollback pass in the executor runs in reverse order over the batch's completed actions when a failure fires with stop-on-failure armed, kill-switch-checked per rollback (the stop outranks the undo), and every rollback is simulated before it is executed: an unsimulable definition is never executed. A rollback that itself fails leaves the batch `partial_failure` with the action honestly `failed` — an applied change whose undo failed is the one state that must never be rendered clean. Governor and kill-switch halts escalate without auto-rollback: automatic further mutation during an incident is refused by design. See [audit 79](audits/79-rollback-engine-review-2026-09-26.md). Schema is **0062 / 63 migrations / 66 public tables**. Next in plan order: post-execution verification (M3.7) and the maker-checker reconciler (W5.6).

**Revision 90 — the durable executor (GLM session):**

`/internal/execute` no longer refuses: the executor consumes the dispatch outbox's claimed batches and records everything through migration 0061's SECURITY DEFINER functions — `start_execution_batch` (which enforces the two structural guarantees at the database: executed actions are a subset of the approved token's `action_ids`, and the content digest is recomputed over the stored rows and matched against the token's signed snapshot), per-action start/settle, and `finish_execution_batch` with the sweep that returns unsettled actions to `approved`, retryable only under a fresh approval. A redelivery under the same request key replays the recorded batch instead of re-executing; the same key with a different payload is a conflict. The executor loop owns the kill switch's two checks, stop-on-failure, bounded concurrency and the SEC-7 blast-radius governor: an affected count above the declared one fails `blast_radius_breach` and halts the batch. Execution goes through a write-adapter seam whose only shipped implementation is the bounded reference write transport; with no write origin configured the route refuses `execution_unconfigured` rather than improvising a target. Ledger entries commit inside the RPCs, so every state change and its audit entry appear together or not at all. See [audit 78](audits/78-executor-review-2026-09-26.md). Schema is **0061 / 62 migrations / 66 public tables** (no new tables; four executor functions). Next in plan order: the rollback engine (M3.5), post-execution verification (M3.7) and the maker-checker reconciler (W5.6).

**Revision 89 — W5 foundation: the dry-run engine and the five execution-detail tables (GLM session):**

Migration 0060 creates the five W5 execution-detail tables — `dry_runs`, `execution_batches`, `rollback_executions`, `verification_results`, `plan_reconciliations` — tenant-bound with RLS, composite tenant-consistent foreign keys and no direct write path, plus `record_dry_run`, the M3.2 engine's SECURITY DEFINER write path. A dry-run is bound to exactly the stored action content (the RPC re-reads the row and refuses anything else), a success sets the 24-hour freshness gate, and a refusal — `custom` and unknown action types are never simulable — is recorded as an outcome that invalidates any earlier success. The simulator (`axiom/dry_run.py`) renders structured field-level diffs from declared parameters only and invents nothing: an undeclared record count stays null. `POST /internal/dry-run` records before it returns; the BFF routes `POST /v1/plans/:id/dry-run` and `GET /v1/plans/:id/dry-runs` report recorded/refused/unavailable per action, and the payload is pinned to `tests/contracts/dry-run.v1.json` from both sides. `plan_reconciliations` carries a constraint that `out_of_scope` must be empty: out-of-scope execution is a defect to fail on, not a finding to store. See [audit 77](audits/77-dry-run-engine-review-2026-09-26.md). Schema is **0060 / 61 migrations / 66 public tables**; the next migration is **0061**. Next in plan order: the W5 executor (M3.4) consuming the dispatch outbox under the signed token, then rollback (M3.5), post-verification (M3.7) and the reconciler (W5.6).

**Revision 88 — tool registry UI and PNG graph export (Claude cloud session):** the onboarding setup page gains a **Connector tools** card. It lists each active connector's registered tool versions, with their class and the first characters of the pinned description hash, and offers connector managers an append-only registration form. Registering still authorizes nothing; use needs a live grant whose scope matches the tool's class. The estate graph adds **Export PNG**: the same SVG rasterised at 2x in the browser, alongside Export SVG. Browser journeys now register a read tool through the page, check that a write tool on a reference binding is refused with 409, and check that both exports download. W3.5 still open: derivation edges (these need a data-lineage model and are recorded as a W6/W8 dependency), live updates, and branded export. No migration was added.

**Revision 87 — W4.6/W4.7 discovery route and persistence (Claude cloud session):** migration 0059 adds `connector_discovery_runs`, which is append-only and readable by tenant members. It also adds `record_connector_discovery`, which requires the live Drishti read grant, the matching active workload and a metadata-only result (short identifier-like strings and integers; emails, free text and decimals are refused), and audits the run as agent `drishti` with ledger action `connector.discovery.completed`. `DiscoveryService` takes the descriptor from the reviewed catalogue through the connector's stored descriptor id. It uses the SQL cloud-IAM gate or, for REST/GraphQL, a broker token, and re-resolves the grant around each call. Endpoints come only from reviewed deployment configuration keyed by tenant and connector, and SQL endpoints must be `ap-south-1`. **A result is returned only after it is recorded.** `POST /internal/discovery/run` is off (503) unless a trusted process controller supplies the service. It is authorized by the `x-workload-svid` header, never by a session or query string, and is kept out of request logs; the caller learns only `discovery_refused`. See [audit 76](audits/76-discovery-route-review-2026-09-25.md). **Operator decisions recorded (2026-09-25):** (1) the three held historical secrets stay held until the operator confirms rotation; (2) `main` branch protection is done (offline); (3) stale branches are deleted together after plan completion; (4) Dependabot #32–36 were already closed unmerged and are now **closed out**, re-raised as one staging PR, with `tailwindcss` 4 and ESLint 10 held back; (5) `saml2_bearer` is a **TODO**, not a blocker; (6) sector pack #1 is to be chosen when W7 is reached; (7) promotion to `main` is **paused**: work lands in staging, green, and main is promoted later. Schema is **0059 / 60 migrations / 61 public tables**; the next migration is **0060**. Next: W3.5 remainder and the tool registry UI, then W5.

**Revision 86 — W4.7 GraphQL read transport (Claude cloud session):** the manifest schema gains a `graphql` block. Each resource declares a root field, a page-size argument, an optional cursor argument and path, an items path, and up to 100 dotted field selections. It is required for `graphql` descriptors and forbidden for all other transports. `GraphqlReadConnector` generates the only query it sends, `query AxiomDiscovery(...)`, from those validated names. Values travel as variables; no descriptor or caller supplies query text, and no mutation can be expressed. It shares REST's bounded JSON transport (HTTPS origin, broker bearer token, no redirects, deadline timeout, 1 MiB cap). A response carrying GraphQL `errors` is refused without echoing it. `enumerate` reports observed and missing declared fields, `sample` returns value-shape counts only, and raw `read` is refused. The evidence runs against a loopback GraphQL reference server; see [audit 75](audits/75-graphql-transport-review-2026-09-25.md). Still to do in W4.7: `saml2_bearer` (this needs an XML-DSig signing dependency and a review decision), vendor-verified descriptors, and endpoint configuration plus invocation routes. No migration was added; schema stays at **0058 / 59 migrations / 60 public tables** and the next migration is **0059**.

**Revision 85 — W4.7 REST/OpenAPI read transport and reference descriptor pack (Claude cloud session):** the manifest schema gains `provenance` and a declarative `rest.resources` block. It holds literal GET paths, an items pointer, a page-size parameter and an optional cursor; there is no templating, query text or code. `RestReadConnector` calls only declared resources, on an HTTPS origin, using the broker's bearer token. It allows no redirects, uses deadline-bound timeouts, and accepts only JSON under 1 MiB. `enumerate` returns field paths and `sample` returns value-shape counts; values and tokens never leave the adapter, and raw `read` is refused. The CRM, HRMS, data-warehouse, ticketing and code-repository descriptors ship with **reference** provenance on `reference-mock`, and are exercised over real HTTP against the reference service. Operator input was not received; see [audit 74](audits/74-rest-transport-review-2026-09-25.md). Still to do: GraphQL, `saml2_bearer`, vendor-verified descriptors (these need client tenants), and endpoint configuration plus invocation routes (shared with W4.6). No migration was added; schema stays at **0058 / 59 migrations / 60 public tables** and the next migration is **0059**. Next in plan order: finish W4.7 (GraphQL and `saml2_bearer`), then W5.

**Revision 84 — W4.6 first real SQL binding, read side (Claude cloud session):** migration 0058 adds `resolve_sql_read_grant`, which resolves a Drishti read grant only for cloud-IAM `sql` descriptors and re-reads every lifecycle input and the kill switch on each call. `PostgresReadConnector` runs each call in a rolled-back `READ ONLY` transaction with deadline-bounded timeouts, and refuses privileged roles or any role with write privilege before reading. `enumerate` returns visible relations and columns with category hints; `sample` returns only counts of value shapes, never values; raw `read` is refused. `postgresSessions` allows only `ap-south-1` endpoints with a pinned CA and verified TLS, using a 15-minute RDS IAM token per connection. `SqlDiscoveryGate` verifies the SVID and re-resolves the grant before and after each call. A new CI job, "Live SQL binding (W4.6)", runs against a real PostgreSQL 16. Operator input was not received; assumptions and remaining scope are in [audit 73](audits/73-first-sql-binding-review-2026-09-25.md). Still to do: endpoint configuration store, invocation route, RDS staging acceptance (operator), and MySQL. Schema is **0058 / 59 migrations / 60 public tables**; the next migration is **0059**. Next in plan order: W4.7 REST/OpenAPI and GraphQL transports.

**Revision 83 — W4.5 internal tool registry (Claude cloud session):** migration 0057 adds `register_connector_tool`, which is audited and append-only, makes read/write classification mandatory, and allows no write tools on sandbox bindings. It also adds `verify_connector_tool`, which rejects a tool unless its description matches the SHA-256 pinned at registration. `ToolRegistry` in the BFF refuses unregistered, reclassified or changed tools, and any tool whose class does not match the lease scope. `GET` and `POST /v1/connectors/:id/tools` expose it. See [audit 72](audits/72-internal-tool-registry-review-2026-09-24.md). Schema is **0057 / 58 migrations / 60 public tables**; the next migration is **0058**. Next in plan order: W4.6, the first real SQL binding.

**Revision 82 — W4.4 grant issuance and enforcement (Claude cloud session):**

- Migration 0056 adds `issue_connector_grant` for owners and admins. It enforces Drishti read, Karya write, write only on production bindings, and a 90-day cap; duplicates are refused and every issue is audited. It also adds `resolve_broker_grant`, which re-reads the grant, workload, lifecycle, credential, descriptor and kill switch in one snapshot.
- `GrantBrokerAuthority` composes JWT-SVID verification with that resolution. It re-resolves in `stillCurrent`, and writes fail closed until a W5 approval verifier exists.
- `POST /v1/connector-grants` and an "Issue agent access" form on `/estate/setup` are added.
- The broker is still not exposed on a route. See [audit 71](audits/71-connector-grant-issuance-review-2026-09-24.md).
- Schema is **0056 / 57 migrations / 60 public tables**; the next migration is **0057**.
- Next in plan order: W4.5 internal tool registry, W4.6 first SQL binding, then W4.7 REST/GraphQL.

**Revision 81 — W3.5 estate graph (Claude cloud session):** `/estate/graph` draws agents, connector registrations, systems, estates and data categories, with access edges derived only from active grants. Read edges are teal and write edges are indigo with a 🔒 WRITE label; there is no gold. It has filters, an "Everything Karya can write to" view, a node detail panel and SVG export. Derivation edges (finding/evidence), live agent animation and PNG/branded export remain open W3.5 scope. See [audit 70](audits/70-estate-graph-review-2026-09-24.md). No schema change. Next in plan order: W4.4 grant issuance and enforcement.

**Revision 80 — C-W3-6 estate sustenance (Claude cloud session):**

- Migration 0055 adds an immutable onboarding attestation snapshot, `onboarding_estate_drift` (systems added, removed or changed, and lost connection paths) and a 90-day agent-grant re-attestation queue. Owners and admins record keep or revoke decisions, audited in the ledger.
- The BFF adds `/v1/estates/:id/drift`, `/v1/connector-grants/review` and `/v1/connector-grants/:id/attestations`.
- `/estate/setup` gains a drift card and an access-review list.
- Nothing issues grants. See [audit 69](audits/69-estate-sustenance-review-2026-09-24.md); operator input was not received, and the assumptions are recorded there.
- Schema is now **0055 / 56 migrations / 60 public tables**; the next migration is **0056**.
- Next in plan order: W3.5 `/estate/graph`, then W4.4 grants.

**Secret-scan history audit (#50 promotion):** a full-history gitleaks run found 37 historical findings. 34 were verified as the public Supabase local demo JWTs (`iss=supabase-demo`), named unit-test keys, or placeholder bearer tokens in a quick-reference doc; they are ignored by exact fingerprint in `.gitleaksignore`. **3 are held for the operator and not ignored:** two 64-hex `GOTRUE_JWT_SECRET`/`PGRST_JWT_SECRET` values in `infra/docker/docker-compose.supabase.yml` (commit `7719f0c`, since removed from the file) and one `APPROVAL_SIGNING_KEY` in `.env.preprod.example` (commit `7631b1f`). If any of them was used by a deployed stack, rotate it; then fingerprint-ignore it. `scripts/security-scan.sh` now also runs gitleaks over unpushed commits when gitleaks is installed.

**Revision 79 — C-W3-5 resumable onboarding wizard (Claude cloud session):** migration 0054 (`tenant_onboarding_wizards`, DPO contact on `tenants`, three ledger actions), `start_/advance_onboarding_wizard` and a live readiness checklist, BFF `/v1/onboarding/wizard` routes, and the `/estate/setup` page. The wizard records confirmations only: it issues no grants and does not treat a registered connector as a live connection. See [audit 68](audits/68-onboarding-wizard-review-2026-09-24.md). Operator input on design was not received; the assumptions are recorded in audit 68. Schema is now **0054 / 55 migrations / 58 public tables**. The next migration is **0055**. Next in plan order: C-W3-6 sustenance and re-attestation, then the W3.5 `/estate/graph` page, then W4.4 grants. **History note:** `main` received direct pushes before the staging flow began. All of them are contained in staging, and the only main-only commit was the #45 promotion merge commit, which this revision carries back into staging. The operator should protect `main` so that it accepts only staging promotions.

**Code-scanning remediation (operator request, #47):** the open CodeQL/Bandit alerts on main are fixed at source rather than dismissed:

- `generateUUID` no longer falls back to `Math.random`.
- Evidence GCS detection (TS and Python) and the Temporal Cloud check compare parsed hostnames, not substrings.
- The TOTP base32 padding trim is linear.
- The S3 `Content-MD5` digest is marked `usedforsecurity=False`.
- The acceptance-target file is checked and read through one descriptor.
- `ci.yml` defaults to `contents: read`.
- Lekha raises instead of asserting.
- The swallowed exceptions now log an event name.
- Container `0.0.0.0` binds and the SafeLoader-derived YAML load carry justified `nosec` markers.

Test code is excluded through a shared `.bandit` configuration, which removes about 150 test-only assert and fixture-credential notes. **Early detection:** `scripts/security-scan.sh` (`pnpm security:scan`, run by the husky pre-push hook) applies the same Bandit config as CI. It fails on medium+ in shipped services and on high anywhere, then runs ESLint. `@axiom/eslint-config` now rejects `Math.random` and host-substring checks while editing. With `AXIOM_CODEQL` set, the script also runs CodeQL security-extended locally.

**Follow-ups, not yet fixed:**

- Five web screens still fabricate IDs, hashes and scores with `Math.random`. They are listed as tracked lint debt.
- CodeQL flags world-readable SPIRE health files (deliberate cross-UID reads) and a URL built in `verify-controller-issuance.py`.
- Bandit reports medium findings in test-harness SQL strings.

## Revision 78 — C-W1-3 tenant invitations

**Baseline:** Revisions 76–77 were merged to staging as `b68fa2c` (squash of [vikashkaruna/Proof#43](https://github.com/vikashkaruna/Proof/pull/43)). Staging [CI 36037580711](https://github.com/vikashkaruna/Proof/actions/runs/36037580711) passed.

**Branch and main audit (operator request):** the audit ran on an unshallowed clone. Every remote branch is contained in staging, with no missing commits, and so is `main`. The closed-unmerged PRs are not implementation work: vikashkaruna/Proof#44 was an earlier staging→main attempt, and vikashkaruna/Proof#32–#36 are Dependabot bumps against the old main (follow-up: re-raise them against staging). Staging is promoted to main through [vikashkaruna/Proof#45](https://github.com/vikashkaruna/Proof/pull/45) (merge commit, not squash) only once its checks are green. Its first run failed only on `trivy / Build`, which also fails on main: the workflow was the unmodified GitHub template and built a root `Dockerfile` that does not exist. This revision switches it to a Trivy filesystem scan (the change reaches main through #45 itself). The types compatibility test also caught that 0053's three `tenant.invitation.*` ledger actions were missing from the client `LedgerActionType`; they are now declared. An earlier shallow-clone reading of "unrelated histories" was wrong and is recorded here so it is not repeated.

**Implemented:**

- Migration **0053** `tenant_invitations`, with three atomic, audited RPCs (create, revoke, accept):
  - hashed single-use tokens;
  - restricted invitable roles, where admins cannot mint owners or admins;
  - acceptance bound to the confirmed invited email;
  - one open invitation per address;
  - immutable content, and no deletes.
- BFF routes: the manage routes are `USER_MANAGE`-gated; the accept route is tenantless and rate-limited.
- An invitation mail adapter behind `AXIOM_INVITATION_EMAIL_MODE`, default disabled. When mail is off, the inviter shares a one-time link.
- A `/settings/members` UI and a public, client-only `/invite` accept page that preserves the token across sign-in.
- **Hardening:** the login open redirect is fixed with `safeRedirectPath`.

**Local evidence:**

| Check                                | Result                                                             |
| ------------------------------------ | ------------------------------------------------------------------ |
| Full DB suite                        | pass, including the new invitation SQL and two-session race suites |
| BFF tests                            | **1,038**                                                          |
| Web tests                            | 85                                                                 |
| Workspace gates and deployment gates | pass                                                               |
| Playwright on the real stack         | **70/70**                                                          |

See [audit 67](audits/67-tenant-invitations-review-2026-09-24.md). The operator had not answered clarifying questions, so the role, lifetime and link-sharing decisions follow the recommended options and are recorded in audit 67.

**Next and limits:** real mail delivery and deployed acceptance remain operator-gated (W1-2/W1-3). W1 engineering items C-W1-1…4 are now all delivered. Next in plan order: W3, starting with the C-W3-5 resumable wizard, then C-W3-6 sustenance and the W3.5 graph, then W4.4 grants. W2 is **19/40**. Schema is **0053 / 54 migrations / 57 public tables**, plus three private credential tables. No cloud apply was performed.

## Revision 77 — C-W0-7 scoring semantics and display provenance

**Baseline:** Revision 76 (C-W0-6) is on the same branch and PR ([vikashkaruna/Proof#43](https://github.com/vikashkaruna/Proof/pull/43)). Operator input was not received; the assumptions in [audit 65](audits/65-contact-inquiry-persistence-review-2026-09-24.md) still apply.

**Implemented:**

- **Question set:** a single versioned `GAP_SCAN_QUESTIONS` set (`2026-09-24`) in `@axiom/control-library` drives both the gap-scan form and BFF scoring.
  - q7 now asks about least privilege (it previously asked about MFA while scoring SEC-002).
  - q11 is phrased so that "yes" means compliant (previously admitting a transfer scored as compliant).
  - q12 asks about a DPIA _before_ new high-risk processing.
  - Reports record `questionSetVersion`; stored snapshots are never rescored.
- **Benchmarks:** readiness figures carry `benchmarkBasis: 'editorial_estimate'` and are labelled "Indicative, not measured peer data" in the report page and email.
- **Client portal:** the demo tenant, slug aliases, per-slug invented scores/exposure/control counts, "+6 vs baseline", "WORM lock active", "0 Active Breaches" and "1 nearing SLA" are all removed.
  - It uses the verified tenant and the BFF saved-results projection through a shared `loadAssessmentSnapshot`.
  - It scopes actions to the tenant's plans and shows explicit empty/unavailable/error states.
- **Workbench:** the loader queried non-existent ledger columns and an invalid plan status, so it always showed invented counts (214/8). It now uses real columns with exact counts or "Unavailable", and the static "10/10 Online", "Env: Production" and prompt-registry figures are replaced with truthful labels.

**Local evidence:**

| Check                                 | Result                                               |
| ------------------------------------- | ---------------------------------------------------- |
| Control library tests                 | 83                                                   |
| BFF tests                             | **1,022**                                            |
| Workspace typecheck/lint/test         | pass                                                 |
| Playwright on the real isolated stack | **68/68**, including a new portal provenance journey |

A pre-existing MFA recovery journey timed out 1 in 3 times under `next dev` cold compiles. Its URL wait now matches the spec's existing 20-second waits; it passed 4/4 repeats and the full suite. See [audit 66](audits/66-scoring-and-display-provenance-review-2026-09-24.md).

**Next and limits:** C-W0 code findings are now all delivered. W0 still needs remote parity acceptance, C-W0-5 deployed IAM and the EKS CIDR decision, which are operator/cloud-gated. Next in plan order is **C-W1-3 invitations**, then W3 wizard/sustenance/graph and W4.4 grants. W2 remains **19/40**. Schema is unchanged at **0052 / 53 migrations / 56 public tables**.

## Revision 76 — C-W0-6 durable contact inquiries behind the BFF

**Verified baseline:** Revision 75 is complete at staging `6617e3283092462f40a13168d1f016da69048f14`. [PR 42](https://github.com/vikashkaruna/Proof/pull/42) was integrated by a no-fast-forward merge. Source [CI 35906474455](https://github.com/vikashkaruna/Proof/actions/runs/35906474455) (source `4dedecf`) and exact staging [CI 35908407498](https://github.com/vikashkaruna/Proof/actions/runs/35908407498) both concluded success.

**Session change and operator input:** a Claude cloud session took over from the Codex worktree. The operator was not available to answer clarifying questions, so work continued on the recommended option. Assumptions are recorded in [audit 65](audits/65-contact-inquiry-persistence-review-2026-09-24.md):

1. Cloud-gated W4 items stay parked while cloud apply is unauthorized. The next open code items come first, in plan order: C-W0-6, C-W0-7, C-W1-3 invitations, then W3 (C-W3-5/6, W3.5 graph) and W4.4 grants.
2. Contact mail has its own opt-in (`AXIOM_CONTACT_EMAIL_MODE`), separate from report mail. It defaults to `disabled`.
3. Inquiries have no delete path. Retention/erasure is left to W8.1.

**Implemented:** migration **0052** adds `contact_inquiries`. Only the BFF can write it; checks bind each delivery status to its evidence; a trigger makes submitted content immutable and settles an outcome exactly once (`pending → sent|failed`); and Axiom-internal users can read through their own session. BFF `POST /public/contact` works as follows:

- It rate-limits and fails closed when the rate budget is unavailable.
- It persists before any mail and refuses success when persistence fails.
- It makes at most one provider attempt.
- It replies with exactly the stored status. An unrecorded settlement is reported as `pending`, never `sent`.

Marketing SSR only validates and forwards the request. The in-memory store, the SSR mail path and the public inquiry-count endpoint are removed, and the form states only what the server recorded. Marketing no longer receives `RESEND_API_KEY` or mail variables in Cloud Run, Helm or Compose. Its secret allowlist is `supabase_anon_key` only, enforced by the IAM checker and Terraform test. The BFF gains the `contact_email_mode` variable and the mail settings it actually reads.

**Local evidence (isolated Docker in this session):**

| Check                                                                     | Result                                        |
| ------------------------------------------------------------------------- | --------------------------------------------- |
| Database suite (fresh/re-apply, all SQL, concurrency and upgrade scripts) | pass, including the new contact security test |
| BFF tests                                                                 | **1,016** (12 new)                            |
| Marketing tests                                                           | 6 (4 new)                                     |
| Workspace typecheck/lint/test, Prettier, `terraform fmt`                  | pass                                          |
| Deployment unittests                                                      | **214**                                       |
| tfvars, env-security, MFA-ring, IAM and auth-wiring gates                 | pass                                          |
| Playwright journeys on the real isolated Supabase/BFF/web/marketing stack | **67/67**                                     |

The inquiry row was observed directly in Postgres. The DB suite caught a silent 0-row service-role `DELETE` before commit; it is fixed by an explicit revoke. Terraform validate/test and Helm render could not run locally (registry blocked by the session proxy), so source CI and exact staging CI remain the closure gates.

**Next and limits:** C-W0-7 scoring semantics/benchmark provenance is next, then C-W1-3 invitations. Real provider delivery was not exercised. W0/W1/W2/W3/W4 remain partial. W2 named targets remain **19/40**. Schema is **0052 / 53 migrations / 56 public tables**, plus three private credential tables. No cloud provisioning/apply was authorized or performed.

## Revision 73 — tenant controller secret/KMS permission configuration

**Verified baseline:** Revision 72 is complete on staging `3c2ff1e53452ac3d2762da9652322050624ee486`, [CI 35879582618, attempt 2](https://github.com/vikashkaruna/Proof/actions/runs/35879582618/attempts/2): all 19 applicable jobs and 13 exact-revision reports passed. The 78 assessment outcomes retain every earlier 71; all 45 native runner outcomes and both configurations' 89 API/67 browser outcomes are preserved. [PR 38](https://github.com/vikashkaruna/Proof/pull/38) is merged. The first staging attempt and redundant documentation PR run were cancelled before closure; only successful attempt 2 is evidence.

**Implemented, source acceptance passed:** the default-off workload module now accepts a reviewed per-tenant primary/retiring dispatch-key inventory. Opted-in runners receive two empty, tenant-labelled, Mumbai-only secret containers and fixed resource-level secret-access/decryption grants. The issuer and unconfigured tenants receive none. Shared/duplicate keys, foreign projects/regions, key-version references and zero tenant IDs are refused. No secret versions, signing keys, producer encryption grants or key retirement are managed. The root conditionally enables the KMS API only for this explicit configuration and never disables that shared API on removal.

A non-secret output binds the tenant, host identity, secret resources and exact key-policy fingerprint to the backend's existing contract. Promotion retains old readable-key grants. The independent source inventory gate rejects broader roles, additional authority resources and indirect secret reads. Local module tests pass **26 evaluated cases**, the root passes **nine composition cases**, and the deployment suite passes **178 tests**. Formatting, control/drift and security gates pass. Source [CI 35888025773](https://github.com/vikashkaruna/Proof/actions/runs/35888025773) passes all **19 applicable jobs and 13 exact-revision reports** for code `ac981df` (tested PR integration `fc74c41`). Hosted deployment verification confirms 26 module cases, nine root cases, 178 deployment tests and the IAM source inventory gate. All 78 assessment and 45 native runner outcomes remain; both topology labels retain identical 89 API/67 browser outcomes. Exact staging-merge CI remains the final closure gate, recorded in this task’s `.axiom-runtime/revision73/completion.json` after verification. See [audit 62](audits/62-controller-resource-iam-review-2026-09-23.md) for the configuration contract and concrete effective-policy acceptance requirements.

**Source gate correction:** the first CI run failed on two public synthetic fingerprint false positives. Narrow exceptions preserve secret scanning. The same review exposed ineffective dependency auditing: high/critical Trivy findings and all three locked Python runtime audits now fail the gate. Removing unused `presidio-anonymizer` unblocks cryptography 50.0.1 in agent runtime and removes that dependency from the gateway; the Presidio analyzer and redaction implementation remain. Agent-runtime 187 and gateway 14 tests pass. All three locked dependency audits pass locally; renewed source CI is green, with exact staging acceptance still required.

**Next and limits:** resource configuration is not proof of effective inherited/cloud IAM. Actual per-principal allow/deny checks, secret replication/payload validation, real KMS and global key-purpose review remain external gates. Continue credential issuance/renewal and protected generation rollout, private TLS/DNS, opaque scheduler and authorized cloud identity/recovery acceptance. No cloud provisioning/apply is authorized or performed. W0/W1/W2/W3/W4 remain partial; W2 is **19/40**, schema **0049 / 50 migrations / 55 public tables**, plus the private credential registry. Continue in plan order after each green milestone and report it.

## Revision 72 — tenant-scoped controller backend

**Current checkpoint:** Revision 71 is complete on staging `fd747ad3125895fc49534db5229b72e7ea7e0f60`; [CI 35872098864](https://github.com/vikashkaruna/Proof/actions/runs/35872098864) passed all 19 applicable jobs and all 13 exact-revision acceptance reports, including 45 native runner outcomes. The user's 23 September continuation instruction supersedes the earlier one-milestone stop: proceed in plan order after each green milestone, updating implementation, tests, documentation and staging integration, and report each milestone.

**Implemented, source gate passed:** migration 0049 supplies a non-login, non-inheriting controller role, a private credential registry and tenant checks around the seven existing controller RPCs. RLS and column grants permit only registration, key-policy and opaque dispatch reads. Existing assessment logic, task/approval checks and ledger writes remain authoritative. No delegation, enqueue, policy publication, retention, direct table-write or general administration authority is granted. The existing public `has_tenant_role` read helper remains callable; it adds no write authority.

The production entrypoint requires an owner-only JSON credential file containing an anonymous gateway key and a signed controller token, rejects broad/foreign/expired credentials, and obtains the effective registered tenant through a bounded read-only PostgREST check before listening. The backend verifies the signature; SQL rechecks registration, expiry and revocation per statement. Tokens last at most one hour and registry leases at most 24 hours. A running statement can still settle after revocation; preserve existing uncertain-result recovery and never reset a claim. Signing keys remain outside the runner.

**Local acceptance:** clean source `b547b03` passes 78 real Docker assessment outcomes, preserving every earlier 71 outcome, plus 61 SPIRE identity and five protected-trust checks. Both the actual controller composition and production entrypoint use the scoped credential. All 1,004 BFF tests, 168 deployment tests, the full database migration/security/concurrency/upgrade suite, workspace checks and control/security gates pass. A failed release download was resolved using the prior session's checksum-verified archive; the first full run also required installing this checkout's missing locked Temporal dependencies. Neither failed attempt is closure evidence. Exact source/staging CI remains the final gate.

**Source gate passed:** [CI 35877565279](https://github.com/vikashkaruna/Proof/actions/runs/35877565279) passes all **19 applicable jobs and 13 exact-revision reports** for source `b547b03` (PR integration `6654a47`). This includes 78 assessment outcomes with all earlier 71 retained, 45 native runner outcomes, 61 identity checks, five protected-trust checks and 146 Temporal outcomes. Both container configurations preserve the baseline 89 API and 67 browser outcomes exactly. The documentation-only integration checkpoint records these results; exact staging merge evidence is saved in `.axiom-runtime/revision72/merge-final` and `.axiom-runtime/session-checkpoint.json` after that independent gate.

**Next:** finish exact staging acceptance for this backend boundary, then resource-level secret/KMS/IAM configuration and effective-policy acceptance, private TLS/DNS and opaque scheduler deployment. Credential issuance, renewal and reviewed host-generation replacement are deployment work, not automatic startup behavior. Real GCP IIT/caller/KMS and Mumbai recovery remain external gates. No cloud apply is authorized. W0/W1/W2/W3/W4 remain partial; W2 remains **19/40** named targets. Schema is **0049 / 50 migrations / 55 public tables**, plus the private credential registry. See [audit 61](audits/61-controller-backend-scope-review-2026-09-23.md).

> **Current status lives elsewhere.** Read [Doc 11](11_Phase0-5_Gap_Closure_Plan.md), whose newest revision section is the current checkpoint, then [Doc 14 implementation progress](14_Implementation_Progress.md) and [Doc 15 session handoff](15_Session_Handoff.md), which names the staging head this rests on. The most recent review is [audit 62](audits/62-controller-resource-iam-review-2026-09-23.md).
>
> The **Historical review snapshot** section below is the original 20 September snapshot, kept for its design reasoning. Its commit tables, workspace paths and in-progress notes are historical and several are now wrong — the analyst work is committed, R-01 through R-11 have mixed closure, and staging has moved many times since. Do not resume from them.

## Revision 71 — reviewed controller supervision

**Implemented and reviewed:** protected hash-bound runtime profiles and disabled per-tenant systemd units now deliver a fixed controller lifetime. Start repeats tenant/VM/file/volume admission, checks the immutable image's production entrypoint and environment, records intent before creation, verifies exact private-IP/8443 confinement, and persists the exact container ID before start. Only the trusted UID 20000 controller receives the daemon socket; workers retain their separate boundary. Restart is disabled in Docker and systemd. Docker running is not application readiness.

**Failure handling:** a per-tenant lock prevents competing lifetimes. Uncertain creation or failed ID persistence leaves an unstarted unresolved intent for review, without name adoption or deletion. A durable start intent also blocks a premature stopped receipt when a timed-out activation still appears created. Shutdown verifies ID/name/image/labels against the protected journal and needs no metadata, issuer, DNS, KMS or backend availability. SIGTERM, unexpected exit and wrapper-death recovery preserve records. Docker gets 90 seconds for the application's 85-second grace, namespace probes are bounded to three seconds, and systemd has a 180-second stop budget. A hung/unavailable daemon still requires explicit recovery; no job reset or automatic restart is introduced.

**Review corrections and evidence:** the saved local Docker Desktop probe reproducibly reports loopback/random-port configuration for a requested private-IP/fixed-port create. The production guard continues to refuse that observation. Added direct confinement mutation tests, stricter host-option checks, stop-timeout configuration, profile/name receipt consistency and interrupted-create/persistence/stop regressions. All **168 deployment tests** and **16 Docker host-delivery outcomes**, workspace tests/lint/typecheck, formatting and security/control gates pass locally. Source [CI 35868902682](https://github.com/vikashkaruna/Proof/actions/runs/35868902682) verifies **all 19 applicable jobs and 13 exact-revision result artifacts** for source `b25729d` (PR integration `748bdea`). Native runner acceptance passes **45 outcomes**, retaining all earlier 33; issuer 17, host delivery 16, assessment 71, identity 61 and protected trust five also pass. Browser/API results agree across both local topology labels. The final staging merge remains a separate exact-revision gate; its run, commit and artifact verification are saved in this task's `.axiom-runtime/session-checkpoint.json` and reported at the milestone stop. See [review 60](audits/60-controller-supervision-review-2026-09-23.md).

**Acceptance limits and next:** the native lifecycle fixture uses a deliberately synthetic process at the expected command path and a fixture-only local-node placement substitution. Production GCP placement must reject that node. Actual production-entrypoint, SPIRE identity and real assessment acceptance remain separate required gates. Effective tenant-scoped backend/secret/IAM/KMS permissions, private TLS/DNS, opaque scheduler deployment, real GCP/caller/KMS and Mumbai recovery are pending. No cloud provisioning or activation occurred. W0/W1/W2/W3/W4 remain partial; W2 stays **19/40** named targets, schema **0048 / 49 migrations / 55 public tables**. The later Revision 72 continuation instruction supersedes this historical milestone stop.

## Revision 70 — reviewed tenant-to-VM placement check

Revision 69 is **complete and green** at `55282ea`, CI [35859815075](https://github.com/vikashkaruna/Proof/actions/runs/35859815075): all 19 applicable jobs and 13 exact-revision artifacts verified. This includes 33 native runner, 17 native issuer, 16 host-delivery, 71 assessment and five protected-trust outcomes. This revision continues the accepted dedicated runner VM per tenant decision.

**Implemented:** a protected, hash-reviewed placement profile binds a tenant and controller file generation to a Mumbai zone and private IPv4 address. A read-only root helper compares fixed GCP instance metadata with the installed SPIRE GCP node identity, checks the address belongs to exactly one active non-loopback host interface, verifies protected controller files and live runtime-volume mappings, then reobserves placement and file bindings before returning. The helper and file installer are now included in the checksum-reviewed runner bundle. Metadata reads use only five fixed nonsensitive paths, no proxy/redirect/alternate endpoint, bounded responses and an enforced total child-process deadline. No access or identity token is requested.

**Validation:** 14 new tests include actual local HTTP responses, proxy bypass, redirects, response bounds, a real trickling-child timeout, tenant/node/address mismatch and composition refusal. All 141 deployment tests and 16 disposable Ubuntu file-delivery outcomes pass locally. Native/system-wide evidence still requires exact-merge CI. See [review 59](audits/59-controller-placement-review-2026-09-23.md).

**Boundary and next:** this supplies the preflight for supervised activation; it does not start a controller or yet integrate a host supervisor. Metadata is an observation of the trusted host placement, not cryptographic GCP attestation, continuous authorization, effective IAM or backend credential scoping. Next integrate this check into the supervised container lifetime, preserving exact container ownership, private binding and graceful shutdown. Then complete private TLS/DNS/secret delivery, scoped IAM/KMS and opaque scheduler deployment. Actual GCP identity and Mumbai recovery remain external; other W3/W4 and W0/W1/W2 obligations remain open. No cloud provisioning or schema/application-approval changes.

## Revision 69 — dedicated runner VM per tenant

Revisions 67–68 are **complete and green** together at `a7df79f`, CI [35857993698](https://github.com/vikashkaruna/Proof/actions/runs/35857993698): all 19 applicable jobs and 13 exact-revision artifacts verified. Evidence includes 33 native runner outcomes (all prior 24 retained), 71 assessment outcomes and five protected-trust outcomes. The initial native fixture hash-format mismatch was corrected without weakening production checks.

**Accepted user decision:** use a dedicated runner VM for each tenant, rather than multiple tenant controllers sharing one runner VM. The separate private Mumbai issuer remains the existing shared trust service; public APIs remain on Cloud Run. This intentionally refines the earlier generic dedicated-runner placement and preserves one configured tenant per controller.

**Implemented deployment foundation:** the opt-in workload module now takes a map keyed by canonical tenant UUID. Each entry has its own runner instance, service account, private address, protected state disk and independent controller source ranges. The issuer is separate. Host firewall rules target individual identities; a tenant's controller allowlist cannot open another tenant's runner. Tenant identifiers are carried in runner metadata, labels and output references. Resource keys are tenant-stable, generated names fit provider limits and potential derived-name collisions are refused. `workload_vms = null` still creates no workload hosts; the module supports bounded batches of 1–100 tenants, not a product entitlement limit.

**Validation:** 13 module boundary tests and eight preprod-root tests pass using provider mocks, including multi-tenant resource separation, per-tenant ingress/default deny, metadata/output bindings, invalid ranges/tenant IDs, name limits and default-off composition. Both configurations validate. No cloud apply, IAM grant, controller activation or schema change occurred. See [review 58](audits/58-dedicated-tenant-runner-review-2026-09-23.md).

**Next:** supervised controller lifecycle must match the configured tenant to its reviewed assigned VM/node and private address before activation. Dedicated VMs do not by themselves establish tenant-scoped backend credentials, effective IAM/KMS permissions or scheduler authorization; those gates remain explicit. Continue private TLS/DNS/secret delivery, scoped cloud permissions and opaque scheduler deployment, then remaining W4/W3 and W0/W1/W2 obligations. Existing populated Terraform state needs a reviewed migration/retirement plan; no automatic move or reassignment of an old unbound runner is supplied.

## Revision 68 — protected controller file delivery

**Implemented:** a fresh-output review-bundle preparer and a root-only file installer/checker for the controller's fixed `service.json`, `backend.key`, `tls.key` and `tls.crt` inventory. The manifest binds tenant, reviewed SPIRE installation, intended immutable controller image and exact file hashes. Installation checks the actual installed runner binding and fixes the container paths, Docker endpoint, runtime volume and private listener contract. A root-owned generation manifest precedes file writes; a completion receipt follows them. Existing complete identical generations retain their inodes; incomplete or altered generations are preserved and refused, without repair or overwrite.

**Protection and evidence boundary:** root-only host ancestry encloses a mountable root-owned `0755` directory whose files are owned by UID/GID 20000 with mode `0400`. The checker verifies ownership, permissions, hashes, hard-link count, canonical ancestry and receipt. It can run without the original source bundle. This delivers files; it neither starts/enables a service nor proves TLS/KMS/backend readiness, image admission or effective cloud permissions. The actual controller `--check` remains authoritative for full runtime validation. No secrets are placed in environment variables, command arguments or logs.

**Validation:** ten new delivery tests bring the deployment suite to 127; the protected local preparer and overwrite refusal pass. The native runner gate adds nine checks using actual root filesystem ownership and a read-only container consumer, including worker-UID denial, foreign-node refusal, tamper preservation and incomplete-generation refusal. Native results require the exact-merge artifact before being called green. See [review 57](audits/57-controller-protected-files-review-2026-09-23.md).

**Next:** supervised controller container lifecycle with reviewed immutable-image admission, private listener binding, host-namespace volume preflight, explicit ownership before stop/remove and bounded graceful shutdown. Then private DNS/TLS/secret and scoped IAM/KMS deployment, opaque scheduler delivery, and external GCP/Mumbai backup acceptance. Other W3/W4 and W0/W1/W2 obligations remain open. No cloud provisioning or schema changes; W2 remains 19/40 named targets.

## Revision 67 — exact controller workload admission

Revision 66 is **complete and green** at `1d7aa92`, CI [35854335396](https://github.com/vikashkaruna/Proof/actions/runs/35854335396): all 19 applicable jobs and 13 exact-revision artifacts verified, including 71 assessment outcomes. The initial persona job failed during Supabase startup; its isolated retry passed without code changes.

**Review finding and fix:** a successful Workload API bundle read establishes access to trust material, but does not establish the controller role. Startup now requests the exact `spiffe://<domain>/controller/assessment` JWT-SVID for the fixed `axiom-controller-startup` audience. It requires one matching response, then verifies signature, subject, audience, lifetime and independently current trust under the existing exact-node health gate **before reading backend dispatch policy**. Transport is the configured protected Unix socket with bounded messages/deadline and no retries or alternate transport. The bearer is never returned, persisted or logged. This startup proof adds no tenant/task/action authority and does not replace job approvals or per-tool identity checks.

**Validation:** real Unix gRPC tests cover the exact wire request/metadata, wrong role/audience/signature, expired/future/overlong tokens, malformed/ambiguous responses, denial, timeout, unavailable socket and changed trust. Composition checks prove denied admission cannot query the backend. Real SPIRE acceptance additionally requires controller admission and demonstrates that a registered worker can read bundles yet cannot pass controller admission. The existing actual entrypoint and assessment checks remain required. See [review 56](audits/56-controller-role-admission-review-2026-09-23.md). Exact-merge CI remains the closure gate; do not infer whole-roadmap completion from these checks.

**Next:** protected controller host delivery and supervised container lifecycle; then private TLS/DNS/secret and scoped IAM/KMS deployment plus opaque scheduler delivery. Actual GCP attestation, valid Google caller identity, real cloud KMS and Mumbai backup/restore remain external gates. No cloud provisioning, schema changes or altered application approvals. Other workers/actor chains, live grants, full W3 wizard/readiness/graph and W0/W1/W2 remainder remain open; W2 remains 19/40 named targets.

## Revision 66 — actual controller entrypoint acceptance

Revision 65 is **complete and green** at `66e6147`, CI [35852588998](https://github.com/vikashkaruna/Proof/actions/runs/35852588998): all 19 applicable jobs and 13 exact-revision artifacts verified. Native runner/container acceptance passes 24 outcomes, including exact returned SPIFFE identity; native issuer remains 17 and Docker delivery remains 16.

**Review and implementation:** the existing controller integration exercised composition with explicit fixture database/KMS/OIDC ports. It did not execute the deployed `--check`/`--serve` entrypoint. A new disposable Docker fixture now invokes that inherited entrypoint unchanged with owner-only files, a real HTTPS backend connection to isolated Supabase and real protected SPIRE/health volumes. The private TLS proxy permits only the existing key-policy read and counts refused operations; it does not add a production plaintext or development-credential fallback. Synthetic keys enter private stdin and protected volume files, never Docker environment or command arguments.

**Acceptance:** eight new checks cover actual startup, TLS-host mismatch, foreign node, unsafe backend-file permissions, the private TLS listener rejecting invalid identity, absence of backend/TLS secrets in container environment, graceful SIGTERM, and no job claims. The fixture leaves an explicit pending job available, checks database claims before/after and requires no forbidden backend operation attempts. It cleans up its own named containers, volume and network. The local assessment suite now has 71 outcomes, preserving all prior 63; strengthened final checks and exact-merge CI evidence are saved separately. See [review 55](audits/55-controller-entrypoint-acceptance-review-2026-09-23.md).

**Next in order:** protected controller host delivery and supervised container lifecycle, then private TLS/DNS/secret and scoped IAM/KMS deployment plus opaque scheduler delivery. Valid Google caller identity, real cloud KMS, GCP node attestation and Mumbai backup/restore remain external gates. This local entrypoint test uses the acceptance image inheriting the production entrypoint, not an attestation of a deployed production image. Other workers/actor chains, live grants, full W3 wizard/readiness/graph and W0/W1/W2 remainder remain open. No cloud provisioning or schema/application-authorization changes; schema 0048 / 49 migrations / 55 tables, W2 targets 19/40.

## Revision 65 — protected host socket and health volumes

Revision 64 is **complete and green** at `24e6a87`, CI [35850300471](https://github.com/vikashkaruna/Proof/actions/runs/35850300471): all 19 applicable jobs and 13 exact-revision artifacts verified, including 16 native runner, 17 native issuer and 16 Docker delivery outcomes. No intervening staging implementation was found. The initial fixture run correctly hit the production observer start limit; only the independent test sequence was corrected.

**Implemented:** a root-only, installed-manifest-bound helper prepares or checks two fixed Docker local-driver mappings: `/run/workload` and `/run/spire-health`. Names derive from the reviewed filesystem UUID; labels bind the manifest, UUID and purpose. The helper requires initialized bound state, the reviewed live runner/observer, exact current node health and protected stable source directories. All existing conflicts are checked before writes. A protected review record precedes volume creation; identical explicit retries preserve matching mappings. Options require read-only, nosuid, nodev and noexec binds. Existing active mounts must still reference the original source device/inode and carry those flags. No arbitrary source, driver, Docker endpoint, deletion, repair or container launch is accepted.

**Validation:** 117 deployment tests and local Docker bundle delivery; the expanded native runner gate adds a real container consumer, wrong mapping/UID/image refusal, exact image/UID admission, socket replacement and atomic health refresh, retaining all earlier lifecycle outcomes. Native results remain pending until the exact-merge artifact verifies them. The consumer receives read-only workload/health directories and no admin or daemon socket. The fixture uses local join-token identity, not GCP attestation. See [review 54](audits/54-runtime-volume-delivery-review-2026-09-23.md).

**Next in order:** complete controller container admission/startup and supervision with protected configuration, backend credentials, private TLS and scoped IAM/KMS; then opaque scheduler delivery and external GCP/backup acceptance. Other workers/actor chains, live grants, full W3 wizard/readiness/graph and W0/W1/W2 remainder remain open. No cloud deployment, schema or application-approval changes. Schema 0048 / 49 migrations / 55 public tables; W2 targets 19/40.

## Revision 64 — reviewed runner enrollment and native lifecycle gate

Revision 63 is **complete and green** at `ddf3954`, CI [35848499207](https://github.com/vikashkaruna/Proof/actions/runs/35848499207): all 18 applicable jobs and 12 exact-revision artifacts verified, including 16 Docker and 17 native issuer outcomes. No intervening staging changes were found.

**Implemented:** the protected initializer now supports runners using the reviewed GCP-bound manifest, exact filesystem and separately reviewed bootstrap CA. It requires disabled/stopped normal services and a stopped observer. The bounded static initialization unit keeps the normal runner hardening and Docker/mount dependencies, but does not launch the observer. Before stopping, the helper queries the protected node admin socket twice, requiring the exact expected node, an unexpired certificate and recent non-regressing issuer synchronization. Its receipt binds those observations, the bootstrap CA and stopped key/recovery-state bytes. Separate receipt review refuses changed state or bootstrap trust and an expired node certificate. It publishes the marker without starting normal services. Normal boot remains ready-only with `rebootstrap_mode=never`; interrupted initialization requires explicit recovery.

**Validation:** 105 deployment tests and 16 local Docker delivery outcomes pass. A separate native Ubuntu runner CI gate exercises actual installed commands and service lifetimes, including observer restart/expiry, issuer outage/recovery, mount loss, missing keys and Docker loss. The new native gate remains unverified until its exact-merge artifact passes. Its disposable fixture substitutes local join-token attestation and one exact generated node identity into a separately hashed test bundle; production GCP configuration has no fallback. It cannot prove GCP IIT, cloud IAM or client execution. See [review 53](audits/53-runner-enrollment-lifecycle-review-2026-09-23.md).

**Next in order:** host workload socket/metadata delivery to containers, controller admission and lifecycle, then scoped IAM/KMS, private TLS/DNS and opaque scheduler delivery. Actual GCP attestation, Mumbai backup/restore, other workers/actor chains, live grants, full W3 wizard/readiness/graph and W0/W1/W2 remainder remain open. No cloud provisioning or schema changes; schema remains 0048 / 49 migrations / 55 public tables, W2 targets 19/40.

## Current handoff — Revision 63 (23 September 2026)

Revision 62 is green at `00dc35d` / CI [35842199663](https://github.com/vikashkaruna/Proof/actions/runs/35842199663): 18 jobs and 12 verified artifacts. Revision 63 adds explicit issuer initialization and separate receipt-hash review before publishing its state marker. Normal startup remains initialized-state-only. Local validation passes 96 deployment tests and 16 Docker outcomes; expanded native/combined exact-merge evidence is saved in the session.

Resume automatically in plan order in `codex/w0-w3-closure`, preserving the original checkout. Next implement reviewed runner enrollment and full node/observer lifecycle, then socket-volume mapping, full controller admission, IAM/KMS, private TLS and the opaque scheduler. Failed initialization requires explicit recovery; never delete state or overwrite review records to make a retry succeed. No cloud resources were provisioned. Remaining workers, live grants, full W3 wizard/readiness/graph, W0/W1/W2 and backup-aware key retirement remain open.

## Historical review snapshot

**As of 20 September 2026 · reviewed source: `2c54fcd` plus three uncommitted analyst files.**

W1 has substantial committed implementation but is **not complete**. Resolve the P0 review findings before declaring multi-client readiness. This document is a handoff for another implementing model; no further product implementation was performed during this review.

## Read first

1. [Doc 11, Revision 9](11_Phase0-5_Gap_Closure_Plan.md): the plan, corrections and sequence **as they stood on 20 September**. That document's newest revision section is current; read it instead.
2. [Independent review](audits/04-roadmap-review-2026-09-20.md): R-01–R-11, file evidence and actual test results.
3. [Roadmap traceability](13_Roadmap_Traceability.md): every phase module and BR/FR/NFR owner.
4. Docs [02](02_Phase_Wise_Implementation_Plan.md), [03](03_BRD_PRD.md), [04](04_Solution_Architecture.md): requirements, phase gates and architecture.

The HTML handoff map is a design reference with mock examples, not completion evidence. Text in earlier documents is historical planning context, not an instruction to deploy or implement beyond the current user's authorisation.

## Workspace and branch handoff

| Item                           | Location/state                                                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Review documentation           | Repository root checkout `/Users/vikash/Axiom Proof`, branch `docs/phase0-5-gap-closure-plan`, based on `12bd02e`                               |
| Claude implementation          | `/Users/vikash/Axiom Proof/.claude/worktrees/phase-0-5-gap-closure-5fd349`, branch `claude/phase-0-5-gap-closure-5fd349`, HEAD `2c54fcd`        |
| Unfinished role work           | Modified `packages/types/src/enums.ts` and `packages/types/src/rbac.ts`; untracked `infra/supabase/migrations/0015_user_role_axiom_analyst.sql` |
| Other pre-existing dirty files | Root checkout's `apps/marketing/next-env.d.ts` and `apps/web/next-env.d.ts`; untouched by review                                                |
| Remote-tracking state observed | `origin/staging` at `2c54fcd`; `origin/main` at `9575205`; this is not a cloud deployment or fresh remote verification                          |

> [!WARNING]
> **The table above is a 20 September snapshot and is no longer accurate.** `origin/staging` has advanced well past `2c54fcd`, the analyst files are committed, and migration allocation is through 0026. For the live workspace state, branch and resume sequence, use [Doc 15](15_Session_Handoff.md).

Resume in the implementation worktree, not the old root source. Recheck status and migration numbers against `origin/staging` on resumption; do not overwrite work in progress.

## Completed source changes

“Completed source” means the change exists in a commit. It does not assert migration application, release readiness or live acceptance.

| Commit    | Delivered source                                                                                               | Remaining boundary                                                    |
| --------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `25e3bc5` | W0.0 strict auth mode and removal of topology-based bypasses; BFF test foundation                              | Real strict environment and complete RLS policy verification          |
| `7b4db2c` | CI/lint/format groundwork                                                                                      | Not every package lints; parity/RLS/E2E release gates still missing   |
| `1c244e0` | Strict staging credential validation; Temporal configuration instead of placeholder                            | Boot/migrate from documented configuration and prove secret injection |
| `3b47fbc` | Shared kill state, tenant quota, execute-time dry-run expiry, awaited ledger, bounded nonce cache, batch fetch | In-flight halt, atomic durable execution and database constraints     |
| `9d6e2a5` | TS 0.1.1 citation mapping and count consistency work                                                           | Runtime bundle/publication/provenance parity; R-06                    |
| `cc3fcee` | W7.0 schema/metadata; Nazar loses control-library write declaration                                            | Hashed baseline publication and runtime scope enforcement             |
| `443a06a` | Central capability matrix, approval scope checking and selected route gates                                    | Agent/execute/read route enforcement and RLS alignment; R-01–R-03     |
| `5018188` | UI persisted-state hydration fix                                                                               | Not evidence of a roadmap module completing                           |
| `8fe16ce` | User-scoped pages/tenant helper; removal of auto-owner fallback                                                | SQL authority paths remain vulnerable                                 |
| `898ede6` | TOTP/recovery primitives and schema; per-tenant demo flag                                                      | Email OTP pending decision, secret wiring and abuse controls          |
| `c814f7b` | MFA service/endpoints and approval step-up                                                                     | Full content binding, direct-access enforcement and live acceptance   |
| `9be5ffd` | Login MFA attestations and enforcement                                                                         | Role policy/rotation/revocation/strict persona acceptance             |
| `2c54fcd` | Real membership-based switcher and capability-based navigation/rendering                                       | Analyst WIP and backend/database matrix parity                        |

## In progress — resume without duplicating

> [!NOTE]
> **This section is closed.** The analyst persona shipped in `dc901e9` — migration 0015, the capability matrix and render gating — and the acceptance points below were met, including the negative tests. It is kept because the reasoning about enum naming, membership resolution and the nine resulting role values remains correct. Nothing here is outstanding work.

The analyst role patch adds `AXIOM_ANALYST`, its capabilities and a separate enum migration. This is the “persona/user_role schema plus matrix” work described by the user. The SQL enum is named **`user_role`**; the membership table is **`tenant_users`**. There is no need to invent a `person` or `user_roles` table merely from that shorthand.

Before accepting the patch:

- Keep the enum addition in an append-only migration; apply it before consuming the new value in later migrations.
- Update exhaustive role tests (`rbac.test.ts:118,122` currently fail), navigation, seed identities and acceptance coverage together. Do not simply broaden expected arrays without negative tests.
- Prove analyst can run/review within assigned tenants, cannot approve/execute client mutations, cannot gain global kill/release or user-management authority, and cannot access unassigned tenants via direct database/REST paths.
- Reconcile retained `admin` and all declared roles across SQL, TypeScript, membership resolution, API guards and UI. The plan's eight-row proposal plus retained admin yields nine distinct role values once analyst is added.
- Do not accept migration 0015's comment that internal RLS already makes this safe; R-01/R-02 contradict it.

## Pending — concrete next work

| Priority      | Work                            | Definition of the next acceptable result                                                                                                                           |
| ------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0            | R-01/R-02 SQL authority closure | No self-promotion, target-row tenant binding, safe privileged role assignment; direct Postgres/PostgREST tests including analyst/owner/viewer and multiple tenants |
| P0            | R-03 generic invocation         | Typed payload, role gate, trusted tenant binding, engagement ownership, internal agent policy; Karya cannot bypass execute gate                                    |
| P1            | R-07/R-08 MFA closure           | Key provisioned without leakage, clean strict boot, policy clarified, shared abuse budget, revocation and reviewed-content step-up tests                           |
| P1            | R-06 regulatory publication     | TS/Python parity, immutable old/new library versions, official source hashes, real reviewer provenance; corrected reports remain traceable                         |
| P1            | W2 model slices                 | Existing schema normalised intentionally; request/batch/action keys fixed; fresh and upgrade migrations pass; table ownership classification documented            |
| P1            | W3/W4                           | Estate onboarding then real connector/grant/identity contracts and binding proofs; three live connector types required for Phase 2 exit                            |
| P1            | W5                              | Durable approved-subset execution, contract-compatible dispatch, actual dry-run/rollback, in-flight caps/kill, verification and reconciliation                     |
| P1            | W8.1–W8.3 / W3.1                | Rights/consent, breaches, founder output release, persistent review/generator/playbook journeys                                                                    |
| Continuous    | W9 / W9.1                       | Release-path CI, strict persona E2E, real SQL and operational evidence rather than mock-only assertions                                                            |
| Later / gated | W6, W7 overlays, W10            | Use Doc 11 packages and roadmap commercial gates; retain intentional scope additions                                                                               |

## W2 migration design constraints

- Numbers 0009–0014 are already occupied by kill switch, ledger vocabulary, regulatory metadata and MFA. 0015 is WIP. Allocate new numbers only after checking the worktree.
- Reuse existing `remediation_actions` dry-run/rollback/execution fields through a deliberate migration/backfill; do not introduce divergent duplicate state.
- Use composite tenant-consistent relationships for estate → system → connector → engagement → finding/plan/action. Test that a valid tenant A FK cannot point to tenant B data.
- Global reference data (controls, instruments, baselines, descriptors where global) differs from tenant-owned state and user-scoped MFA. Set publication authority and RLS accordingly.
- Protect safety transitions from broad authenticated updates. Only narrow trusted paths may set dry-run/rollback/approval/execution status; preserve the signed human-approval gate.
- Plan transaction/outbox boundaries now: consuming a token, claiming actions and recording intent cannot leave an unrecoverable half-state. A retries cache written after side effects is not a concurrency guarantee.

## Verification and reporting contract

Use the [review's result table](audits/04-roadmap-review-2026-09-20.md#verification-performed) as the latest local baseline. It includes two expected-to-fix failures, not a wholly green repository. Full build, real database, deployed state and strict E2E remain unverified. Local Python testing used 3.14.6; additionally validate the deployed 3.11 image.

For each completed slice, record commit, applied migration versions, exact command/result, environment/auth mode, tested roles/tenants and any remaining external evidence. Do not label W1 “done” before direct-access isolation, role denial and strict persona flows pass. Do not label Phase 3 “done” before all eight PRD B.10 criteria, a controlled rollback and the original production-client acceptance gate are satisfied.

## Decisions awaiting confirmation

> Resolved since this snapshot: email OTP **is** intentionally deferred; analyst access **is** assigned tenants only, without aggregate `MULTI_TENANT_READ`; higher environments self-host Supabase; every outbox redelivery needs a fresh approval; proxy trust is configured per environment and disabled by default. The still-open decisions are in [Doc 15](15_Session_Handoff.md).

- ~~Whether email OTP is intentionally deferred~~ — deferred, confirmed by the founder.
- ~~Whether analyst access is assigned tenants only~~ — assigned tenants only, confirmed.
- Sectoral pack #1 selection before pack delivery.
- Authoritative provider/retention equivalence record and marketing/API boundary reconciliation.
- BR-4 founder review versus automatic public gap-scan delivery: either introduce the review gate or record an explicit exception with precise scope.

No waiting decision blocks fixing the confirmed P0 defects or continuing independent schema design.
