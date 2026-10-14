"""Successful-dispatch facts. Commit SDK arguments, never claim HTTP-wire attestation."""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from .model_identity import MODEL_ID_PATTERN, safe_model_identity
from .redaction import RedactionSummary

Hash = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
Identity = Annotated[str, Field(min_length=1, max_length=300, pattern=rf"^{MODEL_ID_PATTERN}\z")]
Provider = Literal[
    "self_hosted", "bedrock", "anthropic_api", "anthropic", "openai", "gemini", "fallback_chain"
]


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def object_hash(value: object) -> str:
    return text_hash(
        json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
        )
    )


class StrictModel(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid", frozen=True)


class RouteIdentity(StrictModel):
    provider: Provider
    model: Identity


class ServingIdentity(RouteIdentity):
    reported_model: Identity | None


class Usage(StrictModel):
    availability: Literal["reported", "unavailable"]
    reason: Literal["missing", "invalid"] | None
    input_tokens: int | None
    output_tokens: int | None
    total_tokens: int | None


class Pricing(StrictModel):
    basis: Literal["configuration_estimate", "unavailable"]
    reason: Literal["usage_unavailable", "price_unavailable", "cost_out_of_bounds"] | None
    scope: Literal["successful_response_only"] = "successful_response_only"
    model: Identity
    input_rate: float | None
    output_rate: float | None
    config_sha256: Hash
    cost_usd: float | None


class Commitments(StrictModel):
    request_json_sha256: Hash
    request_json_basis: Literal["canonical_decoded_request_not_http_wire"] = (
        "canonical_decoded_request_not_http_wire"
    )
    template_sha256: Hash
    composed_sha256: Hash
    transport_prompt_sha256: Hash
    sdk_handoff_sha256: Hash
    basis: Literal["sdk_handoff_not_http_wire"] = "sdk_handoff_not_http_wire"
    caller_prompt_sha256: Hash | None


class Attempt(RouteIdentity):
    outcome: Literal["failed", "succeeded"]


class CompletionProvenance(StrictModel):
    planned: RouteIdentity
    serving: ServingIdentity
    usage: Usage
    pricing: Pricing
    commitments: Commitments
    attempts: Annotated[list[Attempt], Field(min_length=1, max_length=3)]
    failed_attempt_usage: Literal["unavailable"] = "unavailable"


@dataclass(frozen=True)
class DispatchResult:
    text: str
    serving: ServingIdentity
    usage: Usage
    transport_prompt_sha256: str
    sdk_handoff_sha256: str
    redaction: RedactionSummary | None
    attempts: tuple[Attempt, ...]


def reported_model(value: object) -> str | None:
    return value if isinstance(value, str) and safe_model_identity(value) else None


def read_usage(value: object) -> Usage:
    """Refuse coercions/estimates; absent or invalid usage does not erase real content."""

    def get(name: str) -> object:
        return value.get(name) if isinstance(value, dict) else getattr(value, name, None)

    incoming, outgoing, total = get("prompt_tokens"), get("completion_tokens"), get("total_tokens")
    reason: Literal["missing", "invalid"] = (
        "missing" if value is None or incoming is None or outgoing is None else "invalid"
    )
    if (
        type(incoming) is int
        and type(outgoing) is int
        and 0 <= incoming <= 2147483647
        and 0 <= outgoing <= 2147483647
        and incoming + outgoing <= 2147483647
        and (total is None or (type(total) is int and total == incoming + outgoing))
    ):
        return Usage(
            availability="reported",
            reason=None,
            input_tokens=incoming,
            output_tokens=outgoing,
            total_tokens=incoming + outgoing,
        )
    return Usage(
        availability="unavailable",
        reason=reason,
        input_tokens=None,
        output_tokens=None,
        total_tokens=None,
    )


def price_usage(
    model: str, usage: Usage, input_rates: dict[str, float], output_rates: dict[str, float]
) -> Pricing:
    incoming, outgoing = input_rates.get(model), output_rates.get(model)
    digest = object_hash(
        {
            "schema_version": 1,
            "basis": "configuration_estimate",
            "model": model,
            "input_rate": incoming,
            "output_rate": outgoing,
        }
    )
    reason: Literal["usage_unavailable", "price_unavailable", "cost_out_of_bounds"] | None = None
    cost: float | None = None
    if incoming is None or outgoing is None:
        reason = "price_unavailable"
    elif usage.input_tokens is None or usage.output_tokens is None:
        reason = "usage_unavailable"
    else:
        cost = usage.input_tokens * incoming + usage.output_tokens * outgoing
        if not math.isfinite(cost) or not 0 <= cost <= 9999.999999:
            cost, reason = None, "cost_out_of_bounds"
    return Pricing(
        basis="configuration_estimate" if reason is None else "unavailable",
        reason=reason,
        model=model,
        input_rate=incoming,
        output_rate=outgoing,
        config_sha256=digest,
        cost_usd=cost,
    )
