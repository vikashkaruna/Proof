"""W6 durable fire RPC and readback contracts; no database mutation in this suite."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any
from uuid import UUID

import pytest

from axiom.cron_next import CronSyntaxError, next_fire
from axiom.scheduler import SchedulerDb, poll_once

AFTER = datetime(2026, 9, 26, 10, 30, tzinfo=UTC)


def test_every_fifteen_minutes() -> None:
    assert next_fire("*/15 * * * *", AFTER) == AFTER.replace(minute=45)


def test_daily_at_three_uses_utc() -> None:
    assert next_fire("0 3 * * *", AFTER) == AFTER.replace(day=27, hour=3, minute=0)


def test_list_and_range_fields() -> None:
    # Hours 8-9 have passed at 10:30, so the next fire is tomorrow 08:05.
    assert next_fire("5,25 8-9 * * *", AFTER) == AFTER.replace(day=27, hour=8, minute=5)


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


FIRE = "fire_monitoring_schedule"
READ = "read_monitoring_schedule_fire"


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


def fire_reply(args: dict[str, Any], **overrides: Any) -> dict[str, Any]:
    cadence = args["p_expected_cadence"]
    try:
        if len(cadence) > 100:
            raise CronSyntaxError
        next_at = next_fire(cadence, AFTER)
        outcome = "no_drift" if args["p_expected_kind"] == "drift_check" else "unwired"
        failure = None if outcome == "no_drift" else "live_executor_unwired"
    except CronSyntaxError:
        next_at = AFTER + timedelta(days=1)
        outcome, failure = "failed", "cadence_invalid"
    body = {
        "tenantId": args["p_tenant_id"],
        "fireId": "44444444-4444-4444-8444-444444444444",
        "scheduleId": args["p_schedule_id"],
        "estateId": args["p_estate_id"],
        "kind": args["p_expected_kind"],
        "cadence": cadence,
        "dueAt": args["p_expected_due_at"],
        "calculationAfter": AFTER.isoformat(),
        "nextRunAt": next_at.isoformat(),
        "correlationId": args.get("p_correlation_id", "55555555-5555-4555-8555-555555555555"),
        "replayed": False,
        "observationOutcome": outcome,
        "recordingOutcome": "recorded" if failure is None else "failed",
        "failureCode": failure,
        "detectedCount": 0,
        "recordedCount": 0,
        "failedCount": 0,
        "scheduleReceipt": {"id": "103", "entryHash": "a" * 64},
        "eventReceipts": [],
    }
    body.update(overrides)
    return body


class FakeClient:
    def __init__(self, schedules: Any) -> None:
        self.schedules = schedules
        self.rpc_calls: list[tuple[str, dict[str, Any]]] = []
        self.rpc_script: dict[str, Any] = {}
        self.orders: list[str] = []

    def from_(self, table: str) -> Any:
        assert table == "monitoring_schedules"
        builder = self

        class Q:
            def select(self, columns: str) -> Q:
                assert columns == "id, tenant_id, estate_id, kind, cadence, next_run_at"
                return self

            def eq(self, column: str, value: Any) -> Q:
                assert (column, value) == ("status", "active")
                return self

            def lte(self, column: str, value: str) -> Q:
                assert column == "next_run_at"
                return self

            def order(self, column: str) -> Q:
                builder.orders.append(column)
                return self

            def limit(self, limit: int) -> Q:
                assert limit == 20
                return self

            def execute(self) -> Any:
                if isinstance(builder.schedules, Exception):
                    raise builder.schedules
                return SimpleNamespace(data=builder.schedules)

        return Q()

    def rpc(self, fn: str, args: dict[str, Any]) -> Any:
        self.rpc_calls.append((fn, args))

        def execute() -> Any:
            scripted = self.rpc_script.get(fn)
            if isinstance(scripted, list):
                scripted = scripted.pop(0)
            if isinstance(scripted, Exception):
                raise scripted
            if callable(scripted):
                scripted = scripted(args)
            if scripted is None and fn not in self.rpc_script:
                scripted = fire_reply(args) if fn == FIRE else {"missing": True}
            return SimpleNamespace(data=scripted)

        return SimpleNamespace(execute=execute)


def counts(**overrides: int) -> dict[str, int]:
    value = {
        "fired": 0,
        "drift_events": 0,
        "failed": 0,
        "refused": 0,
        "skipped": 0,
        "replayed": 0,
        "recovered": 0,
    }
    value.update(overrides)
    return value


@pytest.mark.asyncio
async def test_due_schedule_uses_only_transactional_fire_rpc() -> None:
    client = FakeClient([due_schedule()])
    actual = await poll_once(SchedulerDb(client), now=AFTER)
    assert actual == counts(fired=1)
    assert [fn for fn, _ in client.rpc_calls] == [FIRE]
    args = client.rpc_calls[0][1]
    assert set(args) == {
        "p_tenant_id",
        "p_schedule_id",
        "p_estate_id",
        "p_expected_kind",
        "p_expected_cadence",
        "p_expected_due_at",
        "p_correlation_id",
    }
    assert args["p_expected_due_at"] == due_schedule()["next_run_at"]
    assert UUID(args["p_correlation_id"])
    assert client.orders == ["next_run_at", "id"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "error",
    ["schedule_snapshot_changed", "schedule_not_found", "schedule_not_due", "fire_context_refused"],
)
async def test_stale_or_retired_snapshot_is_not_claimed_fired(error: str) -> None:
    client = FakeClient([due_schedule()])
    client.rpc_script[FIRE] = {"error": error}
    assert await poll_once(SchedulerDb(client), now=AFTER) == counts(skipped=1, refused=1)
    assert len(client.rpc_calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["rediscovery", "reassessment"])
async def test_live_executors_remain_honestly_unwired(kind: str) -> None:
    client = FakeClient([due_schedule(kind=kind)])
    assert await poll_once(SchedulerDb(client), now=AFTER) == counts(fired=1, failed=1)
    assert [fn for fn, _ in client.rpc_calls] == [FIRE]


@pytest.mark.asyncio
async def test_failed_event_transaction_preserves_detected_drift_and_zero_recorded() -> None:
    client = FakeClient([due_schedule()])
    client.rpc_script[FIRE] = lambda args: fire_reply(
        args,
        observationOutcome="drift_detected",
        recordingOutcome="failed",
        failureCode="event_recording_failed",
        detectedCount=3,
        recordedCount=0,
        failedCount=3,
        eventReceipts=[],
    )
    assert await poll_once(SchedulerDb(client), now=AFTER) == counts(fired=1, failed=1, refused=3)


@pytest.mark.asyncio
async def test_transport_loss_recovers_exact_own_fire_without_mutation_retry() -> None:
    client = FakeClient([due_schedule()])

    def lose_response(args: dict[str, Any]) -> Any:
        client.rpc_script[READ] = fire_reply(args, replayed=True)
        raise RuntimeError("response lost after commit")

    client.rpc_script[FIRE] = lose_response
    assert await poll_once(SchedulerDb(client), now=AFTER) == counts(fired=1, recovered=1)
    assert [fn for fn, _ in client.rpc_calls] == [FIRE, READ]
    assert "p_correlation_id" not in client.rpc_calls[1][1]


@pytest.mark.asyncio
async def test_transport_loss_readback_foreign_correlation_is_only_replay() -> None:
    client = FakeClient([due_schedule()])

    def lose_response(args: dict[str, Any]) -> Any:
        client.rpc_script[READ] = fire_reply(
            args, replayed=True, correlationId="77777777-7777-4777-8777-777777777777"
        )
        raise RuntimeError("concurrent fire won")

    client.rpc_script[FIRE] = lose_response
    assert await poll_once(SchedulerDb(client), now=AFTER) == counts(replayed=1)


@pytest.mark.asyncio
async def test_retained_replay_is_not_double_counted() -> None:
    client = FakeClient([due_schedule(), due_schedule()])
    client.rpc_script[FIRE] = [
        lambda args: fire_reply(args),
        lambda args: fire_reply(args, replayed=True),
    ]
    assert await poll_once(SchedulerDb(client), now=AFTER) == counts(fired=1, replayed=1)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "result", [{}, None, {"ok": True}, {"missing": True}, {"error": "invented"}]
)
async def test_missing_or_malformed_payload_cannot_infer_success(result: Any) -> None:
    client = FakeClient([due_schedule()])
    client.rpc_script[FIRE] = result
    assert await poll_once(SchedulerDb(client), now=AFTER) == counts(failed=1, refused=1)
    assert [fn for fn, _ in client.rpc_calls].count(FIRE) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("tenantId", "77777777-7777-4777-8777-777777777777"),
        ("scheduleId", "77777777-7777-4777-8777-777777777777"),
        ("estateId", "77777777-7777-4777-8777-777777777777"),
        ("kind", "reassessment"),
        ("cadence", "0 0 * * *"),
        ("dueAt", "2026-09-26T09:59:00+00:00"),
        ("nextRunAt", "2026-09-26T11:00:00+00:00"),
        ("correlationId", "77777777-7777-4777-8777-777777777777"),
        ("calculationAfter", "2026-09-26T09:59:00+00:00"),
        ("fireId", "bad"),
        ("replayed", 1),
        ("detectedCount", True),
        ("failedCount", -1),
        ("recordedCount", 1),
        ("scheduleReceipt", {"id": "0", "entryHash": "a" * 64}),
        ("scheduleReceipt", {"id": "103", "entryHash": "bad"}),
        ("extra", True),
    ],
)
async def test_strict_retained_bindings_and_proof_fields(field: str, value: Any) -> None:
    client = FakeClient([due_schedule()])
    client.rpc_script[FIRE] = lambda args: fire_reply(args, **{field: value})
    assert await poll_once(SchedulerDb(client), now=AFTER) == counts(failed=1, refused=1)


@pytest.mark.asyncio
async def test_bad_first_schedule_does_not_starve_next_due_schedule() -> None:
    client = FakeClient([due_schedule(), due_schedule(id="88888888-8888-4888-8888-888888888888")])
    client.rpc_script[FIRE] = [RuntimeError("unavailable"), lambda args: fire_reply(args)]
    assert await poll_once(SchedulerDb(client), now=AFTER) == counts(fired=1, failed=1, refused=1)
    assert [fn for fn, _ in client.rpc_calls] == [FIRE, READ, FIRE]


@pytest.mark.asyncio
@pytest.mark.parametrize("cadence", ["99 * * * *", "9" * 5000 + " * * * *"])
async def test_invalid_cadence_uses_only_confirmed_day_backoff(cadence: str) -> None:
    client = FakeClient([due_schedule(cadence=cadence)])
    assert await poll_once(SchedulerDb(client), now=AFTER) == counts(fired=1, failed=1)
    assert [fn for fn, _ in client.rpc_calls] == [FIRE]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "cadence",
    ["0 0 1-31 * 1", "0 0 */1 * 1", "0 0 1 * 0-6", "*/999999999999999999999 * * * *", "0 0 31 * *"],
)
async def test_retained_next_time_matches_existing_utc_cron_semantics(cadence: str) -> None:
    client = FakeClient([due_schedule(cadence=cadence)])
    assert await poll_once(SchedulerDb(client), now=AFTER) == counts(fired=1)


@pytest.mark.asyncio
async def test_calculation_after_preserves_subminute_precision() -> None:
    client = FakeClient([due_schedule(next_run_at="2026-09-26T10:30:15.123456+00:00")])
    server_after = AFTER.replace(second=16, microsecond=654321)
    client.rpc_script[FIRE] = lambda args: fire_reply(
        args,
        calculationAfter=server_after.isoformat(),
        nextRunAt=next_fire(args["p_expected_cadence"], server_after).isoformat(),
    )
    assert await poll_once(SchedulerDb(client), now=AFTER.replace(second=17)) == counts(fired=1)


@pytest.mark.asyncio
async def test_old_replay_does_not_compare_next_time_to_current_clock() -> None:
    client = FakeClient([due_schedule()])
    client.rpc_script[FIRE] = lambda args: fire_reply(args, replayed=True)
    assert await poll_once(SchedulerDb(client), now=AFTER + timedelta(days=30)) == counts(
        replayed=1
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "readback",
    [{"missing": True}, {"missing": True, "extra": False}, {}, None, RuntimeError("unavailable")],
)
async def test_uncertain_fire_is_not_retried_when_readback_unconfirmed(readback: Any) -> None:
    client = FakeClient([due_schedule()])
    client.rpc_script[FIRE] = RuntimeError("unknown commit outcome")
    client.rpc_script[READ] = readback
    assert await poll_once(SchedulerDb(client), now=AFTER) == counts(failed=1, refused=1)
    assert [fn for fn, _ in client.rpc_calls] == [FIRE, READ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "changes",
    [
        {"recordingOutcome": "failed"},
        {"failureCode": "probe_failed"},
        {
            "observationOutcome": "unwired",
            "recordingOutcome": "failed",
            "failureCode": "live_executor_unwired",
        },
        {
            "observationOutcome": "failed",
            "recordingOutcome": "recorded",
            "failureCode": "probe_failed",
        },
        {
            "observationOutcome": "failed",
            "recordingOutcome": "failed",
            "failureCode": "cadence_invalid",
        },
        {"observationOutcome": "drift_detected"},
        {"detectedCount": 2_147_483_648},
        {"recordingOutcome": []},
        {"observationOutcome": {}},
        {"calculationAfter": "bad"},
        {"scheduleReceipt": {"id": "9223372036854775808", "entryHash": "a" * 64}},
        {"scheduleReceipt": {"id": 103, "entryHash": "a" * 64}},
        {"scheduleReceipt": {"id": "103", "entryHash": "A" * 64}},
        {"scheduleReceipt": {"id": "103", "entryHash": "a" * 64, "extra": True}},
    ],
)
async def test_outcome_and_proof_contract_cannot_fabricate_completion(
    changes: dict[str, Any],
) -> None:
    client = FakeClient([due_schedule()])
    client.rpc_script[FIRE] = lambda args: fire_reply(args, **changes)
    assert await poll_once(SchedulerDb(client), now=AFTER) == counts(failed=1, refused=1)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "event",
    [
        None,
        {},
        {"eventId": "bad", "id": "101", "entryHash": "b" * 64},
        {"eventId": "66666666-6666-4666-8666-666666666666", "id": "103", "entryHash": "b" * 64},
        {"eventId": "66666666-6666-4666-8666-666666666666", "id": "0", "entryHash": "b" * 64},
        {"eventId": "66666666-6666-4666-8666-666666666666", "id": "101", "entryHash": "bad"},
    ],
)
async def test_event_receipts_must_precede_and_bind_counted_detection(event: Any) -> None:
    client = FakeClient([due_schedule()])
    client.rpc_script[FIRE] = lambda args: fire_reply(
        args,
        observationOutcome="drift_detected",
        detectedCount=1,
        recordedCount=1,
        eventReceipts=[event],
    )
    assert await poll_once(SchedulerDb(client), now=AFTER) == counts(failed=1, refused=1)


@pytest.mark.asyncio
async def test_same_event_or_ledger_receipt_is_not_counted_twice() -> None:
    client = FakeClient([due_schedule()])
    event = {"eventId": "66666666-6666-4666-8666-666666666666", "id": "101", "entryHash": "b" * 64}
    client.rpc_script[FIRE] = lambda args: fire_reply(
        args,
        observationOutcome="drift_detected",
        detectedCount=2,
        recordedCount=2,
        eventReceipts=[event, event],
    )
    assert await poll_once(SchedulerDb(client), now=AFTER) == counts(failed=1, refused=1)


@pytest.mark.asyncio
async def test_recorded_detection_metrics_come_from_confirmed_receipts() -> None:
    client = FakeClient([due_schedule()])
    events = [
        {"eventId": "66666666-6666-4666-8666-666666666666", "id": "101", "entryHash": "b" * 64},
        {"eventId": "77777777-7777-4777-8777-777777777777", "id": "102", "entryHash": "c" * 64},
    ]
    client.rpc_script[FIRE] = lambda args: fire_reply(
        args,
        observationOutcome="drift_detected",
        detectedCount=2,
        recordedCount=2,
        eventReceipts=events,
    )
    assert await poll_once(SchedulerDb(client), now=AFTER) == counts(fired=1, drift_events=2)


@pytest.mark.asyncio
async def test_positive_partial_claim_is_impossible_under_atomic_sql_contract() -> None:
    client = FakeClient([due_schedule()])
    client.rpc_script[FIRE] = lambda args: fire_reply(
        args,
        observationOutcome="drift_detected",
        recordingOutcome="failed",
        failureCode="event_recording_failed",
        detectedCount=2,
        recordedCount=1,
        failedCount=1,
        eventReceipts=[
            {"eventId": "66666666-6666-4666-8666-666666666666", "id": "101", "entryHash": "b" * 64}
        ],
    )
    assert await poll_once(SchedulerDb(client), now=AFTER) == counts(failed=1, refused=1)


@pytest.mark.asyncio
@pytest.mark.parametrize("probe_code", ["probe_invalid", "probe_failed"])
async def test_confirmed_failed_probe_is_counted_as_failed_fire(probe_code: str) -> None:
    client = FakeClient([due_schedule()])
    client.rpc_script[FIRE] = lambda args: fire_reply(
        args, observationOutcome="failed", recordingOutcome="failed", failureCode=probe_code
    )
    assert await poll_once(SchedulerDb(client), now=AFTER) == counts(fired=1, failed=1)


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["drift_check", "rediscovery", "reassessment"])
async def test_no_baseline_is_a_confirmed_honest_state(kind: str) -> None:
    client = FakeClient([due_schedule(kind=kind)])
    client.rpc_script[FIRE] = lambda args: fire_reply(
        args, observationOutcome="no_baseline", recordingOutcome="recorded", failureCode=None
    )
    assert await poll_once(SchedulerDb(client), now=AFTER) == counts(fired=1)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "row",
    [
        None,
        {},
        "bad",
        due_schedule(id="bad"),
        due_schedule(tenant_id=None),
        due_schedule(estate_id=123),
        due_schedule(cadence=None),
        due_schedule(kind=[]),
        due_schedule(next_run_at=None),
        due_schedule(next_run_at="bad"),
        due_schedule(next_run_at="2026-09-26T10:00:00"),
        due_schedule(next_run_at="2026-09-26T11:00:00+00:00"),
        {**due_schedule(), "extra": True},
    ],
)
async def test_malformed_due_row_has_no_writes_and_later_row_runs(row: Any) -> None:
    client = FakeClient([row, due_schedule()])
    assert await poll_once(SchedulerDb(client), now=AFTER) == counts(fired=1, failed=1, skipped=1)
    assert [fn for fn, _ in client.rpc_calls] == [FIRE]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "data", [None, {}, "bad", [due_schedule()] * 21, RuntimeError("unavailable")]
)
async def test_untrusted_due_collection_is_not_a_clean_pass(data: Any) -> None:
    client = FakeClient(data)
    assert await poll_once(SchedulerDb(client), now=AFTER) == counts(failed=1)
    assert client.rpc_calls == []


@pytest.mark.asyncio
async def test_empty_due_collection_remains_empty_pass() -> None:
    client = FakeClient([])
    assert await poll_once(SchedulerDb(client), now=AFTER) == counts()
    assert client.rpc_calls == []


@pytest.mark.asyncio
async def test_unsupported_kind_is_not_dispatched() -> None:
    client = FakeClient([due_schedule(kind="future_unknown")])
    assert await poll_once(SchedulerDb(client), now=AFTER) == counts(skipped=1)
    assert client.rpc_calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize("counts_value", [counts(fired=1), counts(), None])
async def test_loop_preserves_minimum_interval_and_cancellation(
    monkeypatch: pytest.MonkeyPatch, counts_value: dict[str, int] | None
) -> None:
    import asyncio

    import axiom.scheduler as scheduler
    from axiom.scheduler import SchedulerUnavailable

    async def poll(db: SchedulerDb) -> dict[str, int]:
        if counts_value is None:
            raise SchedulerUnavailable
        return counts_value

    intervals = []

    async def sleep(seconds: int) -> None:
        intervals.append(seconds)
        raise asyncio.CancelledError

    monkeypatch.setattr(scheduler, "poll_once", poll)
    monkeypatch.setattr(scheduler.asyncio, "sleep", sleep)
    with pytest.raises(asyncio.CancelledError):
        await scheduler.scheduler_loop(SchedulerDb(FakeClient([])), 1)
    assert intervals == [30]


@pytest.mark.asyncio
async def test_recovery_without_replayed_flag_is_not_authoritative_retained_reply() -> None:
    client = FakeClient([due_schedule()])

    def lose_response(args: dict[str, Any]) -> Any:
        client.rpc_script[READ] = fire_reply(args)  # A readback must identify its retained nature.
        raise RuntimeError("lost response")

    client.rpc_script[FIRE] = lose_response
    assert await poll_once(SchedulerDb(client), now=AFTER) == counts(failed=1, refused=1)
    assert [fn for fn, _ in client.rpc_calls] == [FIRE, READ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "changes",
    [
        {
            "observationOutcome": "drift_detected",
            "detectedCount": 1,
            "recordedCount": 1,
            "eventReceipts": [
                {
                    "eventId": "66666666-6666-4666-8666-666666666666",
                    "id": "101",
                    "entryHash": "b" * 64,
                }
            ],
        },
        {
            "observationOutcome": "failed",
            "recordingOutcome": "failed",
            "failureCode": "probe_failed",
        },
    ],
)
async def test_live_executor_cannot_claim_detected_drift_or_clean_success(
    changes: dict[str, Any],
) -> None:
    client = FakeClient([due_schedule(kind="reassessment")])
    # Failed probe is legitimate even for an unwired executor; detected events are not.
    client.rpc_script[FIRE] = lambda args: fire_reply(args, **changes)
    expected = (
        counts(fired=1, failed=1)
        if changes["observationOutcome"] == "failed"
        else counts(failed=1, refused=1)
    )
    assert await poll_once(SchedulerDb(client), now=AFTER) == expected


@pytest.mark.asyncio
async def test_serialized_offsets_are_normalized_for_utc_cron_verification() -> None:
    client = FakeClient(
        [due_schedule(cadence="0 3 * * *", next_run_at="2026-09-26T15:30:00+05:30")]
    )
    client.rpc_script[FIRE] = lambda args: fire_reply(
        args,
        dueAt="2026-09-26T10:00:00Z",
        calculationAfter="2026-09-26T16:00:00+05:30",
        nextRunAt="2026-09-27T08:30:00+05:30",
    )
    assert await poll_once(SchedulerDb(client), now=AFTER) == counts(fired=1)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "changes",
    [
        {"fireId": "00000000-0000-0000-0000-000000000000"},
        {"correlationId": "00000000-0000-0000-0000-000000000000"},
        {"detectedCount": 2001},
        {
            "observationOutcome": "drift_detected",
            "recordedCount": 2,
            "detectedCount": 2,
            "eventReceipts": [
                {
                    "eventId": "66666666-6666-4666-8666-666666666666",
                    "id": "102",
                    "entryHash": "b" * 64,
                },
                {
                    "eventId": "77777777-7777-4777-8777-777777777777",
                    "id": "101",
                    "entryHash": "c" * 64,
                },
            ],
        },
    ],
)
async def test_sql_bounds_and_receipt_order_are_enforced(changes: dict[str, Any]) -> None:
    client = FakeClient([due_schedule()])
    client.rpc_script[FIRE] = lambda args: fire_reply(args, **changes)
    assert await poll_once(SchedulerDb(client), now=AFTER) == counts(failed=1, refused=1)


@pytest.mark.asyncio
@pytest.mark.parametrize("calculated", ["9999-12-30T10:00:00Z", "0001-01-01T00:00:00+05:30"])
async def test_extreme_timestamp_refused_without_starving_other_schedules(calculated: str) -> None:
    client = FakeClient([due_schedule(), due_schedule(id="88888888-8888-4888-8888-888888888888")])
    client.rpc_script[FIRE] = [
        lambda args: fire_reply(
            args, calculationAfter=calculated, nextRunAt="9999-12-31T10:00:00Z"
        ),
        lambda args: fire_reply(args),
    ]
    assert await poll_once(SchedulerDb(client), now=AFTER) == counts(fired=1, failed=1, refused=1)
