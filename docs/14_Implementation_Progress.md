# W0 → W1 → W2 → W3 implementation progress

Started 20 September 2026 with authorisation to implement in order and commit/merge/push each verified milestone to staging. Goal remains active until the complete acceptance criteria are proved. Revision 9 review/handoff documents are the starting requirements, not a claim of current completion.

Two models alternate on this repository, each from its own worktree, so a worktree path or branch named in a milestone below is where that milestone was delivered and not where work happens now. This file was opened from `/Users/vikash/.codex/worktrees/w0-w3-closure/Axiom Proof` on branch `codex/w0-w3-closure`, resumed from staging `5a4d6a0`, where analyst migration 0015 was committed. For current status read [Doc 11](11_Phase0-5_Gap_Closure_Plan.md), whose newest revision section is the current checkpoint, and [Doc 15](15_Session_Handoff.md); the most recent reviews are [audit 07](audits/07-staging-integration-review-2026-09-21.md) and [audit 09](audits/09-reviewed-approval-snapshot-2026-09-21.md). Milestone narratives below describe their original delivery and are not restated as current.

## 21 September — W0 deployed-target acceptance and scoped SSR configuration

Reviewed staging `d386fad` (CI 35628480541 green); no new upstream work. Delivered explicit HTTP/API and browser targets, private deployment-bound personas, real API MFA enrollment, exact BFF/SSR revision checks and successful-result comparison. Automatic CI now exercises production BFF/web/marketing containers under preprod and production configuration; the separate manual workflow compares two remote deployments. Review also removed SSR's service-key requirement and ambient frontend hints that waived backend validation. Docker workspace dependencies/private-context exclusions are fixed. Follow-up review replaces Cloud Run placeholder Auth bindings with the managed secrets and adds a per-resource regression gate (Terraform validate and three negative mutations pass). Marketing durable gap-scan storage and shared Cloud Run IAM remain explicit engineering findings; the browser suite does not prove that persistence.

Validation: 59 browser journeys in each of two local production-container configurations, matching API suites, 59 original dev-server journeys, 309 BFF and 54 config tests, 24 harness checks, workspace tests/typecheck/lint and security gate. Final exact merge CI is recorded in the ignored session checkpoint. No remote deployment is claimed. Migration tip remains 0035. [Review 17](audits/17-deployed-acceptance-review-2026-09-21.md), [operator guide](17_Deployed_Acceptance.md), and Docs 11/15/16 carry the remaining gates.

## Delivered milestones

| Milestone                           | Staging commit | Evidence                                                            |
| ----------------------------------- | -------------- | ------------------------------------------------------------------- |
| Review baseline and ordered handoff | `87e8c5b`      | Fast-forwarded and pushed to remote staging; no application changes |

## W0 milestone: direct-client and invocation authority

Committed as `207957b` and pushed to staging. Its CI run `35506935027` failed fetching the database image from public ECR (rate limit), before database tests ran:

- Append-only migration 0016 removes client write authority from domain/safety tables, protects internal identity columns, removes blanket internal cross-tenant RLS bypass and preserves safe profile bootstrap.
- Ledger mutations remain through `append_ledger`; service-role direct writes are denied and ledger_writer retains INSERT-only privilege.
- Generic agent invocation validates tenant/engagement, enforces capability/internal-agent boundaries, refuses direct Karya calls and fails closed if its run cannot be persisted. Raw request inputs are no longer stored in run metadata.
- Disposable PostgreSQL runner applies the complete migration series and tests direct client privileges/RLS. Auth/Storage are contract fixtures in this suite; it does not replace real-auth E2E.
- CI now triggers on staging as well as main and gates later jobs on database security tests. Web ESLint rejects service-role imports.

Local evidence: BFF 127 tests pass; BFF typecheck passes; real PostgreSQL fresh migrations and denial assertions pass. The positive ledger-RPC regression also passes; web lint, security/control gates and diff whitespace checks pass. Historical review documents were formatted to satisfy the repository CI gate.

## W0 milestone: durable idempotency

Committed as `2834f9d` and pushed to staging. CI [35507335231](https://github.com/vikashkaruna/Proof/actions/runs/35507335231) is green for the full configured lane (including database security, lint/typecheck, TS/Python tests and security scan). The eight-session database race admits exactly one claim.

Migration 0017 adds the previously missing request-claim store and service-only RPCs. The BFF now claims a key before running a mutation, binds it to user/tenant/route/body/query/role/scopes/session, rejects competing or conflicting uses, and replays only completed results. Database failure cannot silently disable this gate. Expired or interrupted claims are retained and refused, not automatically re-executed; operational reconciliation of interrupted requests remains necessary. Response bodies may contain sensitive results and require the planned retention/cleanup policy.

Verification: 132 BFF tests and typecheck pass. Fresh PostgreSQL migrations, client-authority and claim/replay assertions pass. The database runner now uses the pinned Docker Hub image with the same-version ECR mirror as a download fallback, addressing the first milestone's infrastructure-only CI failure. This suite uses real PostgreSQL roles/RLS with Auth schema fixtures; real JWT/E2E parity remains open.

## W0 milestone: atomic, entitled onboarding

Committed as `f532aae` and pushed to staging. Full configured CI [35507651395](https://github.com/vikashkaruna/Proof/actions/runs/35507651395) is green. Multi-session tests create exactly one organization at quota 1 and allow exactly three attempts at rate limit 3.

Migration 0018 adds service-only, time-bound onboarding entitlements, a shared fixed-window rate limiter and saved DPO/proposed-system intake. The BFF calls an atomic transaction for tier/quota checks, tenant + owner + initial assessment + intake + genesis ledger. The published library must match the BFF version and contain the declared control count. No live entitlements were granted. [Operator setup and interrupted-request handling](audits/05-w0-operations.md) are documented for deployment.

Verification: 141 BFF tests and typecheck pass; real PostgreSQL tests prove entitlement/tier/expiry/revocation refusal, completeness checks, saved intake, quota/rate limits and full rollback when the ledger fails. W3 estate normalization remains pending; submitted systems are retained as proposals and no longer echoed as connected inventory.

## W0 milestone: credential wiring and expiry gates

Committed as `6aff4bd` and pushed to staging. Full configured CI [35508723074](https://github.com/vikashkaruna/Proof/actions/runs/35508723074) is green.

The BFF MFA encryption key is wired through Compose, Helm, Secret Manager/Terraform and environment sync. Hardened configuration refuses Supabase placeholders and MFA/signing-key reuse; preprod internal secret defaults are generated and persistent. The production Compose topology/dependency issue found during validation is corrected. Missing, malformed and expired dry-run timestamps now block approval and execution before token consumption.

Verification: 44 configuration tests and 147 BFF tests pass, with BFF typecheck green. Preprod Terraform initialized with backend disabled and validates; no plan/apply or secret rotation occurred. Staging, preprod and production Compose configuration checks pass after correcting the production overlay’s pre-existing dependency on a disabled Temporal service. Helm template wiring is reviewed but Helm is not installed locally.

User direction: local Docker Desktop hosts the isolated real Supabase parity stack; higher-environment scripts must dynamically provision Supabase. Implementation of that deployment/parity path is next.

## W0 milestone: real local Auth/PostgREST parity and migration runner

Committed as `2a75c15` and pushed to staging. Its real Auth/PostgREST parity CI job passed. The separate migration-runner regression job exposed a missing `rg` executable on the Ubuntu runner; assertions were switched to portable `grep`, with a follow-up CI run required for the complete lane.

An isolated Docker Desktop Supabase project `axiom-w0-parity` is running on API port 56321 (database 56322). Existing `axiom-proof` and other local projects were preserved. `scripts/start-parity-supabase.sh` starts this project without demo seeds; credentials/logs remain in ignored, protected `.axiom-runtime/parity` state.

The real startup found an incompatibility hidden by SQL fixtures: historical migration 0000 touches Auth-owned tables and cannot run under the CLI's restricted migration role. `scripts/migrate-database.py` applies unchanged files after Supabase initializes, using its administration role. It serializes runners, records source checksums, makes each migration/tracker write atomic and refuses changed history. Database regressions prove second-run no-ops, checksum refusal and rollback of injected failing DDL. No applied migration was rewritten.

`scripts/test-strict-parity.sh` passes locally across staging, preprod, production and onprem labels, using the real complete BFF middleware chain against real password sessions and PostgREST/RLS. Every label produces identical outcomes for absent/synthetic authentication, takeover cookie, own-tenant reads with real engagement rows, foreign-tenant/resource denial, direct self-promotion refusal, viewer invocation refusal, owner MFA quarantine, mandatory idempotency, durable replay/conflict and missing-entitlement refusal. This covers an API security matrix; browser persona journeys and full real MFA enrolment/step-up remain W1 acceptance work. The CLI stack is local test infrastructure, not a claim of cloud deployment.

A new required CI lane runs this matrix on an isolated Supabase stack. Higher-environment dynamic provisioning and replacement of legacy fail-open deployment scripts remain next; the new local runner alone does not fulfill that part of the user's instruction.

## W1 milestone: self-managed MFA, login enforcement and persona gating

Committed as `c814f7b`, `9be5ffd` and `2c54fcd`, all on staging. These precede the W0 milestones above in history; they are recorded here because the handoff document covered only the W0 lane.

RFC 6238 TOTP is self-managed end to end: enrolment, activation, revocation, challenge and verification endpoints in the BFF, with factor secrets encrypted at rest under a key configuration refuses to share with the approval signing key. Replay is closed three ways, because one mechanism would not cover all three cases — a factor's `last_used_counter` refuses a re-used time step, a challenge binds the payload it was issued for (`bound_payload_sha256`), and a verified challenge is consumed (`consumed_at`). Plan approval requires a fresh step-up bound to the plan, the sorted action ids and the mode; that gate runs last, after every eligibility check, so an ineligible approver is refused before being asked for a code rather than after.

Login enforcement quarantines a session whose role requires MFA. The refusal happens before the idempotency key is claimed, so a quarantined request does not burn a key it will never complete; the MFA endpoints stay reachable, or the quarantine would be inescapable; and a user with no factor is told to enrol rather than to verify. The web tenant switcher reads real memberships under RLS, and pages render per persona. Six `(app)` pages were found bypassing `requireTenantContext` — `/ledger`, `/plans/[id]`, `/portal`, `/settings` and both `/engagements` routes — which made the login gate itself bypassable; all six were migrated.

Founder decisions recorded during implementation: step-up is required of everyone unconditionally, with no risk-scored exemption; TOTP and recovery codes only, with email OTP deferred rather than planned; a session attestation lasts 12 hours (`AXIOM_MFA_SESSION_TTL_HOURS`, default 12); a user without an enrolled factor is quarantined until they enrol.

## W1 milestone: the axiom_analyst persona against the 0016 boundary

Committed as `dc901e9`. The plan defines eight personas and the enum shipped with seven. The absence was not cosmetic: `WORKBENCH_ACCESS` had exactly one holder, so every analyst either worked as the founder or did not work at all, and the ledger recorded the founder's identity for work they did not do.

Migration 0015 adds the enum value and nothing else, which is the whole point — 0016 made every client-side tenant read membership-bound and removed the blanket `is_axiom_internal` RLS bypass, so an analyst reaches a client tenant the way anyone else does, by holding a `tenant_users` row in it. `MULTI_TENANT_READ` was deliberately _not_ granted; cross-tenant read remains founder and partner only, and the existing test asserting that passed unchanged. A hand-written refusal list in the RBAC tests had silently excluded the new role, so it is now derived from `rolesWith(Capability.PLAN_APPROVE)` and cannot drift again.

## Tooling: the local deploy no longer succeeds on a failed migration

Committed as `45b0131`. `scripts/dev-docker.sh` ran `pnpm db:migrate || true`, which invokes `supabase db push` — a command that cannot succeed here, because migration 0000 creates roles and writes to the Auth schema under a role the CLI does not grant. Every local deploy therefore skipped every migration and reported success. It now uses the checksummed runner, and refuses a database that has tables but no migration history rather than applying the series on top of unknown state. The guard was verified against the real local `axiom-proof` project, which has 23 public tables, no tracker and none of the 0015–0017 objects.

## W7 milestone: the runtime cites the rules we published (R-06)

Committed as `0c76028`, CI [35512887576](https://github.com/vikashkaruna/Proof/actions/runs/35512887576) green. The TypeScript control library and the Python runtime's `controls.json` had drifted, so an agent could cite a rule number the published library did not carry. `controls.json` is regenerated from the library, a `Control library TS → runtime parity` job fails CI on any future drift, and a second generator (`services/agent-runtime/scripts/build_controls_json.py`, which parsed TypeScript with regexes) and an unimported `control_library.py` that silently fell back to a single control were deleted rather than fixed.

Correcting this exposed an error of my own from the earlier W7.1 work: I had re-mapped the structured `citations` against the Gazette and left stale rule numbers in the `obligation` prose of twelve controls. All twelve are corrected, and a per-control test now asserts prose and citations agree.

## W5 milestone: a batch can execute, and a refusal is visible (R-04, R-05)

Committed as `00fdd13`, CI [35513637410](https://github.com/vikashkaruna/Proof/actions/runs/35513637410) green.

R-04: the execute route consumed the approval token and claimed actions in separate statements, so two concurrent requests could both claim. Migration 0019 adds `claim_plan_execution`, which consumes the token and claims the actions in one transaction and returns a decision rather than raising, plus `execution_request_key` / `execution_claimed_at` / `dispatch_status` columns. The duplicate-key failure was reproduced against real PostgreSQL before the fix and the regression suite `tests/database/execution-claims.test.sql` covers it after.

R-05: the BFF dispatched camelCase fields to a runtime whose Pydantic model declared snake_case with `extra="forbid"`, so every dispatch was rejected — and neither side's tests could catch it, because each was internally consistent. Both are now pinned to `tests/contracts/execution-dispatch.v1.json`, asserted from TypeScript and from Python. Aliases were deliberately not added to the model: accepting both spellings would hide the next mismatch instead of failing on it. The response now distinguishes `dispatch_failed` from `accepted`, so a refused dispatch is visible to the caller rather than reported as success.

## W5 milestone: the executor reads the stop (R-09)

Committed as `b85e84b`. Migration 0009 put the kill switch in shared state and the BFF checked it on request _admission_; nothing in the Python runtime ever read it, so a batch already dispatched ran to completion however many times an operator engaged the stop. FR-8.6 requires "immediately effective", and admission cannot deliver that.

`axiom/kill_switch.py` reads the same rows from inside the runtime, with a two-second TTL — the propagation bound for an emergency stop — and fails **safe**: a state it cannot read is treated as engaged. That is the opposite of how authentication fails here, deliberately; a failure to read authentication withholds authority, a failure to read the kill switch withholds action. Karya checks it twice, once before starting and again after token verification immediately before the mutating step, because verification reaches the network and time passes. The halt outranks every other refusal, including "approval token required", so an operator watching an incident is not told the stop failed to take effect.

Not done, and not decorated to look done: the Temporal chunk-boundary check, because that workflow's execution stage is still a comment; cancelling queued work; connector-level safe interruption. SEC-4 remains partially open — Karya is a stub, so this cannot yet be proved by halting a live batch and auditing it.

## W1 milestone: three R-08 gaps in the approval threat boundary

Committed as `2d8ba71`. The serious one: `concurrency` and `stopOnFailure` live inside the HMAC-signed token spec, and the execute path read them from the request instead. An approver could sign "one at a time, stop on first failure" while the caller ran twenty at once ignoring failures, on the same token — a token that _looks_ like it bounds blast radius and does not. A mismatch is now a 409 `execution_settings_mismatch` raised before the token is spent. Signed values that are absent are treated as unbound, since the spec is signed and a caller cannot drop a field.

Second: `mfa_challenges.max_attempts` bounded guesses against one challenge, and the way around it was to open another. Account-wide issue and verify budgets now survive a fresh challenge, reusing the 0018 rate limiter rather than inventing a second one, and the verify budget is charged before the challenge is looked up so guessing at a non-existent id is not free. Both fail closed when the limiter cannot be read.

Third: the approval binding did not cover which revision was approved; `planVersion` is now part of it. Still open: per-action diff and rollback-definition hashes — plan version is a coarse proxy, and pinning the dry-run diff the approver actually read belongs with the real executor — plus session/IP challenge budgets and an operator-facing document for the role MFA policy.

## W8/W9 milestone: unverified WORM claims, and the gaps CI never looked at (R-10, R-11)

Committed as `6e5aa61`.

R-10: `seal()` returned `lockMode: 'COMPLIANCE'` on every path, including GCS, where no lock header is sent and the S3 API cannot read a bucket policy back. A sealed artefact asserted compliance-mode retention that had never been established. There are now three assurance levels rather than two, because `asserted` — configured, not readable back from here — is a different fact from `verified`, and collapsing them is what produced the original label.

R-11: `services/bff` linted via `echo 'no lint config'`. The package that decides every authorisation in the product was the one package static analysis never examined, and `pnpm lint` reported success for it on every run. It is now wired, and immediately found a `console.log` outside the logger, bypassing the logger's redaction. `--passWithNoTests` was removed from nine packages that have tests, where deleting a suite would have turned CI green, and `@axiom/supabase` — which had none — gained eleven tests for `sessionIdFromAccessToken`, a function every caller treats as an attestation check.

## W5 milestone: the durable dispatch outbox

Committed as `5a4d6a0`, full CI [35514833045](https://github.com/vikashkaruna/Proof/actions/runs/35514833045) green across every configured job, including fresh migrations, direct-client RLS, real Auth/PostgREST strict parity, control parity, lint/typecheck, TS and Python suites and the security scan.

0019 made the claim atomic; it did not make it survive the BFF dying between claim and dispatch, which leaves the token spent, the actions in `executing`, and nothing holding the intent. Migration 0020 writes an outbox row in the same transaction as the token consumption — the only arrangement in which "we took the token" and "we owe a dispatch" cannot disagree — and records delivery separately, because delivery is the half that can fail. The old five-argument `claim_plan_execution` is dropped rather than replaced: `create or replace` with extra defaulted parameters creates an overload, and the existing five-argument call would then be ambiguous, which Postgres refuses outright.

No worker drains the outbox. Until one exists an operator reads `public.pending_execution_dispatches` and decides, which is deliberately better than an automatic retry nobody has designed: the actions carry an approval token that was already consumed, so a redelivery is a decision about a client's production estate, not a cron job.

## Remaining acceptance work — do not mark whole workstreams complete yet

**W0:** the deployment path is now fail-closed and reads its `.env`, and the self-hosted Supabase topology is proved against real GoTrue and PostgREST in CI. What remains is the part only a real deployment can establish: an actual preprod apply, deployed verification of the operational tables/idempotency/onboarding controls, live secret verification, shared in-flight halt/guard tests, verified evidence retention and the required security regressions. Nothing in W0.1 has been applied to GCP; local policy tests and a local topology rehearsal do not prove deployed parity.

**W1:** the analyst persona, role enforcement, the RLS/session-MFA boundary, TOTP + recovery delivery, the session and address challenge budgets, and the per-action content binding are done and on staging. Remaining: MFA key rotation and deployment, strict persona E2E in a browser, the eight PRD B.10 scenarios, and an operator document for the role MFA policy. Default analyst access remains assigned tenants. Email OTP is deferred by founder decision, not planned.

**W2 (after W1):** complete every table/model slice listed in Doc 11, migration upgrades, scoped relationships and RLS, action/batch identity, data retention and schema/runtime contracts. Do not recreate regulatory/MFA tables already present.

**W3:** estate/onboarding and live ER graph as capacity allows after W0–W2. No claim of completion yet.

**Decisions the founder has now made:**

- **Outbox redelivery — a fresh approval, always.** No worker re-dispatches anything. An operator records a judgement and, where that judgement is "this did not run", the actions return to `approved`; the consumed token is not restored, so approving again is the only way back. Implemented in 0023.
- **Ingress trust — configured per environment, off by default.** `AXIOM_TRUSTED_PROXY_HOPS` decides whether a client address can be trusted enough to rate-limit on. 0 disables address budgets rather than trusting a caller-supplied header. Topology in configuration, posture constant, per W0.0.

**Decisions the founder still holds — no further code should assume an answer:**

- **Locking a real evidence bucket.** Irreversible, and a deployment decision. No bucket is locked and no retention mode has been validated against a deployed provider, so R-10 stays open whatever the code asserts.
- **A named human sign-off for the control-library citations.** `verifiedBy: 'Axiom Minds · Founder'` is an attributed string, not a recorded sign-off. R-06's remainder also includes migration 0011's baseline/provenance tables, which the seed leaves unpopulated, and nullable instrument/baseline hashes.

Push without force; re-fetch staging and preserve any concurrent changes before each integration. No deployment or irreversible bucket lock has been performed so far.

## Follow-up review: execution claims, delivery uncertainty and runtime halt

The review of `5a4d6a0` reproduced a remaining R-04 race: two different issued tokens both returned `claimed` for the same actions. The old tests covered sequential contention only. Forward-only migration 0021 locks the plan and requested actions before checking state, rechecks readiness and token expiry/scope under those locks, refuses empty/duplicate action lists, and preserves one durable intent. A two-session regression now observes one winner and leaves the competing token issued. Existing intents never authorize a second dispatch.

The runtime `/internal/execute` stub now explicitly refuses with 501/`accepted: false`; it previously acknowledged responsibility while only logging. The BFF requires a typed, correlated acknowledgement with a durable reference. A lost, malformed or inconsistent acknowledgement produces `dispatch_unknown`, retains the action claims and remains visible for reconciliation. Explicit refusal can release claims, but still consumes the original token. New `finish_execution_dispatch` records action/outbox outcomes atomically and prevents late failure from downgrading confirmed delivery. The public response schema includes both new dispatch outcomes.

The runtime kill reader's constructor failure selected a clear in-memory switch, contradicting its fail-safe documentation. URL-based memory selection also bypassed real local Supabase. Both are removed; explicit test injection remains possible. Invalid response shapes halt too. This closes the discovered fallback defect, not the absent live Temporal/connector interruption workflow.

Verification: 172 BFF tests, BFF typecheck/lint, 91 Python runtime tests, full fresh database/migration and concurrent suites pass. The isolated local Supabase upgraded through 0021 and passed all four strict topology labels. These labels exercise the same local stack and do not prove higher-environment provisioning. Runtime tests require `uv run --extra dev pytest`; without the dev extra the host Python's pytest was selected and failed collection before tests ran.

Remaining work is recorded in [audit 06](audits/06-resumed-implementation-review-2026-09-20.md). W0, W1 and W2 remain partial; no live client estate execution or irreversible evidence bucket lock occurred.

The follow-up execution/kill-switch milestone was committed and pushed to staging as `ccbb60b`. CI [35518756206](https://github.com/vikashkaruna/Proof/actions/runs/35518756206) passed the database race/security gates but failed during Supabase startup, before the parity tests. The protected startup log was not retained by that runner, so its underlying cause is not established. A subsequent change emits only fixed diagnostic categories and container health, never generated credentials. Full CI success remains required.

## Follow-up review: evidence sealing requires provider readback

Both TS and Python vaults now check bucket Object Lock configuration, request COMPLIANCE retention and read it back for the exact uploaded version before returning sealed proof. Missing/short/GOVERNANCE retention, missing versions, failed uploads and unconfirmed requested legal holds fail. Caller metadata cannot overwrite reserved evidence identity/assurance fields. The Python local upload-error fallback, which fabricated a COMPLIANCE result without stored evidence, is removed.

GCS sealing now fails before upload until a native verified retention adapter exists. This is an intentional fail-closed limitation: the S3 client has no evidence that GCS retention is configured or locked, and the current preprod bucket is explicitly unlocked. Existing records may still carry the earlier assurance levels; they must not be relabelled verified. Upload metadata says `unverified` because it is written before readback; the returned seal reports the subsequent verification and exact version. Native provider IAM adds the three readback permissions. No IAM apply, bucket creation, irreversible lock or production upload occurred.

Verification: 17 TypeScript evidence tests and typecheck pass; all 99 runtime tests pass, including eight new retention/failure tests. Tests mock provider responses and do not constitute deployed WORM proof. GCS adapter, controlled provider smoke test and retention deployment remain R-10 acceptance work.

## Follow-up: the dispatch RPCs 0021 left behind, and the last R-08 code items

Six commits, `94f2d2f` through `3c24250`, all on staging with CI green.

**`94f2d2f` — the superseded dispatch RPCs are dropped (0022).** 0021 replaced 0019's `record_execution_dispatch` and 0020's `settle_execution_dispatch` with `finish_execution_dispatch`, and moved the BFF onto it, but left both in place and still granted to `service_role`. A dead grant on a security-definer function is not inert. `record_execution_dispatch` releases a claim on ANY 'failed' status — actions back to `approved`, request key cleared — with no plan lock, no delivered-guard and no outbox coupling, which is exactly the behaviour the correction removed, and it cannot tell a refusal from a timeout because the caller hands it the status. `settle_execution_dispatch` marks an outbox row delivered without touching the actions; since `finish_execution_dispatch` only acts on a row in ('pending','unknown'), a row settled out of band makes the real outcome arrive, find nothing, return false and vanish. The SQL suite had also been asserting the retired semantics as desirable, so it was green while pinning the design that had just been corrected; those assertions now run against `finish_execution_dispatch`, and a new one reads `pg_proc` by name — not by signature, because `drop ... if exists` with a mistyped signature is a silent no-op.

**`c5dba37` — the approval binding covers action content (R-08).** `planVersion` closed the case where a plan was revised. It could not close the case where the version never moves and an action is rewritten in place, and `trg_actions_approved_immutable` only locks an action's definition once `approval_status` is already approved, so everything an approver reads stays writable until the approval lands. Read parameters X, raise a challenge, let someone rewrite the action to Y, submit the code: planId, actionIds, mode and planVersion are all unchanged, the binding matches, and Y is approved and _then_ frozen. The binding now carries a SHA-256 over each action's `action_type`, `parameters`, `rollback_definition`, `closes_finding_ids` and dry-run diff, computed from the database at both ends and never from the request. Canonicalisation sorts object keys, preserves array order — a parameters array is often ordered — sorts `closes_finding_ids` because that one is a set, and normalises undefined to null. Risk fields are excluded deliberately: they describe rather than define, and a background re-scoring must not invalidate an approval in flight. With the digest removed from the hash, rewriting `parameters` after a satisfied challenge returns 201 with a signed token; that is the defect, reproduced.

**`c37c595` and `077ce83` — the remaining challenge budgets.** Per-session budgets (10/hour, charged before the account's) stop a stolen session draining the account allowance and locking out a user whose credentials are fine. Per-address budgets (200/hour, deliberately loose because an address is often a whole office behind one NAT) catch the case neither can see: one attacker spraying across many accounts, each staying inside its own budget. The address half needed a decision rather than a patch, because `x-forwarded-for` is caller input unless a known proxy overwrites it, and keying a limiter on it unvalidated lets a caller name a victim's key. `AXIOM_TRUSTED_PROXY_HOPS` is wired through Compose, Helm and every `.env` example and defaults to 0, which disables the address budget rather than trusting the last entry. The client address is `parts[parts.length - hops]`; the first implementation had this off by one, which with one proxy returns the attacker's value, and ten spoof tests now pin it. The rate-limit subject is a hash, not the address: `request_rate_limits` rows are never swept. That is pseudonymisation, not anonymisation — 2^32 is exhaustible — and making it irreversible needs a secret this service is deliberately not given.

**`3c24250` — operator reconciliation (0023).** An `unknown` dispatch retains its claim, correctly, and nothing could then ever clear it. Reconciliation records a human judgement: `released` asserts the work did not run and returns the actions to `approved` without restoring the consumed token, so approving again is the only route back; `abandoned` closes the intent and leaves the actions alone, which is the honest outcome for a batch nobody can account for. A delivered intent is reconcilable by neither. `EXECUTION_RECONCILE` sits with founder and owner, the roles that can release the emergency stop, and the judgement goes to the ledger as well as the row.

Verification across the six: full 0000–0023 on real PostgreSQL, six SQL suites and three concurrency suites; 248 BFF tests, up from 172; typecheck 15/15, lint 15/15, format, env-security and controls-drift gates, and all three Compose topologies validate. Every fix was mutation-tested — the drops, the content digest, the session charge, the extraction index and the token-restore path each fail the suite when reverted. No deployment, no bucket lock, and no execution against a client estate.

## W0.1 milestone: a deployment that stops when it cannot deploy

Three commits — `716430e`, `66885c5`, `9d59e00` — on staging with CI green, including two new gates and a new topology job. Founder decisions recorded first: higher environments self-host Supabase rather than using Supabase Cloud; nothing billable or irreversible was to be touched, so no GCP resource was created, read or modified and `terraform validate` is as far as this went.

**The deployment path was fail-open at every step, and the steps that failed reported success.** `migrate-cloudsql.sh` applied each migration with psql, retried once, `|| true`'d the result and printed "✓ Applied" regardless — a failed migration was a successful deploy. It kept no history so it re-ran every file every time, and `|| true`'d all three seeds including the statutory control library. The checksummed runner only spoke `docker exec`, so the deployed path had no runner at all; it gains `--dsn`, which parses the URL into libpq `PG*` variables rather than passing it as an argument, because an argument is visible in `ps` to every user on a deploy runner. TLS defaults to `require` rather than libpq's `prefer`, which silently falls back to plaintext, and both modes pass `-w` so a migration cannot block forever on an invisible password prompt. Phase 8 printed "PIPELINE COMPLETE" unconditionally: an unreadable BFF URL skipped the health probe, an exhausted twelve-attempt probe fell out of the loop, and both reached the same green banner, which then printed a literal `<hash>` placeholder as though it were a deployed URL.

**Terraform variables were mapped by hand and covered 15 of 23.** The rest took Terraform defaults silently. `mfa_encryption_key` was among them, so an operator who set `AXIOM_MFA_ENCRYPTION_KEY` in `.env.preprod` — exactly as the template instructs — had it ignored while Terraform minted a different key into Secret Manager; nothing failed, because the BFF received _a_ valid key and the operator's key management simply referred to the wrong secret. `retention_days` had no environment key at all, so an evidence bucket could be created with a 7-day COMPLIANCE lock while the product documented seven years, and compliance mode cannot be shortened by anyone afterwards. `terraform.tfvars` is now generated from `variables.tf`, a declared variable nothing fills is an error, and `check-tfvars-coverage.sh` gates it. `production` also never matched its Terraform directory, which is named `prod`, so its variables were never written from `.env` and the miss read as "normal for local/staging".

**`sync-env.sh verify` exited 0 whatever it found**, so `all` went on to write Terraform and Cloud Run configuration it had just called incomplete. It is now a gate, with `--allow-simulated` for local and staging and never for preprod or production. `scaffold` appends template keys an existing `.env` is missing without touching set values, and `mint` fills the generated secrets in place — the Supabase three from one minting, because the anon and service keys are JWTs signed with the secret and mixing runs leaves GoTrue issuing tokens PostgREST rejects.

**Self-hosted Supabase had three answers and no implementation.** `cloudrun.tf` hard-coded `https://preprod-supabase.axiomproof.ai` while the Terraform provisioned only Cloud SQL; the `.env` template pointed at `<project-ref>.supabase.co`; `SUPABASE_DB_URL` pointed at a third place. The BFF's entire auth path depended on a host nothing served. Preprod now runs GoTrue, PostgREST and an nginx gateway as Cloud Run services against its own Cloud SQL.

Building that locally the way a deployment builds it — empty managed database, no `initdb` mount — found three defects that reading could not, each failing in a message that points elsewhere: GoTrue's MFA migration creates its enums unqualified, so without `search_path=auth` they land in `public` and a later migration dies on `type "auth.factor_type" does not exist` after sixteen tables already exist; migration 0000's hand-rolled `auth.users`, correct for the vanilla Postgres its comment describes, breaks GoTrue's chain partway, fixed by ordering rather than by rewriting an applied migration; and with no `GOTRUE_JWT_DEFAULT_GROUP_NAME` GoTrue emits an empty `role` claim, so PostgREST runs `set local role ""` and every authenticated request fails with a 400 that looks like a malformed query. The committed `docker-compose.supabase.yml` carried the first and third latently, and its `initdb` mount is the second, so that stack had evidently never been run against real GoTrue.

Verification: `tests/database/migration-dsn.sh` exercises the deployed migration path over TCP — TLS enforced, malformed DSNs refused, 24 migrations applied, re-run a no-op, edited history refused, a failing migration exits non-zero, and the deploy entrypoint refuses without a URL, without a reachable database, without the control library and refuses fixed-password identities in production. `tests/deployment/selfhosted-supabase.sh` builds the deployed Supabase shape against real GoTrue v2.169.0 and PostgREST v12.2.8 and asserts a sign-up produces a token PostgREST accepts, that a user belonging to no tenant reads nothing and that an anonymous caller reads nothing. Both run in CI and passed on a clean runner. Local, staging and onprem all pass `verify --allow-simulated` after one `mint`, and a second `mint` leaves every value untouched.

Not done: no GCP apply, so no deployed preprod, no live secret verification and no deployed WORM proof. Supabase Storage is not deployed — the bootstrap creates the schema contract migration 0007 writes against and nothing serves those buckets. The `storage` contract, the Cloud Run services and the gateway image are all unapplied artifacts until a real deploy runs them.

## 21 September integrated milestone: real MFA and managed deployment authority

Resumed from staging `ea27df9`, preserving the other model's action-content binding, session/address budgets, 0022 obsolete RPC retirement, 0023 operator reconciliation and self-hosted deployment work. Latest upstream CI [35531857076](https://github.com/vikashkaruna/Proof/actions/runs/35531857076) was green. The unfinished local MFA test work was stashed before fast-forward and then reconciled; both test additions were retained. Claude's remaining uncommitted deployment-guide edit was not touched.

- **0024:** explicit service-role policies allow the BFF's existing data authority without a superuser `BYPASSRLS` attribute. The stronger topology test first reproduced a service JWT reading zero rows from a known tenant; after the migration it reads and writes successfully. The SQL runner now removes BYPASSRLS in its disposable database before all security suites. Client grants and ledger direct-write revocations are unchanged. A first test-only approach using a new inherited probe role caused this image's server to disconnect; the final test uses the actual service role and passes.
- **0025:** reconciliation revokes other outstanding issued tokens overlapping a released batch. Previously an unused pre-reconciliation token was accepted as supposedly fresh. The new test reproduced that failure, then proved a genuinely post-release approval works. The ledger append now runs in the same transaction as release/outbox/token changes; injected ledger failure rolls all of them back. The HTTP route returns that transaction's correlation id and does not append a duplicate event.
- **W1:** execution enforces `PLAN_EXECUTE` independently of token possession. Approver/analyst/viewer and other non-executing roles are refused. MFA account/session limits now return 429 + Retry-After rather than masquerading as missing enrollment or an incorrect code.
- **Real Auth acceptance:** all four strict labels now exercise TOTP activation, encrypted factor persistence, recovery login, single-use recovery, session isolation, unconditional approval step-up, plan revision and same-version action-content changes, challenge consumption, valid-token viewer denial and issue/verify budgets. This uses real GoTrue/PostgREST and the full BFF middleware chain; no external action executes.
- **Deployment defaults:** self-hosted registration no longer auto-confirms arbitrary email identities because a mailer is absent. Public signup is disabled until a verified invitation/email flow is configured; operator-provisioned synthetic identities still sign in. Cloud SQL runtime URLs require TLS, matching the migration path. Terraform validates; no apply or cloud access occurred.

Local verification: 254 BFF tests, BFF typecheck/lint, complete fresh/upgrade SQL suites plus three concurrency suites and DSN/deploy failure tests pass. Self-hosted GoTrue/PostgREST rehearsal passes positive service access and client isolation. Real MFA parity passes all four labels through 0025. Format and Terraform validation are included before staging integration. [Doc 15](15_Session_Handoff.md) is the resume checkpoint; W0/W1/W2 remain partial.

## W1 milestone: issuing an approval is one transaction, or it is nothing

Committed as `14f18d3`, continuing from staging `8476d8c`. The [21 September review](audits/07-staging-integration-review-2026-09-21.md) named this as the next W1 safety slice, and [Doc 15](15_Session_Handoff.md) restated it: the content digest caught changes made before the route's read, but not the read-to-write race after it.

Seven round trips, each committing on its own — consume the challenge, sign, insert the token, link the challenge, mark the actions approved, move the plan, append the ledger. A fault between any two left a state nobody designed: a token persisted with the actions unapproved is live signed authority for work `claim_plan_execution` will refuse, on a plan nobody can move; a token whose challenge was never linked breaks the trail token → challenge → factor → user, which is the trail FR-7.3 exists to produce. The serious one is actions approved with the ledger append still to come — authority over a client's estate where the row says approved and the tamper-evident chain says nothing happened.

Migration 0026 makes everything after the step-up atomic, under the same lock order as `claim_plan_execution` and `reconcile_execution_dispatch`, so an approval and a claim for one plan cannot interleave. `action_set_content_digest` is recomputed under those locks and compared with the digest the route read, and eligibility is rechecked there too, because the route's reads can go stale before the write lands.

That function is SQL rather than TypeScript on purpose. Both ends of the comparison now use it, so they agree by construction instead of by two languages canonicalising JSON identically — the assumption R-05 disproved, and the one place this design could have repeated it.

**Challenge consumption stays outside the transaction, deliberately.** The review's sequence folded it in. Burning a step-up and then failing costs the approver a re-authentication, which is the safe direction; folding it in would mean a rolled-back issuance silently restores a spent challenge. This is a stated deviation, not an oversight, and reversing it is a one-parameter change.

Verification: full 0000–0026 series on real PostgreSQL. `tests/database/approval-issuance.test.sql` proves the digest ignores the order of the id array, that every refusal persists nothing, that work already in flight and a stale dry-run are caught under the lock, and — with a ledger failure injected by trigger — that a ledger outage leaves no token, no approved action, no moved plan and no linked challenge. Mutation-tested both ways: removing the digest check lets a stale digest issue a token, and removing the in-transaction ledger append lets an approval through with no record.

255 BFF tests, up from 254. The fake PostgREST models both new functions rather than stubbing them, so the route tests still assert behaviour rather than that a call was made; the ledger assertion now reads the ledger table, because that write legitimately moved out of the application. A new route test covers the window this closes — content moving after the route's read — and fails if the route ignores the refusal. Typecheck 15/15, lint 15/15, format, the full workspace suite, and the env-security, controls-drift and deployment-coverage gates all pass.

**Correction, same slice.** The first push of 0026 passed the disposable database suite and failed the strict parity lane. `action_set_content_digest` called pgcrypto's `public.digest`, and extensions are installed per database: Supabase pre-installs pgcrypto into `extensions` in the `postgres` database, while `scripts/test-database.sh` runs `createdb` and migration 0000 then installs it into `public` in that fresh database. The same migration therefore resolved on one stack and failed on the other, after every "Applying:" line had already printed. It now uses the built-in `sha256`, which has no extension or schema dependency, verified against the real `axiom-w0-parity` stack and the full four-label parity suite. This is the clearest return the parity lane has produced: a migration whose behaviour depended on which database it was applied to.

That fix was also reverted once by a footgun in `tests/database/migration-dsn.sh`, which ran `git checkout -- infra/supabase/migrations` to undo tampering only ever applied to a temp copy. The line was unnecessary and destructive, and its symptom was a checksum mismatch several steps later rather than anything naming the cause. Removed.

Not closed by this: action snapshot enforcement at the executor, which is still a refusal stub, so nothing yet proves the content approved is the content executed. Browser persona journeys, MFA key rotation and deployed acceptance remain where Revision 11 left them.

## W1 milestone: the claim enforces the snapshot the approver authorised

Committed as `0a3137f` and merged to staging as `369bcf7`; CI [35554182456](https://github.com/vikashkaruna/Proof/actions/runs/35554182456) is green across every configured job, with only the normally skipped container image build not run. 0026 verified the content digest when an approval was issued. Nothing downstream then checked it, so the approval token named **which rows** to execute and not **what they contained**.

The interesting part is how much of that gap was already closed, and by what. `trg_actions_approved_immutable` in migration 0004 freezes an approved action's `action_type`, `parameters`, `rollback_definition` and `closes_finding_ids`, so the executable definition genuinely cannot move after approval. It does not freeze `dry_run_result` — and the simulated outcome is precisely what the approver read before agreeing. Between approval and execution the diff could be replaced, without anyone breaking a constraint, and nothing noticed.

`tests/database/claim-snapshot.test.sql` establishes both halves against the live schema rather than reading the trigger's source: it asserts that rewriting `parameters` after approval raises, and that rewriting `dry_run_result` does not. If the trigger ever widens, that second assertion fails and someone has to think about it.

Migration 0027 puts the check where it belongs. `claim_plan_execution` already holds the action row locks, already spends the token, and is where actions become `executing`. It recomputes `action_set_content_digest` and compares it with the digest on the token — read from the persisted signed payload, never from the caller, which is why the function still takes no digest parameter at all. A token carrying no snapshot is refused outright: failing closed costs a re-approval, failing open executes content nobody agreed to.

The digest is now signed into `ApprovalTokenSpec`, so the token itself states what was approved, and the approve route reads it before signing rather than after. It is carried into the dispatch intent and onto the wire as contract **v2** — `content_digest`, required on both sides and pinned by the shared fixture that exists because neither side's own tests could catch R-05. The BFF refuses to dispatch actions it cannot name a snapshot for; `claim_plan_execution` makes that unreachable, and reaching it would mean the claim is not the function the route thinks it is.

Existing fixtures created tokens with empty signed payloads, which the new rule correctly refuses. They now take real digests from the same SQL function, so a fixture cannot drift from what the claim recomputes.

Verified: 0000–0027 on real PostgreSQL, nine SQL suites, three concurrency suites, 255 BFF tests, 99 runtime tests, typecheck and lint 15/15, format, and the env-security, controls-drift and deployment-coverage gates. Mutation-tested both directions — removing the digest comparison lets a replaced dry-run diff be claimed and executed, and making `content_digest` optional in the runtime model lets a dispatch through with nothing to verify against.

**What this does not do.** The executor is a refusal stub, so it records the snapshot rather than re-verifying against it. Recomputing there needs database access the stub does not have, and a check around a no-op would read as coverage while guarding nothing. Today's enforcement point is the claim — transactional, under the row locks, and stronger than a check in the executor would be — but it is not the same thing as the executor refusing, and the distinction matters for any Phase 3 acceptance claim.

## W1 follow-up: the reviewed snapshot must survive the gap between reads

Integrated staging `369bcf7`; its [CI run](https://github.com/vikashkaruna/Proof/actions/runs/35554182456) passed. Reviewed the 0026 atomic issuance, pgcrypto portability fix and 0027 claim-time snapshot changes against source and tests. Preserved their behavior, including the deliberate choice to consume MFA before the issuance transaction.

The remaining race was earlier than the 0026 test covered: the route consumed a challenge against action read A, then fetched a live database digest B and signed B. An edit after consumption but before the digest read became approved content, because the transaction correctly compared B with B. Parameter and dry-run-result regression tests both reproduced HTTP 201 before the fix; both now get 409 with no token or approval ledger entry. A plan revision moving in the same window is refused too.

0028 hashes the exact server-read rows used in the MFA binding through a pure SQL helper, retaining the 0026 digest format. A new reviewed-issuance entrypoint locks and checks the expected revision and plan eligibility, then calls the existing atomic transaction; direct service-role access to the old entrypoint is revoked. Existing signed token digests remain compatible. Missing revisions fail closed. Migration must precede BFF rollout; an old BFF using the retired entrypoint refuses issuance until upgraded.

Validation: 258 BFF tests and typecheck/lint; full 29-migration sequence, ten SQL suites, four concurrency suites and DSN/deploy refusal tests; all four real Auth/PostgREST MFA parity labels. The new concurrency test observes the issuer blocked on a writer lock before asserting its refusal, rather than merely running two sequential calls. Its initial fixture collided with the preceding execution test's email; the fixture now uses its own identity. No cloud resources or live estate mutations were involved. Final staging CI is checked after push.

## Documentation checkpoint: the index, and the links nobody could follow

No behaviour changed here. Recorded because the status documents cite each other by revision number and staging SHA, so every merge leaves some of them behind, and a stale pointer costs the next session real time.

The 0028 work above re-pointed Docs 11, 12 and 15 as it landed. What it did not reach was [Doc 00](00_README_Document_Index.md) — the index, and the first file a new reader opens. It still led with "Implementation status (20 September 2026)", pointed at **Revision 9**, sent the reader to [Doc 12](12_Implementation_Handoff.md) to resume — which has since been relabelled historical precisely so nobody does that — and carried no row at all for Doc 14 or Doc 15, the two files that hold current status. It now names Revision 14, staging `e5a830d` and its green CI, and lists Docs 14 and 15 with what each is for.

Two smaller contradictions went with it. Doc 12's "Read first" list still called Revision 9 the current plan, three lines under a banner saying everything below it was historical. And in Doc 15 the third founder decision — challenge consumption staying outside the issuing transaction — had lost its bullet marker in the 0028 edit, so the list read as two items and that text attached itself to the control-library citation bullet. It is a settled tradeoff rather than a pending decision, so it now sits with the other standing decisions, under its own marker.

One unrelated defect fell out of checking the links. [Doc 08](08_DEPLOYMENT_GUIDE.md)'s "Summary of Key Files" table linked all eight entries by absolute `file:///Users/vikash/Axiom%20Proof/...` URLs — one machine's main checkout, which resolves for no other reader and from no worktree of this repository. They are repo-relative now.

Verified: a link check over `docs/*.md` reports zero unresolvable relative targets, where it reported eight before; `pnpm format:check` is clean across the repository; the env-security, controls-drift and deployment-coverage gates pass. `docs/11_Phase0-5_Gap_Closure_Plan.md` is in `.prettierignore` by design — prose, not code — so it is formatted by hand and `format:check` does not cover it.

## W1 milestone: rotating the MFA encryption key without locking everyone out

Two pieces: verifying 0028 rather than inheriting it, and then the rotation gap it named as next W1 work.

**0028, checked rather than accepted.** Reverting the approve route's digest source to a live post-MFA read fails exactly three tests — the parameter edit, the dry-run edit, and the existing post-read race — so the regression tests pin the fix rather than decorate it. The claim worth checking independently was byte compatibility: `action_set_content_digest` now round-trips through `jsonb_to_recordset`, and 0027 compares a token's stored digest against a fresh recompute, so any disagreement would make every approval token issued before 0028 permanently unclaimable, presenting as `content_changed` on content nobody had touched. Rebuilding the 0026 implementation under a second name and comparing on adversarial content — deep nesting with non-insertion key order, non-BMP emoji with ZWJ, combining marks, embedded quotes and control characters, `1.00` / `0.1000` / `1e3` / a 23-digit integer / `-0.0`, and `'null'::jsonb` in every jsonb column — produced identical digests for every row, every subset, the empty set and a duplicated id list, while still detecting a real edit. The other three `consumeChallenge` call sites bind to stable identifiers the following operation uses directly, so no read-after-consume window exists there.

**The rotation gap.** `AXIOM_MFA_ENCRYPTION_KEY` could not be rotated. A TOTP secret has to be recoverable to check a code, so every enrolled factor is sealed under that key, and the `v1` envelope recorded no key identity. Replacing the key therefore did not degrade service — it locked out every enrolled user at the same instant, and each lockout was indistinguishable from a wrong code. The operator policy told readers not to do it, and `sync-env.sh` warned that rotating "makes every enrolled authenticator undecryptable". Both were accurate descriptions of a missing capability.

The envelope is now `v2$<keyId>$<iv>$<tag>$<ciphertext>`. The id is a hash of the key material, domain-separated from the key derivation, so it can sit in a row or a log line without being a step towards the key it names. The BFF reads a ring: `AXIOM_MFA_ENCRYPTION_KEY` seals new and rewrapped secrets, `AXIOM_MFA_ENCRYPTION_KEYS_PREVIOUS` lists keys that may still be read. A factor sealed under a retiring key verifies normally and is rewritten under the primary key on the next **successful** verification — never on a failed one, which would let anyone who can reach the endpoint drive writes against an account they cannot authenticate as. Rotation drains at the pace people log in, and no step decrypts the whole table into one process. Pre-ring `v1` envelopes are opened by trying each key in turn, which is only safe because GCM authenticates: a wrong key fails its tag rather than returning a different plausible secret.

A secret no key on the ring can open returns `secret_unreadable` and **HTTP 503**, not a rejected code, and is logged with the missing key id. That distinction is the whole point — collapsing it is what would hide a broken rotation inside ordinary failed-login noise, and the user is told it is our fault rather than being blamed for a code we could not check. A rewrap that fails to persist is logged and ignored: the secret is still readable under its old key, so the cost is one more login before it moves, where failing the verification would turn housekeeping into a lockout.

**Operator path.** `MINT_FORCE=true ./scripts/sync-env.sh <env> mint` now captures the outgoing MFA key and carries it onto the retiring list instead of orphaning every factor, and `verify` reports how many retiring keys are still on the ring. The new variable is deliberately **not** in `required_keys`: empty is the normal state and that gate treats empty as missing, so listing it there would have broken `verify` in every environment with no rotation in progress. The env templates, all four Compose topologies, the runbook and the MFA operator policy were updated together.

Verified: 268 BFF tests (up from 258), 161 `@axiom/mfa` tests, 100 runtime tests, typecheck and lint 15/15, format, the env-security, controls-drift and deployment-coverage gates, and all three merged Compose topologies. The mint carry-over was run end to end against a real env file, which was restored byte-for-byte afterwards and checksummed to prove it. Mutation-tested three ways: removing the rewrap leaves secrets on the retiring key, reporting `code_rejected` instead of `secret_unreadable` loses the operator signal, and rewrapping before the code is checked lets an unauthenticated caller drive writes — each fails the tests that name it.

**What this does not do.** Rotation has never been exercised against a deployed environment, because nothing is deployed. The Cloud Run and Helm paths pass the primary key through Secret Manager and do not yet carry the retiring list, so an environment rotated there today would still need that wired into its secret flow; an empty list cannot be a Secret Manager version, so that needs a conditional resource rather than another entry in the existing set. Browser persona journeys remain the other open W1 item.

## W1 milestone: browser persona journeys, against real authentication

Doc 11's W1 exit criterion is specific: "a `viewer` in tenant A cannot see tenant B, cannot reach an approve button, and cannot call the approve endpoint. Proven by test, not inspection." This is that proof, and the first finding was about the harness meant to provide it.

**The suite could not run, and could not have meant anything if it had.** `tests/e2e` was absent from `pnpm-workspace.yaml`, so `@playwright/test` was never installed and `pnpm test:e2e` resolved to no package — it exited 0 having run nothing, which is the `--passWithNoTests` failure this repository has already been bitten by twice. There was no e2e job in CI. And `playwright.config.ts` still set `AXIOM_E2E_BYPASS_AUTH: 'true'` and shipped an `axiom_e2e_bypass` cookie in `storageState`, both deleted from the application in W0.0 — the cookie having been step 2 of a complete unauthenticated founder-owner takeover chain (SEC-2). Under that bypass the BFF resolves every caller to one `E2E_IDENTITY` founder, so a persona journey written on it would have been a founder wearing a viewer's name: it would have passed whether the render gating worked, or existed.

**The harness now.** `scripts/seed-personas.ts` creates nine real GoTrue accounts with real passwords — founder, owner, approver, a second approver narrowed by `approval_scopes`, reviewer, viewer, partner, analyst, and an owner in the second tenant — across two tenants, and the journeys sign in through the real login form under `AXIOM_AUTH_MODE=strict`. The two tenants carry deliberately different MFA policies: tenant A sets `mfa_required_roles = '{}'` so the authorisation journeys vary one thing at a time, and tenant B keeps `{owner, approver}` so the quarantine is its own journey. Both are stated explicitly rather than inherited from the column default, because a journey that depends on a default breaks quietly the day the default changes.

Twenty-seven journeys: the approve control appears for exactly the personas that should have it; a viewer, reviewer, partner or scoped approver is refused it; no tenant-A persona can read tenant B's plan, including when the active-tenant cookie names B; founder and analyst are held at enrolment by role, tenant B's owner by tenant policy, and the founder is quarantined even though tenant A asks for nobody; the partner portal link appears only for the partner; an unauthenticated visitor is redirected; and a wrong password stays refused, which is the SEC-2/SEC-13 path where a failed login used to mint a founder identity with no credentials.

**What the journeys found.** A scoped approver gets no approve control but keeps **Reject plan**. `SCOPE_NARROWED` in `@axiom/types` covers `PLAN_APPROVE` and `PLAN_EXECUTE` and not `PLAN_REJECT`, so narrowing `approval_scopes` removes the ability to grant and leaves the ability to refuse. That asymmetry is right — saying no is not authority over a client estate — and my first draft of the test asserted the opposite. It is now an explicit assertion with its own journey, and `canApprove` and `canReject` are separate fields on the persona so the two cannot be conflated again. The `approver` and `approverScoped` personas differ only by a non-empty scope list, which is what makes the old note that `approval_scopes` is "defined and never read" falsifiable.

**The third clause.** A rendered page cannot demonstrate that the server refuses a request the page never offers to make, so `viewer_cannot_approve` and `viewer_cannot_reject` were added to `verify-strict-parity.ts`, which holds a real GoTrue token. All four topology labels still produce identical outcomes.

**The gate that missed it.** `check-env-security-gate.sh` scanned `apps packages services` and not `tests`, which is exactly why a harness configuring the deleted bypass survived W0.0 untouched. It scans `tests` now; reintroducing `AXIOM_E2E_BYPASS_AUTH` into the harness fails the gate, verified by doing it.

Verified: 27 journeys green; 268 BFF, 178 `@axiom/mfa` and 32 web tests; typecheck and lint 15/15; format; strict parity across all four labels; env-security, controls-drift and deployment-coverage gates. Mutation-tested three ways — forcing `canApprove = true` in the plan page fails the four journeys that must not be offered approval; disabling the login-MFA gate fails all four quarantine journeys; and switching the harness back to `AXIOM_AUTH_MODE=e2e-bypass` fails **25 of 27**, the two survivors being the pure-data assertions that never open a browser. That last one is the one that matters: it is the direct evidence these journeys depend on real per-persona identity, which the previous harness could not have claimed.

**Correction, same slice.** The first CI run failed, and the cause was this change rather than anything it tested. Making the suite runnable started four spec files that had never executed, and they were written for the world the bypass created. `approval-console.spec.ts` opened `/plans` after writing a fake Supabase session into `localStorage` with `access_token: 'test-access-token'` — one of the BFF's `SYNTHETIC_TOKENS`, honoured only under the bypass W0.0 deleted — so the setup was inert and the assertions were really about what a logged-out visitor sees, on a plan id no database has ever held. It signs in as a seeded persona now, against `state.planA.id`, and gained the assertion the inert version could not make: the same plan page as a viewer, with no kill switch. `gap-scan.spec.ts` and the marketing half of `security.spec.ts` needed the marketing server on port 3000, which the rewritten config had stopped starting; it starts again. `agent-ui-communication.spec.ts` is `test.describe.fixme` with its reason in the file: `/workbench` needs `WORKBENCH_ACCESS`, held only by `founder` and `axiom_analyst`, and `ALWAYS_MFA_REQUIRED` holds both at enrolment until a TOTP challenge is satisfied against a running BFF. Deleting it would have removed real coverage of a real surface; leaving it red would have been worse. Suite now: 37 passed, 2 fixme.

**What this does not do.** The journeys prove what each persona is _offered_, not that an approver can carry an approval through to a signed token in a browser. That needs the TOTP challenge satisfied against a running BFF, and is the next piece of W1. Nothing is deployed, so none of this is deployed acceptance. Running `next dev` regenerates `apps/web/next-env.d.ts` with dev-mode type paths and writes Next's own `AGENTS.md`/`CLAUDE.md` into `apps/web`; neither is committed here.

## W1 milestone: an approver completes an approval in a browser

The persona journeys proved what each role is _offered_. This is the positive case actually completing, and the defect that turned up on the way.

**The harness grew a BFF.** A step-up challenge has to be satisfied against something, and every authorisation the product makes is decided in the BFF, so a journey that stops at the page is only testing a page. `playwright.config.ts` now starts the BFF alongside the web app and the marketing site, sharing one `commonEnv` so the Supabase target and the MFA ring key cannot drift between them. `scripts/seed-personas.ts` enrols real TOTP factors, writing `user_mfa_factors.secret_encrypted` under that same ring key — the two ends agree by construction rather than by both happening to read the same variable correctly.

An approver now signs in with a real password, selects an action, opens the step-up panel, enters a code generated from their own seeded secret, and gets a **signed approval token**. A wrong code approves nothing and leaves the panel open. The same code cannot be spent twice. A viewer is never offered the path; a scoped approver is refused it and keeps only refusal.

Two of those journeys taught me something about my own fixtures before they taught me anything about the product. Approving is a state transition, so two journeys sharing one seeded action make the second fail for a reason unrelated to what it tests — each approval journey creates its own plan now. And `last_used_counter` replay defence is per **factor**, not per challenge, so the happy-path and replay journeys approving inside one 30-second TOTP step had the second correctly refused; the replay journey has its own authenticator. Both were the product working exactly as designed, surfacing as test failures.

**The defect.** The browser-to-BFF bridge derives an `Idempotency-Key` from method, path and body whenever the caller supplies none. For `POST /v1/mfa/challenge` with `{"purpose":"login"}` that is the same key for a given user **forever**. `claim_request` (migration 0017) returns `conflict` whenever the stored claim's authority hash differs, and that hash includes the GoTrue session id. So the first login-MFA verification of a user's life claimed the key, and every later sign-in presented the same key from a different session and was refused `idempotency_conflict` permanently — the user could never complete login MFA again. Inside a single session it failed more quietly: the claim replayed and handed back a challenge id that had already been consumed.

A derived key is exactly right for approving and executing, where a double submit must not run twice, and exactly wrong for minting a single-use credential. Both challenge callers — the login-MFA prompt and the approval console — supply a per-attempt key now. `apps/web/src/app/api/bff/idempotency-key.test.ts` pins both halves of that rule at unit speed, including the derivation's stability for approvals, so the fix does not depend on the browser lane to stay honest.

The API suites could not have found this. They pass a fresh `randomUUID()` on every request and so never exercise the bridge's derivation at all. It took a browser driving the real client code.

**The workbench journeys are live.** Revision 16 marked them `fixme` because `/workbench` needs `WORKBENCH_ACCESS`, held only by `founder` and `axiom_analyst`, and `ALWAYS_MFA_REQUIRED` holds both at enrolment until a challenge is satisfied — which needed a BFF. With one running, the analyst clears the gate with a real code. They needed one more thing the seed had not modelled: `requireInternalContext` asks two separate questions, `users.is_axiom_internal` and the capability, and the capability alone lands on the client portal. That is the gate working; the fixture was wrong. Axiom staff are marked as staff now.

Verified: the full e2e suite is **47 passed, 0 skipped** — no `fixme` left. 268 BFF, 178 `@axiom/mfa`, 38 web and 14/14 package test tasks; typecheck and lint 15/15; format; env-security, controls-drift and deployment-coverage gates. Mutation-tested: reverting the per-attempt key makes the first login-MFA verification succeed and the second fail, which is the defect's exact signature — works once, then never again.

**What this does not do.** A signed token is not an execution. The token is the gate; a separate execute call runs the work against a client estate, and no connector-backed executor exists to perform it. Nothing is deployed, so none of this is deployed acceptance.

## W1 milestone: the retiring key reaches a deployed BFF

Committed on branch `claude/phase-0-5-gap-closure-5fd349` and merged to staging. No migration; allocation stays at 0028.

Revision 15 made the MFA encryption key rotatable — a primary that seals new and rewrapped secrets, and `AXIOM_MFA_ENCRYPTION_KEYS_PREVIOUS`, a comma-separated list of keys that may still be read — and wired it into the four Compose files. Cloud Run and Helm were not touched, so a **deployed** rotation had no path for the retiring list. `sync-env.sh verify` would pass, the service would roll, and every factor still sealed under the outgoing key would be unreadable.

The shape of that failure is why it matters more than the size of the change suggests. Nothing fails at deploy time. It fails afterwards, one user at a time, as each person's next verification returns `secret_unreadable` and a 503 — which reads like a broken authenticator, not a deployment that shipped half a key ring.

**Absent, not empty.** Both surfaces express "no rotation in flight" as the variable being _absent_, which is already how the key ring reads an unset value. That is forced rather than chosen: an empty payload is not storable as a Secret Manager version, so carrying the retiring list as a permanently-empty member of `local.managed_secrets` would fail every apply that is not a rotation.

- **Cloud Run** — `google_secret_manager_secret.mfa_previous_keys` and its version are `count`-conditional on `var.mfa_encryption_keys_previous`, and the BFF's environment entry is a `dynamic "env"` block iterating that resource, so the condition is stated once in `secrets.tf` instead of being restated in `cloudrun.tf` and left to drift. Clearing the variable destroys the secret, so a retiring key stops existing at the same moment it stops being needed rather than lingering as a live decryption key nobody is watching.
- **Helm** — `optional: true` on the `secretKeyRef` for `mfa-encryption-keys-previous` in the `<release>-internal` Secret. Without it every pod would refuse to start until an operator supplied a key they do not have.
- **`sync-env.sh`** — `mfa_encryption_keys_previous` joins the tfvars mapping, which `check-tfvars-coverage.sh` requires of every declared variable. The Secret Manager push adds the pair only when the value is non-empty; appending it unconditionally would print "Skipping empty or placeholder secret" on every ordinary sync and teach operators to read past the warnings that matter.

**The check that would have caught it.** The omission survived because no gate asks whether a variable reaches every surface that runs the service needing it. `scripts/check-mfa-ring-coverage.sh` asks exactly that across all six BFF surfaces and runs in the existing deployment coverage job. Its match is word-boundary anchored on purpose: `AXIOM_MFA_ENCRYPTION_KEY` is a prefix of `AXIOM_MFA_ENCRYPTION_KEYS_PREVIOUS`, so a substring test would stay green with the primary key missing.

Verified: `terraform validate` passes on preprod; `terraform fmt` shows no new drift from these edits (`cloudrun.tf` has pre-existing alignment drift in its `locals` block, untouched here); `check-tfvars-coverage.sh` passes at 27 declared variables; `check-mfa-ring-coverage.sh` passes on all six surfaces; env-security gate, `prettier --check` and `bash -n` pass.

Mutation-tested twice. Restoring the pre-change `cloudrun.tf` and `bff-deployment.yaml` makes the new gate fail naming those two surfaces and no others. Removing the `mfa_encryption_keys_previous` line from `tfvar_value()` makes `check-tfvars-coverage.sh` fail, which is what holds the sync mapping in place.

**What this does not do.** Nothing is deployed and no rotation has been exercised against a running service, so the path exists but is not proven — the conditional resources are unapplied. The Helm change is reviewed rather than templated: `helm` is not installed on this machine, so `helm template` could not be run locally. CI does not render the chart either, which is a gap worth closing separately.

## W0.1 milestone: the chart that had never been rendered

Committed as `5ff7404` and `37121bb` on branch `claude/helm-render-gate` off staging, merged as `cf0f168` and pushed. Full configured CI [35583341796](https://github.com/vikashkaruna/Proof/actions/runs/35583341796) is green across all fifteen jobs; `Build container images` is skipped, which is its `main`-only condition and not a failure. No migration; allocation stays at 0028.

The previous milestone closed by naming this gap: the Helm half of the MFA key ring was reviewed rather than templated, because `helm` is not installed on the dev machines and no CI job rendered the chart. `helm lint` and `helm template` now run in the deployment coverage lane, and the rendered output is schema-validated with kubeconform.

**The chart could not render at all.** This is the finding, not the gate. Rendering `infra/helm/axiom-proof` on staging fails on the first template it reaches, and behind that failure sat three more:

- `templates/ingress.yaml` used `{{- range .Values.web.ingress.tls.enabled }}` over a **boolean** — `range can't iterate over true`. The marketing block four lines below had always used `if`.
- `_helpers.tpl` and `templates/serviceaccount.yaml` dereference `.Values.serviceAccount.create`, `.name` and `.annotations`, but `values.yaml` declared no `serviceAccount` key. An absent key is a nil pointer in Helm, not an empty string.
- `templates/model-gateway-deployment.yaml` reads `.Values.modelGateway.autoscaling.enabled` with no `autoscaling` block under `modelGateway`. Same failure, different service.
- `templates/serviceaccount.yaml` emitted `annotations:` after `automountServiceAccountToken:` rather than inside `metadata:`, producing a mapping under a scalar.

The consequence for the milestone above is worth stating plainly: `check-mfa-ring-coverage.sh` was confirming that `AXIOM_MFA_ENCRYPTION_KEYS_PREVIOUS` was **present in the chart**, and it was — in a chart that could not produce a manifest. A presence check over template source cannot distinguish a wired variable from an unrenderable file. With the four defects fixed, the BFF Deployment renders and `optional: true` on the `mfa-encryption-keys-previous` `secretKeyRef` is schema-valid, which is the first time that change has been verified by anything other than reading.

**Defaults are not coverage.** A `{{- with }}` guarding an empty map never executes, so the annotations defect rendered clean on the chart defaults _and_ on `values-prod.yaml.example`, and appeared only once an operator attached an IRSA role. `infra/helm/axiom-proof/ci/` holds one values file per branch the defaults leave cold — the Helm convention `ct` already uses — and the gate renders every one. `kubeconform -strict` rejects unknown and duplicate fields, so a typo'd key fails in CI instead of being dropped silently by the API server on apply; `-cache` is not optional, because without it the schema set is refetched per value set and the gate takes minutes instead of a second.

Verified: helm v3.16.3 and kubeconform v0.6.7, both pinned in the job. `helm lint` passes. `helm template` renders 18 resources across chart defaults, `values-prod.yaml.example` and both `ci/` fixtures, and 17 under `serviceAccount.create: false` — all schema-valid at Kubernetes 1.30.0, 0 invalid. `prettier --check` passes on the workflow; `infra/helm/` is prettier-ignored, so the fixtures are not reformatted.

Mutation-tested across all three layers a render gate can fail at, seven defect classes, each restored from a checksummed snapshot: unclosed `{{ if` (template parse), `range` over boolean and a deleted values key (template execution — the two original defects), bad indentation (YAML parse), a misspelled field and a misspelled kind (schema, `-strict`), and the annotations block moved outside `metadata`. All seven fail the gate, each naming the file actually mutated.

**The first mutation harness was wrong, and it is worth recording how.** It restored between cases with `git checkout -- infra/helm/axiom-proof`, which restores HEAD — and the fixes under test were uncommitted. The first case wiped them, and the six that followed reported the same pre-existing failure as seven green PASSes. A mutation harness that restores from the wrong baseline produces exactly the evidence it was built to rule out. The harness now snapshots the working tree and verifies the restore by checksum before every case.

**Then the defects that render perfectly.** With the chart rendering for the
first time, four more appeared. Every one is valid YAML and valid Kubernetes,
so neither `helm template` nor kubeconform can see them:

- Both NetworkPolicies that _grant_ access selected on
  `app.kubernetes.io/part-of`, which lives in `.Values.labels` and was emitted
  on object metadata only — never on the pod templates. They matched zero pods
  while the default-deny matched all of them, so every workload had DNS and
  nothing else. Fixed with an `axiom-proof.podLabels` helper, kept separate
  from `selectorLabels` because `spec.selector.matchLabels` is immutable on an
  existing Deployment and widening it would fail every upgrade.
- Binding those policies to real pods then exposed that `allow-internal`
  carried only the **egress** half. A NetworkPolicy decision needs the sender's
  egress and the receiver's ingress, so `bff:4000`, `agent-runtime:8000` and
  `model-gateway:8001` still admitted nothing; only port 3000 from
  ingress-nginx was allowed in, which is the public edge, not the data plane.
- A `marketing` Service and the Ingress rule for `axiomproof.ai` pointed at a
  Deployment that did not exist; the public site answered 503. Its environment
  mirrors the staging and preprod Compose services, minus
  `AXIOM_E2E_BYPASS_AUTH` — removed from the application in W0.0 and never to
  reach a deployed surface.
- `bff` and `agentRuntime` omitted `replicas` for an autoscaler the chart never
  shipped, running one pod each under `minAvailable: 1` budgets that then
  permit zero voluntary evictions and stall a node drain. `temporalWorker` had
  values, a Dockerfile and a published image but no Deployment, so durable work
  would be accepted and never run. Both now exist; `modelGateway` keeps
  `autoscaling.enabled: false` and its declared `replicaCount: 2`.

**A second gate, because it answers a different question.**
`scripts/check-rendered-manifests.py` reads the rendered stream and asserts
what the manifests _mean_: every bundled component has a workload, every
Service selects a pod, every NetworkPolicy binds, every Service port is
admitted under the default-deny, and no PodDisruptionBudget sits at or above
its own replica floor. Run against the pre-change tree it reports seven
findings. The component list is passed explicitly because `temporal-worker` has
no Service and no Ingress rule — nothing in the rendered output referred to it,
so only a declared expectation could see that it was missing at all.

Verified: helm v3.16.3 and kubeconform v0.6.7, both pinned. `helm lint` passes.
22 resources render across chart defaults, `values-prod.yaml.example` and both
`ci/` fixtures — 21 under `serviceAccount.create: false` — all schema-valid at
Kubernetes 1.30.0, 0 invalid, and all passing the semantic checks. The hosted
runner reproduced those counts exactly, so the gate is confirmed on the
platform that will enforce it and not only on a developer machine.
`check-mfa-ring-coverage.sh`, `check-tfvars-coverage.sh` and
`check-control-count.sh` still pass; `prettier --check` passes on the workflow
and this document.

Mutation-tested at 13 cases, each restored from a checksummed snapshot: seven
render defects across template parse, YAML parse and schema, and six semantic
ones — pod labels losing `part-of`, the HPA template removed, the marketing and
temporal-worker Deployments removed, a disruption budget raised to its replica
floor, and the data-plane ingress half removed. All 13 fail the gate, each
naming the defect actually injected.

**The first mutation harness was wrong, and it is worth recording how.** It
restored between cases with `git checkout -- infra/helm/axiom-proof`, which
restores HEAD — and the fixes under test were uncommitted. The first case wiped
them, and the six that followed reported the same pre-existing failure as seven
green PASSes. A mutation harness that restores from the wrong baseline produces
exactly the evidence it was built to rule out. It now snapshots the working
tree and verifies the restore by checksum before every case.

**What this does not do.** It renders; it does not deploy, and nothing was
applied to a cluster. kubeconform validates against the upstream schema set
only: no CRDs, no admission controllers and no cluster policy are consulted, so
a manifest can pass here and still be rejected on apply. The topology
corrections — the pod labels, the ingress half, the two new Deployments and the
autoscalers — are reasoned from the Compose files and the existing Services
rather than observed against a running cluster, and they are the first thing a
real deploy should be checked against. The marketing Deployment's Resend key is
mounted `optional`, so a cluster without it serves the site with a contact form
that cannot send.

## Tooling: the Terraform gate, and what formatting was hiding

Committed as `5423640`, `26172fb` and `dccc5d7` on branch `claude/gifted-maxwell-0b053f`, merged as `9bd609f` and pushed. No migration; allocation stays at 0028.

`terraform fmt -check -recursive infra/terraform` had been failing on four files and nothing noticed, because no job had ever run it. The previous milestone recorded the `cloudrun.tf` half of this as "pre-existing alignment drift in its `locals` block, untouched here" and moved on, which was the correct call for that change and is the reason it survived to this one.

**The drift nobody wrote.** Three of the four are ordinary: `envs/prod/{eks,s3,vpc}.tf` carry two spaces before an inline comment where fmt wants one, plus an unaligned `bucket` against `object_lock_enabled` in the evidence bucket. They have been untouched since `332c290` and `cc99dbc`. The fourth is worth naming because no one wrote a misaligned line to cause it. fmt aligns _contiguous_ runs of attribute assignments, and a comment ends the run. `66885c5` replaced preprod's hard-coded `supabase_preprod_url` with a reference to the supabase.tf gateway and documented the swap in a two-line comment directly above it — which split the `locals` block into two alignment groups. The six keys above had been padded to the width of `supabase_preprod_url`, the longest key at 20 characters; correct while they shared its group, stale the moment they did not. Their group's widest member is now `agent_runtime_url` at 17, so fmt narrows them. The edit that invalidated those six lines is three lines away and modifies none of them, which is why review passed over it.

**What fmt cannot see.** fmt only parses; it never resolves a module or a reference. `terraform validate` does, and running it found `envs/prod` unloadable. `cluster_name`, `vpc_cidr` and `kubernetes_version` were each declared twice — bare in `main.tf`, documented in `variables.tf`, identical defaults — and Terraform rejects a variable declared twice in one module, so `init` aborted before module installation. Removing the bare copies (behaviour-preserving, since the defaults matched) gets `init` far enough to resolve modules, where it reports seven more: `eks.tf` pins `~> 20.0` but passes `name`, `kubernetes_version` and `endpoint_*`, which are the v21 argument names — v20 prefixes them `cluster_*`; `vpc.tf` pins `~> 5.5` but passes `create_flow_log_iam_role`, which that major calls `create_flow_log_cloudwatch_iam_role`. The common cause is that `terraform init` has never been run against `envs/prod`; the mismatch would have failed the first attempt.

**The gate.** `hashicorp/setup-terraform@v3` plus `terraform fmt -check -recursive infra/terraform` and `terraform validate` for preprod, added to the existing deployment coverage job (W0.1). The Terraform version is pinned rather than floating: fmt's own rules can change between releases, and an unpinned gate would turn an upstream release into a red build on files nobody touched. `validate` covers preprod only. prod is deliberately absent — including it would land the gate red, and the repairs it needs change provisioned infrastructure (the EKS API endpoint's exposure among them) rather than formatting.

Verified: `terraform fmt -check -recursive infra/terraform` exits 0 across both environments; `terraform validate` succeeds on preprod; the formatting commit is whitespace-only by two independent checks — `git diff -w` is empty, and every file is token-identical to its previous revision after whitespace collapse; the workflow parses under `yaml.safe_load` with `terraform_version` surviving as the string `1.15.8` rather than a float.

Mutation-tested twice, and the second one is the point. Widening the padding on `bff_service_url` makes the fmt gate exit 3 naming that file; restoring it returns exit 0. Then, separately, a reference to an undeclared `var.undeclared_typo` inserted at correct alignment leaves `fmt` at **exit 0** — it cannot see the defect at all — while `validate` exits 1 naming the variable. That pair is the argument for running both rather than treating fmt as coverage.

**What this does not do.** Nothing was applied and no cloud resource was created — `init -backend=false` and `validate` only. `envs/prod` was left invalid and ungated at this point; the entry below closes that, and the CI evidence for both is cited there.

## Tooling follow-up: prod loads, and the gate covers it

Committed as `325a832` and `3d99fb0` on branch `claude/gifted-maxwell-0b053f`, merged as `9bd609f` and pushed. Full configured CI [35584341666](https://github.com/vikashkaruna/Proof/actions/runs/35584341666) is green across all fifteen jobs; `Build container images` is skipped, which is its `main`-only condition and not a failure. No migration; allocation stays at 0028.

The entry above gated formatting everywhere and validity in preprod only, because `envs/prod` could not be initialised and gating it would have landed the job red. That is now closed: prod validates, and the gate covers both environments.

**Not a half-finished upgrade.** The obvious reading of prod's seven rejected arguments was an abandoned module bump. It was not. The same `module "eks"` block mixes v21 spellings (`name`, `kubernetes_version`, `endpoint_*`) with v20 ones (`cluster_encryption_config`, `enable_irsa`) — a combination no single version has ever accepted. The configuration was assembled from whichever version's documentation was open at the time, and because nothing had ever run `terraform init` against prod, nothing ever said so.

**Pins kept, names changed.** Moving eks to v21 or helm to v3 would change what gets provisioned; renaming changes only which name expresses a setting that was already there. So `~> 20.0` (resolving 20.37.2) and `~> 5.5` (resolving 5.21.0) both stand, and nine things were corrected against them: five eks arguments to their `cluster_*` spellings, two vpc flow-log arguments to `create_flow_log_cloudwatch_iam_role` and `flow_log_cloudwatch_log_group_retention_in_days`, `helm_release.cluster_autoscaler` from the provider v3 `set = [{...}]` attribute to the v2 repeated block its `~> 2.11` pin takes, and an explicit empty `filter {}` on the evidence bucket's lifecycle rule.

**The gate discovers environments rather than naming them.** `for env in infra/terraform/envs/*/` — because the failure that produced prod was an environment nobody was checking, and a list of two would reproduce it the moment a third appears. `-backend=false` is deliberate, not incidental: prod's main.tf carries a live `backend "s3"` block, and a configuration gate must not reach for state.

Verified: `terraform fmt -check -recursive infra/terraform` exits 0; `terraform validate` succeeds on **both** environments with no warnings. The two workflow steps were extracted verbatim from the parsed YAML and executed against a pristine `git archive` of HEAD, so what was tested is what CI runs rather than a retyping of it. The hosted runner then confirmed it on the merge commit: the `Deployment configuration coverage (W0.1)` job is green in 30 seconds, and its `terraform validate (all environments)` step logs both `::group::infra/terraform/envs/preprod/` and `::group::infra/terraform/envs/prod/`, two `Success! The configuration is valid` verdicts, and zero errors or warnings. The loop is therefore confirmed to have iterated both environments rather than matching nothing — a glob that expanded to no directories would also have exited 0.

Mutation-tested per fix class, which is what separates the three that the gate holds from the one it does not. Reverting any single eks rename, any vpc rename, or the helm block form fails validate at exit 1 naming prod — and each leaves `fmt` at exit 0, so fmt would not have caught any of them. Removing the lifecycle `filter {}`, however, **passes at exit 0** with a warning: `validate` does not fail on warnings. That fix is therefore defensive against a future provider major rather than enforced here. Promoting warnings to failures was declined deliberately — a provider minor can introduce one on files nobody touched, which is the same brittleness the pinned `terraform_version` exists to avoid. The loop was also confirmed to reach and fail on its _second_ iteration, so a prod-only regression cannot hide behind a green preprod.

**What this does not do.** Nothing was applied and no cloud resource was created; `init -backend=false` and `validate` only. prod is loadable now, not correct — `validate` checks that a configuration resolves, never that it describes infrastructure anyone wants. One item is carried forward unchanged and should be read as an open decision rather than a closed one: `cluster_endpoint_public_access_cidrs` still carries `["0.0.0.0/0"]`, exactly as the v21-named argument did, with the "restrict via WAF / OIDC in production" comment still standing above it and still unactioned. What changed is that this exposure is now reachable rather than blocked behind a configuration that could not load. The gate is now observed green on the hosted runner, so what remains unproven here is the configuration's correctness, not the gate's.

## W2 milestone: tenant-bound estate inventory and assessment scope

Integrated staging `a73dad7`; its [CI run 35585891610](https://github.com/vikashkaruna/Proof/actions/runs/35585891610) was green. The other model had already delivered the browser/MFA slice named in the earlier handoff, plus chart and Terraform gates. The unfinished local strict-browser prototype was saved in a named stash and superseded by the integrated harness rather than applied on top of it. No accepted work was discarded and migrations through 0028 were preserved.

0029 adds four estate-domain tables and an optional estate reference on engagements, with composite foreign keys enforcing tenant consistency even for administrative writes. Reads follow actual membership, independent of a missing/stale selected-tenant JWT claim or internal-staff flag. Client roles have no write/TRUNCATE privileges; explicit service policies work without BYPASSRLS. Scan state/timestamps cannot claim completion before an interval exists. Deleting referenced scope is restricted; archive preserves history. No estate or scope is inferred for existing assessments.

The BFF engagement-creation API accepts `estateId` under its existing `ENGAGEMENT_CREATE` gate; malformed IDs fail validation and invalid foreign references are refused. Shared estate/system/category/scan schemas and branded IDs are exported from `@axiom/types`. There are no new estate mutation APIs or discovery jobs yet — those require the W3/W4 workflows rather than a second unchecked metadata write path.

Review follow-ups: the integrated browser harness put its administrative Supabase key in `commonEnv`, which was passed to web and marketing as well as BFF; the key now sits in `bffEnv` only. Running its 47 journeys exposed an approval-page hydration error caused by AgentIcon's block element nested inside PageHeader's paragraph. All 47 still passed, so passing clicks alone did not detect the fault. AgentIcon now uses an inline span and PageHeader supports rich description content. The approval journeys assert no `pageerror`; restoring the prior markup causes the positive approval journey to fail that assertion. The mutation restored exact working bytes before re-running.

Validation: 272 BFF tests, 89 MFA package tests, 38 web tests, shared-type tests/typechecks, database suites through 0029, four concurrency suites, DSN failure checks, a populated 0028→0029 upgrade, and four real Auth/MFA/estate isolation parity labels. All 47 browser journeys pass after the markup fix, including the new runtime-error assertion; final CI verifies the pushed merge. Local browser uses installed Chrome in an isolated automation profile; CI retains pinned Chromium. Generated Next type-reference changes are not committed. No cloud deployment or external estate action occurred.

Remaining W2/W3: estate management APIs/UI with audit/idempotency, onboarding proposal normalization and human-confirmed legacy assignment, connector registry and actual scan execution. A separate W1 UX gap remains: "Replace authenticator" does not collect the `enrolment` challenge required by the BFF, so it fails safely instead of completing; the seeded-factor approval journeys do not cover that path.

## W1 milestone: authenticator replacement, and the two defects under it

Committed as `a6bb4df` and `d4c1e3d` on branch `claude/axiom-proof-phase-gap-closure-b88105`, merged as `67555e3` and pushed. Full configured CI [35591900877](https://github.com/vikashkaruna/Proof/actions/runs/35591900877) is green across all sixteen jobs on that head; `Build container images` is skipped, which is its `main`-only condition and not a failure. Integrated staging `ad2d046`; its upstream CI was green. Migration allocation moves to **0030** — allocated after re-fetching staging, which had not moved past `ad2d046`.

Revision 21 carried this forward as a UI gap: "Replace authenticator does not collect the `enrolment` challenge required by the BFF, so it fails safely instead of completing." That was accurate and incomplete, and the gap between those two is the finding.

**A refusal is not evidence of a working control.** Because the button never sent `mfaChallengeId`, no request in the product's history had cleared the enrolment gate, so nothing had ever reached the path behind it. That path was broken too. `user_mfa_factors_one_active_totp` (migration 0012) is UNIQUE on `user_id` WHERE `totp AND active`; `activateTotpEnrolment` promoted the pending factor with a bare UPDATE and never retired the one being replaced, so activation raised `23505` for any user who already held a factor. The service mapped that unique violation onto `no_pending_factor` — "No enrolment is in progress" — which names the wrong layer entirely. Fixing only the UI would have moved the failure later in the flow, to after the user had been shown a new secret, and made its cause harder to find rather than easier.

**Migration 0030.** `activate_totp_factor` retires the replaced factor and activates the new one under one set of row locks. Neither order is available from outside a transaction: activate-then-revoke is what the index forbids, and revoke-then-activate leaves an account with no active factor on a fault. The second is the dangerous one for a reason beyond lockout — a first enrolment is deliberately not step-up gated, so that window hands over the revoke-then-re-enrol chain the enrolment gate exists to break. The function is `security definer` with an empty `search_path`, executable by `service_role` only, and scoped by `user_id` as well as factor id so no caller can retire someone else's authenticator.

**The client half.** The security page opens the `enrolment` challenge, satisfies it with the current authenticator or a recovery code, and spends it on the new enrolment; the setup key is not rendered until the challenge is satisfied. It sends a per-attempt `Idempotency-Key` — it is the third caller of `/v1/mfa/challenge`, whose derived bridge key is fixed for a body of `{"purpose":"enrolment"}` and would replay a spent challenge on the second replacement. `BeginMfaEnrolmentRequestSchema` now declares `mfaChallengeId`; the route had been reading it off the raw body, and an undeclared field is a contract nobody can see.

**Coverage, where there was none.** `POST /v1/mfa/enrol` had no route-level test at all — seven now, covering first enrolment, the refusal with no challenge, the refusal with an opened-but-unsatisfied challenge, success, single-use consumption, retirement of the replaced factor, and a malformed id as 400 rather than a failed step-up. `tests/database/totp-replacement.test.sql` covers 0030 and separately asserts the unique index still bites, so dropping the index could not leave the function's own tests green while two live authenticators became possible. Five browser journeys cover both replacement paths and both refusals, including that the retired authenticator no longer satisfies a step-up.

**The double was more permissive than the database.** `fake-postgrest` had no notion of the unique index, which is how the bare UPDATE passed every unit test in the repository and failed against a real stack. It now models the index and raises on violation the way Postgres does, so a regression fails at unit speed rather than in the browser lane.

**The journeys provision their own accounts.** First drafted against two new seeded personas in the style of the existing ones; they passed, then failed on the immediately following run. Enrolment, replacement and recovery-code consumption are state transitions on the account itself, so a persona-based journey passes once on a freshly seeded database and fails on every rerun — under `retries: 2` that appears as a first attempt passing and both retries failing, which reads as a product flake rather than a fixture defect. `createApprovablePlan` already encodes this rule for plans. The two personas were removed again and `createMfaAccount` added beside it. Confirmed by running the journeys twice in succession against an already-mutated database.

Mutation-tested per layer, restoring from a scratchpad snapshot and verifying each restore by checksum — the working tree held the fix, so `git checkout --` would have restored the defect and produced a column of green PASSes proving nothing. Dropping `mfaChallengeId` from the schema fails 3 route tests; disabling the enrolment gate fails 4, including the success case, because a challenge that is never consumed is never spent; dropping the per-attempt `Idempotency-Key` fails the web rule; reverting the service to the bare UPDATE fails the retirement test; removing the retire step from 0030 fails the SQL suite with the original `duplicate key value violates unique constraint "user_mfa_factors_one_active_totp"`, the exact defect and not merely a non-zero exit; restoring the original UI defect fails 3 of 5 browser journeys while first enrolment correctly still passes.

Validation: 279 BFF tests, 40 web, 178 MFA package, 14 packages green, lint and typecheck 15/15, `format:check` clean, the W0.0 environment/security gate and MFA ring coverage, the database suite including 31 migrations and every concurrency and DSN lane, all four strict-parity topology labels, and 52 browser journeys. The estate foundation's own suites were rerun here rather than inherited and are unchanged.

**One job failed first, and it was not this work.** `Self-hosted Supabase topology (W0.1)` exited 1 after 41 seconds with `Head "https://registry-1.docker.io/v2/postgrest/postgrest/manifests/v12.2.8" ... read: connection reset by peer` — a Docker Hub reset during image acquisition, before the script reached a database at all. It was re-run on the same commit and passed in 34 seconds with nothing changed. Recorded rather than quietly re-run, because a red job on a migration commit invites the assumption that the migration caused it, and the log is the thing that says otherwise.

**What this does not do.** Factor revocation through the UI and enrolment under login quarantine are untouched. Replacement does not invalidate `mfa_session_attestations` already issued against the retired factor; on the recovery-code path that is a posture question recorded as an open decision in Doc 11 E.2 rather than answered here. No cloud apply, no connector execution, and no change to any deployed instance.

## Status pass: a per-workstream register, re-derived rather than inherited

No code change. Doc 11 gains a **workstream status register** covering W0–W10 in one maintained table, replacing the previous arrangement where a reader asking "where is W4?" had to reconstruct it from six per-revision delta tables.

Every row was re-derived by running that row's own acceptance check against `3c1275f`. Three things came out of doing that rather than copying the previous revision forward.

**SEC-3 reads as open and is closed.** `git grep -ln createSupabaseAdmin -- apps/web/src` returns 21 files, which looks like the service-role ban having failed. It has not: the gate matches _calls_ and excludes comment lines, and every one of those 21 matches is a comment recording what used to be there and why it was wrong. Actual calls: zero. The baseline file is correct and the documentation is doing its job — but a reader running the obvious grep will reach the wrong conclusion, so the register states the distinction explicitly.

**28 of the 34 named W2 target tables do not exist.** Checked against the migrated database, not by grep, after grep produced a false negative: `regulatory_instruments` exists but is not created by a literal `create table public.regulatory_instruments`, so a pattern search called it missing. The database says the whole W7.0 regulatory baseline group of six is delivered, alongside the four estate tables from 0029, and that all 7 connector, 5 execution-detail, 4 monitoring/policy, 4 multi-regulator, 4 Phase 1/2 parity and 4 rights/consent tables are absent. Doc 11's target list now annotates the regulatory group as delivered, which its prose already said and its code block did not.

**Performance is untouched, and W9 did not say so.** `k6`, `artillery`, `p95`, `benchmark` and `load test` match nothing in the repository. PERF-3 is delivered through `take_rate_limit`; PERF-2's estimated counts are not, and NFR-7 cannot be load-tested until W4 lands. W9 was carrying an unqualified strength on the testing half while the performance half had nothing in it.

The register's own summary is the uncomfortable part and is left uncomfortable: six workstreams Partial, two Pending outright, W0's remaining half and W8's retention Gated on actions this workspace is not permitted to take. The delivered work concentrates in the P0 band; the two XL workstreams that constitute the actual product loop — W4's connectors and W5's executor — are close to empty, and W5's tables are empty _because_ W4 has to land first.

Doc 13 is kept for its Doc 02 module-to-owner mapping, which nothing else carries, but its header no longer presents a 20 September `2c54fcd` snapshot as current status; it now defers to the register and says the register wins on conflict.

## Handover pass: an operator completion runbook for W0–W3

No code change. Doc 16 is new: the ordered steps the operator runs to configure, deploy, migrate, seed and verify W0 through W3, what evidence each step returns, and what I do with that evidence before a status moves.

**Why it exists.** The register says what is delivered. It does not say who does the next thing, and for these four workstreams the split is uneven enough that assuming is expensive. W0's remainder is entirely the operator's — its code is closed. W2 and W3 are almost entirely mine. W1 is genuinely shared, including one decision only the founder can make. Every item in Doc 16 names exactly one owner.

**What re-verification found before writing it.** Two W0.1 items the plan still lists as outstanding are already done, and asking the operator to do them would have wasted their time: the mock Supabase substitution is reachable only under `e2e-bypass`, which `@axiom/config` refuses at boot outside `local`/`test`, and the idempotency auto-key generation is gone with no environment relaxing it — including `e2e-bypass`, which relaxes authentication only. So W0 has no code work left at all, which is a materially different message from "W0 is partial".

**The honest gap it names.** W0's exit criteria require that the same suite run against preprod and a production-configured stack with any divergence failing the build. That lane does not exist. `scripts/verify-strict-parity.ts` is structurally local-only — it reads `.axiom-runtime/parity/status.json` and binds to a Docker-reachable interface — so its four topology labels are one local stack under four configurations, which every review has said and which is easy to mistake for four environments. Writing the deployed lane is mine, and it is blocked until there is a deployed target to point it at. The browser journeys, by contrast, already accept `PLAYWRIGHT_BASE_URL` and skip their own dev servers, so they can be aimed at a deployed environment as soon as personas can be seeded there.

**Redaction is part of the contract.** The runbook is written so the operator never has to send a secret: Secret Manager resource names where I need to know a secret exists, a SHA-256 where I need to confirm two values match, and an explicit never-send list covering service-role keys, JWT secrets, `APPROVAL_SIGNING_KEY`, any `.env*`, and `.axiom-runtime/personas/state.json`, which holds working test credentials.

**What it deliberately does not cover.** W4 onward. W4 and W5 are the XL workstreams that make up the product loop, they are close to empty, and W5's tables reference W4's so W5 cannot start first. Sequencing them is a separate conversation once W0–W3 are real rather than a section appended to a runbook nobody can act on yet.

Doc 00 registers Doc 16 and its entry-point paragraph now names the register. Doc 11's register links to it from the W0–W3 discussion. Lint and typecheck 15/15, 14 packages green, `format:check` clean, W0.0 and control-count gates pass; every anchor verified against its heading slug.

## 21 Sep 2026 — Revision 23: revocation and quarantine

Reviewed and integrated staging `1990304` (other model's replacement fix, status register and Doc 16). Completed C-W1-1 and C-W1-2: purpose-bound revocation UI and explicit enrollment → save recovery codes → login verification for quarantined users. Forward migration 0031 makes credential/session revocation atomic and serializes racing login attestations. Recovery-code consumption now rejects revoked credentials even when unused.

Validation: 284 BFF tests, 55 strict browser journeys, 32 migrations with SQL failure injection and five concurrency suites, populated upgrade, DSN/deployment refusals and real Auth/PostgREST parity. Old UI and removed credential-status checks fail the new regression assertions. See review 12 for evidence and limits. Doc 16 is updated at this checkpoint; W1 remains partial. Next: make activation/recovery-set rotation one transaction, then W2 connector schema in dependency order. The recovery-replacement session policy remains a pending user decision.

## 21 Sep 2026 — Revision 24: atomic recovery rotation

Continued from merge 47685ab. Migration 0032 and the BFF now commit activation plus recovery hashes together. The service role cannot bypass this through the legacy activation primitive. Fault injection proves old credentials survive failed recovery persistence, and a populated upgrade proves the migration itself changes no credential rows. Storage failure returns 503 rather than `no_pending_factor` or a code error.

286 BFF tests, all eight credential lifecycle browser journeys, real Auth parity, 33-migration database/security/concurrency suite and both populated upgrades pass locally. Revision 23 staging CI found `rg` absent on its database runner; replaced that test-only dependency with `grep`, without changing the security assertion. Docs, operator runbook and handoff updated. W1 replacement-session policy still awaits the user's answer; next independent batch is W2 connector schema.

## 21 Sep 2026 — Revision 25: W2 connector data foundation

Continued after green staging `6271699` (CI 35618777188). Migration 0033 adds all seven W2 connector tables, tenant-consistent references, broker-private envelope storage, immutable published metadata, explicit target provenance and the Drishti-read/Karya-write grant split. Shared schemas describe metadata; no invocation authority is implied.

Validated 34 migrations, SQL isolation/constraint tests without BYPASSRLS, real GoTrue/PostgREST connector isolation across all four local labels, credential-read-denial mutation, populated 0032 upgrade, 42 shared type tests and workspace typecheck/lint. The upgrade creates empty tables and changes no existing systems. Doc 16 now records delivery and migration evidence required from the operator. W2: 19/40 named targets delivered, 21 absent; W4 runtime still pending. Next: W3 estate management API/UI and deliberate onboarding scope review. E.2.3 remains unanswered; no change to replacement-session policy.

## Revision 26 — W3 estate inventory milestone

Reviewed upstream `b380578` (no newer staging work). Migration 0034, central `estate.manage` capability and `/estate` deliver tenant-scoped estate/system create/edit/archive/restore and confirmed assignment of unassigned intake assessments. Authority is repeated inside the audited transaction; stale edits conflict, observed category provenance survives declaration changes, active connectors block archival, and archived estates refuse new scope. Browser writes retain their idempotency key after an ambiguous response.

298 BFF tests, all 35 migrations, six concurrency suites, three populated upgrades, DSN/deploy failures and four local real-Auth parity configurations pass. The browser milestone covers inventory lifecycle, read-only roles, lost-response replay and confirmed assignment. Final browser/CI results and merge identity are recorded in the ignored session checkpoint. See [review 15](audits/15-estate-management-review-2026-09-21.md).

W3 is **partial**: proposal normalization/review and the complete wizard remain pending. User decision recorded: **owner and admin** can approve proposals prepared by analysts. Next work follows that decision, then W3.5/W4. No claim of live connector execution or deployed acceptance.

## Revision 27 — W3 reviewed onboarding inventory

The prior inventory milestone merged as `b62f87b`, with all applicable CI checks green ([35626658366](https://github.com/vikashkaruna/Proof/actions/runs/35626658366)). Migration 0035 and `/estate/onboarding` now implement staff preparation and **owner/admin** review of immutable intake mappings. Approval atomically creates inventory and source links with audit records; changed estate versions, self-review, duplicate applications and cross-tenant requests are refused.

309 BFF tests, 59 browser journeys, 36 migrations, seven concurrency suites, three populated upgrades and four local real-Auth parity configurations pass; workspace lint/typecheck/format pass. Final-ledger fault injection leaves no applied inventory. The full W3 wizard and W3.5/W4 remain pending; declarations do not imply active connections. See [review 16](audits/16-onboarding-proposal-review-2026-09-21.md) and the saved handoff.
