# W0 → W1 → W2 → W3 implementation progress

Started 20 September 2026 with authorisation to implement in order and commit/merge/push each verified milestone to staging. Goal remains active until the complete acceptance criteria are proved. Revision 9 review/handoff documents are the starting requirements, not a claim of current completion.

Implementation worktree: `/Users/vikash/.codex/worktrees/w0-w3-closure/Axiom Proof`, branch `codex/w0-w3-closure`. Resumed from staging `5a4d6a0` after reviewing Claude's eight later commits. The analyst migration 0015 is now committed. Claude's additional uncommitted handoff text was preserved here; his worktree was not edited. See Doc 11 Revision 10 and audit 06 for the latest verified status; milestone narratives below describe their original delivery.

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

**W0:** finish strict environment/real-auth parity, deployed verification of the new operational tables/idempotency/onboarding controls, live secret verification, shared in-flight halt/guard tests, verified evidence retention and all required security regressions. Preserve the complete W0 exit criteria; local policy tests alone do not prove deployed parity.

**W1:** the analyst persona, role enforcement, the RLS/session-MFA boundary and TOTP + recovery delivery are done and on staging. Remaining: MFA key rotation and deployment, strict persona E2E in a browser, the eight PRD B.10 scenarios, session/IP challenge budgets, per-action diff and rollback hashes in the approval binding, and an operator document for the role MFA policy. Default analyst access remains assigned tenants. Email OTP is deferred by founder decision, not planned.

**W2 (after W1):** complete every table/model slice listed in Doc 11, migration upgrades, scoped relationships and RLS, action/batch identity, data retention and schema/runtime contracts. Do not recreate regulatory/MFA tables already present.

**W3:** estate/onboarding and live ER graph as capacity allows after W0–W2. No claim of completion yet.

**Decisions the founder holds — no further code should assume an answer:**

- **The outbox worker.** Whether a redelivery needs fresh approval, how many attempts are allowed, and what happens to a partially executed batch. The token was already consumed, so this is a policy about client estates.
- **Locking a real evidence bucket.** Irreversible, and a deployment decision. No bucket is locked and no retention mode has been validated against a deployed provider, so R-10 stays open whatever the code asserts.
- **A named human sign-off for the control-library citations.** `verifiedBy: 'Axiom Minds · Founder'` is an attributed string, not a recorded sign-off. R-06's remainder also includes migration 0011's baseline/provenance tables, which the seed leaves unpopulated, and nullable instrument/baseline hashes.

Push without force; re-fetch staging and preserve any concurrent changes before each integration. No deployment or irreversible bucket lock has been performed so far.

## Follow-up review: execution claims, delivery uncertainty and runtime halt

The review of `5a4d6a0` reproduced a remaining R-04 race: two different issued tokens both returned `claimed` for the same actions. The old tests covered sequential contention only. Forward-only migration 0021 locks the plan and requested actions before checking state, rechecks readiness and token expiry/scope under those locks, refuses empty/duplicate action lists, and preserves one durable intent. A two-session regression now observes one winner and leaves the competing token issued. Existing intents never authorize a second dispatch.

The runtime `/internal/execute` stub now explicitly refuses with 501/`accepted: false`; it previously acknowledged responsibility while only logging. The BFF requires a typed, correlated acknowledgement with a durable reference. A lost, malformed or inconsistent acknowledgement produces `dispatch_unknown`, retains the action claims and remains visible for reconciliation. Explicit refusal can release claims, but still consumes the original token. New `finish_execution_dispatch` records action/outbox outcomes atomically and prevents late failure from downgrading confirmed delivery. The public response schema includes both new dispatch outcomes.

The runtime kill reader's constructor failure selected a clear in-memory switch, contradicting its fail-safe documentation. URL-based memory selection also bypassed real local Supabase. Both are removed; explicit test injection remains possible. Invalid response shapes halt too. This closes the discovered fallback defect, not the absent live Temporal/connector interruption workflow.

Verification: 172 BFF tests, BFF typecheck/lint, 91 Python runtime tests, full fresh database/migration and concurrent suites pass. The isolated local Supabase upgraded through 0021 and passed all four strict topology labels. These labels exercise the same local stack and do not prove higher-environment provisioning. Runtime tests require `uv run --extra dev pytest`; without the dev extra the host Python's pytest was selected and failed collection before tests ran.

Remaining work is recorded in [audit 06](audits/06-resumed-implementation-review-2026-09-20.md). W0, W1 and W2 remain partial; no live client estate execution or irreversible evidence bucket lock occurred.
