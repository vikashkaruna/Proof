"""Tests for the Model Gateway FastAPI application endpoints."""

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from model_gateway.app import app
from model_gateway.config import Settings


@pytest.fixture
def client(monkeypatch):
    import json
    from types import SimpleNamespace

    async def provider(**kwargs):
        content = json.dumps(
            {
                "category": "other",
                "ok": True,
                "vector": [0],
                "prompt": kwargs["messages"][0]["content"],
            }
        )
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=content))],
            usage=SimpleNamespace(prompt_tokens=10, completion_tokens=20),
        )

    for key in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr("litellm.acompletion", provider)
    with TestClient(app) as test_client:
        app.state.settings = Settings(
            _env_file=None,
            anthropic_api_key="synthetic-provider-key",
            openai_api_key=None,
            gemini_api_key=None,
        )
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
    assert response.status_code == 503
    assert response.json() == {"detail": "chat_provider_unavailable"}


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
    assert response.status_code == 503
    assert response.json() == {"detail": "chat_provider_unavailable"}


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
        def __init__(self):
            self.choices = [MockChoice()]
            self.usage = MockUsage()

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
        assert res_failover.status_code == 503
        assert res_failover.json() == {"detail": "model_provider_unavailable"}
    finally:
        app_mod.app.state.settings.anthropic_api_key = original_key


def test_onprem_rejects_hosted_keys_and_external_model_urls():
    with pytest.raises(ValueError, match="Hosted model keys"):
        Settings(environment="onprem", api_key="private", anthropic_api_key="hosted")
    with pytest.raises(ValueError, match="local-model"):
        Settings(
            environment="onprem", api_key="private", self_hosted_base_url="https://example.com"
        )


def test_onprem_model_unavailable_is_explicit_and_auth_required(client):
    from model_gateway.router import decide_route

    original = app.state.settings
    try:
        app.state.settings = Settings(environment="onprem", api_key="private")
        decision = decide_route("reasoning", "openai/gpt-4o", app.state.settings)
        assert decision.provider == "self_hosted"
        assert decision.fallback_chain == ()
        unauthorized = client.post(
            "/v1/chat/completions", json={"messages": [{"role": "user", "content": "hello"}]}
        )
        assert unauthorized.status_code == 401
        headers = {"Authorization": "Bearer private"}
        complete = client.post(
            "/v1/complete", headers=headers, json={"prompt": "hello", "model": "openai/gpt-4o"}
        )
        chat = client.post(
            "/v1/chat/completions",
            headers=headers,
            json={"messages": [{"role": "user", "content": "hello"}]},
        )
        assert complete.status_code == 503
        assert complete.json()["detail"] == "local_model_unavailable"
        assert chat.status_code == 503
        assert chat.json()["detail"] == "local_model_unavailable"
    finally:
        app.state.settings = original


def test_onprem_license_expiry_blocks_local_inference(client):
    with patch.dict("os.environ", {"ENVIRONMENT": "onprem", "AXIOM_OFFLINE_LICENSE": "expired"}):
        assert client.get("/health").status_code == 200
        assert client.get("/ready").status_code == 503
        response = client.post("/v1/complete", json={"prompt": "hello"})
        assert response.status_code == 403
        assert response.json() == {"error": "offline_license_invalid"}


@pytest.mark.parametrize(
    ("prompt", "variables", "raw_pii"),
    [
        ("Email: customer@example.com", {}, "customer@example.com"),
        ("Email: customer{{domain}}", {"domain": "@example.com"}, "customer@example.com"),
    ],
)
def test_hosted_fallback_redacts_final_composition(client, monkeypatch, prompt, variables, raw_pii):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    import model_gateway.app as app_mod

    # Synthetic settings and a mocked provider prevent any credential/provider use.
    monkeypatch.setattr(app_mod.app.state.settings, "anthropic_api_key", "test-egress-provider")
    monkeypatch.setattr(app_mod.app.state.settings, "openai_api_key", None)
    monkeypatch.setattr(app_mod.app.state.settings, "gemini_api_key", None)
    provider = AsyncMock(
        return_value=SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="Reviewed"))],
            usage=SimpleNamespace(prompt_tokens=3, completion_tokens=2),
        )
    )
    monkeypatch.setattr("litellm.acompletion", provider)
    response = client.post(
        "/v1/complete",
        json={
            "prompt": prompt,
            "variables": variables,
            "task": "structural",
            "pii_redact": False,
        },
    )
    assert response.status_code == 200
    assert provider.await_count == 1
    dispatched = provider.await_args.kwargs["messages"][0]["content"]
    assert raw_pii not in dispatched
    assert "[REDACTED:EMAIL]" in dispatched
    assert response.json()["pii_redacted"] is True
    assert response.json()["redactions"]["EMAIL"] == 1


@pytest.mark.parametrize("unavailable", ["disabled", "raises", "malformed"])
def test_hosted_fallback_refuses_unavailable_redaction_before_provider(
    client, monkeypatch, unavailable
):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    import model_gateway.app as app_mod

    monkeypatch.setattr(app_mod.app.state.settings, "anthropic_api_key", "test-egress-provider")
    monkeypatch.setattr(app_mod.app.state.settings, "openai_api_key", None)
    monkeypatch.setattr(app_mod.app.state.settings, "gemini_api_key", None)
    provider = AsyncMock(
        return_value=SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="Reviewed"))],
            usage=SimpleNamespace(prompt_tokens=3, completion_tokens=2),
        )
    )
    monkeypatch.setattr("litellm.acompletion", provider)
    if unavailable == "disabled":
        monkeypatch.setattr(app_mod.app.state.settings, "pii_redaction_enabled", False)
    elif unavailable == "raises":

        def refuse_redaction(_text):
            raise RuntimeError("synthetic-redaction-failure customer@example.com")

        monkeypatch.setattr(app_mod, "redact", refuse_redaction)
    else:
        monkeypatch.setattr(app_mod, "redact", lambda _text: None)
    response = client.post(
        "/v1/complete",
        json={
            "prompt": "Email: customer@example.com",
            "task": "structural",
            "pii_redact": False,
        },
    )
    assert provider.await_count == 0
    assert response.status_code == 503
    assert response.json() == {"detail": "hosted_redaction_unavailable"}


@pytest.mark.parametrize("redaction_fails_on_retry", [False, True])
def test_every_hosted_retry_rechecks_final_redaction(
    client, monkeypatch, redaction_fails_on_retry, capsys
):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, Mock

    import model_gateway.app as app_mod

    monkeypatch.setattr(app_mod.app.state.settings, "anthropic_api_key", "test-egress-provider")
    monkeypatch.setattr(app_mod.app.state.settings, "openai_api_key", "test-retry-provider")
    monkeypatch.setattr(app_mod.app.state.settings, "gemini_api_key", None)
    calls = []

    async def provider(**kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            raise RuntimeError("synthetic first provider unavailable")
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="Reviewed"))],
            usage=SimpleNamespace(prompt_tokens=3, completion_tokens=2),
        )

    mocked_provider = AsyncMock(side_effect=provider)
    monkeypatch.setattr("litellm.acompletion", mocked_provider)
    actual_redact = app_mod.redact

    def guarded_redaction(text):
        if redaction_fails_on_retry and len(calls) == 1:
            raise RuntimeError("private-redactor-marker customer@example.com")
        return actual_redact(text)

    redactor = Mock(side_effect=guarded_redaction)
    monkeypatch.setattr(app_mod, "redact", redactor)
    response = client.post(
        "/v1/complete",
        json={
            "prompt": "Email: customer{{domain}}",
            "variables": {"domain": "@example.com"},
            "task": "structural",
            "pii_redact": False,
        },
    )
    assert redactor.call_count == 2
    assert all("customer@example.com" not in call["messages"][0]["content"] for call in calls)
    if redaction_fails_on_retry:
        assert mocked_provider.await_count == 1
        assert response.status_code == 503
        assert response.json() == {"detail": "hosted_redaction_unavailable"}
        assert "private-redactor-marker" not in capsys.readouterr().out
    else:
        assert mocked_provider.await_count == 2
        assert response.status_code == 200
        assert response.json()["pii_redacted"] is True
        assert response.json()["redactions"]["EMAIL"] == 1


@pytest.mark.parametrize("phase", ["template", "variables"])
def test_initial_redactor_failure_is_bounded_and_never_dispatches(
    client, monkeypatch, phase, capsys
):
    from unittest.mock import AsyncMock

    import model_gateway.app as app_mod

    provider = AsyncMock()
    monkeypatch.setattr("litellm.acompletion", provider)

    def unavailable(_value):
        raise RuntimeError("private-initial-redactor-marker customer@example.com")

    monkeypatch.setattr(
        app_mod, "redact" if phase == "template" else "redact_variables", unavailable
    )
    response = client.post(
        "/v1/complete",
        json={
            "prompt": "Email: {{customer}}",
            "variables": {"customer": "customer@example.com"},
            "task": "reasoning",
            "pii_redact": True,
        },
    )
    assert response.status_code == 503
    assert response.json() == {"detail": "redaction_unavailable"}
    assert provider.await_count == 0
    assert "private-initial-redactor-marker" not in capsys.readouterr().out


@pytest.mark.parametrize(
    "environment", ["development", "test", "staging", "preprod", "production", "onprem"]
)
@pytest.mark.parametrize("exhausted", [False, True])
def test_ordinary_environment_provider_failure_is_bounded(
    client, monkeypatch, capsys, environment, exhausted
):
    from unittest.mock import AsyncMock

    import model_gateway.app as app_mod

    marker = "sensitive-customer-value@example.invalid"
    for key in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    original = app_mod.app.state.settings
    settings = Settings(
        _env_file=None,
        environment=environment,
        api_key="private",
        anthropic_api_key=None,
        openai_api_key=None,
        gemini_api_key=None,
    )
    if exhausted and environment != "onprem":
        settings.anthropic_api_key = "synthetic-provider-key"
    local_calls = []
    if exhausted and environment == "onprem":
        import httpx

        settings.self_hosted_base_url = "http://local-model:8000"
        factory = httpx.AsyncClient

        def local_failure(request):
            local_calls.append(request)
            raise httpx.ConnectError(marker, request=request)

        monkeypatch.setattr(
            httpx,
            "AsyncClient",
            lambda **kwargs: factory(**kwargs, transport=httpx.MockTransport(local_failure)),
        )
    mock = AsyncMock(side_effect=RuntimeError(marker))
    monkeypatch.setattr("litellm.acompletion", mock)
    app_mod.app.state.settings = settings
    try:
        response = client.post(
            "/v1/complete",
            headers={"Authorization": "Bearer private"},
            json={"prompt": "test", "model": "stub-dpdpa-specialist"},
        )
        assert response.status_code == 503
        assert response.json() == {
            "detail": "local_model_unavailable"
            if environment == "onprem"
            else "model_provider_unavailable"
        }
        assert marker not in response.text
        assert marker not in capsys.readouterr().out
        assert mock.await_count == (1 if exhausted and environment != "onprem" else 0)
        assert len(local_calls) == (1 if exhausted and environment == "onprem" else 0)
    finally:
        app_mod.app.state.settings = original


@pytest.mark.parametrize("environment", ["development", "test", "staging", "preprod", "production"])
@pytest.mark.parametrize("model", ["stub-dpdpa-specialist", "claude-3-5-sonnet-20241022"])
def test_ordinary_chat_cannot_fabricate_success(client, monkeypatch, environment, model):
    from unittest.mock import AsyncMock

    import model_gateway.app as app_mod

    original = app_mod.app.state.settings
    app_mod.app.state.settings = Settings(
        _env_file=None,
        environment=environment,
        api_key="private",
        anthropic_api_key=None,
        openai_api_key=None,
        gemini_api_key=None,
    )
    mock = AsyncMock()
    monkeypatch.setattr("litellm.acompletion", mock)
    try:
        response = client.post(
            "/v1/chat/completions",
            headers={"Authorization": "Bearer private"},
            json={
                "model": model,
                "messages": [{"role": "user", "content": "test"}],
                "tenant_id": "00000000-0000-4000-8000-000000000001",
            },
        )
        assert response.status_code == 503
        assert response.json() == {"detail": "chat_provider_unavailable"}
        mock.assert_not_awaited()
    finally:
        app_mod.app.state.settings = original


@pytest.mark.parametrize("endpoint", ["/v1/complete", "/v1/chat/completions"])
def test_onprem_actual_adapter_success_is_preserved(client, monkeypatch, endpoint):
    import httpx

    import model_gateway.app as app_mod

    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": "Actual local adapter result"}}],
                "usage": {"prompt_tokens": 7, "completion_tokens": 8},
            },
        )

    factory = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: factory(**kwargs, transport=httpx.MockTransport(handler)),
    )
    original = app_mod.app.state.settings
    app_mod.app.state.settings = Settings(
        _env_file=None,
        environment="onprem",
        api_key="private",
        self_hosted_base_url="http://local-model:8000",
        anthropic_api_key=None,
        openai_api_key=None,
        gemini_api_key=None,
    )
    try:
        payload = (
            {"prompt": "test"}
            if endpoint.endswith("complete")
            else {"model": "local", "messages": [{"role": "user", "content": "test"}]}
        )
        response = client.post(endpoint, headers={"Authorization": "Bearer private"}, json=payload)
        assert response.status_code == 200
        data = response.json()
        assert (
            data["text"]
            if endpoint.endswith("complete")
            else data["choices"][0]["message"]["content"]
        ) == "Actual local adapter result"
        assert (
            data["total_tokens"] if endpoint.endswith("complete") else data["usage"]["total_tokens"]
        ) == 15
        assert len(seen) == 1
        assert str(seen[0].url) == "http://local-model:8000/v1/chat/completions"
    finally:
        app_mod.app.state.settings = original
