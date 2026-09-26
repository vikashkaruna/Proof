"""W6 — the continuous-compliance scheduler.

The cron calculator is pure and tested against the standard DOM/DOW rule.
The scheduler pass is tested against scripted database responses: due
drift schedules fire, drift becomes recorded events sharing the fire's
correlation id, a no-baseline estate is stated honestly, rediscovery and
reassessment do their safe part (readiness probe, honest outcome,
bookkeeping always advanced) and never improvise the live half they do
not hold, unknown kinds stay due untouched, a not-due schedule is never
seen, a refused bookkeeping write is counted instead of faked, and a
cadence the engine cannot compute records a failed run instead of
spinning.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any
from uuid import UUID

import pytest

from axiom.cron_next import CronSyntaxError, next_fire
from axiom.scheduler import SchedulerDb, SchedulerUnavailable, poll_once

AFTER = datetime(2026, 9, 26, 10, 30, tzinfo=UTC)


def test_every_fifteen_minutes() -> None:
    assert next_fire("*/15 * * * *", AFTER) == AFTER.replace(minute=45)


def test_daily_at_three_uses_utc() -> None:
    assert next_fire("0 3 * * *", AFTER) == AFTER.replace(day=27, hour=3, minute=0)


def test_list_and_range_fields() -> None:
    # Hours 8-9 have passed at 10:30, so the next fire is tomorrow 08:05.
    assert next_fire("5,25 8-9 * * *", AFTER) == AFTER.replace(
        day=27, hour=8, minute=5
    )


def test_dom_and_dow_follow_the_or_rule() -> None:
    # 2026-09-26 is a Saturday (dow 6). "13 the 1st or every Monday" — both
    # restricted: a day matches when EITHER matches.
    fired = next_fire("0 13 1 * 1", AFTER)  # the 1st, or Mondays
    assert fired == datetime(2026, 9, 28, 13, 0, tzinfo=UTC)  # Monday


def test_short_month_day_of_month_is_skipped() -> None:
    fired = next_fire("0 0 31 * *", datetime(2026, 9, 30, 12, 0, tzinfo=UTC))
    assert (fired.month, fired.day) == (10, 31)


def test_garbage_cadence_raises() -> None:
    with pytest.raises(CronSyntaxError):
        next_fire("every 15 minutes", AFTER)
    with pytest.raises(CronSyntaxError):
        next_fire("99 * * * *", AFTER)


class FakeClient:
    """Scripted double: the due filter emulates the database's own
    (active rows whose next_run_at has been reached); RPC responses come
    from `rpc_script`, defaulting to success."""

    def __init__(self, schedules: list[dict[str, Any]]) -> None:
        self.schedules = schedules
        self.rpc_calls: list[tuple[str, dict[str, Any]]] = []
        self.rpc_script: dict[str, Any] = {}
        self._now: str | None = None

    def from_(self, _table: str) -> Any:
        builder = self

        class Q:
            def select(self, _c: str) -> Q:
                return self

            def eq(self, _c: str, _v: Any) -> Q:
                return self

            def lte(self, _c: str, value: Any) -> Q:
                builder._now = value
                return self

            def limit(self, _n: int) -> Q:
                return self

            def execute(self) -> Any:
                due = [
                    s
                    for s in builder.schedules
                    if s.get("next_run_at") is not None
                    and (builder._now is None or s["next_run_at"] <= builder._now)
                ]
                return SimpleNamespace(data=due)

        return Q()

    def rpc(self, fn: str, args: dict[str, Any]) -> Any:
        self.rpc_calls.append((fn, args))
        response = self.rpc_script.get(fn, {"ok": True})
        if isinstance(response, list):
            response = response.pop(0)
        return SimpleNamespace(execute=lambda: SimpleNamespace(data=response))


def drift_response(**overrides: Any) -> dict[str, Any]:
    body = {
        "status": "drifted",
        "added": [],
        "removed": [],
        "changed": [],
        "connectionLost": [],
    }
    body.update(overrides)
    return body


def due_schedule(**overrides: Any) -> dict[str, Any]:
    row = {
        "id": "11111111-1111-4111-8111-111111111111",
        "tenant_id": "22222222-2222-4222-8222-222222222222",
        "estate_id": "33333333-3333-4333-8333-333333333333",
        "kind": "drift_check",
        "cadence": "*/15 * * * *",
        "next_run_at": "2026-09-26T10:00:00+00:00",
    }
    row.update(overrides)
    return row


def recorded_events(client: FakeClient) -> list[tuple[str, dict[str, Any]]]:
    return [c for c in client.rpc_calls if c[0] == "record_drift_event"]


def recorded_runs(client: FakeClient) -> list[tuple[str, dict[str, Any]]]:
    return [c for c in client.rpc_calls if c[0] == "record_schedule_run"]


def called_fns(client: FakeClient) -> set[str]:
    return {fn for fn, _ in client.rpc_calls}


def is_uuid(value: Any) -> bool:
    try:
        UUID(str(value))
    except (TypeError, ValueError):
        return False
    return True


@pytest.mark.asyncio
async def test_drift_becomes_recorded_events_and_a_fired_run() -> None:
    client = FakeClient([due_schedule()])
    client.rpc_script["onboarding_estate_drift"] = drift_response(
        added=[{"id": "s-1", "name": "New CRM"}],
        connectionLost=[{"id": "s-2", "name": "Old Warehouse"}],
    )
    counts = await poll_once(SchedulerDb(client), now=AFTER)
    events = recorded_events(client)
    assert len(events) == 2
    kinds = {args["p_kind"] for _, args in events}
    assert kinds == {"system_added", "connection_lost"}
    severities = {args["p_kind"]: args["p_severity"] for _, args in events}
    assert severities["connection_lost"] == "high"
    runs = recorded_runs(client)
    assert len(runs) == 1
    assert runs[0][1]["p_outcome"] == "drift_detected"
    # The fire's writes share one generated correlation id — the ledger's
    # correlation column is NOT NULL and record_drift_event refuses a null.
    run_correlation = runs[0][1]["p_correlation_id"]
    assert is_uuid(run_correlation)
    assert {args["p_correlation_id"] for _, args in events} == {run_correlation}
    assert counts["fired"] == 1
    assert counts["drift_events"] == 2


@pytest.mark.asyncio
async def test_clean_estate_records_no_drift() -> None:
    client = FakeClient([due_schedule()])
    client.rpc_script["onboarding_estate_drift"] = drift_response()
    counts = await poll_once(SchedulerDb(client), now=AFTER)
    assert recorded_events(client) == []
    assert recorded_runs(client)[0][1]["p_outcome"] == "no_drift"
    assert counts["drift_events"] == 0


@pytest.mark.asyncio
async def test_no_baseline_is_stated_not_failed() -> None:
    client = FakeClient([due_schedule()])
    client.rpc_script["onboarding_estate_drift"] = drift_response(status="no_baseline")
    await poll_once(SchedulerDb(client), now=AFTER)
    assert recorded_runs(client)[0][1]["p_outcome"] == "no_baseline"


@pytest.mark.asyncio
async def test_refused_drift_event_does_not_block_the_run() -> None:
    client = FakeClient([due_schedule()])
    client.rpc_script["onboarding_estate_drift"] = drift_response(
        added=[{"id": "s-1", "name": "New CRM"}]
    )
    client.rpc_script["record_drift_event"] = {"error": "invalid_event"}
    counts = await poll_once(SchedulerDb(client), now=AFTER)
    assert counts["drift_events"] == 0
    assert recorded_runs(client)[0][1]["p_outcome"] == "no_drift"
    assert counts["fired"] == 1


@pytest.mark.asyncio
async def test_unknown_kinds_stay_due_untouched() -> None:
    client = FakeClient([due_schedule(kind="audit")])
    counts = await poll_once(SchedulerDb(client), now=AFTER)
    assert counts["skipped"] == 1
    assert client.rpc_calls == []


@pytest.mark.asyncio
async def test_not_due_schedule_is_never_seen() -> None:
    client = FakeClient([due_schedule(next_run_at="2026-09-26T11:00:00+00:00")])
    counts = await poll_once(SchedulerDb(client), now=AFTER)
    assert counts == {
        "fired": 0,
        "drift_events": 0,
        "failed": 0,
        "refused": 0,
        "skipped": 0,
    }
    assert client.rpc_calls == []


@pytest.mark.asyncio
async def test_uncountable_cadence_records_a_failed_run() -> None:
    client = FakeClient([due_schedule(cadence="99 * * * *")])
    counts = await poll_once(SchedulerDb(client), now=AFTER)
    runs = recorded_runs(client)
    assert counts["failed"] == 1
    assert len(runs) == 1
    assert runs[0][1]["p_outcome"] == "failed"
    assert runs[0][1]["p_next_run_at"] == (AFTER + timedelta(days=1)).isoformat()
    assert is_uuid(runs[0][1]["p_correlation_id"])


# ─── rediscovery ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_rediscovery_without_baseline_records_no_baseline() -> None:
    client = FakeClient([due_schedule(kind="rediscovery")])
    client.rpc_script["onboarding_estate_drift"] = drift_response(status="no_baseline")
    counts = await poll_once(SchedulerDb(client), now=AFTER)
    runs = recorded_runs(client)
    assert len(runs) == 1
    assert runs[0][1]["p_outcome"] == "no_baseline"
    assert datetime.fromisoformat(runs[0][1]["p_next_run_at"]) > AFTER
    assert counts["fired"] == 1
    assert counts["drift_events"] == 0


@pytest.mark.asyncio
async def test_rediscovery_on_ready_estate_refuses_to_improvise() -> None:
    client = FakeClient([due_schedule(kind="rediscovery")])
    client.rpc_script["onboarding_estate_drift"] = drift_response()
    counts = await poll_once(SchedulerDb(client), now=AFTER)
    runs = recorded_runs(client)
    # The live re-enumeration is not held by this runtime: the run is
    # recorded failed — no invented inventory, no fabricated success.
    assert runs[0][1]["p_outcome"] == "failed"
    assert datetime.fromisoformat(runs[0][1]["p_next_run_at"]) > AFTER
    assert called_fns(client) == {"onboarding_estate_drift", "record_schedule_run"}
    assert recorded_events(client) == []
    assert counts["fired"] == 1
    assert counts["drift_events"] == 0


@pytest.mark.asyncio
async def test_rediscovery_unonboarded_estate_records_failed() -> None:
    client = FakeClient([due_schedule(kind="rediscovery")])
    client.rpc_script["onboarding_estate_drift"] = drift_response(status="not_onboarded")
    counts = await poll_once(SchedulerDb(client), now=AFTER)
    assert recorded_runs(client)[0][1]["p_outcome"] == "failed"
    assert counts["fired"] == 1


@pytest.mark.asyncio
async def test_rediscovery_uncountable_cadence_skips_the_probe() -> None:
    client = FakeClient([due_schedule(kind="rediscovery", cadence="99 * * * *")])
    counts = await poll_once(SchedulerDb(client), now=AFTER)
    # The cadence gate precedes everything: a failed run is recorded and no
    # estate probe is spent on a schedule that cannot say when it fires.
    assert counts["failed"] == 1
    assert called_fns(client) == {"record_schedule_run"}
    assert recorded_runs(client)[0][1]["p_outcome"] == "failed"


# ─── reassessment ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_reassessment_without_baseline_records_no_baseline() -> None:
    client = FakeClient([due_schedule(kind="reassessment")])
    client.rpc_script["onboarding_estate_drift"] = drift_response(status="no_baseline")
    counts = await poll_once(SchedulerDb(client), now=AFTER)
    runs = recorded_runs(client)
    assert len(runs) == 1
    assert runs[0][1]["p_outcome"] == "no_baseline"
    assert datetime.fromisoformat(runs[0][1]["p_next_run_at"]) > AFTER
    assert counts["fired"] == 1
    assert counts["drift_events"] == 0


@pytest.mark.asyncio
async def test_reassessment_on_ready_estate_refuses_to_improvise() -> None:
    client = FakeClient([due_schedule(kind="reassessment")])
    client.rpc_script["onboarding_estate_drift"] = drift_response()
    counts = await poll_once(SchedulerDb(client), now=AFTER)
    runs = recorded_runs(client)
    # Nothing is scored and nothing is claimed assessed: the live dispatch
    # needs a human actor and a controller-wrapped input this runtime does
    # not hold, so the run is recorded failed.
    assert runs[0][1]["p_outcome"] == "failed"
    assert datetime.fromisoformat(runs[0][1]["p_next_run_at"]) > AFTER
    assert called_fns(client) == {"onboarding_estate_drift", "record_schedule_run"}
    assert recorded_events(client) == []
    assert counts["fired"] == 1


@pytest.mark.asyncio
async def test_reassessment_unonboarded_estate_records_failed() -> None:
    client = FakeClient([due_schedule(kind="reassessment")])
    client.rpc_script["onboarding_estate_drift"] = drift_response(status="not_onboarded")
    counts = await poll_once(SchedulerDb(client), now=AFTER)
    assert recorded_runs(client)[0][1]["p_outcome"] == "failed"
    assert counts["fired"] == 1


# ─── bookkeeping refusals ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_drift_run_refusal_is_counted_never_faked() -> None:
    client = FakeClient([due_schedule()])
    client.rpc_script["onboarding_estate_drift"] = drift_response()
    client.rpc_script["record_schedule_run"] = {"error": "schedule_not_active"}
    counts = await poll_once(SchedulerDb(client), now=AFTER)
    # The write was attempted and refused; the schedule stays due. It is
    # counted as refused, not reported fired.
    assert len(recorded_runs(client)) == 1
    assert counts["refused"] == 1
    assert counts["fired"] == 0


@pytest.mark.asyncio
async def test_rediscovery_run_refusal_is_counted_never_faked() -> None:
    client = FakeClient([due_schedule(kind="rediscovery")])
    client.rpc_script["onboarding_estate_drift"] = drift_response(status="no_baseline")
    client.rpc_script["record_schedule_run"] = {"error": "invalid_run"}
    counts = await poll_once(SchedulerDb(client), now=AFTER)
    assert len(recorded_runs(client)) == 1
    assert counts["refused"] == 1
    assert counts["fired"] == 0


@pytest.mark.asyncio
async def test_uncountable_cadence_refusal_is_counted_never_faked() -> None:
    client = FakeClient([due_schedule(cadence="99 * * * *")])
    client.rpc_script["record_schedule_run"] = {"error": "schedule_not_found"}
    counts = await poll_once(SchedulerDb(client), now=AFTER)
    assert counts["failed"] == 1
    assert counts["refused"] == 1
    assert counts["fired"] == 0


@pytest.mark.asyncio
async def test_database_unavailability_skips_the_pass() -> None:
    class Broken:
        def from_(self, _t: str) -> Any:
            raise SchedulerUnavailable()

    counts = await poll_once(SchedulerDb(Broken()), now=AFTER)
    assert counts == {
        "fired": 0,
        "drift_events": 0,
        "failed": 0,
        "refused": 0,
        "skipped": 0,
    }


def test_scheduler_db_fail_closed() -> None:
    class BrokenClient:
        def from_(self, _t: str) -> Any:
            raise RuntimeError("down")

    with pytest.raises(SchedulerUnavailable):
        SchedulerDb(BrokenClient()).due_schedules("2026-09-26T00:00:00+00:00")
