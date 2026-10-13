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
the sanctioned read, record an honest outcome, attempt to advance the
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
from uuid import UUID, uuid4

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
        data = getattr(response, "data", None)
        if not isinstance(data, list) or len(data) > 20:
            raise SchedulerUnavailable("invalid due-schedule collection")
        return data

    def call(self, fn: str, args: dict[str, Any]) -> dict[str, Any]:
        try:
            data = self._client.rpc(fn, args).execute().data
        except Exception as exc:
            structlog.get_logger().warning("scheduler.rpc_unavailable", fn=fn)
            raise SchedulerUnavailable from exc
        if not isinstance(data, dict):
            raise SchedulerUnavailable("invalid RPC response")
        return data


class SchedulerUnavailable(RuntimeError):  # noqa: N818 — reads as the state it reports
    """The database response is unavailable or cannot be trusted."""


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


def _valid_uuid(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        parsed = UUID(value)
    except ValueError:
        return False
    return str(parsed) == value


def _valid_timestamp(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return False
    return parsed.tzinfo is not None


def _valid_schedule(value: Any, moment: datetime) -> bool:
    # The exact selected PostgREST row; unknown kinds are still skipped below.
    return (
        isinstance(value, dict)
        and set(value) == {"id", "tenant_id", "estate_id", "kind", "cadence", "next_run_at"}
        and all(_valid_uuid(value[key]) for key in ("id", "tenant_id", "estate_id"))
        and isinstance(value["kind"], str)
        and isinstance(value["cadence"], str)
        and _valid_timestamp(value["next_run_at"])
        and datetime.fromisoformat(value["next_run_at"]) <= moment
    )


def _probe_estate(db: SchedulerDb, schedule: dict[str, Any]) -> dict[str, Any]:
    """Validate the actual 0055 JSON contract before any drift writes.

    A complete baseline and all four arrays are required. Inconsistent
    current/drifted declarations never become a clean estate outcome.
    """
    try:
        probe = db.call(
            "onboarding_estate_drift",
            {"p_tenant_id": schedule["tenant_id"], "p_estate_id": schedule["estate_id"]},
        )
    except SchedulerUnavailable:
        return {"status": "failed"}
    status = probe.get("status")
    if set(probe) == {"status"} and status == "not_onboarded":
        return {"status": "failed"}
    metadata = {"status", "baselineWizardId", "completedAt"}
    if not _valid_uuid(probe.get("baselineWizardId")) or not _valid_timestamp(
        probe.get("completedAt")
    ):
        return {"status": "failed"}
    if status == "no_baseline" and set(probe) == metadata:
        return probe
    if status not in ("current", "drifted") or set(probe) != metadata | set(_DRIFT_KEYS):
        return {"status": "failed"}
    for key in _DRIFT_KEYS:
        items = probe[key]
        if not isinstance(items, list) or any(
            not isinstance(item, dict)
            or set(item) != {"id", "name"}
            or not _valid_uuid(item["id"])
            or not isinstance(item["name"], str)
            for item in items
        ):
            return {"status": "failed"}
    detected = any(probe[key] for key in _DRIFT_KEYS)
    if detected != (status == "drifted"):
        return {"status": "failed"}
    return probe


def _confirmed_event(recorded: dict[str, Any], kind: str) -> bool:
    """0066 returns the inserted event identity, kind, severity and timestamp."""
    event = recorded.get("driftEvent")
    return (
        set(recorded) == {"driftEvent"}
        and isinstance(event, dict)
        and set(event) == {"id", "kind", "severity", "detectedAt"}
        and _valid_uuid(event["id"])
        and event["kind"] == kind
        and event["severity"] == _SEVERITY_BY_KIND[kind]
        and _valid_timestamp(event["detectedAt"])
    )


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
    does not accept — is logged and reported. An unconfirmed response
    is never counted as fired. An ambiguous write is not retried
    within this pass; subsequent polls read the actual due state."""
    try:
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
    except SchedulerUnavailable:
        structlog.get_logger().warning("scheduler.schedule_run_unconfirmed", kind=schedule["kind"])
        return False
    # 0066 returns exactly {'ok': true}; empty/error/truthy responses are not proof.
    if set(recorded) != {"ok"} or recorded["ok"] is not True:
        structlog.get_logger().warning("scheduler.schedule_run_refused", kind=schedule["kind"])
        return False
    return True


def _next_fire_or_failed_run(
    db: SchedulerDb, schedule: dict[str, Any], moment: datetime, counts: dict[str, int]
) -> datetime | None:
    """The strictly-future next fire, or None after recording a failed run
    with a day's grace — a cadence the engine cannot compute never fires on
    a guess. Failed-run persistence still requires the normal confirmation."""
    try:
        return next_fire(schedule["cadence"], moment)
    except CronSyntaxError:
        _finish_run(
            db, schedule, moment + timedelta(days=1), "failed", counts, _new_correlation_id()
        )
        return None


def _finish_run(
    db: SchedulerDb,
    schedule: dict[str, Any],
    next_at: datetime,
    outcome: str,
    counts: dict[str, int],
    correlation_id: str,
    *,
    incomplete: bool = False,
) -> None:
    """Close the fire: the bookkeeping either advances (fired) or is
    counted as refused — it is never claimed fired without confirmation."""
    confirmed = _record_run(db, schedule, next_at, outcome, correlation_id)
    if confirmed:
        counts["fired"] += 1
    else:
        counts["refused"] += 1
    # Failed counts schedules with any execution/persistence failure, once each.
    if outcome == "failed" or incomplete or not confirmed:
        counts["failed"] += 1


def _estate_readiness(db: SchedulerDb, schedule: dict[str, Any]) -> str:
    """Whether the estate can sustain the run at all, answered through the
    one sanctioned read (`onboarding_estate_drift`, 0055 — STABLE, no
    writes). An estate with no sealed baseline has nothing to rediscover or
    re-assess against; that state is recorded as it is, not worked around.
    """
    probe = _probe_estate(db, schedule)
    if probe["status"] in ("no_baseline", "failed"):
        return str(probe["status"])
    return "ready"


def _run_drift_check(
    db: SchedulerDb, schedule: dict[str, Any], moment: datetime, counts: dict[str, int]
) -> None:
    next_at = _next_fire_or_failed_run(db, schedule, moment, counts)
    if next_at is None:
        return
    correlation_id = _new_correlation_id()
    drift = _probe_estate(db, schedule)
    outcome = drift["status"]
    incomplete = False
    if outcome in ("current", "drifted"):
        # Detection is a source fact, independent of whether event writes succeed.
        outcome = "drift_detected" if outcome == "drifted" else "no_drift"
        for key, kind in _DRIFT_KEYS.items():
            for item in drift[key]:
                summary = f"{kind.replace('_', ' ')}: {item['name']}"[:_MAX_SUMMARY]
                try:
                    recorded = db.call(
                        "record_drift_event",
                        {
                            "p_tenant_id": schedule["tenant_id"],
                            "p_estate_id": schedule["estate_id"],
                            "p_kind": kind,
                            "p_severity": _SEVERITY_BY_KIND[kind],
                            "p_summary": summary,
                            "p_source_ref": item["id"],
                            "p_correlation_id": correlation_id,
                        },
                    )
                    confirmed = _confirmed_event(recorded, kind)
                except SchedulerUnavailable:
                    confirmed = False
                if not confirmed:
                    structlog.get_logger().warning("scheduler.drift_event_unconfirmed", kind=kind)
                    incomplete = True
                    counts["refused"] += 1
                    continue
                counts["drift_events"] += 1
    _finish_run(db, schedule, next_at, outcome, counts, correlation_id, incomplete=incomplete)


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
    """One pass: fired/event counts require confirmed persistence.

    Failed counts schedules with execution or persistence failures once;
    an unreadable due query contributes one failed pass. Refused counts
    unconfirmed writes, including partial event recording. Skipped counts
    malformed rows and unsupported kinds. These categories can overlap.
    """
    moment = (now or datetime.now(UTC)).astimezone(UTC)
    counts = {"fired": 0, "drift_events": 0, "failed": 0, "refused": 0, "skipped": 0}
    try:
        due = db.due_schedules(moment.isoformat())
    except SchedulerUnavailable:
        counts["failed"] += 1
        return counts

    for schedule in due:
        if not _valid_schedule(schedule, moment):
            structlog.get_logger().warning("scheduler.invalid_due_schedule")
            counts["failed"] += 1
            counts["skipped"] += 1
            continue
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
