# Axiom Proof — deployment and acceptance gates

**Status, 2026-09-30:** Deployment instructions are conditional. [Doc 16](16_Operator_Completion_Runbook.md) is the current workstream status; [Audit 91](audits/91-release-readiness-reassessment-2026-09-30.md) lists the open release evidence. The earlier Revision 98 checklist in this file is retired. Its old migration counts, “promote first” instruction, W8 feature inventory and assumed cloud topology must not be used for a current deploy. Historical detail remains in [the archived Revision 98 handoff](16_Operator_Completion_Runbook.md#historical-implementation-chronology) and [the session brief](17_Fresh_Session_Brief.md).

Revision 112 / [PR #111](https://github.com/vikashkaruna/Proof/pull/111) merged to `staging` at `dfd27e9`; exact-staging CI, Bandit, Trivy and Semgrep all passed, including container/browser acceptance. W8 source-bound reports, retained immutable artifacts, trustworthy approval exports, and dispatched proof remain open, followed by W9 and W10. No remote preprod or production acceptance run is recorded. The local production-profile Docker test is **not** a production deployment.

## 1. Engineering clearance before release

Record one evidence row per W0–W10 requirement with the implementing commit, test or measured result, reviewer and unresolved limitation. The [gap plan](11_Phase0-5_Gap_Closure_Plan.md) defines the requirements; Audit 91 identifies the current false-completion findings. At minimum:

- W8 must prove source/producer binding, verified immutable versions for exact source, PDF and dossier bytes, review/release/dispatch bound to those receipts, honest approval exports, and real positive/refusal browser and provider journeys. Do not enable the old caller-authored report or Pramaan/email paths as a shortcut.
- W9 must enforce coverage floors in CI, measure the real throughput and report thresholds, and restore the database **and evidence objects** from a scheduled backup with measured RPO/RTO and integrity checks.
- W10 must pass an isolated offline install, upgrade, restore and persona journey with strict secrets, functional in-perimeter Auth/PostgREST/DB, verified WORM configuration, and local model dispatch or an explicit unavailable result. Test with egress blocked.
- Re-run the complete quality and security gate at the exact proposed release SHA. Preserve `AGENTS.md` approval, ledger, Object Lock and residency invariants. Merge each increment into `staging` only after its PR checks pass, then verify CI and security on the exact staging merge SHA.

Until these are green, remain in the implementation and staging cycle. A green PR or local Docker suite alone is not release clearance.

## 2. Identify and prepare the real target

Before changing an environment, obtain its actual provider/project/account, region, runtime and data topology, existing deployment SHA, database migration ledger, secrets source, DNS and rollback route. Do not assume the AWS/EKS/Supabase examples in [Doc 08](08_DEPLOYMENT_GUIDE.md) represent the live target; that guide mixes historical topology descriptions with the current Cloud Run and private Mumbai workload-host decision. Verify this target from provider state and deployment records. Preserve existing client data and running services.

Use fresh secrets from the target's secret manager; rotate values known exposed in historical repository commits. Confirm that all client personal data, backups, storage, logs and model processing remain in `ap-south-1`, and that third-party model egress receives only redacted values. Verify identity and IAM boundaries, network paths, the effective strict auth mode, and S3 Object Lock **Compliance** retention with a readback against a real object/version. Confirm a recoverable backup and rollback plan before migration or traffic cutover. Never print credentials into logs or artifacts.

The user has requested production deployment after full engineering clearance. This page does not prohibit an agent from deploying an authorized release; it requires a verified target and completed gates. Staging-to-main promotion remains a separate branch/release-control decision, not the first step in a stale Revision 98 checklist.

## 3. Preprod deployment and deployed acceptance

Deploy the release candidate at an exact, recorded SHA, with the same security rules as production. Apply only checksum-verified **append-only** migrations to the target. Verify startup, service revisions, migration ledger, health, auth, tenant isolation, MFA, BFF approval gates, ledger append path, provider credentials, scheduler and connector composition. Use synthetic tenants and avoid destructive action on client data. A claimed live write-path test must use a human approval with a completed dry-run, validated rollback and signed scope token.

Run [the target-identity and browser/API runner](../scripts/run-deployed-acceptance.sh) with a private `AXIOM_ACCEPTANCE_TARGET` file. It validates revision and HTTP identity before seeding fixture identities. The [deployed acceptance workflow](../.github/workflows/deployed-acceptance.yml) requires an exact 40-character SHA and environment-scoped target secret. Its two matrices compare preprod with a separately configured production-profile or on-prem target; **a `production-configured-acceptance` label is not proof of actual production**. Archive allowlisted API/browser result artifacts, migration/target proof, provider readbacks and failure details without fixture credentials. The [local HTTP harness](../scripts/test-deployed-http.sh) is a useful engineering rehearsal only.

Run the W8 positive/refusal journeys through the actual preprod web and BFF, including founder versus manager/viewer, report provenance, retained object/version and release/dispatch checks. Exercise W9 measured load/restore and W10 offline tests in their appropriate isolated targets. Record differences and fix them before promotion; do not mark a failing or unrun gate green.

## 4. Production release and acceptance

After preprod and W0–W10 evidence are green, select the exact tested release SHA and reconcile the branch promotion policy with the target deployment mechanism. Take/verify the production backup and rollback route, apply only validated migrations, deploy the same artifact, and verify its reported SHA and migration ledger before shifting traffic. Check health, real residency/IAM/Object Lock configuration, core persona/API/browser journeys with synthetic accounts, protected approval/ledger behavior, evidence exact-version retrieval, and release/dispatch refusal boundaries. Run remote deployed acceptance against the **actual production URL and topology**, not just a production-configured local or CI stack. Capture the workflow run, sanitized results, target revision, timing and operator decision.

If a gate fails, stop promotion, isolate or roll back the application by the documented target-specific route, and preserve append-only data. Database rollback is not an automatic reverse of an applied migration. Investigate against [the runbook](09_RUNBOOK.md), record the failure and rerun the exact failed gate plus affected regression suite before retrying.

Only after the exact production revision and all required remote checks pass may the plan be marked complete. Update [Doc 16](16_Operator_Completion_Runbook.md) and the release audit with links to concrete evidence rather than percentages or inferred status.
