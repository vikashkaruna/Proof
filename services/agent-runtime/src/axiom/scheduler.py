"""W6 — the continuous-compliance scheduler.

Polls `monitoring_schedules` for due rows (active, next_run_at reached)
and executes them through the database's own write paths:
`onboarding_estate_drift` (0055, read-only) answers whether an estate can
sustain a run at all, `record_drift_event` (0066) records each drift
detection, and `record_schedule_run` advances the schedule's bookkeeping —
last run, next fire computed from the cadence by `cron_next`, never by a
guess, with a strictly-future next fire enforced by the RPC itself.

Every fire carries one generated correlation id shared by all of its
writes: the ledger's correlation column is NOT NULL (0005) and
`record_drift_event` refuses a null one, so a fire without a correlation
id would crash the pass or silently drop its own detections.

The loop is OFF by default: `feature_continuous_scheduler` must be
enabled per environment, because a scheduler that fires without reviewed
configuration is exactly the kind of autonomous action this platform
refuses. The `rediscovery` and `reassessment` executors do the safe part
fully — resolve the due schedule, probe the estate's readiness through
the sanctioned read, record an honest outcome, always advance the
bookkeeping — but their live halves (the connector-broker re-enumeration
behind the BFF; the human-initiated controller dispatch the Temporal
workers drive) are operator-gated compositions this runtime does not
hold, so a serviceable estate is recorded `failed` rather than answered
with an invented inventory or assessment.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import structlog

from .cron_next import CronSyntaxError, next_fire


class SchedulerDb:
    """Fail-closed service-role access for the scheduler's own needs."""

    def __init__(self, client: Any):
        self._client = client

    def due_schedules(self, now: str) -> list[dict[str, Any]]:
        try:
            response = (
                self._client.from_("monitoring_schedules")
                .select("id, tenant_id, estate_id, kind, cadence, next_run_at")
                .eq("status", "active")
                .lte("next_run_at", now)
                .limit(20)
                .execute()
            )
        except Exception as exc:
            structlog.get_logger().warning("scheduler.due_unreadable")
            raise SchedulerUnavailable from exc
        return list(response.data or [])

    def call(self, fn: str, args: dict[str, Any]) -> dict[str, Any]:
        try:
            data = self._client.rpc(fn, args).execute().data
        except Exception as exc:
            structlog.get_logger().warning("scheduler.rpc_unavailable", fn=fn)
            raise SchedulerUnavailable from exc
        return data if isinstance(data, dict) else {}


class SchedulerUnavailable(RuntimeError):  # noqa: N818 — reads as the state it reports
    """The database could not be reached; the poll is skipped."""


_SEVERITY_BY_KIND = {
    "system_added": "medium",
    "system_removed": "high",
    "system_changed": "medium",
    "connection_lost": "high",
}
# `onboarding_estate_drift` returns its findings under these keys — the
# connection-lost set is named `connectionLost` by the RPC (0055) — mapped
# onto the closed drift-event kinds `record_drift_event` accepts (0066).
_DRIFT_KEYS = {
    "added": "system_added",
    "removed": "system_removed",
    "changed": "system_changed",
    "connectionLost": "connection_lost",
}
_MAX_SUMMARY = 300  # record_drift_event refuses anything longer; bound it here


def _new_correlation_id() -> str:
    return str(uuid4())


def _record_run(
    db: SchedulerDb,
    schedule: dict[str, Any],
    next_at: datetime,
    outcome: str,
    correlation_id: str,
) -> bool:
    """Advance the schedule's bookkeeping through `record_schedule_run`
    (0066). A refusal — the schedule retired mid-poll, an outcome the RPC
    does not accept — is logged and reported, never faked as a fire: the
    schedule stays due and the next poll retries it."""
    recorded = db.call(
        "record_schedule_run",
        {
            "p_tenant_id": schedule["tenant_id"],
            "p_schedule_id": schedule["id"],
            "p_next_run_at": next_at.isoformat(),
            "p_outcome": outcome,
            "p_correlation_id": correlation_id,
        },
    )
    if "error" in recorded:
        structlog.get_logger().warning(
            "scheduler.schedule_run_refused", kind=schedule["kind"], reason=recorded["error"]
        )
        return False
    return True


def _next_fire_or_failed_run(
    db: SchedulerDb, schedule: dict[str, Any], moment: datetime, counts: dict[str, int]
) -> datetime | None:
    """The strictly-future next fire, or None after recording a failed run
    with a day's grace — a cadence the engine cannot compute never fires on
    a guess, and the failed run lands in the ledger for an operator."""
    try:
        return next_fire(schedule["cadence"], moment)
    except CronSyntaxError:
        counts["failed"] += 1
        if not _record_run(
            db, schedule, moment + timedelta(days=1), "failed", _new_correlation_id()
        ):
            counts["refused"] += 1
        return None


def _finish_run(
    db: SchedulerDb,
    schedule: dict[str, Any],
    next_at: datetime,
    outcome: str,
    counts: dict[str, int],
    correlation_id: str,
) -> None:
    """Close the fire: the bookkeeping either advances (fired) or is
    counted as refused — it is never claimed fired when it did not."""
    if _record_run(db, schedule, next_at, outcome, correlation_id):
        counts["fired"] += 1
    else:
        counts["refused"] += 1


def _estate_readiness(db: SchedulerDb, schedule: dict[str, Any]) -> str:
    """Whether the estate can sustain the run at all, answered through the
    one sanctioned read (`onboarding_estate_drift`, 0055 — STABLE, no
    writes). An estate with no sealed baseline has nothing to rediscover or
    re-assess against; that state is recorded as it is, not worked around.
    """
    probe = db.call(
        "onboarding_estate_drift",
        {"p_tenant_id": schedule["tenant_id"], "p_estate_id": schedule["estate_id"]},
    )
    if probe.get("status") == "no_baseline":
        return "no_baseline"
    if "error" in probe or probe.get("status") == "not_onboarded":
        return "failed"
    return "ready"


def _run_drift_check(
    db: SchedulerDb, schedule: dict[str, Any], moment: datetime, counts: dict[str, int]
) -> None:
    next_at = _next_fire_or_failed_run(db, schedule, moment, counts)
    if next_at is None:
        return
    correlation_id = _new_correlation_id()
    drift = db.call(
        "onboarding_estate_drift",
        {"p_tenant_id": schedule["tenant_id"], "p_estate_id": schedule["estate_id"]},
    )
    outcome = "no_drift"
    if "error" in drift or drift.get("status") in ("not_onboarded", "no_baseline"):
        outcome = "no_baseline" if drift.get("status") == "no_baseline" else "failed"
    else:
        for key, kind in _DRIFT_KEYS.items():
            for item in drift.get(key) or []:
                summary = f"{kind.replace('_', ' ')}: {item.get('name', item.get('id'))}"[:_MAX_SUMMARY]
                recorded = db.call(
                    "record_drift_event",
                    {
                        "p_tenant_id": schedule["tenant_id"],
                        "p_estate_id": schedule["estate_id"],
                        "p_kind": kind,
                        "p_severity": _SEVERITY_BY_KIND[kind],
                        "p_summary": summary,
                        "p_source_ref": str(item.get("id")),
                        "p_correlation_id": correlation_id,
                    },
                )
                if "error" in recorded:
                    structlog.get_logger().warning(
                        "scheduler.drift_event_refused", reason=recorded["error"]
                    )
                    continue
                counts["drift_events"] += 1
                outcome = "drift_detected"

    _finish_run(db, schedule, next_at, outcome, counts, correlation_id)


def _run_rediscovery(
    db: SchedulerDb, schedule: dict[str, Any], moment: datetime, counts: dict[str, int]
) -> None:
    """Re-enumerate the estate's systems. The live half — the connector
    broker re-enumeration Drishti runs through a live, operator-issued
    `connector.read` grant — lives behind the BFF and is not built in this
    runtime. An inventory improvised here would fabricate estate facts, so
    a ready estate is recorded `failed` and the live slice stays explicitly
    unbuilt; the drift-check schedule remains the sanctioned drift detector.
    """
    next_at = _next_fire_or_failed_run(db, schedule, moment, counts)
    if next_at is None:
        return
    correlation_id = _new_correlation_id()
    readiness = _estate_readiness(db, schedule)
    if readiness != "ready":
        outcome = readiness
    else:
        structlog.get_logger().warning("scheduler.rediscovery_unwired", kind="rediscovery")
        outcome = "failed"
    _finish_run(db, schedule, next_at, outcome, counts, correlation_id)


def _run_reassessment(
    db: SchedulerDb, schedule: dict[str, Any], moment: datetime, counts: dict[str, int]
) -> None:
    """Re-run the estate's control assessment. The live half — a dispatch
    that requires a human actor, a controller-wrapped encrypted input and a
    delegated workload task (`enqueue_assessment_dispatch`, 0044), then the
    Temporal workers' reserve/acknowledge lease — is a composition this
    runtime neither holds nor may improvise. A ready estate is recorded
    `failed`; nothing is scored, nothing is claimed assessed.
    """
    next_at = _next_fire_or_failed_run(db, schedule, moment, counts)
    if next_at is None:
        return
    correlation_id = _new_correlation_id()
    readiness = _estate_readiness(db, schedule)
    if readiness != "ready":
        outcome = readiness
    else:
        structlog.get_logger().warning("scheduler.reassessment_unwired", kind="reassessment")
        outcome = "failed"
    _finish_run(db, schedule, next_at, outcome, counts, correlation_id)


_RUNNERS = {
    "drift_check": _run_drift_check,
    "rediscovery": _run_rediscovery,
    "reassessment": _run_reassessment,
}


async def poll_once(db: SchedulerDb, *, now: datetime | None = None) -> dict[str, int]:
    """One scheduler pass. Returns the counts an operator can act on."""
    moment = (now or datetime.now(UTC)).astimezone(UTC)
    counts = {"fired": 0, "drift_events": 0, "failed": 0, "refused": 0, "skipped": 0}
    try:
        due = db.due_schedules(moment.isoformat())
    except SchedulerUnavailable:
        return counts

    for schedule in due:
        runner = _RUNNERS.get(schedule["kind"])
        if runner is None:
            # A kind this build does not know stays due, untouched: firing
            # on a guess is exactly what the scheduler refuses.
            counts["skipped"] += 1
            continue
        runner(db, schedule, moment, counts)
    return counts


async def scheduler_loop(db: SchedulerDb, poll_seconds: int) -> None:
    """The long-running poll. Crashes of a single pass are logged and
    absorbed; the loop itself survives."""
    while True:
        try:
            counts = await poll_once(db)
            if counts["fired"] or counts["drift_events"] or counts["failed"] or counts["refused"]:
                structlog.get_logger().info("scheduler.pass", **counts)
        except SchedulerUnavailable:
            pass
        await asyncio.sleep(max(30, poll_seconds))
