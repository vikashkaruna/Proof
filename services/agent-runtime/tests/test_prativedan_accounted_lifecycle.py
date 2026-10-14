"""Dedicated source+phase capabilities stay in the controller, never the target."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from test_prativedan_assessment_draft_codec import claimed
from test_prativedan_assessment_draft_codec import packet as fixture_packet

from axiom.accounted_controller import AccountedDispatchRequest
from axiom.canonicalise import sha256_hex
from axiom.model_call_store import ModelCallStore
from axiom.prativedan_accounted_lifecycle import PrativedanAccountedLifecycle
from axiom.prativedan_accounting_port import PrativedanAccountingPort
from axiom.prativedan_assessment_store import PrativedanAssessmentStore


@pytest.mark.asyncio
async def test_frozen_source_claim_then_data_only_render_then_controller_completion():
    packet = fixture_packet.__wrapped__()
    b = packet["binding"]
    rpc = SimpleNamespace(
        call=AsyncMock(
            side_effect=[
                packet["readback"],
                {
                    "claimed": True,
                    "expires_at": claimed(packet)["claim_expires_at"],
                    "readback": claimed(packet),
                },
            ]
        )
    )
    phase = SimpleNamespace(
        call=AsyncMock(
            side_effect=[{"id": "6", "entry_hash": "6" * 64}, {"id": "7", "entry_hash": "7" * 64}]
        )
    )
    lifecycle = PrativedanAccountedLifecycle(PrativedanAssessmentStore(rpc), phase, b)
    request = AccountedDispatchRequest(
        tenant_id=b.tenant_id, run_id=b.run_id, request_sha256=sha256_hex(b.request_text)
    )
    result = await lifecycle.claim(request)
    assert result.target.__slots__ == ("_input_text",)
    model = AsyncMock(side_effect=AssertionError("deterministic renderer must not call model"))
    output = await result.target.run(model)
    assert output["review_required"] is True
    model.assert_not_awaited()
    await lifecycle.complete(result.binding, result.started_receipt, "8" * 64, None)
    assert phase.call.call_args.args[0] == "record_prativedan_assessment_phase"
    with pytest.raises(ValueError, match="dedicated_accounting_dispatch_refused"):
        await lifecycle.claim(request)


@pytest.mark.asyncio
async def test_lost_claim_cannot_run_target_or_append_phase():
    packet = fixture_packet.__wrapped__()
    b = packet["binding"]
    rpc = SimpleNamespace(
        call=AsyncMock(side_effect=[packet["readback"], TimeoutError("private-canary")])
    )
    phase = SimpleNamespace(call=AsyncMock())
    lifecycle = PrativedanAccountedLifecycle(PrativedanAssessmentStore(rpc), phase, b)
    with pytest.raises(TimeoutError):
        await lifecycle.claim(
            AccountedDispatchRequest(
                tenant_id=b.tenant_id, run_id=b.run_id, request_sha256=sha256_hex(b.request_text)
            )
        )
    phase.call.assert_not_awaited()


@pytest.mark.asyncio
async def test_dedicated_accounting_fresh_verified_context_and_no_rpc_crossover():
    from axiom_model_accounting import AccountingBinding

    b = fixture_packet.__wrapped__()["binding"]
    binding = AccountingBinding(
        schema_version=2,
        tenant_id=b.tenant_id,
        run_id=b.run_id,
        correlation_id=b.operation_key,
        request_sha256=sha256_hex(b.request_text),
        agent="prativedan",
        agent_version="0.1.0",
    )
    context = SimpleNamespace(verified_context=AsyncMock(side_effect=[{"fresh": 1}, {"fresh": 2}]))
    rpc = SimpleNamespace(call=AsyncMock())
    port = PrativedanAccountingPort(rpc, context, binding)
    args = ModelCallStore.arguments(binding)
    await port.call("read_model_accounting_result", args)
    await port.call("read_model_accounting_result", args)
    assert rpc.call.call_args_list[0].args[1]["authority"] != {"fresh": 2}
    assert rpc.call.call_args_list[1].args[1]["authority"] == {"fresh": 2}
    with pytest.raises(ValueError, match="Dedicated accounting operation refused"):
        await port.call("append_agent_ledger", args)
    with pytest.raises(ValueError, match="Dedicated accounting operation refused"):
        await port.call("read_model_accounting_result", {**args, "authority": {}})
    assert context.verified_context.await_count == 2
