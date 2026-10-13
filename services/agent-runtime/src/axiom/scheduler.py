"""W6 durable, due-slot-bound scheduler fires.

The database atomically probes, records detections and their receipts, settles
one durable fire and advances the schedule. Python verifies the retained result
against the exact due snapshot and the existing UTC cron calculator. Transport
loss permits an authoritative read only, never another mutation attempt.

Activation stays off by default. Rediscovery/reassessment live execution remains
unwired; neither scheduler claims nor bookkeeping confer connector/task authority.
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, NoReturn
from uuid import UUID, uuid4

import structlog

from .cron_next import CronSyntaxError, next_fire

_FIRE_RPC = "fire_monitoring_schedule"
_READ_RPC = "read_monitoring_schedule_fire"
_KINDS = {"drift_check", "rediscovery", "reassessment"}
_COORDINATION_REFUSALS = {
    "schedule_not_found",
    "schedule_snapshot_changed",
    "schedule_not_due",
    "fire_context_refused",
}
_FIRE_FIELDS = {
    "tenantId",
    "fireId",
    "scheduleId",
    "estateId",
    "kind",
    "cadence",
    "dueAt",
    "calculationAfter",
    "nextRunAt",
    "correlationId",
    "replayed",
    "observationOutcome",
    "recordingOutcome",
    "failureCode",
    "detectedCount",
    "recordedCount",
    "failedCount",
    "scheduleReceipt",
    "eventReceipts",
}


class SchedulerUnavailable(RuntimeError):  # noqa: N818 — reported state
    """A database response is unavailable or cannot be trusted."""


class SchedulerDb:
    """Service-role access without direct table writes or execution credentials."""

    def __init__(self, client: Any) -> None:
        self._client = client

    def due_schedules(self, now: str) -> list[dict[str, Any]]:
        try:
            response = (
                self._client.from_("monitoring_schedules")
                .select("id, tenant_id, estate_id, kind, cadence, next_run_at")
                .eq("status", "active")
                .lte("next_run_at", now)
                .order("next_run_at")
                .order("id")
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


def _valid_uuid(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        parsed = UUID(value)
        return str(parsed) == value and parsed.int != 0
    except ValueError:
        return False


def _timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
        return parsed.astimezone(UTC) if parsed.tzinfo is not None else None
    except ValueError, OverflowError:
        return None


def _valid_schedule(value: Any, moment: datetime) -> bool:
    if not isinstance(value, dict) or set(value) != {
        "id",
        "tenant_id",
        "estate_id",
        "kind",
        "cadence",
        "next_run_at",
    }:
        return False
    due = _timestamp(value["next_run_at"])
    return (
        all(_valid_uuid(value[key]) for key in ("id", "tenant_id", "estate_id"))
        and isinstance(value["kind"], str)
        and isinstance(value["cadence"], str)
        and due is not None
        and due <= moment
    )


def _receipt_id(value: Any, *, event: bool = False) -> int | None:
    fields = {"id", "entryHash", "eventId"} if event else {"id", "entryHash"}
    if not isinstance(value, dict) or set(value) != fields:
        return None
    identifier, digest = value["id"], value["entryHash"]
    if not isinstance(identifier, str) or re.fullmatch(r"[1-9][0-9]{0,18}", identifier) is None:
        return None
    if not isinstance(digest, str) or re.fullmatch(r"[a-f0-9]{64}", digest) is None:
        return None
    if event and not _valid_uuid(value["eventId"]):
        return None
    parsed = int(identifier)
    return parsed if parsed <= 9_223_372_036_854_775_807 else None


@dataclass(frozen=True)
class _ConfirmedFire:
    fire_id: str
    correlation_id: str
    replayed: bool
    recorded_count: int
    failed_count: int
    failed: bool


def _verify_fire(reply: dict[str, Any], schedule: dict[str, Any]) -> _ConfirmedFire:
    """Validate retained identity, calculation, outcome and ledger references.

    The RPC independently joins these receipts to the actual fire and ledger;
    shape validation alone must never be treated as database authority.
    """

    def refuse() -> NoReturn:
        raise SchedulerUnavailable("unconfirmed fire proof")

    if set(reply) != _FIRE_FIELDS:
        refuse()
    for result_key, source_key in (
        ("tenantId", "tenant_id"),
        ("scheduleId", "id"),
        ("estateId", "estate_id"),
        ("kind", "kind"),
        ("cadence", "cadence"),
    ):
        if reply[result_key] != schedule[source_key]:
            refuse()
    due, calculated, next_at = (
        _timestamp(reply[key]) for key in ("dueAt", "calculationAfter", "nextRunAt")
    )
    if (
        due is None
        or calculated is None
        or next_at is None
        or due != _timestamp(schedule["next_run_at"])
        or due > calculated
        or next_at <= calculated
    ):
        refuse()
    if (
        not _valid_uuid(reply["fireId"])
        or not _valid_uuid(reply["correlationId"])
        or type(reply["replayed"]) is not bool
    ):
        refuse()
    for key in ("detectedCount", "recordedCount", "failedCount"):
        if type(reply[key]) is not int or not 0 <= reply[key] <= 2000:
            refuse()
    detected, recorded, failed = (
        reply[key] for key in ("detectedCount", "recordedCount", "failedCount")
    )
    if recorded + failed != detected:
        refuse()
    receipt = _receipt_id(reply["scheduleReceipt"])
    events = reply["eventReceipts"]
    if receipt is None or not isinstance(events, list) or len(events) != recorded:
        refuse()
    event_ids: set[str] = set()
    previous_receipt = 0
    for item in events:
        event_receipt = _receipt_id(item, event=True)
        if (
            event_receipt is None
            or event_receipt >= receipt
            or event_receipt <= previous_receipt
            or item["eventId"] in event_ids
        ):
            refuse()
        previous_receipt = event_receipt
        event_ids.add(item["eventId"])
    outcome, completeness, failure_code = (
        reply[key] for key in ("observationOutcome", "recordingOutcome", "failureCode")
    )
    if outcome in ("no_drift", "no_baseline"):
        if detected != 0 or completeness != "recorded" or failure_code is not None:
            refuse()
        if outcome == "no_drift" and schedule["kind"] != "drift_check":
            refuse()
    elif outcome == "drift_detected":
        if detected == 0 or schedule["kind"] != "drift_check":
            refuse()
        if failed == 0:
            if completeness != "recorded" or failure_code is not None:
                refuse()
        elif completeness != "failed" or failure_code != "event_recording_failed" or recorded != 0:
            refuse()
    elif outcome == "failed":
        if (
            detected != 0
            or completeness != "failed"
            or failure_code not in ("cadence_invalid", "probe_invalid", "probe_failed")
        ):
            refuse()
    elif outcome == "unwired":
        if (
            detected != 0
            or completeness != "failed"
            or failure_code != "live_executor_unwired"
            or schedule["kind"] == "drift_check"
        ):
            refuse()
    else:
        refuse()
    # SQL owns the calculation instant, so a legitimate replay may be old.
    # Verify the exact cron result against that instant, not the local clock.
    try:
        if len(schedule["cadence"]) > 100:
            raise CronSyntaxError
        expected_next = next_fire(schedule["cadence"], calculated)
    except CronSyntaxError:
        if outcome != "failed" or failure_code != "cadence_invalid":
            refuse()
        try:
            expected_next = calculated + timedelta(days=1)
        except OverflowError:
            refuse()
    except OverflowError, ValueError:
        refuse()
    else:
        if failure_code == "cadence_invalid":
            refuse()
    if next_at != expected_next:
        refuse()
    return _ConfirmedFire(
        reply["fireId"],
        reply["correlationId"],
        reply["replayed"],
        recorded,
        failed,
        completeness == "failed",
    )


def _run_fire(
    db: SchedulerDb, schedule: dict[str, Any], counts: dict[str, int], seen: set[str]
) -> None:
    correlation_id = str(uuid4())
    context = {
        "p_tenant_id": schedule["tenant_id"],
        "p_schedule_id": schedule["id"],
        "p_estate_id": schedule["estate_id"],
        "p_expected_kind": schedule["kind"],
        "p_expected_cadence": schedule["cadence"],
        "p_expected_due_at": schedule["next_run_at"],
    }
    recovered = False
    try:
        reply = db.call(_FIRE_RPC, {**context, "p_correlation_id": correlation_id})
    except SchedulerUnavailable:
        # No mutation retry: only the retained exact due-slot/config proof is read.
        recovered = True
        try:
            reply = db.call(_READ_RPC, context)
        except SchedulerUnavailable:
            counts["failed"] += 1
            counts["refused"] += 1
            return
    if (
        set(reply) == {"error"}
        and isinstance(reply["error"], str)
        and reply["error"] in _COORDINATION_REFUSALS
    ):
        counts["skipped"] += 1
        counts["refused"] += 1
        return
    try:
        confirmed = _verify_fire(reply, schedule)
        if recovered and not confirmed.replayed:
            raise SchedulerUnavailable("readback must be a retained replay")
        if not recovered and not confirmed.replayed and confirmed.correlation_id != correlation_id:
            raise SchedulerUnavailable("foreign current-call proof")
    except SchedulerUnavailable:
        structlog.get_logger().warning("scheduler.fire_unconfirmed", kind=schedule["kind"])
        counts["failed"] += 1
        counts["refused"] += 1
        return
    if (
        confirmed.fire_id in seen
        or confirmed.correlation_id != correlation_id
        or (confirmed.replayed and not recovered)
    ):
        counts["replayed"] += 1
        return
    seen.add(confirmed.fire_id)
    counts["fired"] += 1
    counts["drift_events"] += confirmed.recorded_count
    counts["refused"] += confirmed.failed_count
    counts["failed"] += int(confirmed.failed)
    counts["recovered"] += int(recovered)


async def poll_once(db: SchedulerDb, *, now: datetime | None = None) -> dict[str, int]:
    """Count each confirmed current-call fire once; replays never repeat metrics."""
    moment = (now or datetime.now(UTC)).astimezone(UTC)
    counts = {
        "fired": 0,
        "drift_events": 0,
        "failed": 0,
        "refused": 0,
        "skipped": 0,
        "replayed": 0,
        "recovered": 0,
    }
    try:
        due = db.due_schedules(moment.isoformat())
    except SchedulerUnavailable:
        counts["failed"] += 1
        return counts
    seen: set[str] = set()
    for schedule in due:
        if not _valid_schedule(schedule, moment):
            structlog.get_logger().warning("scheduler.invalid_due_schedule")
            counts["failed"] += 1
            counts["skipped"] += 1
            continue
        if schedule["kind"] not in _KINDS:
            counts["skipped"] += 1
            continue
        _run_fire(db, schedule, counts, seen)
    return counts


async def scheduler_loop(db: SchedulerDb, poll_seconds: int) -> None:
    """Keep polling unavailable databases; cancellation still propagates."""
    while True:
        try:
            counts = await poll_once(db)
            if any(counts.values()):
                structlog.get_logger().info("scheduler.pass", **counts)
        except SchedulerUnavailable:
            pass
        await asyncio.sleep(max(30, poll_seconds))
