# Saved implementation session — 21 September 2026

Logical checkpoint after integrating staging `8476d8c` and delivering atomic approval issuance. The merge commit containing this file is the resume baseline; fetch staging before changing anything. See [Doc 14](14_Implementation_Progress.md) for progress and [Doc 11 Revision 12](11_Phase0-5_Gap_Closure_Plan.md) for current status.

## Workspace and authorization

- Worktree: `/Users/vikash/Axiom Proof/.claude/worktrees/phase-0-5-gap-closure-5fd349`, branch `claude/phase-0-5-gap-closure-5fd349`, merged to `staging` with a merge commit.
- Two models alternate on this repository and review each other's work. Assume staging has moved on arrival, and assume the other model's work is sound but incomplete — verify findings against the code before accepting them, and hunt for what was left behind. Both assumptions have repeatedly paid off.
- Accepted decisions stand: higher environments self-host Supabase; fresh approval for every redelivery; proxy trust configured per environment and disabled by default; TOTP and recovery codes only, email OTP deferred; **no billable or irreversible cloud action** in these sessions.
- No cloud apply, billable resource, irreversible lock or live estate execution was performed. `terraform validate` is as far as infrastructure work went.

## Completed at this checkpoint

Integrated the seven corrections in the [21 September review](audits/07-staging-integration-review-2026-09-21.md) — all seven verified against the code rather than accepted on report, and all seven genuine. Two were mine to have caught: the TLS floor was set in the migration runner but not in the runtime connection URLs, and preprod auto-confirmed identities, turning an unverified address into a verified one. The sharpest was `PLAN_EXECUTE` being declared in the capability matrix and enforced nowhere, so possession of a signed token was sufficient to execute and role was never checked.

Then migration 0026, which the review named as next: approval issuance in one transaction, with the content digest and eligibility rechecked under the row locks. Details and the mutation results are in Doc 14.

Validation at this checkpoint: full 0000–0026 series on real PostgreSQL; seven SQL suites including the new `approval-issuance.test.sql`; three concurrency suites; the DSN migration path and the self-hosted Supabase topology against real GoTrue and PostgREST; 255 BFF tests; typecheck and lint 15/15; format; env-security, controls-drift and deployment-coverage gates. CI must also pass for the final staging head.

## Next implementation sequence

1. **W1 safety — carry the snapshot into execution.** 0026 proves the content approved is the content _verified_. Nothing yet proves it is the content _executed_: the executor is still a refusal stub, and the approval token carries no per-action content hash for it to check. This is the direct continuation, and it is the last piece that makes the binding end-to-end.
2. **W0 acceptance / deployment.** Cloud SQL role ownership and runtime role separation, bootstrap upgrade behaviour, SMTP/invitation configuration so public signup can be re-enabled, public ingress and secrets. Self-hosted Storage is a schema contract only. GCS sealing needs a native readback verifier and an approved locked bucket before live evidence can be claimed.
3. **W1 remainder.** Browser persona journeys, MFA key rotation and deployment.
4. **W2.** The Doc 11 table/model slices with tenant-consistent foreign keys, RLS and upgrade tests; highest-value next vertical slice is estate/system/engagement linkage. Do not recreate existing regulatory, MFA or operational tables.
5. **W3.** Normalise stored onboarding proposals into estates/systems, resumable wizard, authorised live graph.

The eight PRD B.10 live execution scenarios belong to Phase 3 acceptance; API-level MFA success is not their completion. R-06 still needs populated provenance and a named human citation sign-off. W0, W1 and W2 are **partial**, not complete.

## Decisions still with the founder

- **Locking a real evidence bucket.** Irreversible and a deployment decision. No bucket is locked and no retention mode has been validated against a deployed provider, so R-10 stays open whatever the code asserts.
- **A named human sign-off for the control-library citations.** `verifiedBy: 'Axiom Minds · Founder'` is an attributed string, not a recorded sign-off.
- **Whether challenge consumption should join the issuing transaction.** It is currently outside: burning a step-up and then failing costs a re-authentication, which is the safe direction, where folding it in would mean a rolled-back issuance silently restores a spent challenge. A one-parameter change either way.

## Operational state

- Docker Desktop project `axiom-w0-parity`: API 56321, DB 56322. Other local Supabase projects preserved and untouched.
- Credentials remain in ignored `.axiom-runtime/parity/status.json` and protected logs; never print or commit them. Parity reports contain outcomes only.
- `scripts/test-database.sh` creates and removes its own container, and removes `BYPASSRLS` only inside that disposable database. It also runs `createdb`, so **extensions live in different schemas there than on a real Supabase stack** — pgcrypto lands in `public` rather than `extensions`. A migration that qualifies an extension function by schema can pass this suite and fail the parity lane. Prefer built-ins such as `sha256` over pgcrypto's `digest`.
- The parity project's migration history is real and persistent. If an unreleased migration is amended after being applied there, reset it as `supabase_admin` — drop what it created and delete its `axiom_migrations.applied` row — rather than editing the file to match a stale checksum.
- `tests/database/migration-dsn.sh` and `tests/deployment/selfhosted-supabase.sh` each create and remove their own network and containers. The latter runs real GoTrue and PostgREST and tests disabled public signup plus authenticated admin provisioning.
- Environment files: `./scripts/sync-env.sh <env> scaffold`, then `mint`, then `verify`. `verify` is a gate and exits non-zero; `--allow-simulated` is for local, staging and onprem only. `terraform.tfvars` is **generated** — editing it has no effect.
- No worker retries an outbox intent. Human release revokes other outstanding approvals; every redelivery needs a fresh one. Reconciliation and its ledger proof commit together, as does approval issuance.
- MFA policy and runbook: [operator guidance](audits/08-mfa-operator-policy.md).

Suggested resume commands: `git status --short`, `git fetch origin --prune`, compare `origin/staging` against your last tip, read any new `docs/audits/*review*.md`, then verify by running the suites rather than trusting the report. Applied SQL history through **0026** must remain unchanged; allocate the next number only after checking staging.
