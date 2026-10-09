"""Unwired 0119 stage port prototype: no registration or runtime credentials."""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .agents.base import DispatchContext
from .canonicalise import canonical_json, sha256_hex

UUID = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
HASH = r"^[a-f0-9]{64}$"


class FrozenRecord(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    @field_validator("accepted", "verified", mode="before", check_fields=False)
    @classmethod
    def exact_bool(cls, value: object) -> object:
        if type(value) is not bool:
            raise ValueError("Evidence stage boolean must be explicit")
        return value


class EvidencePlacement(FrozenRecord):
    tenant_id: str = Field(pattern=UUID)
    engagement_id: str | None = Field(pattern=UUID)
    operation_id: str = Field(pattern=UUID)
    provider: Literal["s3", "s3-compatible"]
    bucket: str = Field(min_length=3, max_length=255)
    object_key: str = Field(min_length=1, max_length=1024)
    content_hash: str = Field(pattern=HASH)
    byte_size: int = Field(ge=1, le=8 * 1024 * 1024)
    retain_until: str
    legal_hold: bool
    encryption: Literal["AES256", "aws:kms"]

    @field_validator("retain_until")
    @classmethod
    def aware_time(cls, value: str) -> str:
        if datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is None:
            raise ValueError("Evidence stage requires a timezone")
        return value


class EvidenceStageInput(EvidencePlacement):
    purpose: Literal["saakshi_owned_resource_stage_v1"]
    actor_id: str = Field(pattern=UUID)
    operation_key: str = Field(pattern=UUID)
    owned_resource_id: str = Field(pattern=UUID)
    human_request_hash: str = Field(pattern=HASH)

    @model_validator(mode="after")
    def exact_placement(self) -> Self:
        expected = (
            f"tenants/{self.tenant_id}/evidence-ingestions/{self.operation_key}/{self.content_hash}"
        )
        if self.object_key != expected:
            raise ValueError("Evidence placement mismatch")
        return self


class EvidenceStageReceipt(EvidencePlacement):
    correlation_id: str = Field(pattern=UUID)
    version_id: str = Field(min_length=1, max_length=1024)
    collected_by_agent: Literal["saakshi"]
    readback_at: str
    lock_mode: Literal["COMPLIANCE"]
    verified: Literal[True]

    @field_validator("version_id")
    @classmethod
    def actual_version(cls, value: str) -> str:
        if not value.strip() or value == "null":
            raise ValueError("Version is unconfirmed")
        return value

    @field_validator("readback_at")
    @classmethod
    def aware_readback(cls, value: str) -> str:
        return EvidencePlacement.aware_time(value)


class StagedEvidenceOutput(FrozenRecord):
    kind: Literal["sealed_pending_registration"] = "sealed_pending_registration"
    accepted: Literal[False] = False
    source: EvidenceStageInput
    receipt: EvidenceStageReceipt


class SignedEvidenceStageRequest(FrozenRecord):
    signed_text: str = Field(min_length=1, max_length=32000)
    signature: str = Field(pattern=HASH)


class StageEnvelope(FrozenRecord):
    version: Literal[1]
    input_text: str = Field(min_length=1, max_length=16000)
    correlation_id: str = Field(pattern=UUID)
    dispatch_context: DispatchContext
    expires_at: int

    @field_validator("version", mode="before")
    @classmethod
    def exact_version(cls, value: object) -> object:
        if type(value) is not int:
            raise ValueError("Evidence stage version must be explicit")
        return value


def verify_evidence_stage_request(
    request: SignedEvidenceStageRequest,
    secret: str | None,
    *,
    peer_secret: str | None,
    other_secrets: tuple[str | None, ...] = (),
    now: float | None = None,
) -> tuple[EvidenceStageInput, str, DispatchContext]:
    if (
        not secret
        or not peer_secret
        or len(secret.encode()) < 32
        or secret == peer_secret
        or secret in other_secrets
        or len(request.signed_text.encode()) > 32000
    ):
        raise ValueError("Evidence stage signature refused")
    expected = hmac.new(
        secret.encode(), b"axiom-saakshi-stage-v1\0" + request.signed_text.encode(), hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(expected, request.signature):
        raise ValueError("Evidence stage signature refused")
    if canonical_json(json.loads(request.signed_text)) != request.signed_text:
        raise ValueError("Evidence stage serialization refused")
    envelope = StageEnvelope.model_validate_json(request.signed_text)
    if canonical_json(envelope.model_dump(mode="json")) != request.signed_text:
        raise ValueError("Evidence stage context serialization refused")
    delta = envelope.expires_at - (time.time() if now is None else now)
    if not 0 < delta <= 120 or len(envelope.input_text.encode()) > 16000:
        raise ValueError("Evidence stage capability expired")
    source = EvidenceStageInput.model_validate_json(envelope.input_text)
    if (
        canonical_json(source.model_dump(mode="json")) != envelope.input_text
        or sha256_hex(envelope.input_text) != envelope.dispatch_context.request_hash
    ):
        raise ValueError("Evidence stage input mismatch")
    return source, envelope.correlation_id, envelope.dispatch_context


@dataclass(frozen=True)
class EvidenceStagePort:
    """Internal exact-resource port, never HTTP JSON or a general storage client.

    BFF resolves approved retained bytes, claims the immutable run/intent and
    seals only its configured exact placement. No URL or credentials are input.
    Controller verification/atomic registration remain separate and mandatory.
    """

    source: EvidenceStageInput
    correlation_id: str
    stage: Callable[[EvidenceStageInput, str], Awaitable[EvidenceStageReceipt]]


async def stage_owned_evidence(
    source: EvidenceStageInput,
    correlation_id: str,
    port: EvidenceStagePort,
    *,
    now: datetime | None = None,
) -> StagedEvidenceOutput:
    if (
        not isinstance(port, EvidenceStagePort)
        or source != port.source
        or correlation_id != port.correlation_id
    ):
        raise ValueError("Evidence stage capability mismatch")
    source = EvidenceStageInput.model_validate_json(source.model_dump_json())
    receipt = EvidenceStageReceipt.model_validate_json(
        (await port.stage(source, correlation_id)).model_dump_json()
    )
    fields = (
        "provider",
        "bucket",
        "object_key",
        "content_hash",
        "byte_size",
        "tenant_id",
        "engagement_id",
        "legal_hold",
        "encryption",
        "operation_id",
    )
    if (
        any(getattr(receipt, name) != getattr(source, name) for name in fields)
        or receipt.correlation_id != correlation_id
    ):
        raise ValueError("Evidence stage receipt mismatch")
    clock = now or datetime.now(UTC)
    retained = datetime.fromisoformat(receipt.retain_until.replace("Z", "+00:00"))
    expected = datetime.fromisoformat(source.retain_until.replace("Z", "+00:00"))
    readback = datetime.fromisoformat(receipt.readback_at.replace("Z", "+00:00"))
    if retained < expected or abs((readback - clock).total_seconds()) > 300:
        raise ValueError("Evidence stage receipt is unconfirmed")
    return StagedEvidenceOutput(source=source, receipt=receipt)
