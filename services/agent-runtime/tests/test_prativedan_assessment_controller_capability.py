"""Synthetic private-port causality; not deployed identity/channel evidence."""

from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from test_prativedan_assessment_draft_codec import packet as codec_packet

from axiom.canonicalise import canonical_json, sha256_hex
from axiom.ledger_client import AppendInput
from axiom.prativedan_assessment_controller_capability import PrativedanControllerLedger
from axiom.prativedan_assessment_draft_codec import parse_source_v2, project_source_v2
from axiom.prativedan_renderer_config import renderer_commitment


@pytest.fixture
def capability():
    fixture = codec_packet.__wrapped__()
    binding = fixture["binding"]
    journal = fixture["readback"]
    source = parse_source_v2(journal["source_text"], journal["source_sha256"])
    input_hash = sha256_hex(canonical_json(project_source_v2(source).model_dump(mode="json")))
    port = SimpleNamespace(call=AsyncMock(return_value={"id": "17", "entry_hash": "a" * 64}))
    ledger = PrativedanControllerLedger(port, binding, input_hash)
    version, _, digest = renderer_commitment()
    event = AppendInput(
        tenant_id=binding.tenant_id,
        correlation_id=binding.operation_key,
        actor_type="agent",
        actor_id="prativedan",
        agent_version="0.1.0",
        action_type="report.generated",
        target_ref=binding.engagement_id,
        input_hash=input_hash,
        detail={
            "phase": "started",
            "run_id": binding.run_id,
            "request_hash": sha256_hex(binding.request_text),
            "renderer_config_version": version,
            "renderer_config_sha256": digest,
        },
    )
    return ledger, port, event


@pytest.mark.asyncio
async def test_narrow_start_port_has_no_caller_ledger_metadata_or_credentials(capability):
    ledger, port, event = capability
    result = await ledger.append(event)
    assert result.id == "17"
    name, arguments = port.call.call_args.args
    assert name == "record_prativedan_assessment_phase"
    assert set(arguments) == {"t", "k", "r", "rh", "phase_name", "output_hash"}
    assert arguments["output_hash"] is None
    assert ledger._client is None
    assert ledger._read_client is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "changes",
    [
        {"actor_type": "human"},
        {"actor_id": "board-renderer"},
        {"model_id": "invented-model"},
        {"prompt_hash": "a" * 64},
        {"input_hash": "0" * 64},
        {"output_hash": "a" * 64},
        {"action_type": "report.released"},
        {"result": "success"},
        {"detail": {"phase": "started"}},
    ],
)
async def test_wrong_metadata_is_zero_call_refusal(capability, changes):
    ledger, port, event = capability
    with pytest.raises(PermissionError):
        await ledger.append(replace(event, **changes))
    port.call.assert_not_called()


@pytest.mark.asyncio
async def test_completion_requires_confirmed_start_and_exact_ancestry(capability):
    ledger, port, event = capability
    completed = replace(
        event,
        result="success",
        output_hash="b" * 64,
        detail={**event.detail, "phase": "completed", "started_entry": "17"},
    )
    with pytest.raises(PermissionError):
        await ledger.append(completed)
    port.call.assert_not_called()
    await ledger.append(event)
    await ledger.append(completed)
    assert port.call.await_count == 2
    assert port.call.call_args.args[1]["output_hash"] == "b" * 64


@pytest.mark.asyncio
async def test_start_transport_loss_no_retry_or_later_completion(capability):
    ledger, port, event = capability
    port.call.side_effect = TimeoutError("Synthetic lost response")
    with pytest.raises(TimeoutError):
        await ledger.append(event)
    assert port.call.await_count == 1
    with pytest.raises(PermissionError):
        await ledger.append(
            replace(
                event,
                result="success",
                output_hash="b" * 64,
                detail={**event.detail, "phase": "completed", "started_entry": "17"},
            )
        )
    assert port.call.await_count == 1
