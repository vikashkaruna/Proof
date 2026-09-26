# Revision 93 — Execution progress telemetry (W5.7)

## Scope and assumptions

This slice delivers the last record-keeping item of Doc 11's W5 list: per-task lifecycle telemetry for the execution loop. Operator input was not received. The assumptions are:

1. **The pre- and post-task records are database records, not log lines.** Every action the executor starts opens an `agent_runs` row (`running`, agent `karya`, bound to the plan and action) through `record_karya_run_start`, and closes it exactly once through `record_karya_run_finish` with the outcome, latency and redaction hashes. The table stores hashes of canonical content — never parameters, never estate values.
2. **No task, no record.** Actions the batch never started (skipped by stop-on-failure, or swept) open no run: `agent_runs` records tasks that ran, which is what makes "started → finished" trustworthy.
3. **Events describe recorded state.** The BFF broadcasts `execution.progress` per action from the executor's acknowledgement — an ack the runtime gives only after every action is settled and ledger-recorded — so a subscriber sees the batch's reality, never a prediction.
4. **The run lifecycle is closed to improvisation.** Migration 0064 revokes `service_role`'s direct UPDATE on `agent_runs` (a 0006 leftover): the lifecycle can only move through the two validated functions, whose error codes are bounded identifiers and whose statuses are the table's own check list.
5. **Live per-action streaming during a batch** — events pushed the moment each action transitions — needs the cross-instance channel (Supabase Realtime over Postgres CDC, as `realtime.ts` already anticipates). The ledger and `agent_runs` are that stream's source of truth; the composition is operator-gated production work and is deliberately not claimed here.

## Change

- **Migration 0064** — `record_karya_run_start` (validates the plan/action pair in the tenant, opens `running` with the parameters hash and `pii_redacted`) and `record_karya_run_finish` (bounded error code, non-negative latency, output hash; a closed run cannot close again); direct `service_role` writes on `agent_runs` revoked.
- **`axiom/executor.py`** — per-action run records around the adapter call: opened after the kill-switch check and content read, closed on every terminal path (success, adapter refusal, blast-radius breach, scope defence), with latency measured around the mutating call.
- **BFF `execution-dispatch.ts`** — the acknowledgement schema carries the executor's per-action recorded outcomes (uuid action ids, closed outcome set, bounded count); `DispatchOutcome` surfaces them camelCased.
- **BFF execute route** — broadcasts `execution.progress` per action from the recorded outcomes, with the batch id as `executionId` and the refusal code as `result`.

## Evidence

- **`tests/database/karya-runs.test.sql`:** a run opens running/hashed/bound and closes once with outcome, latency and output hash; a closed run cannot close again; refused: an unknown action, an unhashed input, an invented status, an unbounded error code; `authenticated` cannot execute the functions and the (nobypassrls) `service_role` cannot update or delete rows directly.
- **`test_executor.py`:** every executed action opens and closes exactly one run with the parameters hash on the pre-record; failed actions close their run as failed with the refusal code; never-started actions open nothing.
- **BFF tests:** ambiguous acknowledgements (bad uuids, invented outcomes) release nothing; well-formed outcomes surface camelCased.
- **Results:** agent-runtime 236 tests pass, BFF 1114, the database suite passes on fresh migrations, ruff/tsc/eslint clean.

## Not delivered

- Live in-batch streaming (CDC composition), the W5 web surfaces (a runs/progress view), and a manual rollback route — the remaining W5 items, all UI/composition work.
- Deployed acceptance on a real environment (operator).
