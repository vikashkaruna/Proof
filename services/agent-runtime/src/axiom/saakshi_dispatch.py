"""One-shot source-bound transport of retained human evidence metadata only."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from pydantic import BaseModel, ConfigDict, Field

from .canonicalise import canonical_json, sha256_hex
from .saakshi_staging import HASH, UUID, EvidenceStageInput


class EvidenceInvokeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    tenant_id: str = Field(pattern=UUID)
    run_id: str = Field(pattern=UUID)
    operation_key: str = Field(pattern=UUID)


class RecordedEvidenceDispatch(EvidenceInvokeRequest):
    input_text: str = Field(min_length=1, max_length=16000)
    request_hash: str = Field(pattern=HASH)
    requested_receipt: str = Field(pattern=r"^[1-9][0-9]{0,19}$")


class EvidenceDispatchClaim(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    run_id: str = Field(pattern=UUID)
    claimed: bool
    expires_at_ms: int = Field(gt=0)


class EvidenceDispatchLedger(Protocol):
    async def load_saakshi_dispatch(
        self, *, tenant_id: str, run_id: str, operation_key: str
    ) -> object: ...
    async def claim_saakshi_dispatch(
        self, *, tenant_id: str, run_id: str, operation_key: str, request_hash: str
    ) -> object: ...


@dataclass(frozen=True)
class PreparedEvidenceDispatch:
    source: EvidenceStageInput
    run_id: str
    correlation_id: str
    requested_receipt: str
    expires_at_ms: int


class EvidenceAlreadyClaimedError(ValueError):
    """A claimed or uncertain attempt cannot redispatch."""


async def prepare_evidence_dispatch(
    ledger: EvidenceDispatchLedger, request: EvidenceInvokeRequest, *, now_ms: int
) -> PreparedEvidenceDispatch:
    parameters = request.model_dump()
    recorded = RecordedEvidenceDispatch.model_validate(
        await ledger.load_saakshi_dispatch(**parameters)
    )
    if any(getattr(recorded, name) != value for name, value in parameters.items()):
        raise ValueError("Evidence source was refused")
    if len(recorded.input_text.encode()) > 16000:
        raise ValueError("Evidence source was refused")
    source = EvidenceStageInput.model_validate_json(recorded.input_text)
    if (
        canonical_json(source.model_dump(mode="json")) != recorded.input_text
        or sha256_hex(recorded.input_text) != recorded.request_hash
        or source.tenant_id != request.tenant_id
        or source.operation_key != request.operation_key
    ):
        raise ValueError("Evidence source was refused")
    claim = EvidenceDispatchClaim.model_validate(
        await ledger.claim_saakshi_dispatch(**parameters, request_hash=recorded.request_hash)
    )
    if claim.run_id != request.run_id or claim.expires_at_ms <= now_ms:
        raise ValueError("Evidence claim was refused")
    if not claim.claimed:
        raise EvidenceAlreadyClaimedError("Evidence source was already claimed")
    return PreparedEvidenceDispatch(
        source,
        request.run_id,
        request.operation_key,
        recorded.requested_receipt,
        claim.expires_at_ms,
    )
