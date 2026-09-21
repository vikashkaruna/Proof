# Saved implementation session — 21 September 2026

Fetch staging first; the merge containing this file is the checkpoint. Plan **Revision 26**, migration tip **0034**. Reviewed upstream **b380578**, green CI [35622078471](https://github.com/vikashkaruna/Proof/actions/runs/35622078471); no newer upstream changes at review. Read [Doc 11](11_Phase0-5_Gap_Closure_Plan.md), [Doc 16](16_Operator_Completion_Runbook.md) and [review 15](audits/15-estate-management-review-2026-09-21.md).

## Completed milestone

W3 inventory API/UI: owner/admin/founder estate and system create/edit/archive/restore, explicit legacy-intake scope assignment, atomic audit entries, optimistic versions and existing BFF idempotency. `/estate` uses tenant-scoped RLS reads and BFF writes. Declarations and observations coexist; edits preserve scanner provenance. Started or already assigned assessments cannot be moved. Archived estates cannot accept new systems/assessment bindings. Active connectors prevent archival.

The browser retains body/path/key after a lost response and offers exact-intent retry. The browser journey loses a committed response deliberately and verifies the retry uses its original key. Real-Auth integration checks exactly one audit event after replay. Unknown/expired claims need reconciliation, not a forced new key.

Validation: 298 BFF tests, 35 migrations, six concurrency suites, three populated upgrades, DSN/deploy refusal lane, real Auth parity under four local topology configurations. Browser, lint/typecheck/format and exact staging CI results are saved in ignored `.axiom-runtime/session-checkpoint.json` after completion. Local parity is not deployed evidence.

## Accepted policy and next work, in order

1. **W3 onboarding proposals:** the user answered that tenant **admins may approve too**, alongside client owners. Analysts prepare; they cannot directly change the live estate. Implement normalization/review against retained `tenant_onboarding_intakes`, with explicit estate selection, immutable proposal/review provenance and atomic audited application. Do not infer systems or migrate completed assessment scope. Full wizard remains pending.
2. W3.5 live graph and W4 registry/descriptor validation, broker/SVID and grant enforcement. Seven connector tables already exist from 0033; do not recreate them. Future activation must coordinate locks with estate/system archival. Only then normalize W5 execution details against stable grants. W2 targets: 19/40 delivered, 21 absent; 49 public tables overall.
3. W1 invitations and deployed MFA acceptance remain open. E.2.3 (ending MFA sessions after recovery-based replacement) is unanswered; the onboarding answer does not change it. Explicit revocation already ends assurance.
4. W0 deployed parity/persona harness remains engineering work. No cloud deployment or irreversible retention lock was performed.

## Workspace and operation

Worktree `/Users/vikash/.codex/worktrees/w0-w3-closure/Axiom Proof`, branch `codex/w0-w3-closure`. Preserve root and Claude worktrees. User authorizes implementation/testing/docs and merge pushes to staging at logical checkpoints. No billable/irreversible cloud deployment authorization added.

Local Docker project `axiom-w0-parity`, API 56321, DB 56322, migration tip 0034. This isolated synthetic test stack was rebuilt while validating the unpublished migration; other Docker projects were untouched. Credentials stay in ignored `.axiom-runtime`. Next migration **0035 only after fresh fetch**. Published migrations are append-only. Higher environments self-host Supabase dynamically through deployment scripts. TOTP/recovery only; email OTP deferred. Fresh human approval for execution redelivery; no automatic retry. Sudhaar has no client-system credentials. Ledger writes use append_ledger.

Local Chrome override: `AXIOM_E2E_BROWSER_CHANNEL=chrome`; CI uses pinned Chromium. Use per-journey accounts for credential-changing tests. Restore dev-generated next-env.d.ts before commit. Do not pop the superseded browser-prototype stash. Staging CI cancels superseded runs; check ancestry when diagnosing a cancellation.
