"""Model Gateway client.

The Model Gateway is the single chokepoint for every LLM call in the
agent runtime. Per Doc 04 §5.1 and Doc 05 §6, this client:
  1. Routes to the appropriate model based on agent + task
  2. Redacts PII before any egress to a third-party model provider
  3. Preserves gateway-owned completion commitments for future invocation accounting
  4. Preserves reported usage and configuration cost estimates for the cost-attribution requirement
     (NFR-11: infrastructure cost per client must stay < 15% of ACV)
  5. Refuses incomplete or legacy completion receipts; this client does not append ledger entries or cache responses

The gateway is self-hosted on the same EKS cluster as the agents
(Doc 06 §6). The Python client here is a thin HTTP wrapper; the
gateway itself is in services/model-gateway.
"""

from __future__ import annotations

import hashlib
import json
import math
import time
from dataclasses import dataclass, field
from typing import Annotated, Any, Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, ValidationError, model_validator

from .canonicalise import sha256_hex
from .config import Settings, get_settings
from .service_auth import ServiceAuthError, service_auth_headers

TaskKind = Literal[
    "structural",  # schema/metadata only; no row values
    "reasoning",  # high-stakes; may include redacted values
    "embedding",  # vector embedding
    "classification",  # field-level classification
    "summarisation",  # summarising a long doc
    "report",  # generating a report
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


Hash = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
Identity = Annotated[
    str, Field(min_length=1, max_length=300, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,299}\z")
]
Provider = Literal[
    "self_hosted", "bedrock", "anthropic_api", "anthropic", "openai", "gemini", "fallback_chain"
]
Tokens = Annotated[int, Field(ge=0, le=2147483647)]


class _StrictResponse(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid", frozen=True)


class _RouteIdentity(_StrictResponse):
    provider: Provider
    model: Identity


class _ServingIdentity(_RouteIdentity):
    reported_model: Identity | None


class _Usage(_StrictResponse):
    availability: Literal["reported", "unavailable"]
    reason: Literal["missing", "invalid"] | None
    input_tokens: Tokens | None
    output_tokens: Tokens | None
    total_tokens: Tokens | None


class _Pricing(_StrictResponse):
    basis: Literal["configuration_estimate", "unavailable"]
    reason: Literal["usage_unavailable", "price_unavailable", "cost_out_of_bounds"] | None
    scope: Literal["successful_response_only"]
    model: Identity
    input_rate: Annotated[FiniteFloat, Field(ge=0)] | None
    output_rate: Annotated[FiniteFloat, Field(ge=0)] | None
    config_sha256: Hash
    cost_usd: Annotated[FiniteFloat, Field(ge=0, le=9999.999999)] | None


class _Commitments(_StrictResponse):
    request_json_sha256: Hash
    request_json_basis: Literal["canonical_decoded_request_not_http_wire"]
    template_sha256: Hash
    composed_sha256: Hash
    transport_prompt_sha256: Hash
    sdk_handoff_sha256: Hash
    basis: Literal["sdk_handoff_not_http_wire"]
    caller_prompt_sha256: Hash | None


class _Attempt(_RouteIdentity):
    outcome: Literal["failed", "succeeded"]


class CompletionProvenance(_StrictResponse):
    planned: _RouteIdentity
    serving: _ServingIdentity
    usage: _Usage
    pricing: _Pricing
    commitments: _Commitments
    attempts: Annotated[list[_Attempt], Field(min_length=1, max_length=3)]
    failed_attempt_usage: Literal["unavailable"]


class ModelResponse(_StrictResponse):
    schema_version: Literal[2]
    text: Annotated[str, Field(min_length=1)]
    input_tokens: Tokens | None
    output_tokens: Tokens | None
    total_tokens: Tokens | None
    cost_usd: Annotated[FiniteFloat, Field(ge=0, le=9999.999999)] | None
    latency_ms: Annotated[int, Field(ge=0)]
    model_id: Identity
    pii_redacted: bool
    prompt_hash: Hash
    redactions: dict[str, Annotated[int, Field(ge=0)]]
    route_reason: str
    correlation_id: str
    provenance: CompletionProvenance

    @model_validator(mode="after")
    def consistent_receipt(self) -> ModelResponse:
        p = self.provenance
        u, price = p.usage, p.pricing
        if (
            not self.text.strip()
            or self.model_id != p.serving.model
            or self.prompt_hash != p.commitments.transport_prompt_sha256
        ):
            raise ValueError("inconsistent serving commitment")
        if p.serving.provider not in ("anthropic", "openai", "gemini", "self_hosted"):
            raise ValueError("unknown serving connector")
        if p.serving.provider != "self_hosted" and not p.serving.model.startswith(
            p.serving.provider + "/"
        ):
            raise ValueError("inconsistent serving connector")
        last = p.attempts[-1]
        if (
            last.provider != p.serving.provider
            or last.model != p.serving.model
            or last.outcome != "succeeded"
            or any(a.outcome != "failed" for a in p.attempts[:-1])
        ):
            raise ValueError("inconsistent attempt identity")
        if (self.input_tokens, self.output_tokens, self.total_tokens) != (
            u.input_tokens,
            u.output_tokens,
            u.total_tokens,
        ):
            raise ValueError("inconsistent reported usage")
        if u.availability == "reported":
            if (
                u.reason is not None
                or u.input_tokens is None
                or u.output_tokens is None
                or u.total_tokens != u.input_tokens + u.output_tokens
                or u.total_tokens > 2147483647
            ):
                raise ValueError("invalid reported usage")
        elif u.reason is None or any(
            v is not None for v in (u.input_tokens, u.output_tokens, u.total_tokens)
        ):
            raise ValueError("fabricated unavailable usage")
        config_text = json.dumps(
            {
                "schema_version": 1,
                "basis": "configuration_estimate",
                "model": price.model,
                "input_rate": price.input_rate,
                "output_rate": price.output_rate,
            },
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
        if (
            price.model != self.model_id
            or self.cost_usd != price.cost_usd
            or hashlib.sha256(config_text.encode()).hexdigest() != price.config_sha256
        ):
            raise ValueError("inconsistent pricing commitment")
        if price.basis == "configuration_estimate":
            if (
                price.reason is not None
                or u.input_tokens is None
                or u.output_tokens is None
                or price.input_rate is None
                or price.output_rate is None
                or price.cost_usd
                != u.input_tokens * price.input_rate + u.output_tokens * price.output_rate
            ):
                raise ValueError("invalid pricing estimate")
        elif price.reason is None or price.cost_usd is not None:
            raise ValueError("fabricated unavailable cost")
        else:
            expected_reason = None
            if price.input_rate is None or price.output_rate is None:
                expected_reason = "price_unavailable"
            elif u.input_tokens is None or u.output_tokens is None:
                expected_reason = "usage_unavailable"
            else:
                estimate = u.input_tokens * price.input_rate + u.output_tokens * price.output_rate
                if not math.isfinite(estimate) or not 0 <= estimate <= 9999.999999:
                    expected_reason = "cost_out_of_bounds"
            if price.reason != expected_reason:
                raise ValueError("invalid unavailable pricing reason")
        return self


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
          - Reported token availability and configuration cost estimates
          - Gateway-owned prompt/SDK-handoff commitments and serving identity

        Ledger attribution and caching are separate integration responsibilities;
        this client performs neither.

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
        request_json_hash = sha256_hex(
            json.dumps(
                body, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
            )
        )
        t0 = time.monotonic()
        try:
            r = await self._http.post("/v1/complete", json=body, headers=await self._auth_headers())
            r.raise_for_status()
        except httpx.HTTPStatusError as e:
            raise ModelGatewayError(f"model_gateway_http_{e.response.status_code}") from None
        except httpx.HTTPError:
            raise ModelGatewayError("model_gateway_unreachable") from None
        latency_ms = int((time.monotonic() - t0) * 1000)

        try:
            result = ModelResponse.model_validate(
                json.loads(r.text, object_pairs_hook=_unique_object, parse_constant=_nonfinite_json)
            )
            commitments = result.provenance.commitments
            if (
                commitments.request_json_sha256 != request_json_hash
                or commitments.template_sha256 != prompt_hash
                or commitments.caller_prompt_sha256 != prompt_hash
            ):
                raise ValueError("request commitment mismatch")
        except ValueError, ValidationError:
            # Provider responses and validation errors can contain prompts or keys.
            raise ModelGatewayError("model_gateway_response_invalid") from None
        return result.model_copy(update={"latency_ms": latency_ms})

    async def health(self) -> bool:
        try:
            r = await self._http.get("/health", headers=await self._auth_headers())
            return r.status_code == 200
        except httpx.HTTPError, ServiceAuthError:
            return False

    async def aclose(self) -> None:
        await self._http.aclose()


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON member")
        result[key] = value
    return result


def _nonfinite_json(_value: str) -> object:
    raise ValueError("nonfinite JSON number")
