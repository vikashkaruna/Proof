# Saved implementation session — 22 September 2026

Local committed merge `bc0f58a` passed both container configurations: 61 browsers and 75 API/restart outcomes each. Its staging CI caught a missing `report_email_mode` mapping in `sync-env.sh`; that deployment wiring is corrected with a default of disabled and the configuration coverage gate rerun. The latest corrective merge CI, not the earlier failed run, is the final gate.

Acceptance correction: the first local container run used five CPU-derived browser workers and hit existing MFA/onboarding UI timeouts. Deployed targets now use the same two workers as CI, still with zero retries and unchanged assertions. That failed run is not closure evidence. The two-worker rerun passed all 61 browsers, then exposed a CommonJS/top-level-await error in the new restart probe; its async entry point is corrected and the complete lane is rerun. The ownership regression also rejects a removed SQL-filter mutation; restored tests pass.

Fetch staging first. The merge containing this file is the checkpoint. Plan **Revision 30**, migration tip **0037** (38 files, 51 public tables; W2 named targets 19/40). Reviewed upstream `f5a88d5`, green CI [35640285441](https://github.com/vikashkaruna/Proof/actions/runs/35640285441); no newer other-model commits appeared. Worktree `/Users/vikash/.codex/worktrees/w0-w3-closure/Axiom Proof`, branch `codex/w0-w3-closure`. Preserve root and Claude worktrees.

A later full run passed preprod including restart but failed the production two-session MFA re-verification helper. Database evidence showed the first code was already consumed by activation, while the later UI retry never reached challenge issuance. Three isolated diagnostic repetitions passed, so the missing retry is not claimed as a reproduced product defect. The journey now waits explicitly for a code different from the successful activation code; dedicated replay tests remain unchanged. The helper retains status-only diagnostics, never codes or response payloads. Final full acceptance is rerun on the corrected fixture.

## Current milestone

C-W0-4: BFF owns gap-scan scoring, durable report snapshots and report mail; SSR owns validation/routing/HttpOnly cookie only. Migration 0037 stores hashes of opaque access tokens and preserves legacy-cookie ownership. Unknown/missing proof cannot read or resend a report. Fixed the prior resend IDOR. Store/rate-limit failures refuse requests; there is no process-memory fallback. Email requires explicit BFF delivery mode and key, and never reports simulated success. Optional mail failure leaves a saved report accessible.

323 BFF tests, 61 browser journeys, 38 migrations including legacy-report upgrade, four real-Auth API parity labels, workspace checks and 25 harness tests pass. Production-container acceptance now performs actual BFF/SSR restarts; exact committed container and CI results are saved in ignored `.axiom-runtime/session-checkpoint.json`. Inspect that checkpoint before claiming final green. See [review 19](audits/19-durable-gap-scan-review-2026-09-22.md) and Docs 11/14/16/17.

## Delivered earlier

- W1 recovery replacement policy (0036): trusted consumed proof binds pending replacement; recovery activation atomically retires all existing account MFA assurance. Current-factor replacement preserves it. Unknown/stale/legacy authorization requires restart. Two-session browser and SQL rollback/race/mutation evidence passed. Do not ask the accepted policy again.
- W3 inventory (0034) and reviewed onboarding (0035): staff prepare immutable proposals; a different client owner **or tenant admin** approves. Full wizard/sustenance remain open.
- W0 deployed-target API/browser harness, scoped SSR configuration, Cloud Run Auth secret bindings, private Docker networking, exact revision checks and sanitized artifacts. Local Docker evidence is distinct from remote acceptance.
- W2 seven connector tables (0033) are metadata foundation only, not executable grants or a working connector runtime.

## Next work in order

1. W0 C-W0-5: per-service Cloud Run identities and least-privilege secret IAM. Scoped environment injection alone does not isolate the shared runtime identity.
2. W0 C-W0-6: move contact inquiry persistence and dispatch behind BFF; process memory and disabled-provider simulated success remain in that separate path. Add restart/ownership or staff access tests as appropriate.
3. W0 C-W0-7: reconcile question/control semantics (q7 MFA vs SEC-002, q11 transfer-existence vs safeguards, q12 annual questionnaire vs pre-processing DPIA). Benchmark/percentile values are hardcoded heuristics; label provenance and avoid implying measured peer results. Review against the roadmap/control library before claiming score accuracy. Do not rewrite saved report snapshots.
4. W1 invitation lifecycle/delivery; no real third-party mail during development. Remote W0/MFA acceptance still needs operator-provisioned isolated targets under Doc 17; EKS CIDR policy/manual workflow promotion remain operator tasks.
5. W4.1 registry/contracts/lifecycle, then broker, workload identity and live grants, to support the remaining W3 wizard/graph. Serialize activation with estate/system archival. W2 execution tables follow stable W4 permission contracts; 21 named targets remain absent.

## Resume constraints

Implementation, local Docker tests, documentation and staging merge pushes are authorized. No billable/irreversible cloud deployment, client-system execution or retention changes. Higher environments dynamically deploy self-hosted Supabase. Sudhaar holds no client-system credentials; ledger writes use append_ledger; execution redelivery needs fresh approval.

Local Supabase project `axiom-w0-parity`, API 56321, DB 56322, through 0037. Private target/persona/probe files remain under ignored `.axiom-runtime`; never publish raw browser reports, traces, ownership cookies or secrets. Run `scripts/test-deployed-http.sh --browser` only from a clean committed tree. Its containers are removed after the rehearsal; the isolated database remains. Next migration **0038 after fresh fetch**, append-only. Restore generated next-env.d.ts before commits; do not pop the superseded browser-prototype stash.
