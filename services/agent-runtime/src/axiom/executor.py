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

            declared = _declared_records(row.get("blast_radius") or {})
            try:
                result = await adapter.execute(row["action_type"], row.get("parameters") or {})
            except WriteRefused as refused:
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
                _settle(db, payload, batch["id"], action_id, "failed", "scope_exceeded", None, None, None)
                return

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

    if halted:
        status = "halted"
    elif not failed:
        status = "completed"
    elif any(o.outcome == "succeeded" for o in outcomes):
        status = "partial_failure"
    else:
        status = "failed"
    finished = db.rpc(
        "finish_execution_batch",
        {
            "p_tenant_id": payload.tenant_id,
            "p_batch_id": batch["id"],
            "p_status": status,
            "p_correlation_id": payload.correlation_id,
        },
    )
    if "error" in finished:
        raise ExecutorRefused(finished["error"])
    final_status = finished["batch"]["status"]
    # The sweep's skipped actions appear here as outcomes so the caller sees
    # every action accounted for.
    settled = {o.action_id for o in outcomes}
    for action_id in payload.action_ids:
        if action_id not in settled:
            outcomes.append(ActionOutcome(action_id=action_id, outcome="skipped"))
    return BatchResult(batch_id=batch["id"], status=final_status, replay=False, outcomes=outcomes)


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


def _declared_records(blast_radius: dict[str, Any]) -> int | None:
    for key in ("records", "affected_records", "record_count"):
        value = blast_radius.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            return value
    return None
