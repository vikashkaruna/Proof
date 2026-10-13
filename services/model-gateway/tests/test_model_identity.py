"""Synthetic identity metadata and reviewed selector tests; no provider requests."""

import pytest

from model_gateway.completion_provenance import reported_model
from model_gateway.config import Settings
from model_gateway.model_identity import configured_model_selectors, resolve_model_selector
from model_gateway.router import decide_route


@pytest.mark.parametrize(
    "name",
    [
        "openai/gpt-4o",
        "gpt-4o",
        "gemini-2.0-flash",
        "Qwen/Qwen2.5-32B-Instruct-AWQ",
        "anthropic.claude-3-haiku-20240307-v1:0",
    ],
)
def test_exact_configured_selector_or_alias_accepted(name):
    settings = Settings(_env_file=None)
    assert resolve_model_selector(name, settings) in configured_model_selectors(settings).values()


@pytest.mark.parametrize(
    "value",
    [
        "customer@example.invalid",
        "gpt model",
        "gpt\ncanary",
        "gpt\x00",
        "gpt；secret",
        " gpt",
        "gpt ",
        "",
        "x" * 301,
    ],
)
def test_unsafe_config_and_price_metadata_refused(value):
    with pytest.raises(ValueError):
        Settings(_env_file=None, openai_model=value)
    with pytest.raises(ValueError):
        Settings(_env_file=None, cost_per_input_token={value: 0.0})
    assert reported_model(value) is None


def test_unconfigured_but_syntactically_valid_selector_not_allowed():
    with pytest.raises(ValueError, match="model_selector_unavailable"):
        resolve_model_selector("openai/gpt-4o/customer-secret", Settings(_env_file=None))


def test_ambiguous_alias_cannot_select_first_configured_identity():
    settings = Settings(_env_file=None, openai_model="openai/same", gemini_model="gemini/same")
    with pytest.raises(ValueError, match="model_selector_unavailable"):
        resolve_model_selector("same", settings)
    assert resolve_model_selector("openai/same", settings) == "openai/same"


@pytest.mark.parametrize(
    "value",
    ["gpt-4o-provider-revision", "anthropic.claude-3-5-sonnet-v1:0", "Qwen/Qwen2.5-Instruct"],
)
def test_safe_reported_revision_preserved_without_claiming_verified_identity(value):
    assert reported_model(value) == value


@pytest.mark.parametrize(
    "configuration",
    [
        {"openai_model": "same", "gemini_model": "same"},
        {"anthropic_model": "same", "openai_fallback_model": "same"},
        {"self_hosted_model": "same", "openai_model": "same"},
        {"bedrock_model": "same", "anthropic_model": "same"},
    ],
)
def test_same_bare_model_in_distinct_provider_slots_is_ambiguous(configuration):
    settings = Settings(_env_file=None, **configuration)
    with pytest.raises(ValueError, match="^model_selector_unavailable$"):
        resolve_model_selector("same", settings)
    assert "same" not in configured_model_selectors(settings)
    with pytest.raises(ValueError, match="^model_selector_unavailable$"):
        decide_route("reasoning", "same", settings)


def test_same_provider_primary_and_fallback_identity_remains_unambiguous():
    settings = Settings(_env_file=None, openai_model="same", openai_fallback_model="same")
    assert resolve_model_selector("same", settings) == "same"
