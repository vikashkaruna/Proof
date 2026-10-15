"""Synthetic exact packets through durable activity, with independent custody reads."""

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from temporalio.exceptions import ApplicationError

from temporal_workers.accounted_activity import accounted_activity

CASES = json.loads(
    (
        Path(__file__).resolve().parents[3]
        / "tests/fixtures/model-accounting/accounted-results.json"
    ).read_text()
)["cases"]


@pytest.mark.asyncio
@pytest.mark.parametrize("packet", CASES, ids=[x["name"] for x in CASES])
async def test_independent_packet_activity(packet):
    runtime = SimpleNamespace(
        invoke=AsyncMock(return_value=json.loads(packet["wire_text"]))
    )
    reader = SimpleNamespace(call=AsyncMock(return_value=packet["expected"]))
    invoke = accounted_activity(runtime=runtime, reader=reader)
    if packet["expected"]["terminal_status"] == "failed":
        with pytest.raises(ApplicationError):
            await invoke(packet["expected"]["binding"])
    else:
        result = await invoke(packet["expected"]["binding"])
        assert result["accounting_status"] == "sealed_observed_journal"
        assert result["result"]["runtime_output_text"] == packet["runtime_output_text"]
    b = packet["expected"]["binding"]
    reader.call.assert_awaited_once_with(
        "read_model_accounting_result",
        {"t": b["tenant_id"], "r": b["run_id"], "rh": b["request_sha256"]},
    )
    runtime.invoke.assert_awaited_once_with(
        {
            "tenant_id": b["tenant_id"],
            "run_id": b["run_id"],
            "request_sha256": b["request_sha256"],
        }
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("boundary", ["runtime", "reader"])
async def test_uncertain_boundary_sanitized_and_never_retried(boundary):
    packet = CASES[0]
    runtime = SimpleNamespace(
        invoke=AsyncMock(return_value=json.loads(packet["wire_text"]))
    )
    reader = SimpleNamespace(call=AsyncMock(return_value=packet["expected"]))
    (
        runtime.invoke if boundary == "runtime" else reader.call
    ).side_effect = RuntimeError("private-canary")
    with pytest.raises(ApplicationError) as caught:
        await accounted_activity(runtime=runtime, reader=reader)(
            packet["expected"]["binding"]
        )
    assert caught.value.non_retryable
    assert "private-canary" not in str(caught.value)
    assert (runtime.invoke if boundary == "runtime" else reader.call).await_count == 1
