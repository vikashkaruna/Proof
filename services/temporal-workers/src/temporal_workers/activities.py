"""HTTP activities. Fail closed on ambiguous responses; never log private bodies."""

from __future__ import annotations

import asyncio
import json
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID

import httpx
from temporalio import activity
from temporalio.exceptions import ApplicationError

from .config import get_settings
from .contracts import ProtocolRefused, validate_result


@activity.defn
async def call_agent_runtime(
    agent: str, input: dict[str, Any], correlation_id: str
) -> dict[str, Any]:
    failure = "agent_invocation_unconfirmed"
    parsed = None
    try:
        if agent not in {
            "drishti",
            "vibhaag",
            "parikshan",
            "sudhaar",
        } or not isinstance(input, dict):
            raise ValueError("Invalid activity assignment")
        UUID(correlation_id)
        UUID(input["tenant_id"])
        UUID(input["engagement_id"])
        settings = get_settings()
        url = urlsplit(settings.agent_runtime_url)
        if (
            url.scheme not in {"http", "https"}
            or not url.hostname
            or url.username
            or url.password
            or url.query
            or url.fragment
            or not settings.agent_runtime_internal_token
        ):
            raise ValueError("Invalid runtime configuration")
        async with (
            asyncio.timeout(65),
            httpx.AsyncClient(timeout=60.0, follow_redirects=False) as client,
            client.stream(
                "POST",
                f"{settings.agent_runtime_url.rstrip('/')}/agents/{agent}/invoke",
                json={"correlation_id": correlation_id, "input": input},
                headers=settings.internal_headers,
            ) as response,
        ):
            if response.status_code != 200:
                raise ValueError("Runtime refused")
            body = bytearray()
            async for chunk in response.aiter_bytes(chunk_size=65536):
                if len(body) + len(chunk) > 2 * 1024 * 1024:
                    raise ValueError("Runtime result too large")
                body.extend(chunk)
            parsed = validate_result(json.loads(body), agent, correlation_id)
    except ProtocolRefused as exc:
        failure = exc.code
    except Exception:  # noqa: BLE001 — sanitize failures at the activity/history boundary.
        failure = "agent_invocation_unconfirmed"
    if parsed is None:
        # Raise outside the exception handler so private validation/HTTP errors
        # cannot become a serialized Temporal failure cause.
        raise ApplicationError(failure, type=failure, non_retryable=True)
    return parsed.model_dump(mode="json")
