"""Real Temporal server/history/replay, with explicitly synthetic agent activities."""

from __future__ import annotations

import asyncio
from uuid import uuid4

import pytest
import pytest_asyncio
from temporal_workers.workflows import ComplianceEngagementWorkflow
from temporalio import activity
from temporalio.client import WorkflowFailureError
from temporalio.exceptions import ApplicationError
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Replayer, Worker

AGENTS = ("drishti", "vibhaag", "parikshan", "sudhaar")


def assignment():
    return {
        "tenant_id": str(uuid4()),
        "engagement_id": str(uuid4()),
        "library_version": "fixture@1",
        "answers": {"fixture": {"present": True}},
    }


def response(agent, correlation):
    outputs = {
        "drishti": {
            "inventory": [{"name": "synthetic"}],
            "needs_live_connector": False,
        },
        "vibhaag": {"classifications": []},
        "parikshan": {
            "findings": [],
            "library_version": "fixture@1",
            "posture_score": 0,
            "estimated_exposure_inr": 0,
        },
        "sudhaar": {"actions": []},
    }
    return {
        "agent": agent,
        "correlation_id": correlation,
        "status": "succeeded",
        "latency_ms": 1,
        "input_tokens": 0,
        "output_tokens": 0,
        "cost_usd": 0,
        "error": None,
        "output": outputs[agent],
        "ledger_entry_ids": ["fixture-start", "fixture-end"],
    }


class SyntheticRuntime:
    def __init__(self, stage=None, fault=None):
        self.calls = []
        self.stage, self.fault = stage, fault

    @activity.defn(name="call_agent_runtime")
    async def invoke(self, agent: str, payload: dict, correlation: str) -> dict:
        self.calls.append((agent, payload, correlation))
        result = response(agent, correlation)
        if agent == self.stage:
            if self.fault == "failed":
                result.update(
                    status="failed", output=None, error="private runtime detail"
                )
            elif self.fault == "malformed":
                result["output"] = {}
            elif self.fault == "binding":
                result["correlation_id"] = str(uuid4())
            elif self.fault == "transport":
                raise ApplicationError(
                    "agent_invocation_unconfirmed", non_retryable=True
                )
            elif self.fault == "escalation":
                result["output"]["escalate"] = True
            elif self.fault == "connector":
                result["output"]["needs_live_connector"] = True
        return result


@pytest_asyncio.fixture
async def server():
    async with await WorkflowEnvironment.start_time_skipping() as env:
        yield env


async def run(server, runtime, data=None):
    queue = f"fixture-{uuid4()}"
    async with Worker(
        server.client,
        task_queue=queue,
        workflows=[ComplianceEngagementWorkflow],
        activities=[runtime.invoke],
    ):
        handle = await server.client.start_workflow(
            ComplianceEngagementWorkflow.run,
            assignment() if data is None else data,
            id=str(uuid4()),
            task_queue=queue,
        )
        result = await asyncio.wait_for(handle.result(), 30)
        history = await handle.fetch_history()
    await Replayer(workflows=[ComplianceEngagementWorkflow]).replay_workflow(history)
    return result, history


async def test_actual_server_computation_frontier_and_deterministic_replay(server):
    data, runtime = assignment(), SyntheticRuntime()
    result, _ = await run(server, runtime, data)
    assert result["status"] == "plan_persistence_required"
    assert result["stages"] == dict.fromkeys(AGENTS, "computed")
    assert result["assessment"]["posture_score"] == 0
    assert result["proposal"] == {"actions": []}
    assert [row[0] for row in runtime.calls] == list(AGENTS)
    assert {row[2] for row in runtime.calls} == {result["correlation_id"]}
    assert all(
        row[1]["tenant_id"] == data["tenant_id"]
        and row[1]["engagement_id"] == data["engagement_id"]
        for row in runtime.calls
    )
    assert runtime.calls[1][1]["inventory"] == [{"name": "synthetic"}]
    assert runtime.calls[2][1]["library_version"] == data["library_version"]
    assert runtime.calls[2][1]["answers"] == data["answers"]


@pytest.mark.parametrize("stage", AGENTS)
@pytest.mark.parametrize("fault", ["failed", "malformed", "binding", "transport"])
async def test_failure_stops_later_stages_without_retry_and_replays(
    server, stage, fault
):
    runtime = SyntheticRuntime(stage, fault)
    result, _ = await run(server, runtime)
    assert result["status"] == ("failed" if fault == "failed" else "unconfirmed")
    assert result["stage"] == stage
    assert [row[0] for row in runtime.calls] == list(AGENTS[: AGENTS.index(stage) + 1])
    assert "private runtime detail" not in str(result)
    assert "proposal" not in result


@pytest.mark.parametrize("stage", AGENTS)
async def test_escalation_handoff_stops_later_stages(server, stage):
    runtime = SyntheticRuntime(stage, "escalation")
    result, _ = await run(server, runtime)
    assert result["status"] == "review_required"
    assert result["code"] == "agent_escalated"
    assert len(runtime.calls) == AGENTS.index(stage) + 1


async def test_live_connector_requires_review(server):
    runtime = SyntheticRuntime("drishti", "connector")
    result, _ = await run(server, runtime)
    assert result["code"] == "live_connector_required"
    assert len(runtime.calls) == 1


@pytest.mark.parametrize(
    "change", ["missing_version", "invalid_tenant", "extra_authority"]
)
async def test_invalid_assignment_never_dispatches(server, change):
    data, runtime = assignment(), SyntheticRuntime()
    if change == "missing_version":
        del data["library_version"]
    elif change == "invalid_tenant":
        data["tenant_id"] = "private-invalid-input"
    else:
        data["approval_token"] = "private-invalid-input"
    with pytest.raises(WorkflowFailureError) as caught:
        await run(server, runtime, data)
    assert caught.value.cause.type == "invalid_engagement_input"
    assert "private-invalid-input" not in str(caught.value.cause)
    assert runtime.calls == []


async def test_pending_activity_survives_worker_restart_once_then_history_replays(
    server,
):
    queue, runtime, data = f"restart-{uuid4()}", SyntheticRuntime(), assignment()
    # First worker can schedule workflows but deliberately has no activity poller.
    # Disable its cache so the test server does not retain sticky routing to a
    # departed worker. This tests durable rescheduling, not sticky-cache expiry.
    async with Worker(
        server.client,
        task_queue=queue,
        workflows=[ComplianceEngagementWorkflow],
        max_cached_workflows=0,
    ):
        handle = await server.client.start_workflow(
            ComplianceEngagementWorkflow.run, data, id=str(uuid4()), task_queue=queue
        )

        async def scheduled():
            while True:
                history = await handle.fetch_history()
                if any(
                    e.HasField("activity_task_scheduled_event_attributes")
                    for e in history.events
                ):
                    return
                await asyncio.sleep(0.05)

        await asyncio.wait_for(scheduled(), 15)
        assert (await handle.query(ComplianceEngagementWorkflow.status))[
            "stage"
        ] == "drishti"
        assert runtime.calls == []
    # New worker instance processes the durable pending command, then the rest.
    async with Worker(
        server.client,
        task_queue=queue,
        workflows=[ComplianceEngagementWorkflow],
        activities=[runtime.invoke],
    ):
        result = await asyncio.wait_for(handle.result(), 30)
        history = await handle.fetch_history()
    assert result["status"] == "plan_persistence_required"
    assert [row[0] for row in runtime.calls] == list(AGENTS)
    await Replayer(workflows=[ComplianceEngagementWorkflow]).replay_workflow(history)


@pytest.mark.parametrize("refused", [False, True])
async def test_real_activity_http_boundary_and_sanitized_history(
    server, monkeypatch, refused
):
    """Real SDK activity execution, synthetic HTTP only; secrets stay out of history."""
    import json
    from types import SimpleNamespace

    import httpx
    from temporal_workers import activities
    from temporal_workers.config import Settings

    calls = []
    client = httpx.AsyncClient

    def handler(request):
        calls.append(request.url.path)
        assert request.headers["X-Internal-Token"] == "synthetic-history-secret"
        if refused:
            return httpx.Response(500, text="synthetic-private-failure-body")
        body = json.loads(request.content)
        agent = request.url.path.split("/")[2]
        return httpx.Response(200, json=response(agent, body["correlation_id"]))

    monkeypatch.setattr(
        activities,
        "get_settings",
        lambda: Settings(
            environment="test",
            agent_runtime_url="http://synthetic.invalid",
            agent_runtime_internal_token="synthetic-history-secret",
        ),
    )
    monkeypatch.setattr(
        activities.httpx,
        "AsyncClient",
        lambda **kwargs: client(transport=httpx.MockTransport(handler), **kwargs),
    )
    result, history = await run(
        server, SimpleNamespace(invoke=activities.call_agent_runtime)
    )
    assert result["status"] == (
        "unconfirmed" if refused else "plan_persistence_required"
    )
    assert len(calls) == (1 if refused else 4)
    serialized = history.to_json()
    assert "synthetic-history-secret" not in serialized
    assert "synthetic-private-failure-body" not in serialized
    # Temporal serializes payload data as base64; inspect decoded failure data too.
    import base64

    assert base64.b64encode(b"synthetic-history-secret").decode() not in serialized
    if refused:
        failed = [
            e.activity_task_failed_event_attributes.failure
            for e in history.events
            if e.HasField("activity_task_failed_event_attributes")
        ]
        assert len(failed) == 1
        assert failed[0].message == "agent_invocation_unconfirmed"
        assert not failed[0].HasField("cause")
