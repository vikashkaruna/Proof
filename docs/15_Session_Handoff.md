# Saved implementation session — 21 September 2026

Fetch staging first; the merge containing this file is the checkpoint. Current plan **Revision 25**, migration tip **0033**. Reviewed upstream **6271699**, green CI [35618777188](https://github.com/vikashkaruna/Proof/actions/runs/35618777188). Read [Doc 11](11_Phase0-5_Gap_Closure_Plan.md), [Doc 16](16_Operator_Completion_Runbook.md) and [review 14](audits/14-connector-foundation-review-2026-09-21.md).

## Delivered this session

1. Merge **47685ab**: C-W1-1 revocation UI and C-W1-2 quarantined enrollment continuation; atomic credential/session retirement (0031), active-credential guards and two-ordering login/revoke races. 284 BFF and 55 browser tests passed locally. Initial CI failed because a new script used `rg`, absent on the runner.
2. Merge **6271699**: atomic authenticator/recovery rotation (0032), persistence errors reported as 503, legacy unsafe primitive unavailable to service_role, old recovery history retained. SQL failure injection and populated upgrade pass; 286 BFF tests and eight lifecycle browser journeys pass. Replaced the runner-only `rg` dependency with portable `grep`. All applicable staging CI jobs passed; container build was skipped by workflow condition.
3. Current merge: W2's seven connector tables (0033), shared metadata schemas, SQL/real-Auth isolation and upgrade tests. Credential envelopes cannot be read by browser roles. Model enforces tenant/workload consistency, provenance and Drishti-read/Karya-write split. W4 runtime remains pending.

Current validation: 34 migrations, five concurrency suites, three populated upgrades, DSN/deployment failures, real Auth parity (four configurations of one local stack), 42 shared type tests, workspace lint/typecheck/format. Browser credential SELECT mutation fails as intended and was restored. Final staging CI and exact merge SHA saved in ignored `.axiom-runtime/session-checkpoint.json` after push.

## Next, in order

1. **W3 estate management API/UI:** capability-gated, audited/idempotent create/update/archive and explicit human legacy-assessment assignment. Never infer scope. The estate definition and system kinds already exist in Doc 11/0029; avoid treating runbook questions as a reason to stop independent engineering. Proposal review-role confirmation still matters before changing approval policy.
2. W4 registry/descriptor validation, broker/SVID and live grant enforcement; the new tables alone cannot connect or execute. Only then normalize W5 execution details against stable W4 grants. Remaining W2 target count: 21 of 40 absent; 19 delivered. There are 49 public tables overall on the migrated local stack.
3. W1 invitations and deployed MFA acceptance remain pending. Invitation workflow/adapter can be implemented before operator delivery provisioning. **E.2.3** question about ending MFA attestations after recovery-based replacement was asked; no answer received. Keep current replacement policy until answered. Explicit revocation always ends MFA assurance.
4. W0 deployed parity/persona harness is still engineering work; local parity is not deployed evidence. No cloud deployment or irreversible retention lock was performed.

## Workspace and operation

Active worktree `/Users/vikash/.codex/worktrees/w0-w3-closure/Axiom Proof`, branch `codex/w0-w3-closure`. Preserve root and Claude worktrees. User authorizes implementation/testing/documentation and merge pushes to staging at logical checkpoints. No billable/irreversible cloud deployment authorization has been added.

Local Docker parity project `axiom-w0-parity`, API 56321, DB 56322; migrations through 0033. Credentials under ignored `.axiom-runtime` must not be printed/committed. Next migration number is 0034 **only after a fresh fetch**. Migrations are append-only. Higher environments self-host Supabase. TOTP/recovery only; email OTP deferred. Fresh human approval for execution redelivery; no automatic retry. Challenge consumption remains outside issuance. Sudhaar has no client-system credentials. Ledger writes use append_ledger.

Use per-journey accounts for credential-changing browser tests. Local Chrome override is `AXIOM_E2E_BROWSER_CHANNEL=chrome`; CI uses pinned Chromium. Restore dev-generated next-env.d.ts files before commit. Do not pop the superseded browser-prototype stash. Staging CI cancels older runs when newer pushes land; verify ancestry before diagnosing cancellation.

Apply 0032 with the updated BFF: the old activation primitive deliberately fails closed after migration. 0033 creates empty tables; do not seed production grants or credentials to imply live connector readiness.
