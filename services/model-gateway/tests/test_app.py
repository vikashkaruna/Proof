"""Tests for the Model Gateway FastAPI application endpoints."""

import pytest
from fastapi.testclient import TestClient

from model_gateway.app import app
from model_gateway.config import Settings


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client


def test_health_endpoint(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_ready_endpoint(client):
    response = client.get("/ready")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ready"
    assert "providers" in data
    assert "redaction_enabled" in data


def test_complete_classification_task(client):
    payload = {
        "prompt": "Classify this data table: user records",
        "task": "classification",
        "temperature": 0.0,
        "max_tokens": 100,
    }
    response = client.post("/v1/complete", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert "text" in data
    assert "category" in data["text"]
    assert data["total_tokens"] > 0
    assert data["model_id"] != ""


def test_complete_structural_and_embedding(client):
    # Structural
    res_struct = client.post(
        "/v1/complete",
        json={"prompt": "Validate schema", "task": "structural"},
    )
    assert res_struct.status_code == 200
    assert "ok" in res_struct.json()["text"]

    # Embedding
    res_embed = client.post(
        "/v1/complete",
        json={"prompt": "Vectorize this", "task": "embedding"},
    )
    assert res_embed.status_code == 200
    assert "[" in res_embed.json()["text"]


def test_complete_pii_redaction_and_variables(client):
    payload = {
        "prompt": "Process user PAN: ABCDE1234F and name: {{user_name}}",
        "task": "reasoning",
        "variables": {"user_name": "Ramesh Gupta"},
        "pii_redact": True,
    }
    response = client.post("/v1/complete", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert data["pii_redacted"] is True
    assert "PAN" in data["redactions"]
    assert "ABCDE1234F" not in data["text"]


def test_complete_api_key_auth(client):
    original_key = app.state.settings.api_key
    try:
        app.state.settings.api_key = "secret-gateway-key"
        # Without auth header
        res_no_auth = client.post("/v1/complete", json={"prompt": "Test"})
        assert res_no_auth.status_code == 401

        # With wrong auth header
        res_wrong = client.post(
            "/v1/complete",
            json={"prompt": "Test"},
            headers={"Authorization": "Bearer wrong-key"},
        )
        assert res_wrong.status_code == 401

        # With correct auth header
        res_ok = client.post(
            "/v1/complete",
            json={"prompt": "Test"},
            headers={"Authorization": "Bearer secret-gateway-key"},
        )
        assert res_ok.status_code == 200
    finally:
        app.state.settings.api_key = original_key


def test_chat_completions_endpoint(client):
    payload = {
        "model": "stub-dpdpa-specialist",
        "messages": [
            {"role": "system", "content": "You are a DPDPA auditor."},
            {"role": "user", "content": "Customer email is customer@example.com."},
        ],
        "pii_redact": True,
    }
    response = client.post("/v1/chat/completions", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert data["object"] == "chat.completion"
    assert data["pii_redacted"] is True
    assert "EMAIL" in data["redactions"]
    assert "customer@example.com" not in data["choices"][0]["message"]["content"]


def test_complete_duplicate_variable_redaction(client):
    payload = {
        "prompt": "PAN is ABCDE1234F",
        "task": "reasoning",
        "variables": {"pan": "ABCDE1234F"},
        "pii_redact": True,
    }
    response = client.post("/v1/complete", json=payload)
    assert response.status_code == 200
    assert response.json()["redactions"]["PAN"] >= 2


def test_chat_completions_non_stub_model(client):
    payload = {
        "model": "claude-3-5-sonnet-20241022",
        "messages": [{"role": "user", "content": "Explain DPDPA principles"}],
        "pii_redact": True,
    }
    response = client.post("/v1/chat/completions", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert "[Model Gateway ·" in data["choices"][0]["message"]["content"]


def test_live_provider_dispatch_and_failover(client, monkeypatch):
    from unittest.mock import AsyncMock, MagicMock
    import model_gateway.app as app_mod

    original_key = app_mod.app.state.settings.anthropic_api_key
    app_mod.app.state.settings.anthropic_api_key = "test-anthropic-key"

    class MockUsage:
        prompt_tokens = 10
        completion_tokens = 20

    class MockChoice:
        message = MagicMock(content="Live LLM response")

    class MockResponse:
        choices = [MockChoice()]
        usage = MockUsage()

    mock_acompletion = AsyncMock(return_value=MockResponse())
    monkeypatch.setattr("litellm.acompletion", mock_acompletion)

    try:
        res = client.post(
            "/v1/complete",
            json={"prompt": "Hello live model", "task": "reasoning"},
        )
        assert res.status_code == 200
        assert res.json()["text"] == "Live LLM response"

        # Now test failover when provider raises exception
        mock_acompletion.side_effect = RuntimeError("Upstream API error")
        res_failover = client.post(
            "/v1/complete",
            json={"prompt": "Hello failover model", "task": "reasoning"},
        )
        assert res_failover.status_code == 200
        assert len(res_failover.json()["text"]) > 0
    finally:
        app_mod.app.state.settings.anthropic_api_key = original_key


