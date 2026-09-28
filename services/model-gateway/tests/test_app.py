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
    assert len(data["choices"]) == 1
    assert data["choices"][0]["message"]["role"] == "assistant"
    assert data["pii_redacted"] is True
    assert "EMAIL" in data["redactions"]
    assert "customer@example.com" not in data["choices"][0]["message"]["content"]
