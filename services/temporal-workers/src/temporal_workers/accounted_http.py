"""Unmounted bounded HTTP port owned by the controller/activity, never an agent."""

import asyncio
from urllib.parse import urlsplit

import httpx
from axiom_model_accounting import _packet


class AccountedRuntimeHttpPort:
    def __init__(
        self, client: httpx.AsyncClient, base_url: str, internal_token: str
    ) -> None:
        parsed = urlsplit(base_url)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or not internal_token
        ):
            raise ValueError("accounted_runtime_configuration_refused")
        self._client = client
        self._url = base_url.rstrip("/") + "/accounted-agents/invoke"
        self._token = internal_token

    async def invoke(self, request: dict[str, str]) -> object:
        try:
            async with (
                asyncio.timeout(65),
                self._client.stream(
                    "POST",
                    self._url,
                    json=request,
                    headers={"X-Internal-Token": self._token},
                    timeout=65,
                    follow_redirects=False,
                ) as response,
            ):
                if response.status_code != 200:
                    raise ValueError("accounted_runtime_refused")
                body = bytearray()
                async for chunk in response.aiter_bytes(chunk_size=65536):
                    if len(body) + len(chunk) > 2097152:
                        raise ValueError("accounted_runtime_refused")
                    body.extend(chunk)
                return _packet(body.decode("utf-8"), 2097152)
        except httpx.HTTPError, TimeoutError, ValueError, TypeError, RuntimeError:
            raise ValueError("accounted_runtime_unconfirmed") from None
