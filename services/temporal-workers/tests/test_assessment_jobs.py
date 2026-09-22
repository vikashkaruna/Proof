"""Real Temporal histories/replay with explicitly synthetic controller activities."""

import asyncio
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from temporal_workers import assessment_activity
from temporal_workers.assessment_activity import AssessmentControllerActivity
from temporal_workers.assessment_jobs import (
    TASK_QUEUE,
    AssessmentJobWorkflow,
    start_assessment_job,
)
from temporalio import activity
from temporalio.exceptions import ApplicationError
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Replayer, Worker


def reference():
    return {"tenantId": str(uuid4()), "jobId": str(uuid4())}


def confirmed(job, cleanup=True):
    return {
        **job,
        "status": "confirmed",
        "runId": str(uuid4()),
        "receipt": "10",
        "resultDigest": "a" * 64,
        "cleanupConfirmed": cleanup,
    }


class SyntheticController:
    def __init__(self, fault=None):
        self.calls = []
        self.fault = fault
        self.run_id = str(uuid4())

    @activity.defn(name="assessment_controller_v1")
    async def invoke(self, job: dict, operation: str) -> dict:
        self.calls.append(operation)
        if self.fault == "loss" and operation == "run":
            raise ApplicationError("assessment_unconfirmed", non_retryable=True)
        if self.fault == "missing":
            return {
                **job,
                "status": "unconfirmed",
                "cleanupConfirmed": False if operation == "run" else None,
            }
        if self.fault == "run_binding" and operation == "run":
            return {
                **job,
                "status": "unconfirmed",
                "runId": self.run_id,
                "cleanupConfirmed": True,
            }
        result = confirmed(job, True if operation == "run" else None)
        if self.fault == "binding":
            result["tenantId"] = str(uuid4())
        if self.fault == "private":
            result["input"] = "synthetic-private-marker"
        return result


@pytest_asyncio.fixture
async def server():
    async with await WorkflowEnvironment.start_time_skipping() as env:
        yield env


@pytest.mark.parametrize(
    "fault", [None, "loss", "missing", "binding", "private", "run_binding"]
)
async def test_real_workflow_bounded_reconciliation_and_replay(server, fault):
    controller, job = SyntheticController(fault), reference()
    async with Worker(
        server.client,
        task_queue=TASK_QUEUE,
        workflows=[AssessmentJobWorkflow],
        activities=[controller.invoke],
    ):
        handle = await start_assessment_job(
            server.client, job["tenantId"], job["jobId"]
        )
        result = await asyncio.wait_for(handle.result(), 30)
        # Repeated scheduling recovers the same completed execution, never creates another.
        again = await start_assessment_job(server.client, job["tenantId"], job["jobId"])
        assert again.id == handle.id and await again.result() == result
        history = await handle.fetch_history()
    await Replayer(workflows=[AssessmentJobWorkflow]).replay_workflow(history)
    assert controller.calls == (
        ["run"]
        if fault is None
        else ["run", "reconcile"]
        if fault == "loss"
        else ["run", "reconcile", "reconcile", "reconcile"]
    )
    assert result["status"] == (
        "confirmed" if fault in (None, "loss") else "unconfirmed"
    )
    if fault == "missing":
        assert result["cleanupConfirmed"] is False
    assert "input" not in result


async def test_producer_validates_before_any_history_submission():
    client = AsyncMock()
    with pytest.raises(ValueError, match="Invalid assessment reference") as caught:
        await start_assessment_job(client, "synthetic-private-marker", str(uuid4()))
    assert caught.value.__context__ is None
    client.start_workflow.assert_not_called()


async def test_pending_opaque_launch_survives_worker_restart_once(server):
    job, controller = reference(), SyntheticController()
    async with Worker(
        server.client,
        task_queue=TASK_QUEUE,
        workflows=[AssessmentJobWorkflow],
        max_cached_workflows=0,
    ):
        handle = await start_assessment_job(
            server.client, job["tenantId"], job["jobId"]
        )

        async def scheduled():
            while not any(
                e.HasField("activity_task_scheduled_event_attributes")
                for e in (await handle.fetch_history()).events
            ):
                await asyncio.sleep(0.05)

        await asyncio.wait_for(scheduled(), 15)
        again = await start_assessment_job(server.client, job["tenantId"], job["jobId"])
        assert again.id == handle.id
    async with Worker(
        server.client,
        task_queue=TASK_QUEUE,
        workflows=[AssessmentJobWorkflow],
        activities=[controller.invoke],
    ):
        assert (await asyncio.wait_for(handle.result(), 30))["status"] == "confirmed"
        history = await handle.fetch_history()
    assert controller.calls == ["run"]
    await Replayer(workflows=[AssessmentJobWorkflow]).replay_workflow(history)


@pytest.mark.parametrize(
    "fault",
    [
        "redirect",
        "status",
        "timeout",
        "json",
        "oversize",
        "binding",
        "private",
        "contradiction",
    ],
)
async def test_private_activity_sanitizes_errors_and_does_not_retry(monkeypatch, fault):
    job, calls = reference(), []

    def respond(request):
        calls.append(request)
        if fault == "redirect":
            return httpx.Response(307, headers={"location": "http://external.invalid"})
        if fault == "status":
            return httpx.Response(500, text="synthetic-private-marker")
        if fault == "timeout":
            raise httpx.ReadTimeout("synthetic-private-marker")
        if fault == "json":
            return httpx.Response(200, text="synthetic-private-marker")
        if fault == "oversize":
            return httpx.Response(200, content=b"x" * 4097)
        result = confirmed(job)
        if fault == "binding":
            result["jobId"] = str(uuid4())
        if fault == "private":
            result["input"] = "synthetic-private-marker"
        if fault == "contradiction":
            result["status"] = "unconfirmed"
        return httpx.Response(200, json=result)

    monkeypatch.setattr(
        AssessmentControllerActivity, "validate_socket", lambda self: None
    )
    monkeypatch.setattr(
        assessment_activity.httpx,
        "AsyncHTTPTransport",
        lambda **_kwargs: httpx.MockTransport(respond),
    )
    with pytest.raises(ApplicationError) as caught:
        await AssessmentControllerActivity("/tmp/synthetic-controller.sock", 0).invoke(
            job, "run"
        )
    assert str(caught.value) == "assessment_unconfirmed: assessment_unconfirmed"
    assert (
        caught.value.__context__ is None
        and caught.value.__cause__ is None
        and caught.value.non_retryable
    )
    assert len(calls) == 1


async def test_real_activity_failure_history_has_no_private_cause(server, monkeypatch):
    monkeypatch.setattr(
        AssessmentControllerActivity, "validate_socket", lambda self: None
    )
    monkeypatch.setattr(
        assessment_activity.httpx,
        "AsyncHTTPTransport",
        lambda **_kwargs: httpx.MockTransport(
            lambda _request: httpx.Response(500, text="synthetic-private-marker")
        ),
    )
    controller, job = (
        AssessmentControllerActivity("/tmp/synthetic-controller.sock", 0),
        reference(),
    )
    async with Worker(
        server.client,
        task_queue=TASK_QUEUE,
        workflows=[AssessmentJobWorkflow],
        activities=[controller.invoke],
    ):
        handle = await start_assessment_job(
            server.client, job["tenantId"], job["jobId"]
        )
        assert (await asyncio.wait_for(handle.result(), 30))["status"] == "unconfirmed"
        history = await handle.fetch_history()
    failures = [
        e.activity_task_failed_event_attributes.failure
        for e in history.events
        if e.HasField("activity_task_failed_event_attributes")
    ]
    assert len(failures) == 4
    assert all(
        e.message == "assessment_unconfirmed" and not e.HasField("cause")
        for e in failures
    )
    for event in history.events:
        raw = event.SerializeToString()
        assert (
            b"synthetic-private-marker" not in raw
            and b"synthetic-controller.sock" not in raw
        )
    await Replayer(workflows=[AssessmentJobWorkflow]).replay_workflow(history)


@pytest.mark.parametrize("enabled", [False, True])
async def test_service_worker_registers_private_queue_only_when_explicit(
    monkeypatch, enabled
):
    from temporal_workers import worker

    calls = []
    monkeypatch.setattr(
        worker, "Worker", lambda client, **options: calls.append(options)
    )
    worker.build_workers(
        object(),
        AssessmentControllerActivity("/tmp/controller.sock", 0) if enabled else None,
    )
    assert [c["task_queue"] for c in calls] == (
        [TASK_QUEUE] if enabled else ["axiom-compliance-v2"]
    )


async def test_real_activity_timeout_only_schedules_confirmation(server):
    started, release, calls = asyncio.Event(), asyncio.Event(), []

    @activity.defn(name="assessment_controller_v1")
    async def invoke(job: dict, operation: str) -> dict:
        calls.append(operation)
        if operation == "run":
            started.set()
            await release.wait()
        return confirmed(job, None)

    job = reference()
    async with Worker(
        server.client,
        task_queue=TASK_QUEUE,
        workflows=[AssessmentJobWorkflow],
        activities=[invoke],
    ):
        handle = await start_assessment_job(
            server.client, job["tenantId"], job["jobId"]
        )
        pending = asyncio.create_task(handle.result())
        await asyncio.wait_for(started.wait(), 15)
        await server.sleep(95)
        release.set()
        result = await asyncio.wait_for(pending, 30)
        assert result["status"] == "confirmed" and calls == ["run", "reconcile"]
        history = await handle.fetch_history()
    assert any(
        e.HasField("activity_task_timed_out_event_attributes") for e in history.events
    )
    await Replayer(workflows=[AssessmentJobWorkflow]).replay_workflow(history)


async def test_cancellation_does_not_reconcile_or_create_replacement(server):
    from temporalio.client import WorkflowFailureError

    started, release, calls = asyncio.Event(), asyncio.Event(), []

    @activity.defn(name="assessment_controller_v1")
    async def invoke(job: dict, operation: str) -> dict:
        calls.append(operation)
        started.set()
        await release.wait()
        return confirmed(job)

    job = reference()
    async with Worker(
        server.client,
        task_queue=TASK_QUEUE,
        workflows=[AssessmentJobWorkflow],
        activities=[invoke],
    ):
        handle = await start_assessment_job(
            server.client, job["tenantId"], job["jobId"]
        )
        await asyncio.wait_for(started.wait(), 15)
        await handle.cancel()
        with pytest.raises(WorkflowFailureError):
            await asyncio.wait_for(handle.result(), 15)
        again = await start_assessment_job(server.client, job["tenantId"], job["jobId"])
        assert again.id == handle.id
        release.set()
        assert calls == ["run"]
        history = await handle.fetch_history()
    await Replayer(workflows=[AssessmentJobWorkflow]).replay_workflow(history)


@pytest.mark.parametrize(
    "fault", [None, "owner", "socket_mode", "directory_mode", "symlink", "not_socket"]
)
async def test_activity_checks_actual_socket_owner_and_permissions(fault):
    import os
    import socket
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory(prefix="ax-socket-", dir="/tmp") as temporary:
        directory = Path(temporary).resolve()
        path = directory / "controller.sock"
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
            listener.bind(str(path))
            directory.chmod(0o710)
            path.chmod(0o660)
            owner = os.getuid()
            if fault == "owner":
                owner += 1
            if fault == "socket_mode":
                path.chmod(0o666)
            if fault == "directory_mode":
                directory.chmod(0o777)
            if fault == "symlink":
                alias = directory / "alias.sock"
                alias.symlink_to(path)
                path = alias
            if fault == "not_socket":
                path.unlink()
                path.write_text("synthetic")
                path.chmod(0o660)
            controller = AssessmentControllerActivity(str(path), owner)
            if fault is None:
                controller.validate_socket()
            else:
                with pytest.raises(ValueError):
                    controller.validate_socket()
