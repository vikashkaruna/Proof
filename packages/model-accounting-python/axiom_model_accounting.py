"""Unmounted metadata-only accounting contracts and provisional arithmetic.

Only a controller independently loading the frozen observed callset and actual
seal receipt can verify no_model. Empty arithmetic alone supplies no proof.
No credentials, ledger client or model transports are created by this module.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from decimal import Decimal, localcontext
from itertools import pairwise
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

# Mirror existing durable canonical nonnil UUID grammar. The trusted loader
# derives actual identities; codecs do not invent or normalize them.
Identifier = Annotated[
    str, Field(pattern=r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\z")
]
Digest = Annotated[str, Field(pattern=r"^[a-f0-9]{64}\z")]
Identity = Annotated[str, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,299}\z")]
ExactEstimate = Annotated[
    str, Field(max_length=335, pattern=r"^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{0,323}[1-9])?\z")
]
Tokens = Annotated[int, Field(ge=0, le=2147483647)]
AggregateTokens = Annotated[int, Field(ge=0, le=2147483647000)]
Provider = Literal[
    "self_hosted", "bedrock", "anthropic_api", "anthropic", "openai", "gemini", "fallback_chain"
]
Agent = Literal[
    "drishti",
    "vibhaag",
    "parikshan",
    "saakshi",
    "sudhaar",
    "karya",
    "samadhan",
    "lekha",
    "nazar",
    "prativedan",
    "pramaan",
    "sanket",
]
Task = Literal["structural", "reasoning", "embedding", "classification", "summarisation", "report"]


class Contract(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid", frozen=True, hide_input_in_errors=True)


class CallStart(Contract):
    schema_version: Literal[2]
    tenant_id: Identifier
    run_id: Identifier
    correlation_id: Identifier
    request_sha256: Digest
    agent: Agent
    agent_version: Identity
    call_id: Identifier
    request_json_sha256: Digest
    request_json_basis: Literal["canonical_decoded_request_not_http_wire"]
    template_sha256: Digest
    model_selector: Identity
    task: Task

    @model_validator(mode="after")
    def nonnil(self) -> Self:
        if "00000000-0000-0000-0000-000000000000" in (
            self.tenant_id,
            self.run_id,
            self.correlation_id,
            self.call_id,
        ):
            raise ValueError("Missing explicit accounting identity")
        return self


class Route(Contract):
    provider: Provider
    model: Identity


class Serving(Route):
    reported_model: Identity | None


class Commitments(Contract):
    composed_sha256: Digest
    transport_prompt_sha256: Digest
    sdk_handoff_sha256: Digest
    basis: Literal["sdk_handoff_not_http_wire"]


class Attempt(Route):
    outcome: Literal["failed", "succeeded"]


class Usage(Contract):
    availability: Literal["reported", "unavailable"]
    input_tokens: Tokens | None
    output_tokens: Tokens | None
    total_tokens: Tokens | None

    @model_validator(mode="after")
    def consistent(self) -> Self:
        if self.availability == "reported":
            if (
                self.input_tokens is None
                or self.output_tokens is None
                or self.total_tokens != self.input_tokens + self.output_tokens
                or self.total_tokens > 2147483647
            ):
                raise ValueError("Inconsistent reported usage")
        elif any(v is not None for v in (self.input_tokens, self.output_tokens, self.total_tokens)):
            raise ValueError("Fabricated unavailable usage")
        return self


class Pricing(Contract):
    basis: Literal["configuration_estimate", "unavailable"]
    scope: Literal["successful_response_only"]
    config_sha256: Digest | None
    estimate_usd: ExactEstimate | None

    @model_validator(mode="after")
    def consistent(self) -> Self:
        if self.basis == "configuration_estimate":
            if (
                self.config_sha256 is None
                or self.estimate_usd is None
                or Decimal(self.estimate_usd) > Decimal("9999.999999")
            ):
                raise ValueError("Invalid configuration estimate")
        elif self.estimate_usd is not None:
            raise ValueError("Fabricated unavailable estimate")
        return self


class CallOutcome(CallStart):
    state: Literal["completed", "failed", "cancelled", "uncertain"]
    failure_code: (
        Literal[
            "gateway_unavailable",
            "current_authority_refused",
            "gateway_response_invalid",
            "invocation_cancelled",
            "transport_uncertain",
        ]
        | None
    )
    content_sha256: Digest | None
    planned: Route | None
    serving: Serving | None
    commitments: Commitments | None
    attempts: Annotated[list[Attempt], Field(min_length=1, max_length=3)] | None
    usage: Usage
    pricing: Pricing

    @model_validator(mode="after")
    def consistent_observation(self) -> Self:
        if self.pricing.basis == "configuration_estimate" and self.usage.availability != "reported":
            raise ValueError("Unreported estimate usage")
        if self.state == "completed":
            if (
                self.failure_code is not None
                or self.content_sha256 is None
                or self.planned is None
                or self.serving is None
                or self.commitments is None
                or self.attempts is None
            ):
                raise ValueError("Incomplete observed response")
            last = self.attempts[-1]
            if (
                last.outcome != "succeeded"
                or last.provider != self.serving.provider
                or last.model != self.serving.model
                or any(a.outcome != "failed" for a in self.attempts[:-1])
            ):
                raise ValueError("Inconsistent served attempt")
            # Configured bare IDs are legitimate. Provider ownership is verified
            # by gateway configuration; a prefix alone is not evidence.
            if self.serving.provider not in ("self_hosted", "anthropic", "openai", "gemini"):
                raise ValueError("Inconsistent serving connector")
        else:
            if (
                self.failure_code is None
                or any(
                    v is not None
                    for v in (
                        self.content_sha256,
                        self.planned,
                        self.serving,
                        self.commitments,
                        self.attempts,
                    )
                )
                or self.usage.availability != "unavailable"
                or self.pricing.basis != "unavailable"
                or self.pricing.config_sha256 is not None
            ):
                raise ValueError("Fabricated failed observation")
            if (self.state == "cancelled") != (self.failure_code == "invocation_cancelled") or (
                self.state == "uncertain"
            ) != (self.failure_code == "transport_uncertain"):
                raise ValueError("Inconsistent failed observation")
        return self


class AccountingSummary(Contract):
    schema_version: Literal[2]
    basis: Literal["no_model", "all_known", "known_partial", "unknown"]
    call_count: Annotated[int, Field(ge=0, le=1000)]
    known_usage_call_count: Annotated[int, Field(ge=0, le=1000)]
    known_estimate_call_count: Annotated[int, Field(ge=0, le=1000)]
    unknown_attempt_usage: bool
    input_tokens: AggregateTokens | None
    output_tokens: AggregateTokens | None
    total_tokens: AggregateTokens | None
    estimate_usd: ExactEstimate | None
    known_input_tokens: AggregateTokens
    known_output_tokens: AggregateTokens
    known_total_tokens: AggregateTokens
    known_estimate_usd: ExactEstimate

    @model_validator(mode="after")
    def consistent(self) -> Self:
        if (
            self.known_estimate_call_count > self.known_usage_call_count
            or self.known_usage_call_count > self.call_count
            or self.known_total_tokens != self.known_input_tokens + self.known_output_tokens
            or self.known_total_tokens > self.known_usage_call_count * 2147483647
        ):
            raise ValueError("Inconsistent accounting sums")
        if (
            (self.known_usage_call_count == 0 and self.known_total_tokens != 0)
            or (self.known_estimate_call_count == 0 and self.known_estimate_usd != "0")
            or Decimal(self.known_estimate_usd)
            > Decimal("9999.999999") * self.known_estimate_call_count
        ):
            raise ValueError("Fabricated known partial sums")
        usage_known = (
            not self.unknown_attempt_usage and self.known_usage_call_count == self.call_count
        )
        price_known = (
            not self.unknown_attempt_usage and self.known_estimate_call_count == self.call_count
        )
        if (self.input_tokens, self.output_tokens, self.total_tokens) != (
            (self.known_input_tokens, self.known_output_tokens, self.known_total_tokens)
            if usage_known
            else (None, None, None)
        ) or self.estimate_usd != (self.known_estimate_usd if price_known else None):
            raise ValueError("Fabricated complete aggregates")
        expected = (
            "no_model"
            if self.call_count == 0
            else "all_known"
            if usage_known and price_known
            else "known_partial"
            if self.known_usage_call_count or self.known_estimate_call_count
            else "unknown"
        )
        if self.basis != expected or (
            self.call_count == 0
            and (
                self.unknown_attempt_usage
                or self.known_total_tokens != 0
                or self.known_estimate_usd != "0"
            )
        ):
            raise ValueError("Inconsistent accounting basis")
        return self


def _exact_sum(values: list[str]) -> str:
    with localcontext() as ctx:
        ctx.prec = 340
        result = format(sum((Decimal(v) for v in values), Decimal(0)), "f")
    return result.rstrip("0").rstrip(".") if "." in result else result


def derive_accounting(values: list[object]) -> AccountingSummary:
    """Provisional arithmetic only; no seal/receipt or invocation authority."""
    if len(values) > 1000:
        raise ValueError("Accounting callset bound exceeded")
    calls = [CallOutcome.model_validate(v) for v in values]
    if len({v.call_id for v in calls}) != len(calls):
        raise ValueError("Duplicate accounting call identity")
    if calls:
        first = calls[0]
        if any(
            (v.tenant_id, v.run_id, v.correlation_id, v.request_sha256, v.agent, v.agent_version)
            != (
                first.tenant_id,
                first.run_id,
                first.correlation_id,
                first.request_sha256,
                first.agent,
                first.agent_version,
            )
            for v in calls
        ):
            raise ValueError("Accounting invocation binding refused")
    usage = [v for v in calls if v.usage.availability == "reported"]
    priced = [v for v in calls if v.pricing.basis == "configuration_estimate"]
    unknown = any(v.state != "completed" or len(v.attempts or []) > 1 for v in calls)
    input_tokens = sum(v.usage.input_tokens or 0 for v in usage)
    output_tokens = sum(v.usage.output_tokens or 0 for v in usage)
    cost = _exact_sum(
        [v.pricing.estimate_usd for v in priced if v.pricing.estimate_usd is not None]
    )
    usage_known, price_known = (
        not unknown and len(usage) == len(calls),
        not unknown and len(priced) == len(calls),
    )
    basis: Literal["no_model", "all_known", "known_partial", "unknown"] = (
        "no_model"
        if not calls
        else "all_known"
        if usage_known and price_known
        else "known_partial"
        if usage or priced
        else "unknown"
    )
    return AccountingSummary(
        schema_version=2,
        basis=basis,
        call_count=len(calls),
        known_usage_call_count=len(usage),
        known_estimate_call_count=len(priced),
        unknown_attempt_usage=unknown,
        input_tokens=input_tokens if usage_known else None,
        output_tokens=output_tokens if usage_known else None,
        total_tokens=input_tokens + output_tokens if usage_known else None,
        estimate_usd=cost if price_known else None,
        known_input_tokens=input_tokens,
        known_output_tokens=output_tokens,
        known_total_tokens=input_tokens + output_tokens,
        known_estimate_usd=cost,
    )


class LegacyProjection(Contract):
    input_tokens: Tokens | None
    output_tokens: Tokens | None
    cost_usd: str | None


def legacy_projection(summary: AccountingSummary) -> LegacyProjection:
    """Exact retained estimate stays separate; six-place compatibility is rounded.

    ROUND_HALF_UP matches PostgreSQL nonnegative numeric rounding. Overflow
    refuses; tiny positive projection zero never means verified no_model.
    """
    value = AccountingSummary.model_validate(summary.model_dump())
    if (value.total_tokens or 0) > 2147483647:
        raise ValueError("Legacy token projection overflow")
    cost = None
    if value.estimate_usd is not None:
        with localcontext() as ctx:
            ctx.prec = 340
            from decimal import ROUND_HALF_UP

            rounded = Decimal(value.estimate_usd).quantize(
                Decimal("0.000001"), rounding=ROUND_HALF_UP
            )
        if rounded > Decimal("9999.999999"):
            raise ValueError("Legacy cost projection overflow")
        cost = format(rounded, ".6f")
    return LegacyProjection(
        input_tokens=value.input_tokens, output_tokens=value.output_tokens, cost_usd=cost
    )


class CallPayload(Contract):
    """Transient business bytes, never persisted in accounting or diagnostics."""

    model: Identity
    prompt: str = Field(min_length=1, max_length=1048576)
    task: Task
    temperature: Annotated[int | float, Field(ge=0, le=2, allow_inf_nan=False)]
    max_tokens: Annotated[int, Field(ge=1, le=2147483647)]
    variables: dict[str, object]
    pii_redact: bool
    response_format: dict[str, object] | None


class CallCompletion(Contract):
    text: str = Field(min_length=1, max_length=1048576)
    observation: CallOutcome


def sha256_hex(value: str | bytes) -> str:
    return hashlib.sha256(value.encode("utf-8") if isinstance(value, str) else value).hexdigest()


class AccountingBinding(Contract):
    schema_version: Literal[2]
    tenant_id: Identifier
    run_id: Identifier
    correlation_id: Identifier
    request_sha256: Digest
    agent: Agent
    agent_version: Identity

    @model_validator(mode="after")
    def nonnil(self) -> Self:
        if "00000000-0000-0000-0000-000000000000" in (
            self.tenant_id,
            self.run_id,
            self.correlation_id,
        ):
            raise ValueError("Accounting identity refused")
        return self


class Receipt(Contract):
    id: str = Field(pattern=r"^[1-9][0-9]{0,18}\z")
    entry_hash: Digest

    @model_validator(mode="after")
    def bounded(self) -> Self:
        if int(self.id) > 9223372036854775807:
            raise ValueError("Accounting receipt refused")
        return self


class AccountingSeal(AccountingBinding):
    serialization: Literal["postgres-jsonb-text-v1"]
    calls_text: str = Field(min_length=2, max_length=8388608)
    calls_sha256: Digest
    summary: AccountingSummary
    requested_receipt: Receipt
    agent_started_receipt: Receipt
    agent_completed_receipt: Receipt
    accounting_receipt: Receipt

    @model_validator(mode="after")
    def ordered(self) -> Self:
        ids = [
            self.requested_receipt.id,
            self.agent_started_receipt.id,
            self.agent_completed_receipt.id,
            self.accounting_receipt.id,
        ]
        if any(int(a) >= int(b) for a, b in pairwise(ids)):
            raise ValueError("Accounting receipt order refused")
        if "\0" in self.calls_text or len(self.calls_text.encode("utf-8")) > 8388608:
            raise ValueError("Accounting callset bound refused")
        return self


class AccountingStoreError(ValueError):
    """Bounded refusal; no raw payload or transport exception is exposed."""


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise AccountingStoreError("Accounting packet refused")
        result[key] = value
    return result


def _refuse_constant(_: str) -> object:
    raise AccountingStoreError("Accounting packet refused")


def _packet(text: str, limit: int) -> object:
    if len(text.encode("utf-8")) > limit:
        raise AccountingStoreError("Accounting packet refused")
    return json.loads(text, object_pairs_hook=_unique_object, parse_constant=_refuse_constant)


def verify_accounting_seal(payload: object, expected: AccountingBinding) -> AccountingSeal:
    """Pure validation, not evidence of independently loaded ledger authority.

    Only the future mounted controller may supply an independently loaded seal.
    Caller-supplied self-consistent packets are never an authorization proof.
    """
    try:
        value = AccountingSeal.model_validate(payload)
        binding = AccountingBinding.model_validate(
            value.model_dump(include=set(AccountingBinding.model_fields))
        )
        if binding != expected or sha256_hex(value.calls_text) != value.calls_sha256:
            raise AccountingStoreError("Accounting seal refused")
        calls = json.loads(
            value.calls_text, object_pairs_hook=_unique_object, parse_constant=_refuse_constant
        )
        if not isinstance(calls, list) or len(calls) > 1000:
            raise AccountingStoreError("Accounting seal refused")
        parsed = [CallOutcome.model_validate(v) for v in calls]
        if any(
            AccountingBinding.model_validate(
                v.model_dump(include=set(AccountingBinding.model_fields))
            )
            != expected
            for v in parsed
        ):
            raise AccountingStoreError("Accounting seal refused")
        if derive_accounting([v.model_dump() for v in parsed]) != value.summary:
            raise AccountingStoreError("Accounting seal refused")
        return value
    except ValueError, TypeError, RecursionError, OverflowError:
        raise AccountingStoreError("Accounting seal refused") from None


ProjectionCost = Annotated[str, Field(pattern=r"^(?:0|[1-9][0-9]{0,3})\.[0-9]{6}\z")]


SafeError = Annotated[str, Field(pattern=r"^[a-z0-9_]{1,80}\z")]


class AccountedResultError(ValueError):
    def __init__(self) -> None:
        super().__init__("accounted_result_contract_refused")


ResultRefused = AccountedResultError


def _integer(token: str) -> int:
    value = int(token)
    if abs(value) > 9007199254740991:
        raise ResultRefused()
    return value


def _float(token: str) -> float:
    value = float(token)
    if (
        not math.isfinite(value)
        or Decimal(token) != Decimal(str(value))
        or (value.is_integer() and abs(value) > 9007199254740991)
    ):
        raise ResultRefused()
    return value


def parse_output_text(text: str) -> dict[str, object]:
    """Hash original UTF-8, never a JS/Python reserialization of business JSON."""
    try:
        if not text or "\0" in text or len(text.encode("utf-8")) > 1048576:
            raise ResultRefused()
        value = json.loads(
            text,
            object_pairs_hook=_unique_object,
            parse_constant=_refuse_constant,
            parse_int=_integer,
            parse_float=_float,
        )
        if not isinstance(value, dict):
            raise ResultRefused()
        pending: list[tuple[object, int]] = [(value, 0)]
        count = 0
        while pending:
            item, depth = pending.pop()
            count += 1
            if depth > 40 or count > 100000:
                raise ResultRefused()
            if isinstance(item, dict):
                for key in item:
                    if "\0" in key:
                        raise ResultRefused()
                    key.encode("utf-8")
                pending.extend((v, depth + 1) for v in item.values())
            elif isinstance(item, list):
                pending.extend((v, depth + 1) for v in item)
            elif isinstance(item, str):
                if "\0" in item:
                    raise ResultRefused()
                item.encode("utf-8")
        return value
    except Exception:
        raise ResultRefused() from None


class JournalReference(Contract):
    calls_sha256: Digest
    receipt: Receipt


class AccountedResult(AccountingBinding):
    kind: Literal["accounted_agent_result"]
    status: Literal["succeeded", "failed"]
    latency_ms: Annotated[int, Field(ge=0, le=2147483647)]
    input_tokens: Tokens | None
    output_tokens: Tokens | None
    cost_usd: ProjectionCost | None
    error: SafeError | None
    runtime_output_text: str | None = Field(max_length=1048576)
    ledger_entry_ids: list[str] = Field(min_length=2, max_length=2)
    accounting_reference: JournalReference

    @model_validator(mode="after")
    def consistent(self) -> Self:
        for value in self.ledger_entry_ids:
            Receipt(id=value, entry_hash="0" * 64)
        if self.ledger_entry_ids[0] == self.ledger_entry_ids[1]:
            raise ResultRefused()
        if self.status == "succeeded":
            if self.error is not None or self.runtime_output_text is None:
                raise ResultRefused()
            parse_output_text(self.runtime_output_text)
        elif self.error is None or self.runtime_output_text is not None:
            raise ResultRefused()
        return self


class ExpectedResult(Contract):
    """These facts must be independently loaded, never copied from an HTTP body."""

    binding: AccountingBinding
    seal: AccountingSeal
    terminal_status: Literal["succeeded", "failed"]
    runtime_output_sha256: Digest | None

    @model_validator(mode="after")
    def consistent(self) -> Self:
        if (self.terminal_status == "succeeded") != (self.runtime_output_sha256 is not None):
            raise ResultRefused()
        return self


@dataclass(frozen=True)
class VerifiedAccountedResult:
    result: AccountedResult
    output: dict[str, object] | None
    accounting_status: Literal["sealed_observed_journal"] = "sealed_observed_journal"


def verify_accounted_result(value: object, expected: ExpectedResult) -> VerifiedAccountedResult:
    try:
        witness = ExpectedResult.model_validate(expected.model_dump())
        actual = AccountedResult.model_validate(value)
        seal = verify_accounting_seal(witness.seal.model_dump(), witness.binding)
        binding = AccountingBinding.model_validate(
            actual.model_dump(include=set(AccountingBinding.model_fields))
        )
        if (
            binding != witness.binding
            or actual.status != witness.terminal_status
            or actual.accounting_reference.calls_sha256 != seal.calls_sha256
            or actual.accounting_reference.receipt != seal.accounting_receipt
            or actual.ledger_entry_ids
            != [seal.agent_started_receipt.id, seal.agent_completed_receipt.id]
        ):
            raise ResultRefused()
        metrics = legacy_projection(seal.summary)
        if (actual.input_tokens, actual.output_tokens, actual.cost_usd) != (
            metrics.input_tokens,
            metrics.output_tokens,
            metrics.cost_usd,
        ):
            raise ResultRefused()
        output = None
        if actual.runtime_output_text is not None:
            if sha256_hex(actual.runtime_output_text) != witness.runtime_output_sha256:
                raise ResultRefused()
            output = parse_output_text(actual.runtime_output_text)
        return VerifiedAccountedResult(actual, output)
    except Exception:
        raise ResultRefused() from None


class LegacyAccountingView(Contract):
    """Historical zero/null telemetry remains readable without inventing proof."""

    model_config = ConfigDict(strict=True, extra="ignore", frozen=True, hide_input_in_errors=True)
    input_tokens: Tokens | None
    output_tokens: Tokens | None
    total_tokens: Tokens | None
    cost_usd: Annotated[int | float, Field(ge=0, le=9999.999999, allow_inf_nan=False)] | None
    accounting_status: Literal["legacy_unverified"] = "legacy_unverified"
