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
