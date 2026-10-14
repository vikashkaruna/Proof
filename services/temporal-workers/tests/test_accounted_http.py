"""Bounded mocked HTTP port; no live peers/providers."""

import json
from pathlib import Path

import httpx
import pytest

from temporal_workers.accounted_http import AccountedRuntimeHttpPort

PACKETS = json.loads(
    (
        Path(__file__).resolve().parents[3]
        / "tests/fixtures/model-accounting/accounted-results.json"
    ).read_text()
)["cases"]


@pytest.mark.asyncio
@pytest.mark.parametrize("packet", PACKETS, ids=[p["name"] for p in PACKETS])
async def test_exact_wire_survives_controller_transport(packet):
    calls = []

    async def handler(request):
        calls.append(request)
        assert request.url.path == "/accounted-agents/invoke"
        assert request.headers["X-Internal-Token"] == "synthetic-nonoperational-peer"
        return httpx.Response(200, content=packet["wire_text"])

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        b = packet["expected"]["binding"]
        result = await AccountedRuntimeHttpPort(
            client, "http://fixture.invalid", "synthetic-nonoperational-peer"
        ).invoke(
            {
                "tenant_id": b["tenant_id"],
                "run_id": b["run_id"],
                "request_sha256": b["request_sha256"],
            }
        )
        assert result["runtime_output_text"] == packet["runtime_output_text"]
    assert len(calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status,body",
    [
        (302, b"{}"),
        (503, b"private-canary"),
        (200, b'{"x":1,"x":1}'),
        (200, b"\xff"),
        (200, b"x" * 2097153),
    ],
)
async def test_bad_response_refuses_once_without_private_causes(status, body):
    calls = []

    async def handler(request):
        calls.append(request)
        return httpx.Response(status, content=body)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(ValueError, match="accounted_runtime_unconfirmed") as caught:
            await AccountedRuntimeHttpPort(
                client, "http://fixture.invalid", "synthetic-nonoperational-peer"
            ).invoke({})
        assert "private-canary" not in str(caught.value)
    assert len(calls) == 1
