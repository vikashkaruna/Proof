# Continuing implementation — Revision 72

The user's 23 September instruction is to continue in plan order after every green milestone, report each milestone, and maintain the implementation/testing/documentation/no-fast-forward staging-merge cycle. It supersedes the earlier request to stop after one milestone. Use the existing isolated Docker parity stack where appropriate. No cloud provisioning/apply is authorized. The overall roadmap is incomplete; do not mark the whole goal complete because one revision passes.

## Current source and integration gate

**Current checkpoint:** Revision 71 is complete on staging `fd747ad3125895fc49534db5229b72e7ea7e0f60`; [CI 35872098864](https://github.com/vikashkaruna/Proof/actions/runs/35872098864) passed all 19 applicable jobs and all 13 exact-revision acceptance reports, including 45 native runner outcomes. The user's 23 September continuation instruction supersedes the earlier one-milestone stop: proceed in plan order after each green milestone, updating implementation, tests, documentation and staging integration, and report each milestone.

**Implemented, source gate passed:** migration 0049 supplies a non-login, non-inheriting controller role, a private credential registry and tenant checks around the seven existing controller RPCs. RLS and column grants permit only registration, key-policy and opaque dispatch reads. Existing assessment logic, task/approval checks and ledger writes remain authoritative. No delegation, enqueue, policy publication, retention, direct table-write or general administration authority is granted. The existing public `has_tenant_role` read helper remains callable; it adds no write authority.

The production entrypoint requires an owner-only JSON credential file containing an anonymous gateway key and a signed controller token, rejects broad/foreign/expired credentials, and obtains the effective registered tenant through a bounded read-only PostgREST check before listening. The backend verifies the signature; SQL rechecks registration, expiry and revocation per statement. Tokens last at most one hour and registry leases at most 24 hours. A running statement can still settle after revocation; preserve existing uncertain-result recovery and never reset a claim. Signing keys remain outside the runner.

**Local acceptance:** clean source `b547b03` passes 78 real Docker assessment outcomes, preserving every earlier 71 outcome, plus 61 SPIRE identity and five protected-trust checks. Both the actual controller composition and production entrypoint use the scoped credential. All 1,004 BFF tests, 168 deployment tests, the full database migration/security/concurrency/upgrade suite, workspace checks and control/security gates pass. A failed release download was resolved using the prior session's checksum-verified archive; the first full run also required installing this checkout's missing locked Temporal dependencies. Neither failed attempt is closure evidence. Exact source/staging CI remains the final gate.

**Source gate passed:** [CI 35877565279](https://github.com/vikashkaruna/Proof/actions/runs/35877565279) passes all **19 applicable jobs and 13 exact-revision reports** for source `b547b03` (PR integration `6654a47`). This includes 78 assessment outcomes with all earlier 71 retained, 45 native runner outcomes, 61 identity checks, five protected-trust checks and 146 Temporal outcomes. Both container configurations preserve the baseline 89 API and 67 browser outcomes exactly. The documentation-only integration checkpoint records these results; exact staging merge evidence is saved in `.axiom-runtime/revision72/merge-final` and `.axiom-runtime/session-checkpoint.json` after that independent gate.

**Next:** finish exact staging acceptance for this backend boundary, then resource-level secret/KMS/IAM configuration and effective-policy acceptance, private TLS/DNS and opaque scheduler deployment. Credential issuance, renewal and reviewed host-generation replacement are deployment work, not automatic startup behavior. Real GCP IIT/caller/KMS and Mumbai recovery remain external gates. No cloud apply is authorized. W0/W1/W2/W3/W4 remain partial; W2 remains **19/40** named targets. Schema is **0049 / 50 migrations / 55 public tables**, plus the private credential registry. See [audit 61](audits/61-controller-backend-scope-review-2026-09-23.md).

- Prior staging baseline: Revision 70, `616ed0239ef27fce4f483a951baccd02132a65d0`, CI [35861740826](https://github.com/vikashkaruna/Proof/actions/runs/35861740826), all 19 applicable jobs and 13 exact-revision artifacts green.
- Original WIP is preserved on `codex/controller-supervision` at `b7fe4f03cd742636955f8231df9d8f5699a076a8` (implementation checkpoint `1912444`). It is not the finished Revision 71 evidence.
- Revision 71 review used `codex/revision71-controller-review` in `/Users/vikash/.codex/worktrees/750f/Axiom Proof`, with [PR 37](https://github.com/vikashkaruna/Proof/pull/37). Source [CI 35868902682](https://github.com/vikashkaruna/Proof/actions/runs/35868902682) passes all 19 applicable jobs and 13 exact-revision result artifacts, including 45 native runner outcomes with the earlier 33 preserved. Revision 71 staging merge is `fd747ad`, CI 35872098864 green; read this task’s `.axiom-runtime/session-checkpoint.json` or inspect the staging CI before continuing. The verified source checkpoint is recorded in Doc 15; final exact-merge CI and artifacts are recorded in this task’s `.axiom-runtime/revision71` and `.axiom-runtime/session-checkpoint.json`.
- Do not edit `/Users/vikash/Axiom Proof` or `/Users/vikash/.codex/worktrees/w0-w3-closure/Axiom Proof`. Both are separate task checkouts. Do not reload/fork the old conversation.

Current active branch: `codex/revision72-controller-permissions`, based on verified Revision 71 staging. Revision 72 source acceptance is green; exact staging integration is the remaining milestone gate.

## Revision 71 scope

The runtime delivers reviewed protected profiles/disabled units and supervises a fixed private controller container with durable intent and exact ownership. Review added direct confinement regressions, bounded namespace discovery, explicit 90-second Docker stop timeout/180-second unit budget, strict intent bindings, and durable start intent to preserve uncertain activation. No automatic restart, name adoption, deletion, job reset or cloud apply is supplied. Local deployment tests total 168; Docker host delivery has 16 passing outcomes. Read [audit 60](audits/60-controller-supervision-review-2026-09-23.md) and [Doc 16](16_Operator_Completion_Runbook.md) before any operator action.

The new native lifecycle fixture uses a deliberately synthetic process and a fixture-only local-node placement substitution. Native Linux must verify exact private binding and ownership failure paths. The production GCP placement path must reject that local node. Separate actual controller-entrypoint, SPIRE identity and assessment gates remain mandatory; fixture success is not real GCP/IAM/KMS/TLS deployment acceptance. The local Docker Desktop port rewrite was reproduced and remains refused without weakening the guard.

## Pending in plan order

Effective tenant-scoped backend/secret/IAM/KMS permissions, private TLS/DNS and opaque scheduler deployment remain next. Actual GCP IIT, valid cloud caller identity, real KMS and Mumbai backup/restore remain external gates. No cloud provisioning/apply is authorized.

The broader roadmap is incomplete: W0 remote deployments/parity; W1 invitations/email/deployed acceptance; W2 **19/40 named target tables delivered** (schema 0049, 50 migrations, 55 public tables plus a private credential registry); W3 full resumable wizard/sustenance/live graph; W4 remaining worker/actor chains, live connector grants and later execution lifecycle; later W5–W10 phase gates. Completed supervision does not complete W4 or the overall goal.

## Standing constraints

- Local real Docker Supabase/Auth/Postgres; generated higher-environment configuration.
- Dedicated private Mumbai runner **VM per tenant**, separate private issuer and public Cloud Run APIs.
- Owners **or tenant admins** approve staff onboarding proposals.
- Mandatory MFA again after recovery-code authenticator replacement.
- Completed private dispatch retention configurable by environment, default 90 days; unresolved jobs/evidence retain separate rules.
- Preserve application approvals, dry-run/rollback, Sudhaar's no-write role, append-only ledger, WORM and Mumbai locality.
- Native systemd fixture is **fresh GitHub-hosted Ubuntu only**, never a user machine. `/Users/vikash/bin/gh` is available. Private runtime artifacts must not be committed or reused as deployable configuration.
