"""W0.0 · SEC-11 — the Temporal workers must not run without a real credential."""

from __future__ import annotations

import pytest

from temporal_workers.config import HARDENED_ENVIRONMENTS, Settings


def _settings(**overrides) -> Settings:
    base = {
        "environment": "production",
        "agent_runtime_internal_token": "a" * 48,
    }
    base.update(overrides)
    return Settings(**base)  # type: ignore[arg-type]


@pytest.mark.parametrize("environment", HARDENED_ENVIRONMENTS)
def test_missing_token_refused_in_every_deployed_environment(environment: str) -> None:
    with pytest.raises(ValueError, match="AGENT_RUNTIME_INTERNAL_TOKEN"):
        _settings(environment=environment, agent_runtime_internal_token=None)


@pytest.mark.parametrize(
    "token",
    [
        # The exact literal that shipped in workflows.py, never substituted.
        "{{AGENT_RUNTIME_INTERNAL_TOKEN}}",
        "<placeholder-token>",
        "dev-agent-runtime-token-axiom",
        "changeme",
        "your-token-here",
    ],
)
def test_placeholder_tokens_refused(token: str) -> None:
    with pytest.raises(ValueError, match="placeholder"):
        _settings(agent_runtime_internal_token=token)


def test_real_token_accepted() -> None:
    settings = _settings()
    assert settings.internal_headers == {"X-Internal-Token": "a" * 48}


@pytest.mark.parametrize("environment", ["development", "local", "test"])
def test_non_deployed_environments_are_not_gated(environment: str) -> None:
    settings = _settings(environment=environment, agent_runtime_internal_token=None)
    # No credential available, and the headers say so rather than sending a
    # literal template string.
    assert settings.internal_headers == {}


def test_agent_runtime_url_is_topology_and_overridable() -> None:
    settings = _settings(agent_runtime_url="https://agent-runtime.preprod.example")
    assert settings.agent_runtime_url == "https://agent-runtime.preprod.example"
