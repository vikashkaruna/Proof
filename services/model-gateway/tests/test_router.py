"""Tests for the model router decision logic."""

from model_gateway.config import Settings
from model_gateway.router import decide_route


def test_structural_routes_to_self_hosted():
    s = Settings(
        aws_region="ap-south-1",
        bedrock_model="anthropic.claude-3-5-sonnet",
        self_hosted_model="Qwen/Qwen2.5-32B-Instruct-AWQ",
    )
    d = decide_route("structural", "", s)
    assert d.provider == "self_hosted"
    assert "Qwen" in d.model


def test_reasoning_routes_to_bedrock():
    s = Settings(
        aws_region="ap-south-1",
        bedrock_model="anthropic.claude-3-5-sonnet",
        self_hosted_model="Qwen/Qwen2.5-32B-Instruct-AWQ",
    )
    d = decide_route("reasoning", "", s)
    assert d.provider == "bedrock"
    assert "claude" in d.model


def test_explicit_claude_request_honoured():
    s = Settings(
        aws_region="ap-south-1",
        bedrock_model="anthropic.claude-3-5-sonnet",
        self_hosted_model="Qwen/Qwen2.5-32B-Instruct-AWQ",
    )
    d = decide_route("structural", s.fallback_model, s)
    assert d.provider == "bedrock"


def test_explicit_qwen_request_honoured():
    s = Settings(
        aws_region="ap-south-1",
        bedrock_model="anthropic.claude-3-5-sonnet",
        self_hosted_model="Qwen/Qwen2.5-72B",
    )
    d = decide_route("reasoning", "Qwen/Qwen2.5-72B", s)
    assert d.provider == "self_hosted"
    assert "Qwen" in d.model


def test_configured_custom_model_does_not_require_substring_provider_guessing():
    settings = Settings(_env_file=None, openai_model="custom-deployment")
    decision = decide_route("reasoning", "custom-deployment", settings)
    assert decision.provider == "openai"
    assert decision.model == "openai/custom-deployment"


def test_configured_local_model_named_gpt_remains_local():
    settings = Settings(_env_file=None, self_hosted_model="local/gpt-private")
    decision = decide_route("reasoning", "local/gpt-private", settings)
    assert decision.provider == "self_hosted"
    assert decision.model == "local/gpt-private"
