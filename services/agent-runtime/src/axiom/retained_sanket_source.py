"""Consistency boundary for a SQL-authorized retained Sanket capture.

This is a service-side factory, not a business-input or transport endpoint.
The future restricted composition must prove current authority, source ownership,
original human capture receipt, immutable request and exclusive claim before work. Hashes
here prove byte consistency only: caller-provided JSON is never that authority.
Raw HTML was discarded by the original guarded capture; this factory does not
claim to fetch it again or independently rehash its content digest.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Annotated, Any

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, field_validator

from .agents.public_source import Digest, Identifier, Version
from .agents.sanket import SanketAgent, SanketInput, SanketOutput
from .canonicalise import canonical_json, sha256_hex
from .public_signal_sources import GuardedPublicDocument, VerifiedPublicSourceBatch, public_origin


def canonical_positive_int64_receipt(value: Any) -> str:
    if (
        type(value) is not str
        or re.fullmatch(r"[1-9][0-9]{0,18}", value) is None
        or int(value) > 9223372036854775807
    ):
        raise ValueError("Canonical positive signed int64 receipt refused")
    return value


Receipt = Annotated[str, BeforeValidator(canonical_positive_int64_receipt)]
MAX_CAPTURE_RESULT_BYTES = 32768
MAX_INPUT_BYTES = 32768


class RetainedSanketScope(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    tenant_id: Identifier
    actor_id: Identifier
    engagement_id: Identifier
    run_id: Identifier
    operation_key: Identifier


class RetainedSanketCapture(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    check_id: Identifier
    capture_actor_id: Identifier
    capture_correlation_id: Identifier
    capture_receipt: Receipt
    result_sha256: Digest
    requested_url: str = Field(min_length=1, max_length=2048)
    final_url: str = Field(min_length=1, max_length=2048)
    checked_at: str = Field(min_length=1, max_length=64)
    content_sha256: Digest
    byte_size: int = Field(ge=1, le=512 * 1024)
    title: str = Field(max_length=300)
    headings: tuple[str, ...] = Field(max_length=12)

    @field_validator("headings", mode="before")
    @classmethod
    def immutable_headings(cls, value: Any) -> tuple[str, ...]:
        if not isinstance(value, (list, tuple)) or any(
            type(item) is not str or len(item) > 300 for item in value
        ):
            raise ValueError("Retained heading projection refused")
        return tuple(value)


class RetainedSanketInput(SanketInput):
    """Dedicated input hash binds the source; generic Sanket still refuses it."""

    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    schema_version: Version
    tenant_id: Identifier
    engagement_id: Identifier
    correlation_id: Identifier
    source: RetainedSanketCapture


class RecordedSanketSource(RetainedSanketScope):
    input_text: str = Field(min_length=1, max_length=MAX_INPUT_BYTES)
    input_hash: Digest
    requested_receipt: Receipt
    capture_result_text: str = Field(min_length=1, max_length=MAX_CAPTURE_RESULT_BYTES)


@dataclass(frozen=True, slots=True)
class PreparedRetainedSanketSource:
    input: RetainedSanketInput
    public_source_batch: VerifiedPublicSourceBatch
    requested_receipt: str


class RetainedSanketAgent(SanketAgent):
    """Only a dedicated trusted composition may install this strict source input."""

    def __init__(self, *, prepared: PreparedRetainedSanketSource, **kwargs: Any):
        if type(prepared) is not PreparedRetainedSanketSource:
            raise ValueError("Retained Sanket service capability required")
        super().__init__(public_source_batch=prepared.public_source_batch, **kwargs)
        self._retained_source = prepared

    def input_schema(self) -> type[RetainedSanketInput]:
        return RetainedSanketInput

    async def _run(self, *, correlation_id: str, input: SanketInput, **deps: Any) -> SanketOutput:
        if (
            not isinstance(input, RetainedSanketInput)
            or input != self._retained_source.input
            or correlation_id != self._retained_source.input.correlation_id
            or "public_source_batch" in deps
        ):
            raise ValueError("Retained Sanket installed source mismatch")
        return await super()._run(correlation_id=correlation_id, input=input)


def prepare_retained_sanket_source(
    recorded: object, *, expected_scope: RetainedSanketScope
) -> PreparedRetainedSanketSource:
    """Decode the restricted loader's row, without any HTTP, DB or ledger work."""
    row = RecordedSanketSource.model_validate(recorded)
    if (
        RetainedSanketScope.model_validate(
            row.model_dump(include=set(RetainedSanketScope.model_fields))
        )
        != expected_scope
        or len(row.input_text.encode("utf-8")) > MAX_INPUT_BYTES
        or len(row.capture_result_text.encode("utf-8")) > MAX_CAPTURE_RESULT_BYTES
        or sha256_hex(row.input_text) != row.input_hash
    ):
        raise ValueError("Retained Sanket dispatch consistency refused")
    parsed = RetainedSanketInput.model_validate_json(row.input_text)
    if (
        parsed.tenant_id != row.tenant_id
        or parsed.engagement_id != row.engagement_id
        or parsed.correlation_id != row.operation_key
        or int(parsed.source.capture_receipt) >= int(row.requested_receipt)
        or canonical_json(parsed.model_dump(mode="json")) != row.input_text
        or sha256_hex(row.capture_result_text) != parsed.source.result_sha256
    ):
        raise ValueError("Retained Sanket input consistency refused")
    original = json.loads(row.capture_result_text)
    source = parsed.source
    if not isinstance(original, dict) or (
        original.get("status") != "checked"
        or type(original.get("httpStatus")) is not int
        or original.get("httpStatus") != 200
        or type(original.get("bytes")) is not int
        or original.get("bytes") != source.byte_size
        or original.get("requestedUrl") != source.requested_url
        or original.get("finalUrl") != source.final_url
        or original.get("checkedAt") != source.checked_at
        or original.get("contentSha256") != source.content_sha256
        or original.get("title") != source.title
        or original.get("headings") != list(source.headings)
    ):
        raise ValueError("Retained Sanket capture projection refused")
    # The SQL loader verifies the original full-result hash against the human
    # capture receipt. Reconstruct only its exact bounded DOM projection.
    document = GuardedPublicDocument(
        requested_url=source.requested_url,
        final_url=source.final_url,
        checked_at=source.checked_at,
        content_sha256=source.content_sha256,
        byte_size=source.byte_size,
        title=source.title,
        headings=source.headings,
        capture_reference=source.check_id,
    )
    batch = VerifiedPublicSourceBatch(
        tenant_id=row.tenant_id,
        correlation_id=row.operation_key,
        agent="sanket",
        approved_origins=tuple(
            dict.fromkeys((public_origin(source.requested_url), public_origin(source.final_url)))
        ),
        documents=(document,),
    )
    return PreparedRetainedSanketSource(parsed, batch, row.requested_receipt)
