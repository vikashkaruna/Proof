"""Strict SDK receipts, safe errors, no legacy/default-substituted accounting."""

from copy import deepcopy

import httpx
import pytest

from axiom.canonicalise import sha256_hex
from axiom.config import Settings
from axiom.model_gateway import ModelGateway, ModelGatewayError, ModelRequest, ModelResponse


def receipt(prompt="p", *, unavailable=False, model="planned", temperature=0.2):
    import json
    from hashlib import sha256

    hashed = sha256_hex(prompt)
    request_body = {
        "model": model,
        "prompt": prompt,
        "task": "reasoning",
        "temperature": temperature,
        "max_tokens": 4096,
        "variables": {},
        "pii_redact": True,
        "response_format": None,
        "prompt_hash": hashed,
    }
    request_json_hash = sha256_hex(
        json.dumps(
            request_body, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
        )
    )
    usage = {
        "availability": "unavailable" if unavailable else "reported",
        "reason": "missing" if unavailable else None,
        "input_tokens": None if unavailable else 1,
        "output_tokens": None if unavailable else 2,
        "total_tokens": None if unavailable else 3,
    }
    pricing_config = {
        "schema_version": 1,
        "basis": "configuration_estimate",
        "model": "openai/m",
        "input_rate": 0.1,
        "output_rate": 0.2,
    }
    cost = None if unavailable else 0.5
    return {
        "schema_version": 2,
        "text": "answer",
        "input_tokens": usage["input_tokens"],
        "output_tokens": usage["output_tokens"],
        "total_tokens": usage["total_tokens"],
        "cost_usd": cost,
        "latency_ms": 1,
        "model_id": "openai/m",
        "pii_redacted": True,
        "prompt_hash": hashed,
        "redactions": {},
        "route_reason": "configured",
        "correlation_id": "synthetic-correlation",
        "provenance": {
            "planned": {"provider": "anthropic", "model": "anthropic/first"},
            "serving": {
                "provider": "openai",
                "model": "openai/m",
                "reported_model": "provider-revision",
            },
            "usage": usage,
            "pricing": {
                "basis": "unavailable" if unavailable else "configuration_estimate",
                "reason": "usage_unavailable" if unavailable else None,
                "scope": "successful_response_only",
                "model": "openai/m",
                "input_rate": 0.1,
                "output_rate": 0.2,
                "config_sha256": sha256(
                    json.dumps(pricing_config, sort_keys=True, separators=(",", ":")).encode()
                ).hexdigest(),
                "cost_usd": cost,
            },
            "commitments": {
                "request_json_sha256": request_json_hash,
                "request_json_basis": "canonical_decoded_request_not_http_wire",
                "template_sha256": hashed,
                "composed_sha256": hashed,
                "transport_prompt_sha256": hashed,
                "sdk_handoff_sha256": "1" * 64,
                "basis": "sdk_handoff_not_http_wire",
                "caller_prompt_sha256": hashed,
            },
            "attempts": [
                {"provider": "anthropic", "model": "anthropic/first", "outcome": "failed"},
                {"provider": "openai", "model": "openai/m", "outcome": "succeeded"},
            ],
            "failed_attempt_usage": "unavailable",
        },
    }


async def call(data, *, status=200, request=None):
    async with httpx.AsyncClient(
        base_url="http://gw.invalid",
        transport=httpx.MockTransport(lambda _r: httpx.Response(status, json=data)),
    ) as client:
        gateway = ModelGateway(Settings(model_gateway_url="http://gw.invalid"), http=client)
        return await gateway.complete(request or ModelRequest(model="planned", prompt="p"))


@pytest.mark.parametrize("unavailable", [False, True])
async def test_preserves_serving_model_and_nullable_usage(unavailable):
    result = await call(receipt(unavailable=unavailable))
    assert result.model_id == "openai/m"
    assert result.provenance.serving.reported_model == "provider-revision"
    assert result.input_tokens == (None if unavailable else 1)
    assert result.cost_usd == (None if unavailable else 0.5)


@pytest.mark.parametrize(
    "mutator",
    [
        lambda d: d.pop("schema_version"),
        lambda d: d.pop("cost_usd"),
        lambda d: d.update(input_tokens=True),
        lambda d: d.update(total_tokens=2147483648),
        lambda d: d.update(model_id="planned"),
        lambda d: d.update(prompt_hash="0" * 64),
        lambda d: d["provenance"]["commitments"].update(caller_prompt_sha256="0" * 64),
        lambda d: d["provenance"]["commitments"].update(template_sha256="0" * 64),
        lambda d: d["provenance"]["pricing"].update(config_sha256="0" * 64),
        lambda d: d["provenance"]["pricing"].update(cost_usd=0.0),
        lambda d: d["provenance"]["usage"].update(total_tokens=99),
        lambda d: d["provenance"]["serving"].update(provider="anthropic"),
        lambda d: d["provenance"]["attempts"][-1].update(outcome="failed"),
        lambda d: d.update(text=" "),
        lambda d: d.update(unreviewed=True),
    ],
)
async def test_refuses_missing_and_inconsistent_receipts(mutator):
    data = deepcopy(receipt())
    mutator(data)
    with pytest.raises(ModelGatewayError, match="response_invalid"):
        await call(data)


async def test_legacy_numeric_success_no_longer_defaults():
    with pytest.raises(ModelGatewayError, match="response_invalid"):
        await call({"text": "hi", "input_tokens": 1, "output_tokens": 1, "total_tokens": 2})


async def test_unavailable_usage_cannot_be_zero_substituted():
    data = receipt(unavailable=True)
    data.update(input_tokens=0, output_tokens=0, total_tokens=0, cost_usd=0.0)
    with pytest.raises(ModelGatewayError, match="response_invalid"):
        await call(data)


async def test_error_never_echoes_response_or_transport_secrets():
    with pytest.raises(ModelGatewayError) as error:
        await call({"error": "synthetic-sensitive-value"}, status=503)
    assert str(error.value) == "model_gateway_http_503"
    assert "synthetic-sensitive-value" not in str(error.value)


@pytest.mark.parametrize("bad", [True, -1, float("nan"), float("inf"), 10000.0])
def test_nonfinite_or_invalid_cost_refused_before_use(bad):
    from pydantic import ValidationError

    data = receipt()
    data["cost_usd"] = bad
    with pytest.raises(ValidationError):
        ModelResponse.model_validate(data)


@pytest.mark.parametrize(
    "raw",
    [
        '{"text":"a","text":"b"}',
        '{"provenance":{"usage":{"reason":null,"reason":"invalid"}}}',
        '{"cost_usd":NaN}',
        "not JSON",
    ],
)
async def test_json_duplicates_and_nonfinite_numbers_refused(raw):
    async with httpx.AsyncClient(
        base_url="http://gw.invalid",
        transport=httpx.MockTransport(
            lambda _r: httpx.Response(
                200, content=raw, headers={"content-type": "application/json"}
            )
        ),
    ) as client:
        gateway = ModelGateway(Settings(model_gateway_url="http://gw.invalid"), http=client)
        with pytest.raises(ModelGatewayError, match="response_invalid"):
            await gateway.complete(ModelRequest(model="planned", prompt="p"))


async def test_known_usage_without_price_is_explicit_unavailable_cost():
    import hashlib
    import json

    data = receipt()
    pricing = data["provenance"]["pricing"]
    pricing.update(
        basis="unavailable",
        reason="price_unavailable",
        input_rate=None,
        output_rate=None,
        cost_usd=None,
    )
    config = {
        "schema_version": 1,
        "basis": "configuration_estimate",
        "model": "openai/m",
        "input_rate": None,
        "output_rate": None,
    }
    pricing["config_sha256"] = hashlib.sha256(
        json.dumps(config, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    data["cost_usd"] = None
    result = await call(data)
    assert result.total_tokens == 3
    assert result.cost_usd is None
    data["provenance"]["pricing"]["reason"] = "usage_unavailable"
    with pytest.raises(ModelGatewayError, match="response_invalid"):
        await call(data)


async def test_transport_error_never_echoes_sensitive_text():
    def handler(_request):
        raise httpx.ConnectError("synthetic-sensitive-value")

    async with httpx.AsyncClient(
        base_url="http://gw.invalid", transport=httpx.MockTransport(handler)
    ) as client:
        gateway = ModelGateway(Settings(model_gateway_url="http://gw.invalid"), http=client)
        with pytest.raises(ModelGatewayError) as error:
            await gateway.complete(ModelRequest(model="planned", prompt="p"))
        assert str(error.value) == "model_gateway_unreachable"


@pytest.mark.parametrize(
    "changed",
    [
        {"variables": {"value": "different"}},
        {"temperature": 0.9},
        {"max_tokens": 100},
        {"task": "structural"},
        {"model": "different"},
        {"response_format": {"type": "json_object"}},
        {"pii_redact": False},
    ],
)
async def test_same_prompt_response_from_different_request_refused(changed):
    request = ModelRequest(**{"model": "planned", "prompt": "p", **changed})
    with pytest.raises(ModelGatewayError, match="response_invalid"):
        await call(receipt(), request=request)


@pytest.mark.parametrize("temperature", [0, 0.0])
async def test_exact_outgoing_request_number_representation_bound(temperature):
    request = ModelRequest(model="planned", prompt="p", temperature=temperature)
    result = await call(receipt(temperature=temperature), request=request)
    assert result.text == "answer"
    other = 0.0 if type(temperature) is int else 0
    with pytest.raises(ModelGatewayError, match="response_invalid"):
        await call(receipt(temperature=other), request=request)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("provider", "unknown_provider"),
        ("reported_model", "customer@example.invalid"),
        ("reported_model", "provider-revision\n"),
        ("reported_model", "secret model"),
        ("model", "openai/m\n"),
    ],
)
async def test_unsafe_or_unknown_response_identity_refused(field, value):
    data = receipt()
    data["provenance"]["serving"][field] = value
    with pytest.raises(ModelGatewayError, match="response_invalid") as error:
        await call(data)
    assert value not in str(error.value)
