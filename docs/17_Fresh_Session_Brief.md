# Continuing implementation — Revision 88

**Current status board:** see [Doc 14 — Build status board (Revision 88)](14_Implementation_Progress.md#build-status-board--revision-88-2026-09-25). It lists each stream's status, pending work, effort (S/M/L/XL) and outside gates.

## Session close-out and handoff — Revision 97 (2026-09-26)

**Where to continue:**

- Work from a branch cut fresh from `origin/staging` (Revision 96 merged via PR #73; Revision 97 lands via the standing-policy branch's PR).
- Open every PR into **`staging`** with a merge commit, and merge only when all checks are green.
- **Promotion to `main` has resumed (2026-09-26).** Revisions 89–96 are on main via PRs #72 and #75, both merge commits — never squash, never direct pushes.
- To start: `git fetch origin staging && git checkout -B codex/<your-branch> origin/staging`.

**State at close:**

- Schema is **0000–0068: 69 migrations, 70 public tables** (Rev 94 the four W6 monitoring/policy tables; Rev 95 the scheduler write paths; Rev 96 drift acknowledgement; Rev 97 the standing-policy engine — the dual-control constraint, the lifecycle RPCs and `evaluate_standing_policy`). The next migration is **0069**; never edit an applied migration.
- Latest audit is **85**.
- Parallel lanes in flight (each hands over via a green PR to staging): Bandit fixes (`codex/bandit-hardening`), W6 rediscovery/reassessment executors (`codex/w6-schedule-executors`), W5 web surfaces (`codex/w5-web-surfaces`). `claude/c-w3-5-onboarding-wizard-wip` is adjudicated stale (byte-identical to the Revision 79 migration) — delete after plan completion.

**Build and test status** (staging, PR #56 head `bc176d5`, 21 of 21 CI checks green):

| Suite                                 | Result                                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| BFF (vitest)                          | 1148 passed, plus 5 live PostgreSQL tests that run in the "Live SQL binding (W4.6)" job |
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

1. **Rotation — still the operator's action item.** The three historical secret findings were retired via `.gitleaksignore` fingerprints with rationale (PR #74; full-history scan green), but the values are burned in public history: deployments must source fresh secrets via `scripts/mint-supabase-keys.mjs`, and deployed preprod values still need rotation.
2. `main` branch protection/rulesets are done; the phantom required-check contexts that blocked PR #72 no longer block (PRs #72 and #75 merged clean).
3. Stale branches are deleted together after plan completion.
4. Dependabot #32–36 are closed out and their updates landed via PR #57. `tailwindcss` 4 and ESLint 10 are held back: the major-version migration and `scopeManager.addGlobals` breakage respectively.
5. `saml2_bearer` is a TODO, not a blocker.
6. Sector pack #1 will be chosen when W7 is reached.
7. Promotion to `main` **resumed 2026-09-26** — PR #72 (through #74) and PR #75 (Revisions 95–96) merged with merge commits; keep `origin/main..origin/staging` empty after each promotion.

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

**Revision 97 — the standing-policy engine (GLM session):**

W6.2 · M4.1 lands, the piece that lets pre-granted human approval move a batch without a human present — without weakening anything that makes approval safe. Migration 0068 gives `standing_approval_policies` its lifecycle and `policy_evaluations` its writer: `create_standing_policy` (dual-controlled by two different humans — a new schema constraint makes that a fact, not a convention — with a closed scope of only the keys the engine reads and an expiry of at most a year), `revoke_standing_policy` (once, ledgered) and `evaluate_standing_policy`, which routes every within-scope request THROUGH `issue_reviewed_plan_approval` — the plan-version check, the dry-run/rollback freshness gate (BR-2), the digest over the reviewed content and the atomic `approval.token.issued` ledger entry run exactly as an interactive approval, with the policy's named approver on the token and the policy id + version in its `conditions`. A scope miss or an oversize batch escalates (`monitoring.policy.escalated`, agent `nazar`); a lapsed policy retires itself against `clock_timestamp()` and records the evaluation; a gate refusal under the locks records no evaluation and mints no token, because the policy made no authority decision there. The BFF gains the policy CRUD (`POST/GET /v1/policies/standing`, `POST /v1/policies/standing/:id/revoke`) and `POST /v1/plans/:id/standing-approval` (PLAN_APPROVE, kill-switch gated, the same per-action dry-run hard gate as the approve route; escalation renders as a 200 decision, issuance as the same signed-token shape). All four ledger values were added to `LedgerActionType` in the same commit. See [audit 85](audits/85-standing-policy-engine-review-2026-09-26.md). Schema is **0068 / 69 migrations / 70 public tables**. Next in plan order: drift alerting, the monitoring/policy UI, the rediscovery/reassessment executors (in flight), the W5 web surfaces (in flight) and the manual rollback route.

**Revision 96 — drift acknowledgement and the monitoring-health surface (GLM session):**

The drift story closes: migration 0067 adds `acknowledge_drift_event` — the human's write path onto a detection, binding `acknowledged_by`/`acknowledged_at` together, refusing a second judgement, and ledgering `monitoring.drift.acknowledged` as a human action (added to `LedgerActionType` in the same commit). The BFF gains `POST /v1/monitoring/drift-events/:id/acknowledge` (ESTATE_MANAGE, RPC refusals rendered as 409), `GET /v1/monitoring/drift-events` and `GET /v1/monitoring/health` — the monitoring-of-the-monitoring surface: per-schedule freshness with overdue flags and last-7-days drift counts by severity with an unacknowledged count. See [audit 84](audits/84-drift-acknowledgement-health-review-2026-09-26.md). Schema is **0067 / 68 migrations / 70 public tables**. Next in plan order: the standing-policy engine — the W6 piece that issues scoped approval tokens through the existing gate or escalates.

**Revision 95 — the continuous-compliance scheduler (GLM session):**

The scheduler fires due monitoring schedules through the database's own write paths. Migration 0066 adds `record_drift_event` (the only write path into `drift_events`: closed kind/severity sets, bounded identifier-shaped summaries, against a real estate, ledgered as `monitoring.drift.detected`) and `record_schedule_run` (advances an active schedule's bookkeeping to a strictly-future next fire, ledgered as `monitoring.schedule.fired`). The next fire is computed by a minimal deterministic cron engine (`axiom/cron_next.py`, standard DOM/DOW OR rule, month-length aware) — a cadence the engine cannot compute records a failed run with a day's grace, never a spin or a guess. `drift_check` schedules execute against the estate's sealed baseline (`onboarding_estate_drift`, 0055): each detected system becomes an event with severity by kind (connection loss and removal high). `rediscovery` and `reassessment` stay registered but unexecuted — left due for their executors' slice. The loop (`axiom/scheduler.py`) is off unless `feature_continuous_scheduler` is set per environment, absorbs single-pass failures, and is cancelled on shutdown. Both ledger values were added to `LedgerActionType` in the same commit. See [audit 83](audits/83-scheduler-review-2026-09-26.md). Schema is **0066 / 67 migrations / 70 public tables**. Next in plan order: the standing-policy engine, drift acknowledgement routes, rediscovery/reassessment executors and the monitoring-health surface.

**Revision 94 — W6 foundation: the continuous-compliance tables (GLM session):**

W6 opens with its foundation: migration 0065 creates the four monitoring/policy tables Doc 11 lists as missing — `monitoring_schedules` (per-estate cron schedules with a one-active-per-kind partial unique index; a re-registration retires the replaced schedule in the same audited transaction), `drift_events` (append-only, closed kind/severity sets, all-or-nothing acknowledgement), `standing_approval_policies` (human-authored AND human-approved, scope-bounded with a mandatory `action_types` array, expiring — the engine they feed issues scoped tokens through the existing approval gate or escalates, never bypassing BR-1/BR-2) and `policy_evaluations` (append-only, tenant-bound to the policy). `register_monitoring_schedule` is the estate manager's write path, and the BFF gains `POST /v1/monitoring/schedules` (ESTATE_MANAGE, future first fire required, RPC refusals rendered as 409) and `GET /v1/monitoring/schedules` (POSTURE_READ, tenant-scoped). Ledger action `monitoring.schedule.registered` is added to `LedgerActionType` in the same commit. The scheduler, drift write path and policy engine are the next W6 slices. See [audit 82](audits/82-continuous-compliance-foundation-review-2026-09-26.md). Schema is **0065 / 66 migrations / 70 public tables**; the next migration is **0066**.

**Revision 93 — execution progress telemetry (GLM session):**

W5.7 lands, the last record-keeping item of the W5 list. Migration 0064 adds `record_karya_run_start`/`record_karya_run_finish`: every action the executor starts opens an `agent_runs` row (agent `karya`, `running`, bound to the plan and action, carrying a hash of the executed parameters and `pii_redacted`), and closes exactly once with the outcome, latency and output hash — through bounded error codes, and with `service_role`'s leftover direct UPDATE on the table revoked. No task, no record: skipped and swept actions open nothing, which is what makes started→finished trustworthy. The executor opens the record after the kill-switch check and closes it on every terminal path. The BFF broadcasts `execution.progress` per action from the executor's acknowledgement — an ack the runtime gives only after every action is settled and ledger-recorded — so subscribers see recorded state, not predictions; ambiguous acknowledgements (bad uuids, invented outcomes) release nothing. Live in-batch streaming stays with the operator-gated CDC composition, whose source of truth (the ledger and `agent_runs`) now exists. See [audit 81](audits/81-execution-telemetry-review-2026-09-26.md). Schema is **0064 / 65 migrations / 66 public tables** (no new tables; two functions and one grant revoke). W5's remaining items are web surfaces, a manual rollback route and the production write path — all UI/composition work. Next in plan order: **W6 continuous compliance** (scheduler, drift and discovery schedules, standing policies, monitor health).

**Revision 92 — post-execution verification and the maker-checker reconciler (GLM session):**

The last two record-keeping halves of the execution loop land together. Migration 0063 adds `record_verification_result` (Parikshan re-runs the targeted checks per settled action through the adapter's new `verify` op; a refused verification is recorded as a failed check, never swallowed; a halted batch skips verification entirely because an operator halting an incident stops estate calls) and `record_plan_reconciliation` — the maker-checker statement whose facts are computed at the database: approved scope from the token row, out-of-scope execution computed from the batch and refused with the offending ids (`out_of_scope_executed`), swept actions listed as unexecuted with their reason, and the content digest recomputed over the approved action set with any drift stated in `parameter_diffs` rather than hidden. The statement is signed with the approval signing key (HMAC-SHA256, the same key that bound the approval) and the whole chain — finding, plan, dry-run, approval, execution, verification, reconciliation — is now reconstructable from the ledger. WORM sealing of the statement stays gated on the locked-storage decision (R-10). See [audit 80](audits/80-verification-reconciliation-review-2026-09-26.md). Schema is **0063 / 64 migrations / 66 public tables** (no new tables; two functions and one ledger enum value). Next in plan order: execution progress telemetry, then a manual rollback route — W5's remaining pieces are UI/telemetry and the operator-gated production write path.

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

The user's instruction still stands: continue in plan order after every green milestone. At each milestone, report it and keep the implementation, testing, documentation and no-fast-forward staging integration up to date. Use isolated Docker services for testing. The overall goal is active and incomplete. No cloud provisioning/apply is authorized.

When operator input is unavailable, continue with the recommended option and record in Docs 11–16 that no input was received, together with the assumptions made.

## Revision 76 — C-W0-6 durable contact inquiries (Claude cloud session)

**Baseline:** Revision 75 is complete at staging `6617e32` (PR 42; source CI 35906474455 and staging CI 35908407498 succeeded).

**Delivered:** migration 0052 `contact_inquiries` (BFF-only writes, immutable content, one-time delivery settlement). BFF `POST /public/contact` and `GET /public/contact/config`. The marketing route only forwards; the SSR mail path and in-memory store are removed. Marketing's mail credential/allowlist is removed from Cloud Run, Helm and Compose. `AXIOM_CONTACT_EMAIL_MODE` is a new BFF opt-in (default `disabled`). See [audit 65](audits/65-contact-inquiry-persistence-review-2026-09-24.md).

**Status:** W0/W1/W2/W3/W4 remain partial. W2 is **19/40**. Schema is **0052 / 53 migrations / 56 public tables**, plus three private credential tables.

## Revision 77 — C-W0-7 scoring semantics and display provenance

Delivered on the same branch/PR as Revision 76. There is a shared versioned gap-scan question set, and benchmarks are labelled as editorial estimates. The portal and Workbench no longer invent figures; the Workbench's broken queries are fixed. Playwright passes 68/68. See [audit 66](audits/66-scoring-and-display-provenance-review-2026-09-24.md).

## Revision 78 — C-W1-3 tenant invitations

Migration 0053, the invitation RPCs, the BFF routes, `/settings/members`, the `/invite` accept page, and the login open-redirect fix. See [audit 67](audits/67-tenant-invitations-review-2026-09-24.md). Staging (through Revision 77) is promoted to main through vikashkaruna/Proof#45 after a full branch audit, as a merge commit once its checks are green; Trivy was fixed (filesystem scan) so that check can pass. **Always unshallow before comparing branches** (`git fetch --unshallow`): the cloud clone is shallow and otherwise reports false "unrelated histories".

## Current work and continuation

- Branch `codex/revision75-controller-generation-transition` (the operator-designated branch), on top of `4dedecf` (already contained in staging). Integrate into `staging` through a PR and a no-fast-forward merge after source CI is green; then verify the staging push CI.
- This cloud container has no persistent `.axiom-runtime`, so checkpoints live in Docs 11–15. The Codex worktree's `.axiom-runtime` evidence remains on the operator's machine.
- **Local test recipe in a fresh cloud container:**
  1. Start `dockerd`.
  2. `pnpm install --frozen-lockfile`.
  3. `bash scripts/test-database.sh`.
  4. Install Supabase CLI 2.116.0 from GitHub releases, then run `SUPABASE_INTERNAL_IMAGE_REGISTRY='' ./scripts/start-parity-supabase.sh` and `pnpm exec tsx scripts/seed-personas.ts`.
  5. Symlink `/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell` to Playwright's expected `chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`.
  6. `pnpm --filter @axiom/e2e exec playwright test` (67 journeys).
- `registry.terraform.io` is blocked by the session proxy, so Terraform validate/test and Helm render run only in CI.
- Never edit an applied migration. The next migration is **0054**. C-W0 code findings (C-W0-4/6/7) and C-W1-1…4 are all delivered. Re-raise the Dependabot bumps (closed vikashkaruna/Proof#32–#36) against staging.

## Next in plan order

1. **W3**: C-W3-5 resumable company → estate → inventory → connector/grant → readiness wizard; C-W3-6 sustenance/re-attestation; the W3.5 `/estate/graph` page.
2. **W4.4**: grant model enforcement per invocation, portal grant/revoke UI and ledger events. Then W4.5–W4.7.
3. **Cloud-gated, when authorized:** secret publication/replication, effective IAM allow/deny evidence, private TLS/DNS, opaque scheduler, and real GCP IIT/caller/KMS/Mumbai recovery. Also W0 remote parity, C-W0-5 deployed IAM, and the EKS CIDR decision.
4. **Follow-up hardening:** Helm `web` and `marketing` deployments still inject `SUPABASE_SERVICE_KEY`, which neither app reads.

## Invariants

Preserve all of the following:

- Tenant-bound approval requires a completed dry-run and a validated rollback.
- Sudhaar has no write credentials.
- The ledger is append-only.
- Evidence uses WORM (Object Lock Compliance mode).
- Personal data stays in Mumbai.

Public APIs remain on Cloud Run. Each tenant gets a dedicated private Mumbai runner, and the issuer is separate. Local success and a completed engineering milestone do not imply whole-roadmap completion or deployed cloud acceptance.
