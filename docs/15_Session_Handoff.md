# Saved implementation session — 21 September 2026

Fetch staging first; the merge containing this file is the checkpoint. Plan **Revision 27**, migration tip **0035**. Reviewed upstream **b62f87b**, green CI [35626658366](https://github.com/vikashkaruna/Proof/actions/runs/35626658366). Read [Doc 11](11_Phase0-5_Gap_Closure_Plan.md), [Doc 16](16_Operator_Completion_Runbook.md) and [review 16](audits/16-onboarding-proposal-review-2026-09-21.md).

## Completed this session

1. `b62f87b`: W3 inventory API/UI (0034), audited/idempotent create/edit/archive/restore, optimistic versions, declared/observed provenance, and explicit assignment of unassigned intakes without recorded work. 298 BFF tests; staging CI green. No newer other-model work was present when fetched.
2. Current merge: W3 staff proposal preparation and client owner/**admin** review (0035), implementing the user's policy answer. Immutable original-intake, estate and normalized-system snapshots; distinct reviewer; content hash and estate-version checks; atomic application/auditing; source-index linkage; one import per initial intake. `/estate/onboarding` is linked from `/estate`.

Validation: 309 BFF tests, 59 browser journeys, all 36 migrations, seven concurrency suites, three populated upgrades, DSN/deploy refusal lane and four local real-Auth parity configurations. Workspace lint/typecheck/format pass. Exact final merge/CI is saved in ignored `.axiom-runtime/session-checkpoint.json`. Local parity remains distinct from deployed evidence.

## Next work, in order

1. **W4.1 registry/contracts/lifecycle**, reusing seven tables from 0033. Then W4.2 broker, W4.3 workload identity, W4.4 live grants. Do not claim W4 execution from schemas or draft connector records. Activation must serialize with estate/system lifecycle checks. W5 normalization waits for stable W4 grants.
2. Complete the W3 resumable company→estate→inventory→connector/grant→readiness wizard and W3.5 live graph against those enforced permissions. Initial proposal review currently handles the whole retained intake; per-item exclusion, later batches and unsent draft autosave remain pending. Preserve original region/personal-data declarations; do not claim they are verified.
3. W1 invitations and deployed MFA acceptance; E.2.3 remains unanswered and is independent of the onboarding admin-policy answer. W0 deployed parity/persona harness also remains engineering work.

Named W2 targets: 19/40 delivered, 21 absent. New proposal/history-link tables bring public tables to 51; do not count them as completing other named W2 targets. Proposal prepare is limited to founder/analyst membership; review to owner/admin, with no self-review. Client human estate management remains separate from agent execution approval.

## Workspace and operation

Worktree `/Users/vikash/.codex/worktrees/w0-w3-closure/Axiom Proof`, branch `codex/w0-w3-closure`. Preserve root and Claude worktrees. User authorizes implementation/tests/docs and merge pushes to staging at logical checkpoints. No billable/irreversible cloud deployment authorization added.

Local Docker project `axiom-w0-parity`, API 56321, DB 56322, through 0035. Only this synthetic stack was rebuilt while iterating unpublished 0034; 0035 upgrades it normally. Credentials remain in ignored `.axiom-runtime`. Next migration **0036 only after fresh fetch**. Published migrations are append-only. Higher environments self-host Supabase via dynamic deployment scripts. TOTP/recovery only; email OTP deferred. Fresh human approval for execution redelivery; no automatic retry. Sudhaar has no client-system credentials. Ledger writes use append_ledger.

Local Chrome override: `AXIOM_E2E_BROWSER_CHANNEL=chrome`; CI uses pinned Chromium. Use per-journey accounts/tenants for mutable browser fixtures. Restore dev-generated next-env.d.ts before commit. Do not pop the superseded browser-prototype stash. Verify ancestry before diagnosing cancelled staging CI runs.
