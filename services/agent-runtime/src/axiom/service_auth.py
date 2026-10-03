"""Optional Google ID-token auth for service-to-service calls (defence in depth).

AXIOM_SERVICE_AUTH unset/empty: no headers, no network call.
AXIOM_SERVICE_AUTH=gcp-id-token: mint an ID token from the metadata server for
the target's origin and return it in X-Serverless-Authorization, the header
Cloud Run IAM consumes (leaving Authorization free for the app's own key).
Any other value raises. Fails closed: if a token cannot be obtained the caller
must not make the downstream request.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import time
from collections.abc import Awaitable, Callable, Mapping
from urllib.parse import urlsplit

import httpx

ENV_VAR = "AXIOM_SERVICE_AUTH"
MODE_GCP = "gcp-id-token"
HEADER = "X-Serverless-Authorization"
_METADATA = (
    "http://metadata.google.internal/computeMetadata/v1/instance/"
    "service-accounts/default/identity"
)
_TIMEOUT = 2.0
_SKEW = 300.0
_FALLBACK_TTL = 50 * 60.0

# fetch(url, params, headers, timeout) -> (status_code, body_text)
Fetch = Callable[[str, dict[str, str], dict[str, str], float], Awaitable[tuple[int, str]]]


class ServiceAuthError(RuntimeError):
    pass


_cache: dict[str, tuple[str, float]] = {}
_locks: dict[str, asyncio.Lock] = {}


def reset_cache_for_tests() -> None:
    _cache.clear()
    _locks.clear()


async def _default_fetch(
    url: str, params: dict[str, str], headers: dict[str, str], timeout: float
) -> tuple[int, str]:
    async with httpx.AsyncClient(
        timeout=timeout, trust_env=False, follow_redirects=False
    ) as client:
        r = await client.get(url, params=params, headers=headers)
        return r.status_code, r.text


def _origin(target_url: str) -> str:
    parts = urlsplit(target_url)
    if not parts.scheme or not parts.hostname:
        raise ServiceAuthError("service auth: target URL has no scheme/host")
    host = parts.netloc.rsplit("@", 1)[-1]
    return f"{parts.scheme}://{host}"


def _expiry(token: str, now: float) -> float:
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        exp = json.loads(base64.urlsafe_b64decode(payload))["exp"]
        if isinstance(exp, bool) or not isinstance(exp, (int, float)):
            raise ValueError
        return float(exp) - _SKEW
    except Exception:  # noqa: BLE001 - unparsable exp falls back to a fixed TTL
        return now + _FALLBACK_TTL


async def service_auth_headers(
    target_url: str,
    *,
    env: Mapping[str, str] | None = None,
    fetch: Fetch | None = None,
    now: Callable[[], float] | None = None,
) -> dict[str, str]:
    mode = ((env if env is not None else os.environ).get(ENV_VAR) or "").strip()
    if not mode:
        return {}
    if mode != MODE_GCP:
        raise ServiceAuthError(f"{ENV_VAR}: unsupported value {mode!r}")
    clock = now or time.time
    audience = _origin(target_url)

    def cached() -> str | None:
        hit = _cache.get(audience)
        return hit[0] if hit and clock() < hit[1] else None

    token = cached()
    if token is None:
        lock = _locks.setdefault(audience, asyncio.Lock())
        async with lock:
            token = cached()
            if token is None:
                token = await _mint(audience, fetch or _default_fetch)
                _cache[audience] = (token, _expiry(token, clock()))
    return {HEADER: f"Bearer {token}"}


async def _mint(audience: str, fetch: Fetch) -> str:
    try:
        status, body = await fetch(
            _METADATA,
            {"audience": audience, "format": "full"},
            {"Metadata-Flavor": "Google"},
            _TIMEOUT,
        )
    except Exception as exc:  # noqa: BLE001
        raise ServiceAuthError(
            f"service auth: metadata server unreachable ({type(exc).__name__})"
        ) from None
    token = (body or "").strip()
    if status != 200 or not token:
        raise ServiceAuthError(
            f"service auth: metadata server refused (status {status}, "
            f"{'empty' if not token else 'non-200'} body)"
        )
    return token
