# Axiom Proof — implementation handoff

> **Current status lives elsewhere.** Read [Doc 11](11_Phase0-5_Gap_Closure_Plan.md), whose newest revision section is the current checkpoint, then [Doc 14 implementation progress](14_Implementation_Progress.md) and [Doc 15 session handoff](15_Session_Handoff.md), which names the staging head this rests on. The most recent review is [audit 51](audits/51-spire-host-delivery-review-2026-09-23.md).
>
> Everything below is the **original 20 September snapshot**, kept for its design reasoning. Its commit tables, workspace paths and in-progress notes are historical and several are now wrong — the analyst work is committed, R-01 through R-11 have mixed closure, and staging has moved many times since. Do not resume from them.

## Current handoff — Revision 62 (23 September 2026)

Revision 61 is green at `13ce160` / CI [35833267173](https://github.com/vikashkaruna/Proof/actions/runs/35833267173). Revision 62 adds pinned host bundles, protected first-file delivery and initialized-state-only systemd units on Ubuntu 24.04. Docker delivery and a dedicated native systemd/loop-device CI gate accompany the 77 deployment tests. Exact merge evidence is saved in the session; do not equate prepared units with deployed services.

Resume in `codex/w0-w3-closure`, preserving the original checkout. Next complete explicit first enrollment/marker delivery and runner/observer lifecycle acceptance, then socket-volume mapping, full controller admission, scoped IAM/KMS, private TLS and the opaque scheduler. Installer retries preserve identical files and refuse upgrades/conflicts. No cloud provisioning was performed; Terraform remains default-off. Remaining workers, grants, full W3 wizard/readiness/graph, W0/W1/W2 and backup-aware key retirement are still open. Docs 11 and 14–16 carry current evidence and closure gates.

## Historical review snapshot

**As of 20 September 2026 · reviewed source: `2c54fcd` plus three uncommitted analyst files.**

W1 has substantial committed implementation but is **not complete**. Resolve the P0 review findings before declaring multi-client readiness. This document is a handoff for another implementing model; no further product implementation was performed during this review.

## Read first

1. [Doc 11, Revision 9](11_Phase0-5_Gap_Closure_Plan.md): the plan, corrections and sequence **as they stood on 20 September**. That document's newest revision section is current; read it instead.
2. [Independent review](audits/04-roadmap-review-2026-09-20.md): R-01–R-11, file evidence and actual test results.
3. [Roadmap traceability](13_Roadmap_Traceability.md): every phase module and BR/FR/NFR owner.
4. Docs [02](02_Phase_Wise_Implementation_Plan.md), [03](03_BRD_PRD.md), [04](04_Solution_Architecture.md): requirements, phase gates and architecture.

The HTML handoff map is a design reference with mock examples, not completion evidence. Text in earlier documents is historical planning context, not an instruction to deploy or implement beyond the current user's authorisation.

## Workspace and branch handoff

| Item                           | Location/state                                                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Review documentation           | Repository root checkout `/Users/vikash/Axiom Proof`, branch `docs/phase0-5-gap-closure-plan`, based on `12bd02e`                               |
| Claude implementation          | `/Users/vikash/Axiom Proof/.claude/worktrees/phase-0-5-gap-closure-5fd349`, branch `claude/phase-0-5-gap-closure-5fd349`, HEAD `2c54fcd`        |
| Unfinished role work           | Modified `packages/types/src/enums.ts` and `packages/types/src/rbac.ts`; untracked `infra/supabase/migrations/0015_user_role_axiom_analyst.sql` |
| Other pre-existing dirty files | Root checkout's `apps/marketing/next-env.d.ts` and `apps/web/next-env.d.ts`; untouched by review                                                |
| Remote-tracking state observed | `origin/staging` at `2c54fcd`; `origin/main` at `9575205`; this is not a cloud deployment or fresh remote verification                          |

> [!WARNING]
> **The table above is a 20 September snapshot and is no longer accurate.** `origin/staging` has advanced well past `2c54fcd`, the analyst files are committed, and migration allocation is through 0026. For the live workspace state, branch and resume sequence, use [Doc 15](15_Session_Handoff.md).

Resume in the implementation worktree, not the old root source. Recheck status and migration numbers against `origin/staging` on resumption; do not overwrite work in progress.

## Completed source changes

“Completed source” means the change exists in a commit. It does not assert migration application, release readiness or live acceptance.

| Commit    | Delivered source                                                                                               | Remaining boundary                                                    |
| --------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `25e3bc5` | W0.0 strict auth mode and removal of topology-based bypasses; BFF test foundation                              | Real strict environment and complete RLS policy verification          |
| `7b4db2c` | CI/lint/format groundwork                                                                                      | Not every package lints; parity/RLS/E2E release gates still missing   |
| `1c244e0` | Strict staging credential validation; Temporal configuration instead of placeholder                            | Boot/migrate from documented configuration and prove secret injection |
| `3b47fbc` | Shared kill state, tenant quota, execute-time dry-run expiry, awaited ledger, bounded nonce cache, batch fetch | In-flight halt, atomic durable execution and database constraints     |
| `9d6e2a5` | TS 0.1.1 citation mapping and count consistency work                                                           | Runtime bundle/publication/provenance parity; R-06                    |
| `cc3fcee` | W7.0 schema/metadata; Nazar loses control-library write declaration                                            | Hashed baseline publication and runtime scope enforcement             |
| `443a06a` | Central capability matrix, approval scope checking and selected route gates                                    | Agent/execute/read route enforcement and RLS alignment; R-01–R-03     |
| `5018188` | UI persisted-state hydration fix                                                                               | Not evidence of a roadmap module completing                           |
| `8fe16ce` | User-scoped pages/tenant helper; removal of auto-owner fallback                                                | SQL authority paths remain vulnerable                                 |
| `898ede6` | TOTP/recovery primitives and schema; per-tenant demo flag                                                      | Email OTP pending decision, secret wiring and abuse controls          |
| `c814f7b` | MFA service/endpoints and approval step-up                                                                     | Full content binding, direct-access enforcement and live acceptance   |
| `9be5ffd` | Login MFA attestations and enforcement                                                                         | Role policy/rotation/revocation/strict persona acceptance             |
| `2c54fcd` | Real membership-based switcher and capability-based navigation/rendering                                       | Analyst WIP and backend/database matrix parity                        |

## In progress — resume without duplicating

> [!NOTE]
> **This section is closed.** The analyst persona shipped in `dc901e9` — migration 0015, the capability matrix and render gating — and the acceptance points below were met, including the negative tests. It is kept because the reasoning about enum naming, membership resolution and the nine resulting role values remains correct. Nothing here is outstanding work.

The analyst role patch adds `AXIOM_ANALYST`, its capabilities and a separate enum migration. This is the “persona/user_role schema plus matrix” work described by the user. The SQL enum is named **`user_role`**; the membership table is **`tenant_users`**. There is no need to invent a `person` or `user_roles` table merely from that shorthand.

Before accepting the patch:

- Keep the enum addition in an append-only migration; apply it before consuming the new value in later migrations.
- Update exhaustive role tests (`rbac.test.ts:118,122` currently fail), navigation, seed identities and acceptance coverage together. Do not simply broaden expected arrays without negative tests.
- Prove analyst can run/review within assigned tenants, cannot approve/execute client mutations, cannot gain global kill/release or user-management authority, and cannot access unassigned tenants via direct database/REST paths.
- Reconcile retained `admin` and all declared roles across SQL, TypeScript, membership resolution, API guards and UI. The plan's eight-row proposal plus retained admin yields nine distinct role values once analyst is added.
- Do not accept migration 0015's comment that internal RLS already makes this safe; R-01/R-02 contradict it.

## Pending — concrete next work

| Priority      | Work                            | Definition of the next acceptable result                                                                                                                           |
| ------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0            | R-01/R-02 SQL authority closure | No self-promotion, target-row tenant binding, safe privileged role assignment; direct Postgres/PostgREST tests including analyst/owner/viewer and multiple tenants |
| P0            | R-03 generic invocation         | Typed payload, role gate, trusted tenant binding, engagement ownership, internal agent policy; Karya cannot bypass execute gate                                    |
| P1            | R-07/R-08 MFA closure           | Key provisioned without leakage, clean strict boot, policy clarified, shared abuse budget, revocation and reviewed-content step-up tests                           |
| P1            | R-06 regulatory publication     | TS/Python parity, immutable old/new library versions, official source hashes, real reviewer provenance; corrected reports remain traceable                         |
| P1            | W2 model slices                 | Existing schema normalised intentionally; request/batch/action keys fixed; fresh and upgrade migrations pass; table ownership classification documented            |
| P1            | W3/W4                           | Estate onboarding then real connector/grant/identity contracts and binding proofs; three live connector types required for Phase 2 exit                            |
| P1            | W5                              | Durable approved-subset execution, contract-compatible dispatch, actual dry-run/rollback, in-flight caps/kill, verification and reconciliation                     |
| P1            | W8.1–W8.3 / W3.1                | Rights/consent, breaches, founder output release, persistent review/generator/playbook journeys                                                                    |
| Continuous    | W9 / W9.1                       | Release-path CI, strict persona E2E, real SQL and operational evidence rather than mock-only assertions                                                            |
| Later / gated | W6, W7 overlays, W10            | Use Doc 11 packages and roadmap commercial gates; retain intentional scope additions                                                                               |

## W2 migration design constraints

- Numbers 0009–0014 are already occupied by kill switch, ledger vocabulary, regulatory metadata and MFA. 0015 is WIP. Allocate new numbers only after checking the worktree.
- Reuse existing `remediation_actions` dry-run/rollback/execution fields through a deliberate migration/backfill; do not introduce divergent duplicate state.
- Use composite tenant-consistent relationships for estate → system → connector → engagement → finding/plan/action. Test that a valid tenant A FK cannot point to tenant B data.
- Global reference data (controls, instruments, baselines, descriptors where global) differs from tenant-owned state and user-scoped MFA. Set publication authority and RLS accordingly.
- Protect safety transitions from broad authenticated updates. Only narrow trusted paths may set dry-run/rollback/approval/execution status; preserve the signed human-approval gate.
- Plan transaction/outbox boundaries now: consuming a token, claiming actions and recording intent cannot leave an unrecoverable half-state. A retries cache written after side effects is not a concurrency guarantee.

## Verification and reporting contract

Use the [review's result table](audits/04-roadmap-review-2026-09-20.md#verification-performed) as the latest local baseline. It includes two expected-to-fix failures, not a wholly green repository. Full build, real database, deployed state and strict E2E remain unverified. Local Python testing used 3.14.6; additionally validate the deployed 3.11 image.

For each completed slice, record commit, applied migration versions, exact command/result, environment/auth mode, tested roles/tenants and any remaining external evidence. Do not label W1 “done” before direct-access isolation, role denial and strict persona flows pass. Do not label Phase 3 “done” before all eight PRD B.10 criteria, a controlled rollback and the original production-client acceptance gate are satisfied.

## Decisions awaiting confirmation

> Resolved since this snapshot: email OTP **is** intentionally deferred; analyst access **is** assigned tenants only, without aggregate `MULTI_TENANT_READ`; higher environments self-host Supabase; every outbox redelivery needs a fresh approval; proxy trust is configured per environment and disabled by default. The still-open decisions are in [Doc 15](15_Session_Handoff.md).

- ~~Whether email OTP is intentionally deferred~~ — deferred, confirmed by the founder.
- ~~Whether analyst access is assigned tenants only~~ — assigned tenants only, confirmed.
- Sectoral pack #1 selection before pack delivery.
- Authoritative provider/retention equivalence record and marketing/API boundary reconciliation.
- BR-4 founder review versus automatic public gap-scan delivery: either introduce the review gate or record an explicit exception with precise scope.

No waiting decision blocks fixing the confirmed P0 defects or continuing independent schema design.
