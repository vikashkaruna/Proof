"""Producer restarts, lost acknowledgements and lookup-only recovery."""

import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from temporal_workers import assessment_outbox
from temporal_workers.assessment_jobs import TASK_QUEUE, WORKFLOW_TYPE
from temporal_workers.assessment_outbox import AssessmentOutboxPump


def ticket():
    tenant, job = str(uuid4()), str(uuid4())
    return {
        "tenantId": tenant,
        "jobId": job,
        "namespace": "default",
        "workflowId": f"assessment-{tenant}-{job}",
        "leaseId": str(uuid4()),
        "leaseUntil": (datetime.now(UTC) + timedelta(minutes=3)).isoformat(),
        "startBefore": (datetime.now(UTC) + timedelta(minutes=10)).isoformat(),
    }


def fixture(monkeypatch, value=None, fault=None):
    value = ticket() if value is None else value
    handle = SimpleNamespace(
        id=value["workflowId"],
        describe=AsyncMock(
            return_value=SimpleNamespace(
                workflow_type=WORKFLOW_TYPE, task_queue=TASK_QUEUE, run_id=str(uuid4())
            )
        ),
    )
    start, find = AsyncMock(return_value=handle), AsyncMock(return_value=handle)
    monkeypatch.setattr(assessment_outbox, "start_assessment_job", start)
    monkeypatch.setattr(assessment_outbox, "find_assessment_job", find)

    async def respond(operation, payload):
        if operation == "scheduling/poll":
            return {"jobs": [value]}
        if fault == "lost_ack":
            raise ValueError("synthetic-private-marker")
        reply = {k: v for k, v in payload.items() if k != "leaseId"} | {"receipt": "12"}
        if fault == "mismatch":
            reply["workflowRunId"] = str(uuid4())
        if fault == "private":
            reply["input"] = "synthetic-private-marker"
        return reply

    control = SimpleNamespace(request=AsyncMock(side_effect=respond))
    pump = AssessmentOutboxPump(SimpleNamespace(namespace="default"), control)
    return pump, start, find, handle


async def test_submission_acknowledges_only_opaque_bound_execution(monkeypatch):
    pump, start, find, _ = fixture(monkeypatch)
    assert await pump.tick() == {"reserved": 1, "acknowledged": 1, "unconfirmed": 0}
    start.assert_awaited_once()
    find.assert_not_called()
    operation, payload = pump.controller.request.call_args.args
    assert operation == "scheduling/ack"
    assert set(payload) == {
        "tenantId",
        "jobId",
        "leaseId",
        "namespace",
        "workflowId",
        "workflowRunId",
    }


@pytest.mark.parametrize("deadline", [None, "2000-01-01T00:00:00Z"])
async def test_expired_authority_never_starts_new_work(monkeypatch, deadline):
    value = ticket() | {"startBefore": deadline}
    pump, start, find, _ = fixture(monkeypatch, value)
    assert (await pump.tick())["acknowledged"] == 1
    start.assert_not_called()
    find.assert_awaited_once()
    find.side_effect = ValueError("workflow missing")
    assert (await pump.tick())["unconfirmed"] == 1
    start.assert_not_called()


@pytest.mark.parametrize(
    "change",
    [
        {"namespace": "wrong"},
        {"jobId": str(uuid4())},
        {"input": "synthetic-private-marker"},
        {"leaseUntil": "2000-01-01T00:00:00Z"},
        {"leaseUntil": "2099-01-01T00:00:00"},
    ],
)
async def test_bad_ticket_never_reaches_temporal(monkeypatch, change):
    pump, start, find, _ = fixture(monkeypatch, ticket() | change)
    assert await pump.tick() == {"reserved": 0, "acknowledged": 0, "unconfirmed": 1}
    start.assert_not_called()
    find.assert_not_called()
    pump.controller.request.assert_awaited_once()


@pytest.mark.parametrize("fault", ["lost_ack", "mismatch", "private"])
async def test_uncertain_ack_is_not_success_and_has_no_eager_retry(monkeypatch, fault):
    pump, start, _, _ = fixture(monkeypatch, fault=fault)
    assert await pump.tick() == {"reserved": 1, "acknowledged": 0, "unconfirmed": 1}
    start.assert_awaited_once()
    assert pump.controller.request.await_count == 2


@pytest.mark.parametrize("field", ["workflow_type", "task_queue", "run_id"])
async def test_changed_execution_receipt_cannot_be_acknowledged(monkeypatch, field):
    pump, _, _, handle = fixture(monkeypatch)
    setattr(handle.describe.return_value, field, "invalid")
    assert (await pump.tick())["unconfirmed"] == 1
    pump.controller.request.assert_awaited_once()


async def test_cancellation_propagates_without_retry(monkeypatch):
    pump, start, _, _ = fixture(monkeypatch)
    start.side_effect = asyncio.CancelledError()
    with pytest.raises(asyncio.CancelledError):
        await pump.tick()
    pump.controller.request.assert_awaited_once()


async def test_pump_requires_private_configuration_before_connecting():
    from temporal_workers.worker import run_worker_loop

    with pytest.raises(ValueError, match="requires private"):
        await run_worker_loop("unused", "default", None, False, outbox_pump=True)


@pytest.mark.parametrize("enabled", [False, True])
async def test_worker_loop_starts_pickup_only_when_enabled_and_cancels_it(
    monkeypatch, enabled
):
    from temporal_workers import worker

    started, stopped, pump_started, pump_stopped = (
        asyncio.Event(),
        asyncio.Event(),
        asyncio.Event(),
        asyncio.Event(),
    )

    async def run_worker():
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    async def run_pump():
        pump_started.set()
        try:
            await asyncio.Event().wait()
        finally:
            pump_stopped.set()

    monkeypatch.setattr(worker.Client, "connect", AsyncMock(return_value=object()))
    monkeypatch.setattr(
        worker, "build_workers", lambda *_: [SimpleNamespace(run=run_worker)]
    )
    monkeypatch.setattr(worker.AssessmentOutboxPump, "run", lambda _: run_pump())
    task = asyncio.create_task(
        worker.run_worker_loop("unused", "default", None, False, object(), enabled)
    )
    await asyncio.wait_for(started.wait(), 1)
    if enabled:
        await asyncio.wait_for(pump_started.wait(), 1)
    task.cancel()
    await asyncio.wait_for(task, 1)
    assert stopped.is_set()
    assert pump_started.is_set() is enabled
    assert pump_stopped.is_set() is enabled
