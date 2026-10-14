"""Controller/HTTP source tests with synthetic independent custody, never live authority."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from test_accounted_result import fixture

from axiom.accounted_controller import (
    AccountedController,
    AccountedDispatchRequest,
    ClaimedAccountedTarget,
)
from axiom.accounted_router import accounted_router
from axiom.canonicalise import canonical_json, sha256_hex
from axiom.model_call_store import AccountedComputation, ModelCallStore


def setup():
    _, expected = fixture()
    output = {"inventory": [], "score": 3.0}
    # Real controller freezes its own canonical output; terminal reader stores its hash.
    text = canonical_json(output)
    expected = expected.model_copy(update={"runtime_output_sha256": sha256_hex(text)})
    target = object()
    lifecycle = SimpleNamespace(
        claim=AsyncMock(
            return_value=ClaimedAccountedTarget(
                expected.binding, target, expected.seal.agent_started_receipt
            )
        ),
        complete=AsyncMock(return_value=expected.seal.agent_completed_receipt),
    )
    composer = SimpleNamespace(
        compute=AsyncMock(return_value=AccountedComputation(output, (), None))
    )
    store = SimpleNamespace(
        seal=AsyncMock(return_value=expected.seal), read_result=AsyncMock(return_value=expected)
    )
    request = AccountedDispatchRequest(
        tenant_id=expected.binding.tenant_id,
        run_id=expected.binding.run_id,
        request_sha256=expected.binding.request_sha256,
    )
    return (
        AccountedController(lifecycle, composer, store),
        request,
        lifecycle,
        composer,
        store,
        expected,
    )


@pytest.mark.asyncio
async def test_output_frozen_terminal_recorded_sealed_and_independently_read():
    controller, request, lifecycle, composer, store, expected = setup()
    result = await controller.invoke(request)
    assert result.cost_usd == "0.000000"
    assert result.runtime_output_text == canonical_json({"inventory": [], "score": 3.0})
    lifecycle.complete.assert_awaited_once_with(
        expected.binding, expected.seal.agent_started_receipt, expected.runtime_output_sha256, None
    )
    store.read_result.assert_awaited_once_with(expected.binding)
    assert composer.compute.call_args.args[1] is lifecycle.claim.return_value.target


@pytest.mark.asyncio
@pytest.mark.parametrize("boundary", ["claim", "compute", "complete", "seal", "read_result"])
async def test_uncertain_boundary_never_retries(boundary):
    controller, request, lifecycle, composer, store, _ = setup()
    owner = (
        lifecycle
        if boundary in {"claim", "complete"}
        else composer
        if boundary == "compute"
        else store
    )
    getattr(owner, boundary).side_effect = RuntimeError("private-canary")
    with pytest.raises(RuntimeError):
        await controller.invoke(request)
    assert getattr(owner, boundary).await_count == 1


@pytest.mark.asyncio
async def test_dispatch_substitution_stops_before_target():
    controller, request, lifecycle, composer, _, _ = setup()
    request = request.model_copy(update={"run_id": "10000000-0000-0000-0000-000000000099"})
    with pytest.raises(ValueError, match="accounted_dispatch_refused"):
        await controller.invoke(request)
    composer.compute.assert_not_awaited()
    lifecycle.complete.assert_not_awaited()


@pytest.mark.asyncio
async def test_independent_terminal_hash_substitution_refused():
    controller, request, _, _, store, expected = setup()
    store.read_result.return_value = expected.model_copy(update={"runtime_output_sha256": "9" * 64})
    with pytest.raises(ValueError, match="accounted_result_contract_refused"):
        await controller.invoke(request)


@pytest.mark.asyncio
async def test_real_read_port_uses_original_dispatch_and_rejects_foreign_witness():
    _, request, _, _, _, expected = setup()
    rpc = SimpleNamespace(call=AsyncMock(return_value=expected.model_dump()))
    store = ModelCallStore(rpc)
    assert await store.read_result(expected.binding) == expected
    rpc.call.assert_awaited_once_with(
        "read_model_accounting_result",
        {"t": request.tenant_id, "r": request.run_id, "rh": request.request_sha256},
    )
    altered = expected.model_dump()
    altered["binding"]["run_id"] = "10000000-0000-0000-0000-000000000099"
    rpc.call.return_value = altered
    with pytest.raises(ValueError, match="Accounting result unavailable"):
        await store.read_result(expected.binding)


def test_unmounted_http_rejects_caller_witness_and_requires_peer():
    controller, request, _, _, _, _ = setup()
    app = FastAPI()

    def guard(_):
        raise HTTPException(status_code=403, detail="peer_refused")

    app.include_router(accounted_router(controller=controller, require_peer=guard))
    with TestClient(app) as client:
        assert client.post("/accounted-agents/invoke", json=request.model_dump()).status_code == 403
        assert (
            client.post(
                "/accounted-agents/invoke", json={**request.model_dump(), "seal": {}}
            ).status_code
            == 422
        )
