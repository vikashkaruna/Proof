"""Controller/target tests. No hosted provider, keys or billing claims."""

from unittest.mock import AsyncMock

import pytest
from axiom_model_accounting import AccountingBinding

from axiom.canonicalise import canonical_json
from axiom.prativedan_accounted_process import ControllerPorts, compute_zero_only
from axiom.prativedan_contracts import PrativedanInput
from axiom.prativedan_pure_renderer import render_prativedan

BINDING = AccountingBinding(
    schema_version=2,
    tenant_id="11111111-1111-4111-8111-111111111111",
    run_id="22222222-2222-4222-8222-222222222222",
    correlation_id="33333333-3333-4333-8333-333333333333",
    request_sha256="a" * 64,
    agent="prativedan",
    agent_version="0.1.0",
)
INPUT = canonical_json(
    {
        "tenant_id": BINDING.tenant_id,
        "title": "Synthetic unknown draft",
        "kind": "board",
        "findings": [],
        "posture_score": None,
        "estimated_exposure_inr": None,
        "library_version": "0.1.1",
    }
)


@pytest.mark.asyncio
async def test_real_composer_records_actual_open_journal_without_sdk_handoff(monkeypatch):
    sdk = AsyncMock(side_effect=AssertionError("no model call permitted"))
    monkeypatch.setattr("axiom.prativedan_accounted_process.DisabledCompletionSdk.complete", sdk)

    class Ports:
        def __init__(self):
            self.calls = []

        async def require_current(self, binding):
            assert binding == BINDING
            self.calls.append("current")

        async def call(self, name, args):
            assert name == "load_model_accounting_dispatch"
            self.calls.append("open")
            return {
                **BINDING.model_dump(),
                "claimed": True,
                "requested_receipt": {"id": "1", "entry_hash": "b" * 64},
            }

        async def render(self, input_text):
            assert input_text == INPUT
            self.calls.append("render")
            return render_prativedan(PrativedanInput.model_validate_json(input_text)).model_dump(
                mode="json"
            )

    ports = Ports()
    output, error = await compute_zero_only(BINDING, INPUT, ports, ports, ports)
    assert error is None
    assert output is not None
    assert "Unknown" in output
    assert ports.calls == ["current", "open", "current", "render", "current"]
    sdk.assert_not_called()


@pytest.mark.asyncio
async def test_hostile_model_rpc_is_rejected_before_private_controller_or_sdk():
    channel = AsyncMock()
    ports = ControllerPorts(channel, BINDING)
    for name in ("begin_model_accounting_call", "finish_model_accounting_call", "complete", "sdk"):
        with pytest.raises(ValueError, match="zero_only"):
            await ports.call(
                name, {"t": BINDING.tenant_id, "r": BINDING.run_id, "rh": BINDING.request_sha256}
            )
    channel.exchange.assert_not_called()


@pytest.mark.asyncio
async def test_human_stop_prevents_open_and_target():
    class Stop:
        async def require_current(self, binding):
            raise ValueError("stopped")

    rpc = AsyncMock()
    renderer = AsyncMock()
    with pytest.raises(ValueError, match="stopped"):
        await compute_zero_only(BINDING, INPUT, rpc, Stop(), renderer)
    rpc.call.assert_not_called()
    renderer.render.assert_not_called()
