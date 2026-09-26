# Revision 92 — Post-execution verification and the maker-checker reconciler (W5 · M3.7 + W5.6)

## Scope and assumptions

This slice closes the last two record-keeping halves of the execution loop: Parikshan's verification that the gap actually closed (M3.7), and the independent reconciliation statement that proves Sudhaar and Karya agreed (W5.6) — the artifact an auditor will actually ask for. Operator input was not received. The assumptions are:

1. **The reconciler's facts are the database's facts.** `record_plan_reconciliation` computes the comparison itself from the token row and the settled actions; the caller supplies only a human-readable statement and its signature. Approved scope comes from the token, never from the caller.
2. **Out-of-scope execution is computed, and it screams.** Any action the batch touched that the token did not cover is `out_of_scope_executed` — the record is refused and the defect names itself, per Doc 11 W5.6 ("the reconciler asserts it and screams if not"). It is structurally unreachable through the executor; the refusal exists for the state a compromised executor would create.
3. **Drift is stated, not hidden.** The content digest is recomputed at reconcile time over the token's approved action set and compared against the batch's approved digest. A mismatch — approved content changed before or after execution — lands in `parameter_diffs` as `content_digest_drift`, and the statement records it. The comparison is apples-to-apples: the same action set the digest was originally computed over.
4. **Verification verifies an outcome.** Only a settled action is verifiable, through the batch that executed it. A halted batch skips verification entirely — an operator halting an incident stops estate calls, including read-shaped ones — and the verification status simply stays unset until run again. Verification failures do not rewrite what executed: the action stays `succeeded` with a failed verification on its record, which is the honest chain.
5. **The statement is signed with the approval signing key** — the same key that bound the approval — HMAC-SHA256 over the statement text; the gate verifies the signature's shape. Sealing the statement into the WORM evidence vault is the operator-gated storage decision (R-10 remains open) and is deliberately not claimed here.

## Change

- **Migration 0063** — `record_verification_result` (bounded checks array, outcome, optional bounded evidence URI; updates the action's verification columns and links the record) and `record_plan_reconciliation` (computed approved scope, executed reality, unexecuted list with `swept_unexecuted` reasons, drift detection, one statement per batch) plus ledger action `execution.reconciliation.recorded` (added to `LedgerActionType` in `@axiom/types` in the same commit).
- **`axiom/verification.py`** — `verify_batch` (kill-switch guarded, per executed or rolled-back action, through the adapter's new `verify` op; a refused verification is recorded as a failed check, never swallowed) and `reconcile_batch` (the statement text, its HMAC signature, and the RPC call).
- **`axiom/write_adapters.py`** — the adapter protocol gains `verify`; the reference transport implements it over the same bounded channel with a metadata-only checks schema (identifier-shaped check ids, passed/failed outcomes, bounded detail).
- **`axiom/executor.py`** — after the batch reaches its terminal status: verification for executed actions (skipped when halted), then the reconciliation statement (recorded for halted batches too — it is what the incident review reads). The batch result carries the reconciliation outcome.

## Evidence

- **`tests/database/verification-reconciliation.test.sql`:** verification records and links for a settled action, lands in the ledger; refused for a swept action, an action outside the batch, an unsigned statement; the reconciliation's approved scope, executed reality and unexecuted reasons match the token row and settled actions; one statement per batch; out-of-scope execution refused and named; content drift under a finished batch stated; `authenticated` cannot execute either function and the (nobypassrls) `service_role` has no direct write path.
- **`test_executor.py`:** executed actions verified after the batch with the statement recorded; failed verification recorded without rewriting execution outcomes; halted batches skip verification but still state their reality; the statement accounts for every action; a reconciliation refusal surfaces; no signing key skips reconciliation without skipping verification.
- **Results:** agent-runtime 234 tests pass, BFF 1112, types 45 (the new ledger enum value included), the database suite passes on fresh migrations, ruff/tsc clean.

## Not delivered

- Sealing the signed statement into the WORM evidence vault — needs the locked-storage decision (operator, R-10).
- Verification against live estate data through real connectors — the reference transport proves the loop; production composition is operator-gated.
- A scheduled re-verification sweep for actions whose verification failed (a W6 monitoring-schedule concern).

## W5 status after this slice

Of PRD B.10's eight criteria, six are now implemented and testable end-to-end on the reference transport (1 rollback plans, 2 dry-run diffs, 3 dry-run-before-approval, 5 rollback, 7 blast-radius halt, 8 kill switch), and the reconstructable chain (6) is complete: finding → plan → dry-run → approval → execution → verification → reconciliation, each step in the ledger. Criterion 4 (partial-batch approval executes exactly the approved subset) is enforced by `claim_plan_execution` and `start_execution_batch`'s scope check; its deployed acceptance remains operator-gated, as does the production write path.
