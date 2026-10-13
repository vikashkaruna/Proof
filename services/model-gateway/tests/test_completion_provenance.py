"""Usage and pricing facts are independent of response content and route intent."""

from types import SimpleNamespace

import pytest

from model_gateway.completion_provenance import object_hash, price_usage, read_usage
from model_gateway.config import Settings


@pytest.mark.parametrize(
    "value",
    [
        None,
        {},
        {"prompt_tokens": 1},
        {"prompt_tokens": False, "completion_tokens": 2},
        {"prompt_tokens": 1.0, "completion_tokens": 2},
        {"prompt_tokens": "1", "completion_tokens": 2},
        {"prompt_tokens": -1, "completion_tokens": 2},
        {"prompt_tokens": 1, "completion_tokens": float("nan")},
        {"prompt_tokens": 2147483648, "completion_tokens": 0},
        {"prompt_tokens": 2147483647, "completion_tokens": 1},
        {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": True},
        {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 4},
    ],
)
def test_usage_refuses_coercion_missing_and_inconsistent(value):
    usage = read_usage(value)
    assert usage.availability == "unavailable"
    assert (usage.input_tokens, usage.output_tokens, usage.total_tokens) == (None, None, None)


@pytest.mark.parametrize(
    "value",
    [
        {"prompt_tokens": 0, "completion_tokens": 0},
        SimpleNamespace(prompt_tokens=2, completion_tokens=3, total_tokens=5),
        {"prompt_tokens": 2147483647, "completion_tokens": 0, "total_tokens": 2147483647},
    ],
)
def test_valid_reported_usage(value):
    usage = read_usage(value)
    assert usage.availability == "reported"
    assert usage.total_tokens == usage.input_tokens + usage.output_tokens


def test_price_configuration_digest_changes_with_rate_and_model():
    usage = read_usage({"prompt_tokens": 2, "completion_tokens": 3})
    first = price_usage("openai/m", usage, {"openai/m": 0.1}, {"openai/m": 0.2})
    changed = price_usage("openai/m", usage, {"openai/m": 0.2}, {"openai/m": 0.2})
    assert first.cost_usd == pytest.approx(0.8)
    assert first.config_sha256 != changed.config_sha256
    assert first.config_sha256 == object_hash(
        {
            "schema_version": 1,
            "basis": "configuration_estimate",
            "model": "openai/m",
            "input_rate": 0.1,
            "output_rate": 0.2,
        }
    )
    assert price_usage("other", usage, {"openai/m": 0.1}, {"openai/m": 0.2}).cost_usd is None
    assert price_usage("m", read_usage(None), {"m": 0.0}, {"m": 0.0}).cost_usd is None
    assert price_usage("m", usage, {"m": 10000.0}, {"m": 10000.0}).reason == "cost_out_of_bounds"


@pytest.mark.parametrize("rate", [-1.0, float("nan"), float("inf")])
def test_invalid_configured_prices_refused(rate):
    with pytest.raises(ValueError):
        Settings(_env_file=None, cost_per_input_token={"m": rate})
