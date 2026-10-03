"""Model Gateway client.

The Model Gateway is the single chokepoint for every LLM call in the
agent runtime. Per Doc 04 §5.1 and Doc 05 §6, this client:
  1. Routes to the appropriate model based on agent + task
  2. Redacts PII before any egress to a third-party model provider
  3. Records prompt hash + model version into the ledger for every call
  4. Tracks per-tenant token cost for the cost-attribution requirement
     (NFR-11: infrastructure cost per client must stay < 15% of ACV)
  5. Caches responses for structural-only tasks (control library, etc.)

The gateway is self-hosted on the same EKS cluster as the agents
(Doc 06 §6). The Python client here is a thin HTTP wrapper; the
gateway itself is in services/model-gateway.
"""

from __future__ import annotations

import hashlib
import os
import time
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx

from .canonicalise import sha256_hex
from .config import Settings, get_settings
from .service_auth import ServiceAuthError, service_auth_headers


TaskKind = Literal[
    "structural",  # schema/metadata only; no row values
    "reasoning",   # high-stakes; may include redacted values
    "embedding",   # vector embedding
    "classification",  # field-level classification
    "summarisation",   # summarising a long doc
    "report",      # generating a report
]


@dataclass(frozen=True)
class ModelRequest:
    model: str
    prompt: str
    task: TaskKind = "reasoning"
    temperature: float = 0.2
    max_tokens: int = 4096
    variables: dict[str, Any] = field(default_factory=dict)
    pii_redact: bool = True
    response_format: dict[str, Any] | None = None


@dataclass(frozen=True)
class ModelResponse:
    text: str
    input_tokens: int
    output_tokens: int
    total_tokens: int
    cost_usd: float
    latency_ms: int
    model_id: str
    pii_redacted: bool
    prompt_hash: str


class ModelGatewayError(RuntimeError):
    pass


class ModelGateway:
    def __init__(self, settings: Settings | None = None, *, http: httpx.AsyncClient | None = None):
        s = settings or get_settings()
        self._settings = s
        self._url = s.model_gateway_url
        self._headers = {"Content-Type": "application/json"}
        if s.model_gateway_api_key:
            self._headers["Authorization"] = f"Bearer {s.model_gateway_api_key}"
        self._http = http or httpx.AsyncClient(
            base_url=self._url,
            headers=self._headers,
            timeout=httpx.Timeout(60.0, connect=10.0),
        )

    async def _auth_headers(self) -> dict[str, str]:
        # {} unless AXIOM_SERVICE_AUTH=gcp-id-token; raises (fail closed) if no token.
        return await service_auth_headers(self._url)

    async def complete(self, request: ModelRequest) -> ModelResponse:
        """Call the model gateway.

        The gateway is responsible for:
          - Provider routing (self-hosted vLLM, Bedrock, etc.)
          - PII redaction (when request.pii_redact is True)
          - Token accounting
          - Prompt hash + model version recording
          - Caching for structural tasks

        The client passes through what the agent needs; the gateway
        enforces the redacting-egress invariant.
        """
        prompt_hash = sha256_hex(request.prompt)
        body = {
            "model": request.model,
            "prompt": request.prompt,
            "task": request.task,
            "temperature": request.temperature,
            "max_tokens": request.max_tokens,
            "variables": request.variables,
            "pii_redact": request.pii_redact,
            "response_format": request.response_format,
            "prompt_hash": prompt_hash,
        }
        t0 = time.monotonic()
        try:
            r = await self._http.post(
                "/v1/complete", json=body, headers=await self._auth_headers()
            )
            r.raise_for_status()
        except httpx.HTTPStatusError as e:
            raise ModelGatewayError(
                f"Model gateway returned {e.response.status_code}: {e.response.text[:500]}"
            ) from e
        except httpx.HTTPError as e:
            raise ModelGatewayError(f"Model gateway unreachable: {e}") from e
        latency_ms = int((time.monotonic() - t0) * 1000)

        data = r.json()
        return ModelResponse(
            text=data["text"],
            input_tokens=data.get("input_tokens", 0),
            output_tokens=data.get("output_tokens", 0),
            total_tokens=data.get("total_tokens", 0),
            cost_usd=data.get("cost_usd", 0.0),
            latency_ms=latency_ms,
            model_id=data.get("model_id", request.model),
            pii_redacted=data.get("pii_redacted", request.pii_redact),
            prompt_hash=prompt_hash,
        )

    async def health(self) -> bool:
        try:
            r = await self._http.get("/health", headers=await self._auth_headers())
            return r.status_code == 200
        except (httpx.HTTPError, ServiceAuthError):
            return False

    async def aclose(self) -> None:
        await self._http.aclose()
