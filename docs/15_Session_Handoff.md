# Saved implementation session — 21 September 2026

Logical checkpoint after integrating staging `369bcf7` and correcting the gap between the MFA-bound read and signed approval snapshot (0028). The merge commit containing this file is the resume baseline; fetch staging first. Current status: [Doc 11 Revision 14](11_Phase0-5_Gap_Closure_Plan.md), [progress](14_Implementation_Progress.md), [review 09](audits/09-reviewed-approval-snapshot-2026-09-21.md).

## Workspace and authorization

- Worktree: `/Users/vikash/.codex/worktrees/w0-w3-closure/Axiom Proof`, branch `codex/w0-w3-closure`, merged to staging. Preserve other worktrees and any uncommitted work in them.
- Two models alternate on this repository and review each other's work. Assume staging has moved on arrival, and assume the other model's work is sound but incomplete — verify findings against the code before accepting them, and hunt for what was left behind. Both assumptions have repeatedly paid off.
- Accepted decisions stand: higher environments self-host Supabase; fresh approval for every redelivery; proxy trust configured per environment and disabled by default; TOTP and recovery codes only, email OTP deferred; **no billable or irreversible cloud action** in these sessions.
- Challenge consumption stays **outside** the issuing transaction as a deliberate inherited tradeoff: a later failure costs a fresh authentication. This is settled, not a pending founder decision — do not infer an approval to change it from the review documents.
- No cloud apply, billable resource, irreversible lock or live estate execution was performed. `terraform validate` is as far as infrastructure work went.

## Completed at this checkpoint

Integrated the other model's 0026 atomic issuance, portability correction and 0027 claim snapshot enforcement. Added 0028: a pure SQL digest of the exact rows MFA verified, a locked expected-plan-revision/status check, and retirement of the old service-callable issuance entrypoint. Parameter/dry-run edits between challenge consumption and digest acquisition previously issued tokens; regression tests reproduced that behavior and now refuse it. Existing token digest compatibility is tested against the original 0026 implementation.

Validation: 258 BFF tests, typecheck/lint; migrations 0000–0028, ten SQL suites, four actual concurrency suites and DSN/deploy refusal tests; four real Auth/MFA parity labels. Final staging CI must pass for the merge commit. No cloud deployment was attempted.

## Next implementation sequence

1. **W4/W5 execution prerequisite (not a stub-only W1 task).** 0027 made the _claim_ enforce the snapshot: the digest is signed into the approval token, recomputed under the action row locks, and carried onto the wire as dispatch contract v2. What remains is the executor itself, which is a refusal stub and therefore records the snapshot rather than re-verifying against it. A real executor must recompute the digest against the rows it is about to mutate and refuse on a mismatch, proved with fault injection. Adding that check to the stub now would read as coverage while guarding nothing.
2. **W0 acceptance / deployment.** Cloud SQL role ownership and runtime role separation, bootstrap upgrade behaviour, SMTP/invitation configuration so public signup can be re-enabled, public ingress and secrets. Self-hosted Storage is a schema contract only. GCS sealing needs a native readback verifier and an approved locked bucket before live evidence can be claimed.
3. **Next independent W1 implementation.** Strict browser persona journeys and MFA key rotation. Review the existing Playwright harness and security UI first; keep actual external execution refused until a connector-backed executor exists.
4. **W2.** The Doc 11 table/model slices with tenant-consistent foreign keys, RLS and upgrade tests; highest-value next vertical slice is estate/system/engagement linkage. Do not recreate existing regulatory, MFA or operational tables.
5. **W3.** Normalise stored onboarding proposals into estates/systems, resumable wizard, authorised live graph.

The eight PRD B.10 live execution scenarios belong to Phase 3 acceptance; API-level MFA success is not their completion. R-06 still needs populated provenance and a named human citation sign-off. W0, W1 and W2 are **partial**, not complete.

## Decisions still with the founder

- **Locking a real evidence bucket.** Irreversible and a deployment decision. No bucket is locked and no retention mode has been validated against a deployed provider, so R-10 stays open whatever the code asserts.
- **A named human sign-off for the control-library citations.** `verifiedBy: 'Axiom Minds · Founder'` is an attributed string, not a recorded sign-off.

## Operational state

- Docker Desktop project `axiom-w0-parity`: API 56321, DB 56322. Other local Supabase projects preserved and untouched.
- Credentials remain in ignored `.axiom-runtime/parity/status.json` and protected logs; never print or commit them. Parity reports contain outcomes only.
- `scripts/test-database.sh` creates and removes its own container, and removes `BYPASSRLS` only inside that disposable database. It also runs `createdb`, so **extensions live in different schemas there than on a real Supabase stack** — pgcrypto lands in `public` rather than `extensions`. A migration that qualifies an extension function by schema can pass this suite and fail the parity lane. Prefer built-ins such as `sha256` over pgcrypto's `digest`.
- The parity project’s migration history is real and persistent. Preserve applied migrations and history; use a forward migration for corrections. Do not reset shared local state to hide a checksum mismatch.
- `tests/database/migration-dsn.sh` and `tests/deployment/selfhosted-supabase.sh` each create and remove their own network and containers. The latter runs real GoTrue and PostgREST and tests disabled public signup plus authenticated admin provisioning.
- Environment files: `./scripts/sync-env.sh <env> scaffold`, then `mint`, then `verify`. `verify` is a gate and exits non-zero; `--allow-simulated` is for local, staging and onprem only. `terraform.tfvars` is **generated** — editing it has no effect.
- No worker retries an outbox intent. Human release revokes other outstanding approvals; every redelivery needs a fresh one. Reconciliation and its ledger proof commit together, as does approval issuance.
- MFA policy and runbook: [operator guidance](audits/08-mfa-operator-policy.md).

Suggested resume commands: `git status --short`, `git fetch origin --prune`, compare `origin/staging` against your last tip, read any new `docs/audits/*review*.md`, then verify by running the suites rather than trusting the report. Applied SQL history through **0028** must remain unchanged; allocate the next number only after checking staging.

Deployment order for 0028: migrate first, then upgrade the BFF. The old issuance RPC loses service-role access, so mixed versions fail closed for approvals until upgraded. The MFA challenge and dispatch v2 contracts are unchanged. Local parity now has migrations through 0028.
