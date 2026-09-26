# Revision 89 — The dry-run engine and the five execution-detail tables (W5 slice 1)

## Scope and assumptions

This opens W5 (Phase 3 execution loop) with its foundation slice: the M3.2 dry-run / simulation engine and the five execution-detail tables Doc 11 (W2) lists as missing. Operator input was not received. The assumptions are:

1. **Simulated from declared content only.** The simulator works from the action's stored parameters, blast radius and rollback definition. It invents nothing: a record count the plan never declared renders as `null` with `records_declared: false`, never a plausible number. The executor slice (M3.4) must recompute against the live estate; the reconciler (W5.6) proves the two agree.
2. **A refusal is an outcome, not an error.** Doc 04 §3.2 is load-bearing: if the diff cannot be rendered legibly, the action is not eligible for agent execution and routes to manual handling. Refusals are recorded, ledgered, and invalidate any earlier dry-run that had made the action eligible.
3. **The action row is the source of truth.** The BFF reads the stored action and sends exactly that content; `record_dry_run` re-reads the action and refuses (`content_mismatch`) unless the simulated content IS the stored content. The hashes in the record are computed server-side over the stored row.
4. **Result returned only after it is recorded** — the same discipline as the discovery route (Rev 87).
5. **`custom` is never simulable.** A structurally arbitrary action type has no honest diff; it is always refused to manual handling.

## Change

- **Migration 0060** — the five execution-detail tables, all tenant-bound with RLS, composite tenant-consistent foreign keys, service/authenticated read grants and no direct write path:
  - `dry_runs` — one append-only record per simulation or refusal, with the structured diff, a machine-readable refusal code, server-side `parameters_hash` / `rollback_definition_hash` content binding, and a fixed 24-hour TTL;
  - `execution_batches` — one row per claimed approval dispatch (R-04: the request key stays a batch key; no action key appears), carrying the content digest the batch was authorised for;
  - `rollback_executions` — the definition snapshot exactly as executed (M3.5), with its trigger and hash;
  - `verification_results` — the checks Parikshan re-ran and whether the gap closed (M3.7);
  - `plan_reconciliations` — one statement per batch (W5.6, the maker-checker record), with a table-level constraint that `out_of_scope` MUST be empty: out-of-scope execution is structurally impossible, so a row claiming it is a defect to fail on, not a finding to store;
  - link columns on `remediation_actions` (`latest_dry_run_id`, `execution_batch_id`, `latest_rollback_execution_id`, `latest_verification_result_id`) and composite unique constraints on the referenced tables; the inline columns stay as the operational state the approval and claim gates read, with `dry_run_result` now a display cache of the latest diff written only by the RPC;
  - `record_dry_run`, the M3.2 engine's only write path: eligibility (pre-approval only), content binding, outcome-shape validation, 24-hour TTL on both the record and the action's freshness gate, ledger `plan.dry_run.completed` with hashes and refusal codes (never the diff). Batch/rollback/verification/reconciliation write paths land with their slices.
- **`axiom/dry_run.py`** — the pure, deterministic simulator: a typed parameter spec per `action_type` (every enum type except `custom`), field-level structured diffs, no free text or personal values in diff output, unknown/oversized/out-of-spec parameters refused.
- **`POST /internal/dry-run`** (agent-runtime) — internal-token transport like `/internal/execute`, `contract_version` 1, records through `record_dry_run` before returning; recorder unavailability is a 503 with no result, not a rendered diff.
- **BFF routes** — `POST /v1/plans/:id/dry-run` (PLAN_CREATE, bounded to 50 actions, skips ineligible actions rather than silently running them) and `GET /v1/plans/:id/dry-runs` (PLAN_READ), plus `services/dry-run-dispatch.ts`, which distinguishes `recorded` / `refused` / `unavailable` exactly like the execution dispatch.
- **`tests/contracts/dry-run.v1.json`** — the payload pinned from both sides, as the execution dispatch contract has been since R-05.

## Evidence

- **`tests/database/dry-runs.test.sql`:**
  - a success marks the action `dry_run_complete` with the 24-hour gate and links the record; hashes match an independent sha256 over the stored content; the ledger carries the run;
  - refusals are recorded as outcomes and leave the action awaiting with nothing for the approval gate to stand on; a refusal after a success invalidates it;
  - refused: cross-tenant action (`action_not_found`), non-stored content (`content_mismatch`), approved content (`action_not_eligible`), a diff without `changes` (`invalid_diff`), a refusal carrying a diff (`invalid_refusal`);
  - table guards: outcome-shape and tenant-FK violations rejected; a reconciliation row claiming out-of-scope execution cannot be stored; one statement per batch; an open batch cannot already be finished;
  - tenant members read only their own records; neither `authenticated` nor the (nobypassrls) `service_role` can insert, update or delete, or execute the function.
- **`test_dry_run.py`:** structured diffs per type, determinism, never-invented record counts, refusals for `custom`/unknown/invalid/oversized parameters, the contract fixture accepted by the Pydantic model and camelCase refused, and the route recording before returning (success, refusal, recorder error, contract-version mismatch).
- **BFF tests:** the dispatch outcome contract (`recorded`/`refused`/`unavailable`, no result for an ambiguous acknowledgement), the fixture pinned byte-for-byte, and the routes dispatching stored content only, skipping approved actions, and reporting an unreachable runtime as `unavailable`, never as a result.
- **Results:** BFF 1110 tests pass, types 45 (ledger compatibility included — no new enum value was needed), agent-runtime 208, the database suite passes on fresh migrations, ruff and lint and typecheck clean on the changed files.

## Not delivered

- The executor itself (M3.4), the rollback engine (M3.5), post-execution verification (M3.7) and the reconciler (W5.6) — next W5 slices; their tables now exist.
- A web view of dry-run records and refusals (the plan page still renders the inline `dry_run_result`).
- Live-estate simulation — requires the W4 write path and is deliberately out of this slice.
- Deployed acceptance of the dry-run route (needs a deployment; see Doc 17).
