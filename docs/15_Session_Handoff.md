# Saved implementation session — 21 September 2026

Resume from fetched staging, not a guessed SHA. This checkpoint integrated `ad2d046` (green upstream CI [35587825571](https://github.com/vikashkaruna/Proof/actions/runs/35587825571)) and adds W1 authenticator replacement plus migration **0030**; the merge commit containing this file is the resume baseline. Current detail: [Doc 11 Revision 22](11_Phase0-5_Gap_Closure_Plan.md), [progress](14_Implementation_Progress.md), [review 11](audits/11-w1-authenticator-replacement-review-2026-09-21.md). **Per-workstream status for W0–W10 is the [status register](11_Phase0-5_Gap_Closure_Plan.md#workstream-status-register--as-at-revision-22-21-sep-2026)** — start there before picking the next chunk.

## Workspace and accepted scope

- Active worktree `/Users/vikash/Axiom Proof/.claude/worktrees/axiom-proof-phase-gap-closure-b88105`, branch `claude/axiom-proof-phase-gap-closure-b88105`. Preserve sibling worktrees. Fetch before assuming the other model has not advanced staging — **this branch was found 83 commits behind staging with nothing unique on it**, so check `git rev-list --left-right --count origin/staging...HEAD` before trusting a task description that names files the branch does not have.
- User authorizes implementation, review, testing, documentation and incremental merge commits pushed to staging. No billable or irreversible cloud deployment is authorized in these sessions.
- Higher environments self-host Supabase. TOTP/recovery only; email OTP remains deferred. Fresh approval for every redelivery, no automatic retry worker. Proxy trust defaults off.
- Challenge consumption stays outside issuance deliberately. Planning agents still have no mutation credentials, ledger writes go through append_ledger, and real evidence needs provider-verified immutable retention.

## Completed

Reviewed and accepted the other model's estate foundation (0029), browser harness privilege separation and approval-page hydration fix; their suites were rerun here rather than inherited and are unchanged.

Closed W1's replacement path, which Revision 21 recorded as a UI gap and which was broken at three layers, each hiding the next. The Replace button sent no `mfaChallengeId`, so the BFF refused every press — correctly, which is why it survived review. Because nothing had ever cleared that gate, nothing had reached the activation path, where `user_mfa_factors_one_active_totp` made promoting a replacement impossible while the old factor was active; the resulting `23505` was reported as `no_pending_factor`, naming the wrong layer. Migration **0030**'s `activate_totp_factor` retires the replaced factor and activates the new one under one set of row locks. The security page now opens, satisfies and spends the `enrolment` challenge, with a per-attempt `Idempotency-Key`.

Added the coverage that was absent: seven route tests for `/v1/mfa/enrol` (which had none), a SQL suite for 0030 that also asserts the unique index still bites, and five browser journeys for both replacement paths and both refusals. The in-memory PostgREST double now models the unique index — it had been more permissive than the database, which is how the bare UPDATE passed every unit test.

Validation: 279 BFF tests, 40 web, 178 MFA, 14 packages, lint and typecheck 15/15, `format:check`, W0.0 security and MFA ring gates, the database suite including 31 migrations, all four strict-parity labels, and 52 browser journeys. Mutation-tested per layer from a checksum-verified scratchpad snapshot. No cloud apply or connector execution.

## Next implementation chunks

1. **W1 remainder:** factor revocation through the UI (the endpoint exists and is step-up gated; nothing calls it), and enrolment while held under the login-MFA quarantine. Settle Doc 11 E.2 item 3 — whether a recovery-code replacement should invalidate session attestations made with the retired factor — before calling W1 accepted.
2. **W2/W3:** estate management API/UI, explicit legacy-assessment assignment, and onboarding proposal normalization. The schema exists through 0029; no estate mutation endpoint or scan executor was invented. Require capabilities, audit/idempotency and tenant consistency.
3. **W4/W5:** connector registry and real executor with snapshot checks before mutation, rollback and halt tests. Runtime remains a refusal stub; no PRD B.10 completion claim.
4. **W0 acceptance:** deployed ownership/role split, invitation/email flow, ingress, key retirement and immutable evidence. Terraform/Helm gates validate artifacts, not a running deployment. EKS public endpoint CIDR remains unresolved.

Founder decisions still needed for real irreversible evidence retention and named regulatory citation sign-off. W0/W1/W2 remain **partial**.

Status at a glance, from the register: **W0** partial (code closed, deployment gated) · **W1** partial · **W2** partial, 28 of 34 named target tables absent · **W3** pending · **W4** pending, nothing · **W5** partial, authority machinery real and the executor a deliberate refusal stub · **W6** pending · **W7** partial · **W8** partial, retention gated · **W9** partial, performance untouched · **W10** partial, artifacts validate but nothing is deployed.

## Operational resume notes

- Local Docker parity project `axiom-w0-parity`, API 56321, database 56322; migrations through **0030**. Preserve other projects. Allocate the next migration only after fetching staging; never rewrite applied history.
- A fresh worktree needs `pnpm install` before anything typechecks — `@axiom/mfa` resolves through a workspace link, and a stale `node_modules` reports it as a missing module rather than a missing install.
- **A browser journey that changes an account's credentials must provision its own account.** `createMfaAccount` in `tests/e2e/fixtures.ts` does this, beside `createApprovablePlan`. A journey borrowing a seeded persona passes on a freshly seeded database and fails on every rerun, which under `retries: 2` reads as a product flake. Prove a new one is re-runnable by running it twice in a row without reseeding.
- Local credentials and logs stay under ignored `.axiom-runtime`; persona state contains test credentials. Do not print or commit it. Browser fixtures use synthetic identities only.
- Local Chrome can be selected with `AXIOM_E2E_BROWSER_CHANNEL=chrome`; CI uses Playwright's pinned Chromium. Browser servers use ports 3000/3001/4000. Next rewrites `next-env.d.ts` during dev in **both** `apps/web` and `apps/marketing`; revert both before committing.
- Apply 0029 before using estate linkage in the BFF, and 0030 before any authenticator replacement. Old clients may omit estateId; do not fabricate scope during backfill. Scan rows are metadata until a real scanner records a run.
- CI cancels an older staging run when a newer push arrives. Check the SHA and ancestry before treating cancellation as a defect.
- `Self-hosted Supabase topology (W0.1)` pulls three images from Docker Hub and has failed on a registry `connection reset by peer` during acquisition, ~40s in, before reaching a database. Read the log before suspecting the commit: a re-run on the unchanged SHA passed. `test-database.sh` already carries an ECR fallback for the same class of failure; this lane does not.
