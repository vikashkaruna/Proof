"""The actual deployment variable must protect every runtime invocation."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from axiom.agents.base import AgentName, AgentRunResult
from axiom.app import app
from axiom.config import Settings


def test_canonical_deployment_variable_is_loaded(monkeypatch):
    monkeypatch.delenv("INTERNAL_TOKEN", raising=False)
    monkeypatch.setenv("AGENT_RUNTIME_INTERNAL_TOKEN", "canonical-fixture-token")
    assert Settings(_env_file=None).internal_token == "canonical-fixture-token"


def test_legacy_variable_remains_compatible_and_canonical_takes_precedence(monkeypatch):
    monkeypatch.delenv("AGENT_RUNTIME_INTERNAL_TOKEN", raising=False)
    monkeypatch.setenv("INTERNAL_TOKEN", "legacy-fixture-token")
    assert Settings(_env_file=None).internal_token == "legacy-fixture-token"
    monkeypatch.setenv("AGENT_RUNTIME_INTERNAL_TOKEN", "canonical-fixture-token")
    assert Settings(_env_file=None).internal_token == "canonical-fixture-token"


@pytest.mark.parametrize("configured", [None, "", "configured-fixture-token"])
@pytest.mark.parametrize("supplied", [None, "", "wrong-fixture-token"])
def test_generic_invocation_requires_configured_matching_auth(monkeypatch, configured, supplied):
    invoke = AsyncMock()
    monkeypatch.setattr(
        app.state, "settings", SimpleNamespace(internal_token=configured), raising=False
    )
    monkeypatch.setattr(
        app.state, "agents", {AgentName.DRISHTI: SimpleNamespace(invoke=invoke)}, raising=False
    )
    client = TestClient(app)
    response = client.post(
        "/agents/drishti/invoke",
        json={"input": {}},
        headers={} if supplied is None else {"X-Internal-Token": supplied},
    )
    assert response.status_code == 401
    assert response.json() == {"detail": "invalid internal token"}
    invoke.assert_not_called()


def test_deployment_variable_protects_real_http_route(monkeypatch):
    monkeypatch.setenv("AGENT_RUNTIME_INTERNAL_TOKEN", "canonical-fixture-token")
    settings = Settings(_env_file=None)
    invoke = AsyncMock(
        return_value=AgentRunResult(
            agent=AgentName.DRISHTI, correlation_id="fixture-correlation", status="succeeded"
        )
    )
    agent = SimpleNamespace(name=AgentName.DRISHTI, invoke=invoke)
    monkeypatch.setattr(app.state, "settings", settings, raising=False)
    monkeypatch.setattr(app.state, "agents", {AgentName.DRISHTI: agent}, raising=False)
    client = TestClient(app)
    assert client.post("/agents/drishti/invoke", json={"input": {}}).status_code == 401
    response = client.post(
        "/agents/drishti/invoke",
        json={"input": {}},
        headers={"X-Internal-Token": "canonical-fixture-token"},
    )
    assert response.status_code == 200
    invoke.assert_awaited_once()


def test_authentication_precedes_agent_lookup(monkeypatch):
    monkeypatch.setattr(app.state, "settings", SimpleNamespace(internal_token=None), raising=False)
    client = TestClient(app)
    assert client.post("/agents/unknown/invoke", json={"input": {}}).status_code == 401
