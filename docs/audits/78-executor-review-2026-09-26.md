# Revision 90 — The durable executor (W5 · M3.4)

## Scope and assumptions

This slice replaces the runtime's 501 stub: `/internal/execute` now consumes the dispatch outbox's claimed batches and executes them through a write adapter, recording every state change through migration 0061's SECURITY DEFINER functions. Operator input was not received. The assumptions are:

1. **The structural guarantees live in the database, not in the executor.** `start_execution_batch` refuses any action set beyond the approved token's `action_ids` (`scope_exceeded`), resolves the token by the nonce inside its signed spec, and recomputes the content digest over the stored rows against the token's signed snapshot (`digest_mismatch`). A compromised or buggy executor cannot widen scope or execute unapproved content.
2. **Redelivery replays; it never re-executes.** A dispatch under the same request key with the same digest returns the recorded batch (`replay: true`); the same key with a different payload is a conflict. The founder's fresh-approval rule is enforced in the sweep: actions a batch claimed but never settled return to `approved`, retryable only under a NEW approval, because the token is already consumed.
3. **No improvised write target.** The executor executes through a `WriteAdapter`; the one shipped implementation is `ReferenceWriteAdapter`, a bounded HTTP call to the Axiom reference write service (one origin from reviewed configuration, no redirects, deadline timeout, JSON ≤ 1 MiB, metadata-only response). With no write origin configured, the route refuses `execution_unconfigured` — there is no production connector write path yet, and the executor must never invent one.
4. **The blast-radius governor (SEC-7) compares actual against approved.** When the action's blast radius declares a record count and the adapter reports more affected rows than that, the action fails `blast_radius_breach` and the batch halts — the remainder is never scheduled. An undeclared count cannot breach, and the executor never invents one.
5. **The kill switch bounds the stop to one action.** Checked before the batch starts and again at each action's point of no return; an engaged switch halts the batch (`halted`) and the sweep returns the remainder to `approved`.
6. **Ledger and state commit together.** Every RPC writes its own ledger entries (`execution.started`, `execution.action.started/succeeded/failed`, `execution.batch.completed`) inside the same transaction as the state change — no unrecorded execution, no phantom records. No new ledger enum value was needed.

## Change

- **Migration 0061** — `start_execution_batch` (scope + digest + idempotency + plan-to-`executing`), `mark_execution_action_started`, `settle_execution_action` (bounded error codes and state references; only a batch's own `executing` actions settle, and only once), `finish_execution_batch` (terminal status is immutable, plan status mapped, unsettled actions swept to `approved` with the skipped ids listed in the ledger detail).
- **`axiom/executor.py`** — the batch loop: token re-validation before anything runs, two kill-switch checks, stop-on-failure, bounded concurrency, the governor, and fail-closed database access (`ExecutorDb` turns any transport failure into a refusal rather than a silent skip).
- **`axiom/write_adapters.py`** — the adapter seam and the reference implementation.
- **`/internal/execute`** (agent-runtime) — wired to the executor; refuses `execution_unconfigured` (503) without a write origin, `409` with the RPC's reason code on pre-execution refusals, `423` for an engaged kill switch.
- **BFF `execution-dispatch.ts`** — the acknowledgement parser now accepts the executor's `contract_version: 2` response and records the batch id as the outbox's durable reference; ambiguous acknowledgements still release nothing.

## Evidence

- **`tests/database/execution-batches.test.sql`:** batch start records scope from the token row and the recomputed digest; redelivery replays; `scope_exceeded`, `digest_mismatch` and `token_not_found` refused; only the batch's own running actions settle, and only once; unbounded state references refused; finish is once-only with the first terminal status immutable; the sweep returns unsettled actions to `approved`; plan status maps correctly; `authenticated` cannot execute any of the functions and the (nobypassrls) `service_role` has no direct write path.
- **`test_executor.py`:** happy path settles every action; replay executes nothing; stop-on-failure stops scheduling; kill switch halts mid-batch; blast-radius breach halts with the counts in the ledger detail; undeclared counts cannot breach; start refusals surface as refusals; an invalid token refuses before the database is touched; spec membership is defence in depth; the adapter refuses error targets and invalid responses; the database wrapper fails closed.
- **Results:** agent-runtime 222 tests pass, BFF 1112, the database suite passes on fresh migrations, ruff/eslint/tsc clean.

## Not delivered

- Production connector execution: broker lease wiring, real W4 write descriptors, and the credential path from `GrantBrokerAuthority` (operator-gated composition; the reference adapter proves the loop without touching a client system).
- Rollback engine (M3.5), post-execution verification (M3.7), the reconciler (W5.6) and progress telemetry — next W5 slices.
- Deployed acceptance of live execution (needs a deployment; see Doc 17).
