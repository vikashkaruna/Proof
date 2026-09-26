# Revision 91 — The rollback engine (W5 · M3.5)

## Scope and assumptions

This slice delivers M3.5: the engine that executes Sudhaar's rollback definitions, itself dry-run-able, auto-triggered on the failure threshold within a batch. Operator input was not received. The assumptions are:

1. **The engine executes the stored definition, exactly.** The executor reads the action's stored `rollback_definition`, and `record_rollback_execution` re-reads the row and compares the executed definition against it (`definition_mismatch`). A rollback of a reconstructed or edited definition is structurally impossible.
2. **Only a completed action is reversible, and only once.** A rollback records against an action whose `final_outcome` is `succeeded` and that belongs to the recording batch (`batch_mismatch` otherwise); the action then lands `rolled_back` and further rollbacks are refused (`action_not_reversible`).
3. **Dry-run first.** The adapter interface gained `simulate_rollback`; a definition the target refuses to simulate is never executed — the rollback is recorded as failed with the refusal reason, before any mutation.
4. **The failure threshold is stop-on-failure.** With stop-on-failure armed (an approver's signed setting), any action failure auto-rolls-back the batch's completed actions, in reverse order. Without it, failures escalate for a human decision. A governor or kill-switch halt never auto-rolls-back: automatic further mutation is the last thing an incident needs, so completed actions stay and a human decides.
5. **A failed undo is never hidden.** An action whose rollback failed flips its outcome to `failed` with a `rollback_failed` code, the failed rollback is recorded with its reason, and the batch lands `partial_failure` — the state where a change is applied and could not be undone is the one that most needs a human, so it is never rendered as a clean failure or a clean success.
6. **Both ledger phases commit atomically** with the record: `execution.rollback.started` and `execution.rollback.completed` are written inside the RPC, so the ledger never shows an unconcluded rollback or an outcome without its start. No new ledger enum value was needed.

## Change

- **Migration 0062** — `record_rollback_execution` (SECURITY DEFINER, service_role only): validates trigger and status, re-reads the action, enforces reversibility, batch membership and the definition match, computes the definition hash server-side, records the execution, flips the action to `rolled_back`, and writes both ledger phases.
- **`axiom/write_adapters.py`** — the `WriteAdapter` protocol gains `simulate_rollback` / `execute_rollback`; the reference transport implements both over the same bounded channel (one configured origin, no redirects, deadline timeout, metadata-only responses).
- **`axiom/executor.py`** — the auto-rollback pass: reverse order, kill-switch checked before each rollback (the stop outranks the undo — a halt leaves the remaining completed actions for a human), simulate-then-execute, and the status mapping that distinguishes `rolled_back` (clean undo) from `partial_failure` (applied change, undo failed).

## Evidence

- **`tests/database/rollback-executions.test.sql`:** a completed action reverses against its stored definition (hash verified against an independent digest), lands `rolled_back` and links its record; both ledger phases present; refused: an action the batch never completed, a second rollback, a reconstructed definition, a foreign batch, an invented trigger, a non-object definition; `authenticated` cannot execute the function, and the (nobypassrls) `service_role` has no direct write path.
- **`test_executor.py`:** failure with stop-on-failure rolls back the completed action (simulated first, stored definition on the wire, `rolled_back` batch status); a failed rollback leaves `partial_failure` with the action honestly `failed` and the failed rollback recorded; an unsimulable rollback is never executed; no auto-rollback without stop-on-failure; a governor halt does not auto-rollback; nothing completed means nothing to roll back.
- **Results:** agent-runtime 228 tests pass, BFF 1112, the database suite passes on fresh migrations, ruff/tsc clean.

## Not delivered

- A manual rollback trigger route (an operator-facing "undo this action" endpoint with its own approval step) — the `manual` trigger value exists in the schema and waits for that slice.
- Post-execution verification (M3.7) and the maker-checker reconciler (W5.6) — next W5 slices.
- Production rollback execution against real client systems — same operator-gated composition as the executor's write path.
