# Bounded milestone handoff — Revision 71

The user requested one bounded milestone per task, with explicit completed/pending status and a stop. This task reviews and finishes Revision 71 controller supervision only. Do not continue the next roadmap chunk without the user's direction. The old task's goal tracker was usageLimited, not complete; do not reset it or infer whole-goal completion.

## Current source and integration gate

- Last verified staging checkpoint: Revision 70, `616ed0239ef27fce4f483a951baccd02132a65d0`, CI [35861740826](https://github.com/vikashkaruna/Proof/actions/runs/35861740826), all 19 applicable jobs and 13 exact-revision artifacts green.
- Original WIP is preserved on `codex/controller-supervision` at `b7fe4f03cd742636955f8231df9d8f5699a076a8` (implementation checkpoint `1912444`). It is not the finished Revision 71 evidence.
- Current task owns `codex/revision71-controller-review` in `/Users/vikash/.codex/worktrees/750f/Axiom Proof`, with [PR 37](https://github.com/vikashkaruna/Proof/pull/37). Native/source CI and exact staging integration must pass before claiming completion. Final confirmed source, merge, CI and artifact outcomes are recorded in Doc 15 and `.axiom-runtime/revision71`.
- Do not edit `/Users/vikash/Axiom Proof` or `/Users/vikash/.codex/worktrees/w0-w3-closure/Axiom Proof`. Both are separate task checkouts. Do not reload/fork the old conversation.

## Revision 71 scope

The runtime delivers reviewed protected profiles/disabled units and supervises a fixed private controller container with durable intent and exact ownership. Review added direct confinement regressions, bounded namespace discovery, explicit 90-second Docker stop timeout/180-second unit budget, strict intent bindings, and durable start intent to preserve uncertain activation. No automatic restart, name adoption, deletion, job reset or cloud apply is supplied. Local deployment tests total 165; Docker host delivery has 16 passing outcomes. Read [audit 60](audits/60-controller-supervision-review-2026-09-23.md) and [Doc 16](16_Operator_Completion_Runbook.md) before any operator action.

The new native lifecycle fixture uses a deliberately synthetic process and a fixture-only local-node placement substitution. Native Linux must verify exact private binding and ownership failure paths. The production GCP placement path must reject that local node. Separate actual controller-entrypoint, SPIRE identity and assessment gates remain mandatory; fixture success is not real GCP/IAM/KMS/TLS deployment acceptance. The local Docker Desktop port rewrite was reproduced and remains refused without weakening the guard.

## Pending after this milestone — stop before starting

Effective tenant-scoped backend/secret/IAM/KMS permissions, private TLS/DNS and opaque scheduler deployment remain next. Actual GCP IIT, valid cloud caller identity, real KMS and Mumbai backup/restore remain external gates. No cloud provisioning/apply is authorized.

The broader roadmap is incomplete: W0 remote deployments/parity; W1 invitations/email/deployed acceptance; W2 **19/40 named target tables delivered** (schema 0048, 49 migrations, 55 public tables); W3 full resumable wizard/sustenance/live graph; W4 remaining worker/actor chains, live connector grants and later execution lifecycle; later W5–W10 phase gates. Completed supervision does not complete W4 or the overall goal.

## Standing constraints

- Local real Docker Supabase/Auth/Postgres; generated higher-environment configuration.
- Dedicated private Mumbai runner **VM per tenant**, separate private issuer and public Cloud Run APIs.
- Owners **or tenant admins** approve staff onboarding proposals.
- Mandatory MFA again after recovery-code authenticator replacement.
- Completed private dispatch retention configurable by environment, default 90 days; unresolved jobs/evidence retain separate rules.
- Preserve application approvals, dry-run/rollback, Sudhaar's no-write role, append-only ledger, WORM and Mumbai locality.
- Native systemd fixture is **fresh GitHub-hosted Ubuntu only**, never a user machine. `/Users/vikash/bin/gh` is available. Private runtime artifacts must not be committed or reused as deployable configuration.
