"""W5 · M3.4 — the durable executor behind /internal/execute.

Consumes one dispatch intent (the BFF's claimed, outbox-recorded batch)
and executes it through a write adapter, recording everything through the
migration-0061 SECURITY DEFINER functions and nothing else. The
structural guarantees live in the database, not here:

- scope: `start_execution_batch` refuses any action set beyond the
  approved token's `action_ids` (`scope_exceeded`);
- content: it recomputes the content digest over the stored rows and
  matches it against the token's signed snapshot (`digest_mismatch`);
- idempotency: a redelivery under the same request key replays the
  recorded batch instead of executing again;
- the fresh-approval rule: unsettled actions swept by
  `finish_execution_batch` return to `approved`, retryable only under a
  NEW approval because the token is already consumed.

What lives here is the loop the database cannot do: the kill switch's two
checks, stop-on-failure, concurrency, the SEC-7 blast-radius governor
(actual affected count versus the declared/approved count — breach halts
the batch), and the adapter call itself.

Ledger entries are written inside the RPCs, so every state change and its
audit entry commit or fail together.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from dataclasses import dataclass, field
from typing import Any

import structlog

from .kill_switch import KillSwitchEngaged, KillSwitchReader
from .write_adapters import WriteAdapter, WriteRefused


class ExecutorRefused(RuntimeError):  # noqa: N818 — reads as the state it reports
    """The batch was refused before any action ran. `reason` is a code."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


@dataclass
class ActionOutcome:
    action_id: str
    outcome: str  # 'succeeded' | 'failed' | 'skipped' (skipped = swept)
    error_code: str | None = None
    rows_affected: int | None = None


@dataclass
class BatchResult:
    batch_id: str
    status: str
    replay: bool
    outcomes: list[ActionOutcome] = field(default_factory=list)
    # The maker-checker statement (W5.6), recorded after the batch finished.
    reconciliation: dict[str, Any] | None = None


class ExecutorDb:
    """Thin, fail-closed wrapper over the service-role client.

    The runtime never constructs SQL here; every write goes through the
    migration-0061 functions. Any transport failure is a refusal, never a
    silent skip.
    """

    def __init__(self, client: Any):
        self._client = client

    def rpc(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        try:
            data = self._client.rpc(name, args).execute().data
        except Exception as exc:
            structlog.get_logger().warning("executor.rpc_unavailable", fn=name)
            raise ExecutorRefused("record_unavailable") from exc
        if not isinstance(data, dict):
            raise ExecutorRefused("record_unavailable")
        return data

    def action_row(self, tenant_id: str, action_id: str) -> dict[str, Any] | None:
        try:
            response = (
                self._client.from_("remediation_actions")
                .select("id, action_type, parameters, blast_radius")
                .eq("tenant_id", tenant_id)
                .eq("id", action_id)
                .maybeSingle()
                .execute()
            )
        except Exception as exc:
            structlog.get_logger().warning("executor.action_unreadable")
            raise ExecutorRefused("record_unavailable") from exc
        return response.data if isinstance(response.data, dict) else None


async def execute_batch(
    payload: Any,
    *,
    db: ExecutorDb,
    kill_switch: KillSwitchReader,
    adapter: WriteAdapter,
    verify_token: Any,
    signing_key: str | bytes | None = None,
) -> BatchResult:
    """Execute one claimed batch.

    `verify_token(tenant_id, token) -> (ok, reason)` re-validates the
    signed approval before anything runs; the database enforces scope and
    content against the token row itself.
    """
    # First of two kill-switch checks: refuse to start at all.
    try:
        kill_switch.raise_if_engaged(payload.tenant_id)
    except KillSwitchEngaged as halt:
        raise ExecutorRefused(f"kill_switch_engaged: {halt.reason}") from halt

    ok, reason = await verify_token(payload.tenant_id, payload.approval_token)
    if not ok:
        raise ExecutorRefused(f"approval_token_invalid: {reason}")

    started = db.rpc(
        "start_execution_batch",
        {
            "p_tenant_id": payload.tenant_id,
            "p_plan_id": payload.plan_id,
            "p_request_key": payload.request_key,
            "p_correlation_id": payload.correlation_id,
            # The token is resolved from the nonce inside its signed spec
            # (unique per 0005); the dispatch contract carries no token id.
            "p_nonce": str(payload.approval_token.get("spec", {}).get("nonce") or ""),
            "p_content_digest": payload.content_digest,
            "p_mode": payload.mode,
            "p_concurrency": payload.concurrency,
            "p_stop_on_failure": payload.stop_on_failure,
            "p_dispatch_reference": payload.request_key,
            "p_action_ids": list(payload.action_ids),
        },
    )
    if "error" in started:
        raise ExecutorRefused(started["error"])
    batch = started["batch"]
    if started.get("replay"):
        return BatchResult(batch_id=batch["id"], status=batch["status"], replay=True)

    spec = payload.approval_token.get("spec", {})
    outcomes: list[ActionOutcome] = []
    action_rows: dict[str, dict[str, Any]] = {}
    halted = False
    failed = False
    semaphore = asyncio.Semaphore(max(1, int(payload.concurrency)))
    stop = asyncio.Event()

    async def run_action(action_id: str) -> None:
        nonlocal halted, failed
        if stop.is_set():
            outcomes.append(ActionOutcome(action_id=action_id, outcome="skipped"))
            return
        async with semaphore:
            if stop.is_set():
                outcomes.append(ActionOutcome(action_id=action_id, outcome="skipped"))
                return
            # The claim put the action in `executing`; anything else means
            # the batch state moved underneath us — refuse rather than guess.
            marked = db.rpc(
                "mark_execution_action_started",
                {
                    "p_tenant_id": payload.tenant_id,
                    "p_action_id": action_id,
                    "p_batch_id": batch["id"],
                    "p_correlation_id": payload.correlation_id,
                },
            )
            if "error" in marked:
                raise ExecutorRefused(marked["error"])

            # Second kill-switch check: the point of no return is the
            # adapter call, and the stop must bound it to one action.
            try:
                kill_switch.raise_if_engaged(payload.tenant_id)
            except KillSwitchEngaged as halt:
                halted = True
                stop.set()
                outcomes.append(ActionOutcome(action_id=action_id, outcome="skipped"))
                structlog.get_logger().warning(
                    "executor.halted", reason=halt.reason, action_id=action_id
                )
                return

            row = db.action_row(payload.tenant_id, action_id)
            if row is None:
                failed = True
                outcomes.append(
                    ActionOutcome(action_id=action_id, outcome="failed", error_code="action_unavailable")
                )
                _settle(db, payload, batch["id"], action_id, "failed", "action_unavailable", None, None, None)
                if payload.stop_on_failure:
                    stop.set()
                return

            action_rows[action_id] = row
            declared = _declared_records(row.get("blast_radius") or {})

            # W5.7 — the pre-task record: `agent_runs` opens `running` for
            # this action, with a hash of the executed parameters (never
            # the parameters themselves).
            run_id, run_t0 = _start_karya_run(db, payload, action_id, row)
            try:
                result = await adapter.execute(row["action_type"], row.get("parameters") or {})
            except WriteRefused as refused:
                _finish_karya_run(db, payload, run_id, "failed", refused.reason, run_t0, None)
                failed = True
                outcomes.append(
                    ActionOutcome(action_id=action_id, outcome="failed", error_code=refused.reason)
                )
                _settle(db, payload, batch["id"], action_id, "failed", refused.reason, None, None, None)
                if payload.stop_on_failure:
                    stop.set()
                return

            # SEC-7: the approver approved a blast radius; more than that
            # actually affected is a breach — halt and escalate by leaving
            # the batch halted and the remainder unexecuted.
            if (
                declared is not None
                and result.rows_affected is not None
                and result.rows_affected > declared
            ):
                failed = True
                halted = True
                stop.set()
                outcomes.append(
                    ActionOutcome(
                        action_id=action_id,
                        outcome="failed",
                        error_code="blast_radius_breach",
                        rows_affected=result.rows_affected,
                    )
                )
                _finish_karya_run(db, payload, run_id, "failed", "blast_radius_breach", run_t0, None)
                _settle(
                    db, payload, batch["id"], action_id, "failed", "blast_radius_breach",
                    result.pre_state_ref, result.post_state_ref,
                    {"rows_affected": result.rows_affected, "declared_records": declared},
                )
                return

            # Defense in depth behind the database's scope enforcement: if
            # the signed spec carries actionIds, the executed action must be
            # one of them. A spec without the field leaves scope to the DB,
            # which has already refused anything beyond the token row.
            spec_action_ids = spec.get("actionIds")
            if isinstance(spec_action_ids, list) and action_id not in spec_action_ids:
                # The database already refused this; reaching here would
                # mean the token in hand is not the token the claim spent.
                failed = True
                halted = True
                stop.set()
                outcomes.append(
                    ActionOutcome(action_id=action_id, outcome="failed", error_code="scope_exceeded")
                )
                _finish_karya_run(db, payload, run_id, "failed", "scope_exceeded", run_t0, None)
                _settle(db, payload, batch["id"], action_id, "failed", "scope_exceeded", None, None, None)
                return

            _finish_karya_run(db, payload, run_id, "succeeded", None, run_t0, result.post_state_ref)
            outcomes.append(
                ActionOutcome(
                    action_id=action_id,
                    outcome="succeeded",
                    rows_affected=result.rows_affected,
                )
            )
            _settle(
                db, payload, batch["id"], action_id, "succeeded", None,
                result.pre_state_ref, result.post_state_ref,
                {"rows_affected": result.rows_affected},
            )

    try:
        await asyncio.gather(*(run_action(a) for a in payload.action_ids))
    except ExecutorRefused:
        # A recording failure mid-batch: the database remains the source of
        # truth, so finish with `failed` and surface the refusal.
        finished = db.rpc(
            "finish_execution_batch",
            {
                "p_tenant_id": payload.tenant_id,
                "p_batch_id": batch["id"],
                "p_status": "failed",
                "p_correlation_id": payload.correlation_id,
            },
        )
        status = finished.get("batch", {}).get("status", "failed") if "error" not in finished else "failed"
        return BatchResult(batch_id=batch["id"], status=status, replay=False, outcomes=outcomes)

    if not halted:
        # M3.5 — auto-rollback on the failure threshold: with stop-on-failure
        # armed, any failure rolls back what the batch DID complete, in
        # reverse order, each rollback simulated first. A governor or
        # kill-switch halt escalates instead: automatic further mutation is
        # the last thing an incident needs, so the succeeded actions stay
        # and a human decides.
        succeeded_ids = [o.action_id for o in outcomes if o.outcome == "succeeded"]
        if failed and payload.stop_on_failure and succeeded_ids:
            rolled, attempted = await _run_rollbacks(
                db, kill_switch, adapter, payload, batch["id"], succeeded_ids, outcomes
            )
            if rolled:
                status = "rolled_back"
            elif any(o.outcome == "succeeded" for o in outcomes) or attempted:
                # An applied change whose undo failed is the most dangerous
                # state there is: it needs a human, and it is never `failed`.
                status = "partial_failure"
            else:
                status = "failed"
            finished = _finish(db, payload, batch["id"], status)
            return await _post_finish(
                db, kill_switch, adapter, payload, batch["id"], finished, status,
                outcomes, action_rows, halted, signing_key,
            )

    if halted:
        status = "halted"
    elif not failed:
        status = "completed"
    elif any(o.outcome == "succeeded" for o in outcomes):
        status = "partial_failure"
    else:
        status = "failed"
    finished = _finish(db, payload, batch["id"], status)
    return await _post_finish(
        db, kill_switch, adapter, payload, batch["id"], finished, status,
        outcomes, action_rows, halted, signing_key,
    )


async def _post_finish(
    db: ExecutorDb,
    kill_switch: KillSwitchReader,
    adapter: WriteAdapter,
    payload: Any,
    batch_id: str,
    finished: dict[str, Any],
    status: str,
    outcomes: list[ActionOutcome],
    action_rows: dict[str, dict[str, Any]],
    halted: bool,
    signing_key: str | bytes | None,
) -> BatchResult:
    """Verification (M3.7) and the maker-checker statement (W5.6), after
    the batch reached its terminal status. A halted batch skips
    verification — an operator halting an incident stops estate calls —
    but its statement is still recorded, because the reconciliation is
    exactly what the incident review will read."""
    from .verification import reconcile_batch, verify_batch

    result = _final_result(batch_id, finished, outcomes, payload.action_ids)
    if not halted:
        await verify_batch(db, kill_switch, adapter, payload, batch_id, result.outcomes, action_rows)
    if signing_key:
        result.reconciliation = await reconcile_batch(
            db, payload, batch_id, result.status, result.outcomes, signing_key
        )
    return result


def _finish(db: ExecutorDb, payload: Any, batch_id: str, status: str) -> dict[str, Any]:
    finished = db.rpc(
        "finish_execution_batch",
        {
            "p_tenant_id": payload.tenant_id,
            "p_batch_id": batch_id,
            "p_status": status,
            "p_correlation_id": payload.correlation_id,
        },
    )
    if "error" in finished:
        raise ExecutorRefused(finished["error"])
    return finished


def _final_result(
    batch_id: str, finished: dict[str, Any], outcomes: list[ActionOutcome], action_ids: list[str]
) -> BatchResult:
    final_status = finished["batch"]["status"]
    # The sweep's skipped actions appear here as outcomes so the caller sees
    # every action accounted for.
    settled = {o.action_id for o in outcomes}
    for action_id in action_ids:
        if action_id not in settled:
            outcomes.append(ActionOutcome(action_id=action_id, outcome="skipped"))
    return BatchResult(batch_id=batch_id, status=final_status, replay=False, outcomes=outcomes)


async def _run_rollbacks(
    db: ExecutorDb,
    kill_switch: KillSwitchReader,
    adapter: WriteAdapter,
    payload: Any,
    batch_id: str,
    succeeded_ids: list[str],
    outcomes: list[ActionOutcome],
) -> bool:
    """Roll the batch's completed actions back, reverse order, simulated
    first. Returns True when every rollback succeeded.

    A rollback is executed against the action's STORED definition, and
    `record_rollback_execution` re-reads and re-compares it, so the engine
    cannot reverse anything with a definition other than Sudhaar's.

    Returns (all_rolled_back, any_rollback_attempted).
    """
    all_ok = True
    attempted = False
    for action_id in reversed(succeeded_ids):
        # The stop outranks the undo: a halt mid-rollback leaves the
        # remaining completed actions as they are for a human to judge.
        try:
            kill_switch.raise_if_engaged(payload.tenant_id)
        except KillSwitchEngaged as halt:
            all_ok = False
            structlog.get_logger().warning(
                "executor.rollback_halted", reason=halt.reason, action_id=action_id
            )
            break
        row = db.action_row(payload.tenant_id, action_id)
        if row is None:
            raise ExecutorRefused("record_unavailable")
        definition = row.get("rollback_definition") or {}
        # Dry-run the rollback first: a definition the target refuses to
        # simulate is never executed.
        try:
            await adapter.simulate_rollback(row["action_type"], definition)
            attempted = True
            result = await adapter.execute_rollback(row["action_type"], definition)
        except WriteRefused as refused:
            all_ok = False
            attempted = True
            outcome = "failed"
            detail: dict[str, Any] = {"reason": refused.reason}
            recorded = db.rpc(
                "record_rollback_execution",
                {
                    "p_tenant_id": payload.tenant_id,
                    "p_action_id": action_id,
                    "p_batch_id": batch_id,
                    "p_definition": definition,
                    "p_triggered_by": "failure_threshold",
                    "p_status": "failed",
                    "p_result": detail,
                    "p_correlation_id": payload.correlation_id,
                },
            )
            if "error" in recorded:
                raise ExecutorRefused(recorded["error"]) from refused
            for o in outcomes:
                if o.action_id == action_id and o.outcome == "succeeded":
                    o.outcome = outcome
                    o.error_code = f"rollback_failed: {refused.reason}"
            continue
        recorded = db.rpc(
            "record_rollback_execution",
            {
                "p_tenant_id": payload.tenant_id,
                "p_action_id": action_id,
                "p_batch_id": batch_id,
                "p_definition": definition,
                "p_triggered_by": "failure_threshold",
                "p_status": "succeeded",
                "p_result": {"rows_affected": result.rows_affected},
                "p_correlation_id": payload.correlation_id,
            },
        )
        if "error" in recorded:
            raise ExecutorRefused(recorded["error"])
        for o in outcomes:
            if o.action_id == action_id and o.outcome == "succeeded":
                o.outcome = "rolled_back"
                o.rows_affected = result.rows_affected
    return all_ok, attempted


def _settle(
    db: ExecutorDb,
    payload: Any,
    batch_id: str,
    action_id: str,
    outcome: str,
    error_code: str | None,
    pre_ref: str | None,
    post_ref: str | None,
    detail: dict[str, Any] | None,
) -> None:
    result = db.rpc(
        "settle_execution_action",
        {
            "p_tenant_id": payload.tenant_id,
            "p_action_id": action_id,
            "p_batch_id": batch_id,
            "p_outcome": outcome,
            "p_error_code": error_code,
            "p_pre_state_ref": pre_ref,
            "p_post_state_ref": post_ref,
            "p_detail": detail,
            "p_correlation_id": payload.correlation_id,
        },
    )
    if "error" in result:
        raise ExecutorRefused(result["error"])


def _start_karya_run(
    db: ExecutorDb, payload: Any, action_id: str, row: dict[str, Any]
) -> tuple[str, float]:
    """Open the action's `agent_runs` record (W5.7)."""
    parameters_hash = hashlib.sha256(
        json.dumps(row.get("parameters") or {}, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    started = db.rpc(
        "record_karya_run_start",
        {
            "p_tenant_id": payload.tenant_id,
            "p_plan_id": payload.plan_id,
            "p_action_id": action_id,
            "p_correlation_id": payload.correlation_id,
            "p_input_redacted_hash": parameters_hash,
        },
    )
    if "error" in started:
        raise ExecutorRefused(started["error"])
    return str(started["run_id"]), time.monotonic()


def _finish_karya_run(
    db: ExecutorDb,
    payload: Any,
    run_id: str,
    status: str,
    error_code: str | None,
    started_at: float,
    post_state_ref: str | None,
) -> None:
    """Close the action's `agent_runs` record, once, with the outcome."""
    output_hash = (
        hashlib.sha256(f"{post_state_ref}".encode("utf-8")).hexdigest()
        if post_state_ref
        else None
    )
    finished = db.rpc(
        "record_karya_run_finish",
        {
            "p_tenant_id": payload.tenant_id,
            "p_run_id": run_id,
            "p_status": status,
            "p_error_code": error_code,
            "p_latency_ms": int((time.monotonic() - started_at) * 1000),
            "p_output_redacted_hash": output_hash,
        },
    )
    if "error" in finished:
        raise ExecutorRefused(finished["error"])


def _declared_records(blast_radius: dict[str, Any]) -> int | None:
    for key in ("records", "affected_records", "record_count"):
        value = blast_radius.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            return value
    return None
