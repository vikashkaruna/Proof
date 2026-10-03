"""Optional Google ID-token service auth. No network: fetch is injected."""

from __future__ import annotations

import base64
import json

import httpx
import pytest
from temporal_workers import activities
from temporal_workers import service_auth as sa
from temporal_workers.config import Settings
from test_orchestration import assignment, response

ON = {"AXIOM_SERVICE_AUTH": "gcp-id-token"}
CORRELATION = "00000000-0000-4000-8000-000000000001"


def jwt(exp):
    def b(d):
        return base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()

    return f"{b({'alg': 'none'})}.{b({'exp': exp})}.sig"


class Fetch:
    def __init__(self, status=200, body=None, exc=None):
        self.calls = []
        self.status, self.body, self.exc = status, body, exc

    async def __call__(self, url, params, headers, timeout):
        self.calls.append((url, params, headers, timeout))
        if self.exc:
            raise self.exc
        return self.status, self.body if self.body is not None else jwt(10_000)


@pytest.fixture(autouse=True)
def _reset():
    sa.reset_cache_for_tests()
    yield
    sa.reset_cache_for_tests()


@pytest.mark.parametrize("env", [{}, {"AXIOM_SERVICE_AUTH": ""}, {"AXIOM_SERVICE_AUTH": "  "}])
async def test_disabled_returns_empty_without_fetch(env):
    f = Fetch()
    assert await sa.service_auth_headers("http://x", env=env, fetch=f) == {}
    assert f.calls == []


async def test_enabled_header_and_origin_audience():
    f = Fetch()
    h = await sa.service_auth_headers(
        "https://rt.run.app:8443/agents/x/invoke?q=1", env=ON, fetch=f, now=lambda: 0
    )
    assert h == {"X-Serverless-Authorization": f"Bearer {jwt(10_000)}"}
    url, params, headers, timeout = f.calls[0]
    assert url.startswith("http://metadata.google.internal/")
    assert params == {"audience": "https://rt.run.app:8443", "format": "full"}
    assert headers == {"Metadata-Flavor": "Google"}
    assert timeout == 2.0


async def test_cache_hit_and_per_audience():
    f = Fetch()
    for _ in range(3):
        await sa.service_auth_headers("https://a/x", env=ON, fetch=f, now=lambda: 0)
    assert len(f.calls) == 1
    await sa.service_auth_headers("https://b/x", env=ON, fetch=f, now=lambda: 0)
    assert len(f.calls) == 2


async def test_expiry_refetch():
    f = Fetch(body=jwt(1000))
    await sa.service_auth_headers("https://a", env=ON, fetch=f, now=lambda: 600)
    await sa.service_auth_headers("https://a", env=ON, fetch=f, now=lambda: 699)
    assert len(f.calls) == 1
    await sa.service_auth_headers("https://a", env=ON, fetch=f, now=lambda: 700)
    assert len(f.calls) == 2


async def test_unparsable_exp_caches_fifty_minutes():
    f = Fetch(body="not-a-jwt")
    await sa.service_auth_headers("https://a", env=ON, fetch=f, now=lambda: 0)
    await sa.service_auth_headers("https://a", env=ON, fetch=f, now=lambda: 2999)
    assert len(f.calls) == 1
    await sa.service_auth_headers("https://a", env=ON, fetch=f, now=lambda: 3000)
    assert len(f.calls) == 2


async def test_concurrent_fetches_deduped():
    import asyncio

    f = Fetch()
    await asyncio.gather(
        *(sa.service_auth_headers("https://a", env=ON, fetch=f, now=lambda: 0) for _ in range(5))
    )
    assert len(f.calls) == 1


@pytest.mark.parametrize(
    "f",
    [Fetch(exc=OSError("down")), Fetch(status=403), Fetch(body=""), Fetch(body="  \n")],
)
async def test_fail_closed(f):
    with pytest.raises(sa.ServiceAuthError):
        await sa.service_auth_headers("https://a", env=ON, fetch=f)


async def test_unknown_mode_raises():
    f = Fetch()
    with pytest.raises(sa.ServiceAuthError):
        await sa.service_auth_headers("https://a", env={"AXIOM_SERVICE_AUTH": "gcp"}, fetch=f)
    assert f.calls == []


def _setup(monkeypatch, handler):
    client = httpx.AsyncClient
    config = Settings(
        environment="test",
        agent_runtime_url="http://synthetic.invalid/base",
        agent_runtime_internal_token="synthetic-token",
    )
    monkeypatch.setattr(activities, "get_settings", lambda: config)
    monkeypatch.setattr(
        activities.httpx,
        "AsyncClient",
        lambda **kw: client(transport=httpx.MockTransport(handler), **kw),
    )


async def test_integration_header_reaches_runtime_when_enabled(monkeypatch):
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json=response("drishti", CORRELATION))

    _setup(monkeypatch, handler)
    f = Fetch()
    real = sa.service_auth_headers

    async def patched(url, **kw):
        return await real(url, env=ON, fetch=f)

    monkeypatch.setattr(activities, "service_auth_headers", patched)
    await activities.call_agent_runtime("drishti", assignment(), CORRELATION)
    assert seen[0].headers["X-Serverless-Authorization"] == f"Bearer {jwt(10_000)}"
    assert seen[0].headers["X-Internal-Token"] == "synthetic-token"
    assert f.calls[0][1]["audience"] == "http://synthetic.invalid"


async def test_integration_absent_when_disabled(monkeypatch):
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json=response("drishti", CORRELATION))

    _setup(monkeypatch, handler)
    monkeypatch.delenv("AXIOM_SERVICE_AUTH", raising=False)
    await activities.call_agent_runtime("drishti", assignment(), CORRELATION)
    assert "X-Serverless-Authorization" not in seen[0].headers
    assert seen[0].headers["X-Internal-Token"] == "synthetic-token"


async def test_integration_token_failure_makes_no_request(monkeypatch):
    seen = []
    _setup(monkeypatch, lambda r: seen.append(r) or httpx.Response(200))
    monkeypatch.setenv("AXIOM_SERVICE_AUTH", "gcp-id-token")
    monkeypatch.setattr(sa, "_default_fetch", Fetch(status=500))
    with pytest.raises(Exception):
        await activities.call_agent_runtime("drishti", assignment(), CORRELATION)
    assert seen == []
