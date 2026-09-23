# Continuing implementation — Revision 73

The user's 23 September instruction is to continue in plan order after every green milestone, reporting each milestone and maintaining the implementation/testing/documentation/no-fast-forward staging-merge cycle. It supersedes the earlier one-milestone stop. Use existing isolated Docker services where appropriate. The overall goal is active and incomplete. No cloud provisioning/apply is authorized.

## Revision 73 — tenant controller secret/KMS permission configuration

**Verified baseline:** Revision 72 is complete on staging `3c2ff1e53452ac3d2762da9652322050624ee486`, [CI 35879582618, attempt 2](https://github.com/vikashkaruna/Proof/actions/runs/35879582618/attempts/2): all 19 applicable jobs and 13 exact-revision reports passed. The 78 assessment outcomes retain every earlier 71; all 45 native runner outcomes and both configurations' 89 API/67 browser outcomes are preserved. [PR 38](https://github.com/vikashkaruna/Proof/pull/38) is merged. The first staging attempt and redundant documentation PR run were cancelled before closure; only successful attempt 2 is evidence.

**Implemented, acceptance pending:** the default-off workload module now accepts a reviewed per-tenant primary/retiring dispatch-key inventory. Opted-in runners receive two empty, tenant-labelled, Mumbai-only secret containers and fixed resource-level secret-access/decryption grants. The issuer and unconfigured tenants receive none. Shared/duplicate keys, foreign projects/regions, key-version references and zero tenant IDs are refused. No secret versions, signing keys, producer encryption grants or key retirement are managed. The root conditionally enables the KMS API only for this explicit configuration and never disables that shared API on removal.

A non-secret output binds the tenant, host identity, secret resources and exact key-policy fingerprint to the backend's existing contract. Promotion retains old readable-key grants. The independent source inventory gate rejects broader roles, additional authority resources and indirect secret reads. Local module tests pass **26 evaluated cases**, the root passes **nine composition cases**, and the deployment suite passes **178 tests**. Formatting, control/drift and security gates pass; combined source/staging CI remains required at this checkpoint. See [audit 62](audits/62-controller-resource-iam-review-2026-09-23.md) for the configuration contract and concrete effective-policy acceptance requirements.

**Next and limits:** resource configuration is not proof of effective inherited/cloud IAM. Actual per-principal allow/deny checks, secret replication/payload validation, real KMS and global key-purpose review remain external gates. Continue credential issuance/renewal and protected generation rollout, private TLS/DNS, opaque scheduler and authorized cloud identity/recovery acceptance. No cloud provisioning/apply is authorized or performed. W0/W1/W2/W3/W4 remain partial; W2 is **19/40**, schema **0049 / 50 migrations / 55 public tables**, plus the private credential registry. Continue in plan order after each green milestone and report it.

## Current work and evidence

- Worktree: `/Users/vikash/.codex/worktrees/750f/Axiom Proof`; active branch `codex/revision73-controller-resource-iam` from verified staging `3c2ff1e`.
- Revision 72 code source `b547b03`, documentation `3d2268e`, PR integration `6654a47`, source CI 35877565279 and staging CI 35879582618 attempt 2 are verified. Source/staging reports and checks are under this worktree's `.axiom-runtime/revision72`; `completion.json` and `COMPLETED.md` record closure. Do not infer whole-roadmap completion from it.
- Revision 73 local progress and source/staging evidence are under `.axiom-runtime/revision73` and `.axiom-runtime/session-checkpoint.json`. Inspect current CI/commit state before resuming.
- Do not edit `/Users/vikash/Axiom Proof` or `/Users/vikash/.codex/worktrees/w0-w3-closure/Axiom Proof`; they are other task checkouts. The old `codex/controller-supervision` WIP at `b7fe4f0` remains preserved. Do not reload/fork the old conversation.
- The workload Terraform module has 26 mocked boundary/permission cases; the preprod root has nine cases. `scripts/check-workload-iam.py` and ten mutation tests complement evaluated Terraform. Mock applies are offline test state, not deployed IAM evidence.

## Pending plan and standing constraints

Complete the current exact source/staging gate, then credential issuance/renewal and protected generation rollout, private TLS/DNS, opaque scheduler and real GCP IIT/caller/KMS/Mumbai restore. Effective external/inherited IAM remains required before activation. W0 remote parity, W1 invitations/email/deployed acceptance, W2's 21 remaining named targets, full W3 resumable wizard/sustenance/live graph, remaining W4 workers/actor chains/connector grants/later execution lifecycle and W5–W10 phase gates remain open.

- Local real Docker Supabase/Auth/Postgres; generated higher-environment configuration.
- Dedicated private Mumbai runner VM per tenant; separate private issuer; public APIs remain on Cloud Run.
- Owners or tenant admins may approve staff onboarding proposals. Mandatory MFA returns after recovery-code authenticator replacement.
- Completed private dispatch retention is configurable, default 90 days; unresolved jobs/evidence have separate rules.
- Preserve scope-bound human approval, completed dry-run/validated rollback, Sudhaar's no-write role, append-only ledger, WORM and Mumbai locality.
- Native systemd fixtures run only on fresh GitHub-hosted Ubuntu, never the user machine. Local Docker Desktop rewriting of private host bindings is refused; do not weaken admission.
- `/Users/vikash/bin/gh` is available. Never commit private runtime artifacts or reuse synthetic fixture credentials as deployment configuration. Downloads suppress signed artifact URLs from tool output.
