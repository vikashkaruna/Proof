"""Validated legacy computation contracts; these are not persisted tool receipts."""

from __future__ import annotations

from typing import Any, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    FiniteFloat,
    ValidationError,
    model_validator,
)


class EngagementInput(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)
    tenant_id: UUID
    engagement_id: UUID
    correlation_id: UUID | None = None
    library_version: str = Field(min_length=1, max_length=200)
    interview: dict[str, Any] = Field(default_factory=dict)
    systems: list[dict[str, Any]] = Field(default_factory=list, max_length=500)
    answers: dict[str, dict[str, Any]] = Field(default_factory=dict)


class RuntimeResult(BaseModel):
    model_config = ConfigDict(extra="ignore", hide_input_in_errors=True)
    agent: str
    correlation_id: UUID
    status: Literal["succeeded", "failed"]
    latency_ms: int = Field(ge=0, le=2147483647, strict=True)
    input_tokens: int = Field(ge=0, le=2147483647, strict=True)
    output_tokens: int = Field(ge=0, le=2147483647, strict=True)
    cost_usd: FiniteFloat = Field(ge=0, le=9999.999999, strict=True)
    error: str | None
    output: dict[str, Any] | None
    ledger_entry_ids: list[str] = Field(max_length=1000)

    @model_validator(mode="after")
    def consistent(self):
        if self.input_tokens + self.output_tokens > 2147483647:
            raise ValueError("Invalid accounting")
        if self.status == "succeeded" and (
            self.error is not None
            or self.output is None
            or len(self.ledger_entry_ids) < 2
            or len(set(self.ledger_entry_ids)) != len(self.ledger_entry_ids)
            or any(not item or len(item) > 128 for item in self.ledger_entry_ids)
        ):
            raise ValueError("Unconfirmed result")
        if self.status == "failed" and self.output is not None:
            raise ValueError("Contradictory result")
        return self


class ProtocolRefused(Exception):
    def __init__(self, code: str = "agent_result_unconfirmed"):
        self.code = code
        super().__init__(code)


def validate_result(value: object, agent: str, correlation: str) -> RuntimeResult:
    parsed = None
    try:
        candidate = RuntimeResult.model_validate(value)
        if candidate.agent == agent and str(candidate.correlation_id) == correlation:
            parsed = candidate
    except ValidationError:
        parsed = None
    if parsed is None:
        raise ProtocolRefused()
    if parsed.status == "failed":
        raise ProtocolRefused("agent_reported_failure")
    return parsed


def validated_output(result: RuntimeResult, library_version: str) -> dict[str, Any]:
    """Require the data consumed by the next stage; no empty fallback outputs."""
    output = result.output
    if output is None:
        raise ProtocolRefused()
    if "escalate" in output and type(output["escalate"]) is not bool:
        raise ProtocolRefused()
    list_field = {
        "drishti": "inventory",
        "vibhaag": "classifications",
        "parikshan": "findings",
        "sudhaar": "actions",
    }.get(result.agent)
    if (
        list_field is None
        or not isinstance(output.get(list_field), list)
        or any(not isinstance(row, dict) for row in output[list_field])
    ):
        raise ProtocolRefused()
    if (
        result.agent == "drishti"
        and type(output.get("needs_live_connector")) is not bool
    ):
        raise ProtocolRefused()
    if result.agent == "parikshan":
        score = output.get("posture_score")
        exposure = output.get("estimated_exposure_inr")
        if (
            output.get("library_version") != library_version
            or type(score) not in (int, float)
            or not 0 <= score <= 100
            or type(exposure) is not int
            or not 0 <= exposure <= 9007199254740991
        ):
            raise ProtocolRefused()
    return output
