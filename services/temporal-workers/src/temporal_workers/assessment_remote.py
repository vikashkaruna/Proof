"""Authenticated opaque HTTPS controller transport; no downloaded service keys."""

import asyncio
import json
import re
import ssl
from typing import Protocol
from urllib.parse import urlsplit

import httpx
from temporalio import activity

from .assessment_activity import invoke_controller
from .assessment_contracts import transport_payload

_TOKEN = re.compile(r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", re.ASCII)
_METADATA = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity"


def controller_origin(value: str) -> str:
    parsed = urlsplit(value)
    if (
        len(value) > 2048
        or not value.isascii()
        or "%" in parsed.netloc
        or parsed.port == 443
        or parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path
        or "\\" in value
        or re.search(r"[\s\x00-\x1f\x7f]", value)
        or value != f"https://{parsed.netloc}"
        or parsed.netloc != parsed.netloc.lower()
    ):
        raise ValueError("Controller origin refused")
    # Evaluates and validates an explicit port without network access.
    if parsed.port is not None and not 1 <= parsed.port <= 65535:
        raise ValueError("Controller origin refused")
    return value


class IdentityTokenProvider(Protocol):
    async def token(self, audience: str) -> str: ...


class GoogleMetadataIdentity:
    """Uses the assigned workload identity only. No environment endpoint override,
    proxy, redirect, credential file or CLI fallback. Tokens stay in memory.
    """

    async def token(self, audience: str) -> str:
        token = None
        try:
            controller_origin(audience)
            async with (
                asyncio.timeout(3),
                httpx.AsyncClient(
                    timeout=2.5, trust_env=False, follow_redirects=False
                ) as client,
                client.stream(
                    "GET",
                    _METADATA,
                    params={"audience": audience, "format": "full"},
                    headers={"Metadata-Flavor": "Google"},
                ) as response,
            ):
                if (
                    response.status_code != 200
                    or response.headers.get("Metadata-Flavor") != "Google"
                ):
                    raise ValueError("Metadata identity refused")
                body = bytearray()
                async for chunk in response.aiter_bytes(chunk_size=4096):
                    body.extend(chunk)
                    if len(body) > 8192:
                        raise ValueError("Metadata identity refused")
                value = body.decode("ascii")
                if not _TOKEN.fullmatch(value):
                    raise ValueError("Metadata identity refused")
                token = value
        except Exception:  # noqa: BLE001 — provider details and token never leave this boundary.
            token = None
        if token is None:
            raise ValueError("Scheduler identity unavailable")
        return token


class RemoteAssessmentController:
    def __init__(
        self,
        origin: str,
        identity: IdentityTokenProvider | None = None,
        tls: ssl.SSLContext | None = None,
    ):
        self.origin = controller_origin(origin)
        self.identity = identity if identity is not None else GoogleMetadataIdentity()
        if tls is not None and (
            tls.verify_mode != ssl.CERT_REQUIRED or not tls.check_hostname
        ):
            raise ValueError("Controller TLS verification required")
        self.tls = tls or ssl.create_default_context()

    async def request(self, operation: str, payload: dict):
        result = None
        try:
            payload = transport_payload(operation, payload)
            if len(json.dumps(payload).encode()) > 1024:
                raise ValueError("Private operation refused")
            # Identity acquisition is included in the total request budget.
            async with asyncio.timeout(85):
                token = await self.identity.token(self.origin)
                if len(token) > 8192 or not _TOKEN.fullmatch(token):
                    raise ValueError("Scheduler identity unavailable")
                async with (
                    httpx.AsyncClient(
                        timeout=80,
                        verify=self.tls,
                        trust_env=False,
                        follow_redirects=False,
                    ) as client,
                    client.stream(
                        "POST",
                        f"{self.origin}/assessment/{operation}",
                        json=payload,
                        headers={
                            "Authorization": f"Bearer {token}",
                            "X-Serverless-Authorization": f"Bearer {token}",
                        },
                    ) as response,
                ):
                    # The platform consumes X-Serverless-Authorization, leaving
                    # the signed Authorization token for application verification.
                    if response.status_code != 200:
                        raise ValueError("Controller unavailable")
                    body = bytearray()
                    limit = 16384 if operation.startswith("scheduling/") else 4096
                    async for chunk in response.aiter_bytes(chunk_size=4096):
                        body.extend(chunk)
                        if len(body) > limit:
                            raise ValueError("Controller response oversized")
                    result = json.loads(body)
        except Exception:  # noqa: BLE001 — no SDK/HTTP token, body or cause escapes.
            result = None
        if result is None:
            raise ValueError("Private controller unavailable")
        return result


class RemoteAssessmentControllerActivity(RemoteAssessmentController):
    @activity.defn(name="assessment_controller_v1")
    async def invoke(self, reference: dict, operation: str) -> dict:
        return await invoke_controller(self, reference, operation)
