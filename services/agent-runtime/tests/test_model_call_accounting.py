"""Synthetic accounting contracts, not production ledger/runtime authority."""

from copy import deepcopy

import pytest
from pydantic import ValidationError

from axiom.model_call_accounting import CallOutcome, derive_accounting, legacy_projection


def uid(n: int) -> str:
    return f"10000000-0000-0000-0000-{n:012d}"


def observed(n: int = 1) -> dict[str, object]:
    return {
        "schema_version": 2,
        "tenant_id": uid(1),
        "run_id": uid(2),
        "correlation_id": uid(3),
        "request_sha256": "a" * 64,
        "agent": "sudhaar",
        "agent_version": "0.1.0",
        "call_id": uid(10 + n),
        "request_json_sha256": "b" * 64,
        "request_json_basis": "canonical_decoded_request_not_http_wire",
        "template_sha256": "c" * 64,
        "model_selector": "fast",
        "task": "reasoning",
        "state": "completed",
        "failure_code": None,
        "content_sha256": "d" * 64,
        "planned": {"provider": "self_hosted", "model": "qwen/Qwen3"},
        "serving": {"provider": "self_hosted", "model": "qwen/Qwen3", "reported_model": None},
        "commitments": {
            "composed_sha256": "e" * 64,
            "transport_prompt_sha256": "f" * 64,
            "sdk_handoff_sha256": "1" * 64,
            "basis": "sdk_handoff_not_http_wire",
        },
        "attempts": [{"provider": "self_hosted", "model": "qwen/Qwen3", "outcome": "succeeded"}],
        "usage": {
            "availability": "reported",
            "input_tokens": 4,
            "output_tokens": 6,
            "total_tokens": 10,
        },
        "pricing": {
            "basis": "configuration_estimate",
            "scope": "successful_response_only",
            "config_sha256": "2" * 64,
            "estimate_usd": "0.000000000001",
        },
    }


def failed(n: int = 1) -> dict[str, object]:
    result = observed(n)
    result.update(
        state="failed",
        failure_code="gateway_unavailable",
        content_sha256=None,
        planned=None,
        serving=None,
        commitments=None,
        attempts=None,
        usage={
            "availability": "unavailable",
            "input_tokens": None,
            "output_tokens": None,
            "total_tokens": None,
        },
        pricing={
            "basis": "unavailable",
            "scope": "successful_response_only",
            "config_sha256": None,
            "estimate_usd": None,
        },
    )
    return result


def test_provisional_empty_arithmetic_has_no_seal_authority() -> None:
    result = derive_accounting([])
    assert result.basis == "no_model"
    assert result.input_tokens == 0
    assert result.estimate_usd == "0"
    assert "seal_receipt" not in result.model_dump()
    assert "verified" not in result.model_dump()


def test_exact_tiny_costs_survive_rounded_compatibility() -> None:
    result = derive_accounting([observed(), observed(2)])
    assert result.estimate_usd == "0.000000000002"
    assert legacy_projection(result).cost_usd == "0.000000"
    assert result.basis == "all_known"


def test_unknown_call_preserves_known_partial_nulls_full_totals() -> None:
    result = derive_accounting([observed(), failed(2)])
    assert result.basis == "known_partial"
    assert result.total_tokens is None
    assert result.estimate_usd is None
    assert result.known_total_tokens == 10
    assert result.known_estimate_usd == "0.000000000001"


def test_failed_attempt_usage_is_unknown() -> None:
    value = observed()
    value["attempts"] = [
        {"provider": "self_hosted", "model": "qwen/other", "outcome": "failed"},
        {"provider": "self_hosted", "model": "qwen/Qwen3", "outcome": "succeeded"},
    ]
    result = derive_accounting([value])
    assert result.total_tokens is None
    assert result.known_total_tokens == 10
    assert result.unknown_attempt_usage


@pytest.mark.parametrize(
    "patch",
    [
        {"tenant_id": uid(1) + "\n"},
        {"tenant_id": "00000000-0000-0000-0000-000000000000"},
        {"model_selector": "person@example.com"},
        {"model_selector": "fast\n"},
        {"prompt": "private"},
        {"request_sha256": "a" * 64 + "\n"},
    ],
)
def test_strict_metadata_without_raw_payload(patch: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        CallOutcome.model_validate({**observed(), **patch})


@pytest.mark.parametrize(
    "usage",
    [
        {
            "availability": "unavailable",
            "input_tokens": 0,
            "output_tokens": None,
            "total_tokens": None,
        },
        {"availability": "reported", "input_tokens": True, "output_tokens": 6, "total_tokens": 7},
        {"availability": "reported", "input_tokens": 4, "output_tokens": 6, "total_tokens": 11},
    ],
)
def test_usage_fabrication_refused(usage: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        CallOutcome.model_validate({**observed(), "usage": usage})


def test_duplicate_foreign_callsets_refused() -> None:
    with pytest.raises(ValueError, match="Duplicate"):
        derive_accounting([observed(), observed()])
    with pytest.raises(ValueError, match="binding"):
        derive_accounting([observed(), {**observed(2), "tenant_id": uid(9)}])


def test_failed_only_not_no_model() -> None:
    result = derive_accounting([failed()])
    assert result.basis == "unknown"
    assert result.total_tokens is None


def test_compatibility_overflow_refuses() -> None:
    value = deepcopy(observed())
    value["pricing"] = {
        "basis": "configuration_estimate",
        "scope": "successful_response_only",
        "config_sha256": "2" * 64,
        "estimate_usd": "9999.999999",
    }
    with pytest.raises(ValueError, match="overflow"):
        legacy_projection(derive_accounting([value, {**value, "call_id": uid(30)}]))


@pytest.mark.parametrize(
    "patch",
    [
        {"content_sha256": None},
        {"serving": {"provider": "bedrock", "model": "gpt-4", "reported_model": None}},
        {"attempts": [{"provider": "self_hosted", "model": "different", "outcome": "succeeded"}]},
        {"attempts": [{"provider": "self_hosted", "model": "qwen/Qwen3", "outcome": "failed"}]},
        {
            "pricing": {
                "basis": "configuration_estimate",
                "scope": "successful_response_only",
                "config_sha256": None,
                "estimate_usd": "1",
            }
        },
        {
            "pricing": {
                "basis": "unavailable",
                "scope": "successful_response_only",
                "config_sha256": None,
                "estimate_usd": "1",
            }
        },
        {
            "usage": {
                "availability": "unavailable",
                "input_tokens": None,
                "output_tokens": None,
                "total_tokens": None,
            }
        },
        {"state": "failed", "failure_code": "gateway_unavailable"},
    ],
)
def test_inconsistent_observation_refused(patch: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        CallOutcome.model_validate({**observed(), **patch})


@pytest.mark.parametrize(
    "patch",
    [
        {"state": "cancelled", "failure_code": "gateway_unavailable"},
        {"state": "uncertain", "failure_code": "gateway_unavailable"},
        {"failure_code": "transport_uncertain"},
    ],
)
def test_cancellation_uncertainty_distinguished(patch: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        CallOutcome.model_validate({**failed(), **patch})


@pytest.mark.parametrize(
    "patch",
    [
        {"known_usage_call_count": 2},
        {"known_input_tokens": 1, "known_total_tokens": 1},
        {"known_estimate_usd": "1"},
        {"input_tokens": 0},
        {"basis": "no_model"},
    ],
)
def test_summary_fabrication_refused(patch: dict[str, object]) -> None:
    from axiom.model_call_accounting import AccountingSummary

    with pytest.raises(ValidationError):
        AccountingSummary.model_validate({**derive_accounting([failed()]).model_dump(), **patch})


def test_callset_bound_before_parse() -> None:
    with pytest.raises(ValueError, match="bound"):
        derive_accounting([None] * 1001)


def test_integer_estimate_and_half_up_projection() -> None:
    value = observed()
    value["pricing"] = {
        "basis": "configuration_estimate",
        "scope": "successful_response_only",
        "config_sha256": "2" * 64,
        "estimate_usd": "1",
    }
    assert legacy_projection(derive_accounting([value])).cost_usd == "1.000000"
    value["pricing"] = {
        "basis": "configuration_estimate",
        "scope": "successful_response_only",
        "config_sha256": "2" * 64,
        "estimate_usd": "0.0000005",
    }
    assert legacy_projection(derive_accounting([value])).cost_usd == "0.000001"


def test_unavailable_price_retains_reported_usage() -> None:
    value = observed()
    value["pricing"] = {
        "basis": "unavailable",
        "scope": "successful_response_only",
        "config_sha256": "2" * 64,
        "estimate_usd": None,
    }
    result = derive_accounting([value])
    assert result.input_tokens == 4
    assert result.output_tokens == 6
    assert result.estimate_usd is None
    assert result.basis == "known_partial"


def test_known_token_aggregate_overflow_projection_refused() -> None:
    value = observed()
    value["usage"] = {
        "availability": "reported",
        "input_tokens": 2147483647,
        "output_tokens": 0,
        "total_tokens": 2147483647,
    }
    result = derive_accounting([value, {**value, "call_id": uid(99)}])
    assert result.input_tokens == 4294967294
    with pytest.raises(ValueError, match="token projection overflow"):
        legacy_projection(result)


def test_configured_bare_serving_model_does_not_guess_provider_ownership() -> None:
    value = observed()
    value.update(
        planned={"provider": "openai", "model": "same"},
        serving={"provider": "openai", "model": "same", "reported_model": None},
        attempts=[{"provider": "openai", "model": "same", "outcome": "succeeded"}],
    )
    result = CallOutcome.model_validate(value)
    assert result.serving is not None
    assert result.serving.model == "same"
