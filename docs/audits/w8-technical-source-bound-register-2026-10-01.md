# W8.3 recorded technical remediation register — source and release boundary

The technical report is a **recorded-state register** derived from one tenant-bound remediation plan. It does not claim that a configuration changed, a gap closed, a rollback worked, or a vault object was sealed merely because a status or reference appears in a row. Those are distinct recorded events and verification boundaries.

## Authoritative inputs

- `remediation_plans` and its typed `remediation_actions` are the plan/action source. The request RPC freezes exactly 1–100 actions while locking the plan and action rows against concurrent changes. It captures plan version, action order/type/description/risk, and hashes of parameter and rollback-definition JSON. Raw parameters, diffs, pre/post-state URIs and evidence URIs do not enter the report source.
- A linked `dry_runs` row must belong to the same action and plan and bind to the current parameter and rollback-definition hashes. Its recorded status, renderability, timestamps and diff hash are frozen. A dry-run is not approval or execution.
- A linked `approval_tokens` row must contain the action, belong to the plan and match the action's approver. Its status and times are frozen; signature, signed payload and nonce are excluded. The approval token is not itself an execution outcome.
- `execution_batches`, `rollback_executions`, `verification_results` and `plan_reconciliations` are separate linked records. The snapshot validates their action/plan/batch links and rollback-definition hash. Missing links render “Not recorded”; it never promotes an inline outcome or a reference into an independently verified claim.
- The source bytes and SHA-256 are stored once in `technical_request_sources`. The draft is a strict v2 manifest binding request, tenant, plan, title and source digest. The report renderer rechecks source, draft and founder review bytes/digests and derives every displayed status from the frozen source.

## Human and storage gates

Tenant owner/admin or an Axiom-internal founder can request a source. Only an Axiom-internal founder can create/review the deterministic draft, build artifacts and release it. SQL and the BFF reject a generic statutory technical HTML/PDF render or generic release. The founder must review the exact draft hash; publication requires read-back-verified, seven-year S3 Object Lock **COMPLIANCE** versions for both source JSON and PDF, with exact hashes, bytes and version IDs. Unknown provider state stays pending for reconciliation or retry.

## Validation and remaining proof

Focused disposable Postgres tests cover tenant/actor refusal, bad plan/title, idempotency, omission of raw parameter values, stale dry-run refusal without a partially created request, positive linked dry-run/approval/execution/rollback/verification/reconciliation capture, strict draft content, external-founder refusal, build receipt mismatch, source-only pending state, wrong-PDF refusal, exact release and direct-write denial. Report-kit tests cover exact source/review binding, escaped content, missing links, linked detail and forged claims. BFF tests cover route authorization, legacy-path refusal, wrong-kind/provider access boundaries, exact-version retrieval and request visibility. The UI presents the limitations before freezing a source, requires explicit founder review/release acknowledgments, and checks downloaded PDF size and SHA-256.

The isolated branch was tested against staging through migration 0087 plus additive 0093/0094. The planned 0088–0092 migrations are still separate and require a combined ordered migration/database test before merge. Browser E2E and provider-backed artifact readback on the integrated stack remain required; local unit fixtures do not prove Object Lock configuration in production. A recorded verification result or evidence URI is not an independent evidence-vault/closure attestation. The register deliberately omits target-system-level raw data and does not assert an execution throughput or backup recovery objective.
