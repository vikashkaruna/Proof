"""HTTP boundary tests using synthetic transport; no credentials or live runtime."""

from __future__ import annotations

import json

import httpx
import pytest
from temporal_workers import activities
from temporal_workers.config import Settings
from temporal_workers.contracts import (
    ProtocolRefused,
    validate_result,
    validated_output,
)
from temporalio.exceptions import ApplicationError
from test_orchestration import assignment, response

CORRELATION = "00000000-0000-4000-8000-000000000001"


def setup(monkeypatch, handler, **settings):
    client = httpx.AsyncClient
    config = Settings(
        environment="test",
        agent_runtime_url="http://synthetic.invalid",
        agent_runtime_internal_token="synthetic-token",
        **settings,
    )
    monkeypatch.setattr(activities, "get_settings", lambda: config)
    monkeypatch.setattr(
        activities.httpx,
        "AsyncClient",
        lambda **kwargs: client(transport=httpx.MockTransport(handler), **kwargs),
    )
    return config


async def test_http_assignment_and_validated_result(monkeypatch):
    calls = []

    def handler(request):
        calls.append(request)
        result = response("drishti", CORRELATION)
        result["untrusted_extra"] = "discard"
        return httpx.Response(200, json=result)

    setup(monkeypatch, handler)
    data = assignment()
    result = await activities.call_agent_runtime("drishti", data, CORRELATION)
    assert "untrusted_extra" not in result
    assert len(calls) == 1
    assert calls[0].headers["X-Internal-Token"] == "synthetic-token"
    assert calls[0].url.path == "/agents/drishti/invoke"
    assert json.loads(calls[0].content) == {
        "correlation_id": CORRELATION,
        "input": data,
    }


@pytest.mark.parametrize(
    "fault",
    [
        "redirect",
        "status",
        "timeout",
        "json",
        "oversize",
        "failed",
        "binding",
        "agent",
        "receipts",
        "contradiction",
    ],
)
async def test_ambiguous_results_are_sanitized_nonretryable(monkeypatch, fault):
    calls = []

    def handler(request):
        calls.append(request)
        if fault == "redirect":
            return httpx.Response(
                307, headers={"location": "http://other.invalid/private"}
            )
        if fault == "status":
            return httpx.Response(500, text="private-server-detail")
        if fault == "timeout":
            raise httpx.ReadTimeout("private-server-detail")
        if fault == "json":
            return httpx.Response(200, text="private-server-detail")
        if fault == "oversize":
            return httpx.Response(200, content=b"x" * (2 * 1024 * 1024 + 1))
        result = response("drishti", CORRELATION)
        if fault == "failed":
            result.update(status="failed", output=None, error="private-server-detail")
        if fault == "binding":
            result["correlation_id"] = assignment()["tenant_id"]
        if fault == "agent":
            result["agent"] = "karya"
        if fault == "receipts":
            result["ledger_entry_ids"] = ["same", "same"]
        if fault == "contradiction":
            result["error"] = "private-server-detail"
        return httpx.Response(200, json=result)

    setup(monkeypatch, handler)
    with pytest.raises(ApplicationError) as caught:
        await activities.call_agent_runtime("drishti", assignment(), CORRELATION)
    assert caught.value.non_retryable
    assert caught.value.__context__ is None
    assert caught.value.__cause__ is None
    assert "private-server-detail" not in str(caught.value)
    assert len(calls) == 1


@pytest.mark.parametrize(
    "fault", ["credential", "agent", "correlation", "tenant", "url"]
)
async def test_invalid_configuration_never_sends_request(monkeypatch, fault):
    def handler(request):
        pytest.fail("Invalid request must not be sent")

    config = setup(monkeypatch, handler)
    data, agent, correlation = assignment(), "drishti", CORRELATION
    if fault == "credential":
        config.agent_runtime_internal_token = None
    elif fault == "agent":
        agent = "karya"
    elif fault == "correlation":
        correlation = "invalid"
    elif fault == "tenant":
        data["tenant_id"] = "invalid"
    else:
        config.agent_runtime_url = "http://private@synthetic.invalid?token=private"
    with pytest.raises(ApplicationError):
        await activities.call_agent_runtime(agent, data, correlation)


@pytest.mark.parametrize(
    "field,value",
    [
        ("library_version", "other"),
        ("posture_score", True),
        ("posture_score", float("nan")),
        ("posture_score", 101),
        ("estimated_exposure_inr", -1),
        ("estimated_exposure_inr", True),
        ("findings", None),
        ("findings", ["invalid"]),
        ("escalate", "false"),
    ],
)
def test_assessment_payload_rejects_invalid_consumed_fields(field, value):
    result = response("parikshan", CORRELATION)
    result["output"][field] = value
    with pytest.raises(ProtocolRefused):
        validated_output(validate_result(result, "parikshan", CORRELATION), "fixture@1")
