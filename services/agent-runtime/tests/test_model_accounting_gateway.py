"""Actual SDK transport composition, using synthetic receipts without providers."""

import json

import httpx
import pytest
from test_model_call_store import Authority, JournalRpc, Target, binding
from test_model_gateway_provenance import receipt

from axiom.canonicalise import sha256_hex
from axiom.config import Settings
from axiom.model_accounting_gateway import AccountingSdkGateway
from axiom.model_call_store import AccountedComposer, ModelCallStore
from axiom.model_gateway import ModelGateway


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["known", "unknown", "tiny", "failure", "wrong", "redaction"])
async def test_actual_sdk_after_durable_claim_and_honest_metadata(mode: str) -> None:
    rpc = JournalRpc()
    requests = []

    def transport(request: httpx.Request) -> httpx.Response:
        assert rpc.calls[-1][0] == "begin_model_accounting_call"
        raw = json.loads(request.content)
        requests.append(raw)
        data = receipt(raw["prompt"], model=raw["model"], unavailable=mode == "unknown")
        p = data["provenance"]
        p["commitments"]["request_json_sha256"] = sha256_hex(
            json.dumps(raw, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        )
        if mode == "wrong":
            p["commitments"]["request_json_sha256"] = "f" * 64
        if mode == "redaction":
            data["pii_redacted"] = False
        if mode == "tiny":
            price = p["pricing"]
            price["input_rate"], price["output_rate"] = 1e-20, 2e-20
            price["cost_usd"] = data["cost_usd"] = 1e-20 + 2 * 2e-20
            price["config_sha256"] = sha256_hex(
                json.dumps(
                    {
                        "schema_version": 1,
                        "basis": "configuration_estimate",
                        "model": price["model"],
                        "input_rate": price["input_rate"],
                        "output_rate": price["output_rate"],
                    },
                    sort_keys=True,
                    separators=(",", ":"),
                )
            )
        return httpx.Response(503 if mode == "failure" else 200, json=data)

    async with httpx.AsyncClient(
        base_url="http://gw.invalid", transport=httpx.MockTransport(transport)
    ) as client:
        sdk = ModelGateway(Settings(model_gateway_url="http://gw.invalid"), http=client)
        result = await AccountedComposer(
            ModelCallStore(rpc), AccountingSdkGateway(sdk), Authority()
        ).compute(binding(), Target())
    assert len(requests) == 1
    assert "synthetic private payload" not in json.dumps(rpc.calls)
    observed = result.observations[0]
    if mode in {"failure", "wrong", "redaction"}:
        assert result.failure_code == "target_failed"
        assert observed.usage.total_tokens is None
        assert observed.pricing.estimate_usd is None
        assert observed.serving is None
    else:
        assert result.failure_code is None
        assert observed.serving.model == "openai/m"
        assert observed.planned.model == "anthropic/first"
        assert observed.serving.reported_model == "provider-revision"
        assert observed.attempts[0].outcome == "failed"
        assert observed.commitments.sdk_handoff_sha256 == "1" * 64
        if mode == "unknown":
            assert observed.usage.total_tokens is None
            assert observed.pricing.estimate_usd is None
        else:
            assert observed.usage.total_tokens == 3
            assert observed.pricing.estimate_usd == (
                "0.00000000000000000005" if mode == "tiny" else "0.5"
            )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure", ["begin_model_accounting_call", "replay", "finish_model_accounting_call"]
)
async def test_actual_sdk_not_retried_after_uncertain_ack(failure: str) -> None:
    rpc = JournalRpc(fail=None if failure == "replay" else failure, replay=failure == "replay")
    calls = []

    def transport(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        raw = json.loads(request.content)
        data = receipt(raw["prompt"], model=raw["model"])
        data["provenance"]["commitments"]["request_json_sha256"] = sha256_hex(
            json.dumps(raw, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        )
        return httpx.Response(200, json=data)

    async with httpx.AsyncClient(
        base_url="http://gw.invalid", transport=httpx.MockTransport(transport)
    ) as client:
        sdk = ModelGateway(Settings(model_gateway_url="http://gw.invalid"), http=client)
        result = await AccountedComposer(
            ModelCallStore(rpc), AccountingSdkGateway(sdk), Authority()
        ).compute(binding(), Target())
    assert result.failure_code == "accounting_uncertain"
    assert result.output is None
    assert len(calls) == (1 if failure == "finish_model_accounting_call" else 0)
    assert sum(name == "finish_model_accounting_call" for name, _ in rpc.calls) <= 1


@pytest.mark.asyncio
@pytest.mark.parametrize("mutation", ["request", "template", "model", "task", "pii", "duplicate"])
async def test_refused_original_never_enters_sdk(mutation: str) -> None:
    from test_model_call_store import payload

    from axiom.canonicalise import canonical_json
    from axiom.model_call_accounting import CallStart

    value = payload()
    raw = {**value.model_dump(), "prompt_hash": sha256_hex(value.prompt)}
    if mutation == "pii":
        raw["pii_redact"] = False
    text = canonical_json(raw)
    start = CallStart(
        **binding().model_dump(),
        call_id="40000000-0000-4000-8000-000000000001",
        request_json_sha256=sha256_hex(text),
        request_json_basis="canonical_decoded_request_not_http_wire",
        template_sha256=sha256_hex(value.prompt),
        model_selector=value.model,
        task=value.task,
    )
    field = {
        "request": "request_json_sha256",
        "template": "template_sha256",
        "model": "model_selector",
        "task": "task",
    }.get(mutation)
    if field:
        start = start.model_copy(update={field: "report" if mutation == "task" else "f" * 64})
    if mutation == "duplicate":
        text = text.replace("{", '{"model":"fast",', 1)

    class RefusingSdk:
        async def complete(self, _request):
            raise AssertionError("Invalid original reached SDK")

    with pytest.raises(ValueError, match="accounting_gateway_request_invalid"):
        await AccountingSdkGateway(RefusingSdk()).complete(text, start)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mutation", ["request", "template", "caller", "redaction", "serving", "float_cost"]
)
async def test_injected_unchecked_receipt_cannot_bypass_adapter_verification(mutation: str) -> None:
    from axiom.model_gateway import ModelResponse

    class UncheckedSdk:
        async def complete(self, request):
            data = receipt(request.prompt, model=request.model)
            raw = {
                "model": request.model,
                "prompt": request.prompt,
                "task": request.task,
                "temperature": request.temperature,
                "max_tokens": request.max_tokens,
                "variables": request.variables,
                "pii_redact": request.pii_redact,
                "response_format": request.response_format,
                "prompt_hash": sha256_hex(request.prompt),
            }
            data["provenance"]["commitments"]["request_json_sha256"] = sha256_hex(
                json.dumps(raw, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
            )
            response = ModelResponse.model_validate(data)
            fields = {
                "request": "request_json_sha256",
                "template": "template_sha256",
                "caller": "caller_prompt_sha256",
            }
            if mutation in fields:
                commitments = response.provenance.commitments.model_copy(
                    update={fields[mutation]: "f" * 64}
                )
                response = response.model_copy(
                    update={
                        "provenance": response.provenance.model_copy(
                            update={"commitments": commitments}
                        )
                    }
                )
            elif mutation == "redaction":
                response = response.model_copy(update={"pii_redacted": False})
            elif mutation == "serving":
                response = response.model_copy(update={"model_id": "openai/other"})
            else:
                response = response.model_copy(update={"cost_usd": 0.0})
            return response

    rpc = JournalRpc()
    result = await AccountedComposer(
        ModelCallStore(rpc), AccountingSdkGateway(UncheckedSdk()), Authority()
    ).compute(binding(), Target())
    assert result.failure_code == "target_failed"
    assert result.observations[0].failure_code == "gateway_response_invalid"
    assert result.observations[0].usage.total_tokens is None
    assert result.observations[0].pricing.estimate_usd is None


@pytest.mark.parametrize("deadline", [0, -1, 61, float("inf"), float("nan"), True])
def test_operator_budget_is_finite_bounded(deadline: float) -> None:
    with pytest.raises(ValueError, match="accounting_gateway_deadline_invalid"):
        AccountingSdkGateway(object(), deadline_seconds=deadline)


@pytest.mark.asyncio
@pytest.mark.parametrize("cancel_invocation", [False, True])
async def test_total_deadline_or_cancellation_discards_uncooperative_sdk_without_retry(
    cancel_invocation: bool,
) -> None:
    import asyncio

    entered, cancelled, release, exited = (asyncio.Event() for _ in range(4))
    calls = []
    rpc = JournalRpc()

    class HangingSdk:
        async def complete(self, request):
            assert rpc.calls[-1][0] == "begin_model_accounting_call"
            calls.append(request)
            entered.set()
            try:
                await release.wait()
            except asyncio.CancelledError:
                # A vendor SDK may suppress cancellation; controller must still end.
                cancelled.set()
                await release.wait()
            exited.set()
            raise RuntimeError("synthetic late vendor exception with private data")

    operation = asyncio.create_task(
        AccountedComposer(
            ModelCallStore(rpc),
            AccountingSdkGateway(HangingSdk(), deadline_seconds=0.01),
            Authority(),
        ).compute(binding(), Target())
    )
    try:
        await asyncio.wait_for(entered.wait(), 0.2)
        if cancel_invocation:
            operation.cancel()
        result = await asyncio.wait_for(operation, 0.2)
        await asyncio.wait_for(cancelled.wait(), 0.2)
        assert result.failure_code == (
            "invocation_cancelled" if cancel_invocation else "target_failed"
        )
        assert result.output is None
        observed = result.observations[0]
        assert observed.state == ("cancelled" if cancel_invocation else "failed")
        assert observed.failure_code == (
            "invocation_cancelled" if cancel_invocation else "gateway_unavailable"
        )
        assert observed.usage.total_tokens is None
        assert observed.pricing.estimate_usd is None
        assert observed.serving is None
        assert len(calls) == 1
        assert sum(name == "finish_model_accounting_call" for name, _ in rpc.calls) == 1
        before = list(rpc.calls)
        release.set()
        await asyncio.wait_for(exited.wait(), 0.2)
        await asyncio.sleep(0)
        assert rpc.calls == before
    finally:
        release.set()
        if not operation.done():
            operation.cancel()
            await operation


@pytest.mark.asyncio
async def test_deadline_with_lost_failure_receipt_stays_uncertain() -> None:
    import asyncio

    calls = []

    class HangingSdk:
        async def complete(self, request):
            calls.append(request)
            await asyncio.Event().wait()

    rpc = JournalRpc(fail="finish_model_accounting_call")
    result = await AccountedComposer(
        ModelCallStore(rpc), AccountingSdkGateway(HangingSdk(), deadline_seconds=0.01), Authority()
    ).compute(binding(), Target())
    assert result.failure_code == "accounting_uncertain"
    assert result.output is None
    assert result.observations == ()
    assert len(calls) == 1
    assert sum(name == "finish_model_accounting_call" for name, _ in rpc.calls) == 1
