"""W6 — the continuous-compliance scheduler.

Polls `monitoring_schedules` for due rows (active, next_run_at reached)
and executes them through the database's own write paths:
`onboarding_estate_drift` (0055) computes the drift against the last
sealed baseline, `record_drift_event` (0066) records each detection, and
`record_schedule_run` advances the schedule's bookkeeping — last run,
next fire computed from the cadence by `cron_next`, never by a guess.

The loop is OFF by default: `feature_continuous_scheduler` must be
enabled per environment, because a scheduler that fires without reviewed
configuration is exactly the kind of autonomous action this platform
refuses. Rediscovery and reassessment schedules are registered and
stored but not yet executable — the scheduler leaves them due for the
slice that wires their executors, and fires nothing on a guess.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any

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
_DRIFT_KEYS = {
    "added": "system_added",
    "removed": "system_removed",
    "changed": "system_changed",
    "lost": "connection_lost",
}


async def poll_once(db: SchedulerDb, *, now: datetime | None = None) -> dict[str, int]:
    """One scheduler pass. Returns the counts an operator can act on."""
    moment = (now or datetime.now(UTC)).astimezone(UTC)
    counts = {"fired": 0, "drift_events": 0, "failed": 0, "skipped": 0}
    try:
        due = db.due_schedules(moment.isoformat())
    except SchedulerUnavailable:
        return counts

    for schedule in due:
        if schedule["kind"] != "drift_check":
            # Registered and stored, but not yet executable: left due for
            # the slice that wires its executor.
            counts["skipped"] += 1
            continue
        try:
            next_at = next_fire(schedule["cadence"], moment)
        except CronSyntaxError:
            counts["failed"] += 1
            db.call(
                "record_schedule_run",
                {
                    "p_tenant_id": schedule["tenant_id"],
                    "p_schedule_id": schedule["id"],
                    # A cadence the engine cannot compute gets a day's
                    # grace so the schedule does not spin, and the failed
                    # run lands in the ledger for an operator.
                    "p_next_run_at": (moment + timedelta(days=1)).isoformat(),
                    "p_outcome": "failed",
                    "p_correlation_id": None,
                },
            )
            continue

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
                    recorded = db.call(
                        "record_drift_event",
                        {
                            "p_tenant_id": schedule["tenant_id"],
                            "p_estate_id": schedule["estate_id"],
                            "p_kind": kind,
                            "p_severity": _SEVERITY_BY_KIND[kind],
                            "p_summary": f"{kind.replace('_', ' ')}: {item.get('name', item.get('id'))}",
                            "p_source_ref": str(item.get("id")),
                            "p_correlation_id": None,
                        },
                    )
                    if "error" in recorded:
                        structlog.get_logger().warning(
                            "scheduler.drift_event_refused", reason=recorded["error"]
                        )
                        continue
                    counts["drift_events"] += 1
                    outcome = "drift_detected"

        db.call(
            "record_schedule_run",
            {
                "p_tenant_id": schedule["tenant_id"],
                "p_schedule_id": schedule["id"],
                "p_next_run_at": next_at.isoformat(),
                "p_outcome": outcome,
                "p_correlation_id": None,
            },
        )
        counts["fired"] += 1
    return counts


async def scheduler_loop(db: SchedulerDb, poll_seconds: int) -> None:
    """The long-running poll. Crashes of a single pass are logged and
    absorbed; the loop itself survives."""
    while True:
        try:
            counts = await poll_once(db)
            if counts["fired"] or counts["drift_events"] or counts["failed"]:
                structlog.get_logger().info("scheduler.pass", **counts)
        except SchedulerUnavailable:
            pass
        await asyncio.sleep(max(30, poll_seconds))
