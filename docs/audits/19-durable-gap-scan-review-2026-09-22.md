# Durable public gap-scan review — 22 September 2026

Local committed merge `bc0f58a` passed both container configurations: 61 browsers and 75 API/restart outcomes each. Its staging CI caught a missing `report_email_mode` mapping in `sync-env.sh`; that deployment wiring is corrected with a default of disabled and the configuration coverage gate rerun. The latest corrective merge CI, not the earlier failed run, is the final gate.

Acceptance correction: the first local container run used five CPU-derived browser workers and hit existing MFA/onboarding UI timeouts. Deployed targets now use the same two workers as CI, still with zero retries and unchanged assertions. That failed run is not closure evidence. The two-worker rerun passed all 61 browsers, then exposed a CommonJS/top-level-await error in the new restart probe; its async entry point is corrected and the complete lane is rerun. The ownership regression also rejects a removed SQL-filter mutation; restored tests pass.

Reviewed staging `f5a88d5` with green CI 35640285441; no newer other-model commits on fetch. This milestone closes C-W0-4 engineering, not W0 remote or Phase 1 funnel acceptance.

A later full run passed preprod including restart but failed the production two-session MFA re-verification helper. Database evidence showed the first code was already consumed by activation, while the later UI retry never reached challenge issuance. Three isolated diagnostic repetitions passed, so the missing retry is not claimed as a reproduced product defect. The journey now waits explicitly for a code different from the successful activation code; dedicated replay tests remain unchanged. The helper retains status-only diagnostics, never codes or response payloads. Final full acceptance is rerun on the corrected fixture.

## Findings addressed

Marketing computed reports and wrote with an admin client, falling back to process memory on persistence failure. The BFF route stored answers without the corresponding computed snapshot. Report resend bypassed ownership and sent a report selected by ID to a supplied email address. Comments claiming it used only the stored recipient did not match the code.

The BFF now computes and persists one report before returning its ownership capability. SSR forwards validated input and sets an HttpOnly cookie, stripping the proof from browser JSON. SQL retains only its SHA-256 hash; session IDs and browser metadata confer no authority. Retrieval and resend filter by ID and capability hash. Responses omit answers and hashes. The 0037 populated upgrade preserves snapshots and legacy-cookie access. SQL client writes were already refused by 0016; this migration reasserts that boundary rather than claiming it was newly open.

Database and durable budget failures refuse requests. Optional post-persistence mail failure still returns the stored report and capability. Delivery is disabled by default and requires explicit BFF configuration; no simulated success, raw provider payload or submitted PII is logged. Requests have a body limit, durable global/create/report/recipient budgets, timeouts and redirect refusal. SSR preserves Retry-After. The scoring/readiness algorithms moved unchanged; displayed coverage now says selected controls rather than implying every library control was assessed.

## Evidence and limits

323 BFF tests, 61 browser journeys, four real Auth/PostgREST parity labels, all 38 migrations, legacy-report upgrade and 25 harness tests pass. Unit/provider stubs cover required opt-in, receipt validation and sanitized errors without sending mail. SQL verifies service access and client denial. Acceptance now seeds the real published library: otherwise its foreign key correctly refuses a saved report. No immutable control row is overwritten.

The production-container runner performs actual BFF/marketing restarts before owned retrieval and foreign read/resend denial. Exact committed container/CI results are recorded in the ignored checkpoint after execution. Remote restart is operator-controlled and requires separate deployment evidence. Local labels do not prove cloud deployment. Migration 0037 adds no tables: 51 public tables, W2 named targets 19/40.

The cookie is a bearer capability and remains required for emailed links; forwarding email does not grant online access. Browser lifetime is seven days, with no cross-device claim/recovery flow. Delivery is synchronous and bounded, without a durable outbox or idempotent public-create guarantee. Provider receipt means accepted dispatch, not inbox delivery. No real mail/provider account or cloud deployment was exercised.

## Newly recorded open work

- C-W0-5: Cloud Run runtime identities still share IAM authority; environment separation alone is insufficient.
- C-W0-6: separate contact inquiry path still uses process memory, SSR dispatch and simulated disabled-provider success. Do not claim all marketing persistence/mail segregation is complete.
- C-W0-7: q7 asks MFA but scoring maps SEC-002; q11 asks whether transfers occur yet a yes earns full compliance; q12 asks about the past year while the control concerns DPIA before high-risk processing. Readiness sector averages/percentiles are hardcoded heuristics. Reconcile UI/control semantics and clearly identify provenance before claiming assessment accuracy. Preserve existing snapshots.

W1 invitations, W2 remaining 21 named targets, full W3 wizard/graph and W4 live connector execution remain pending. No product-agent execution safeguards, evidence retention or ledger rules changed.
