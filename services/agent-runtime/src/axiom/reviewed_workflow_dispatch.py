"""One-shot retained human-declaration transport, separate from generic inputs."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .agents.public_source import Digest, Identifier
from .agents.reviewed_workflows import ReviewedWorkflowInput
from .canonicalise import canonical_json, sha256_hex
from .ledger_client import LedgerClient


class ReviewedWorkflowInvokeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    tenant_id: Identifier
    run_id: Identifier
    operation_key: Identifier


class RecordedReviewedWorkflowDispatch(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    run_id: Identifier
    request_hash: Digest
    input_text: str = Field(min_length=1)


class ReviewedWorkflowClaim(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    run_id: Identifier
    claimed: bool


class ReviewedWorkflowAlreadyClaimedError(ValueError):
    """Claimed or uncertain attempts must never be executed a second time."""


async def prepare_reviewed_workflow_input(
    ledger: LedgerClient, request: ReviewedWorkflowInvokeRequest
) -> dict[str, Any]:
    """SQL proves authority; transport verifies exact canonical bytes before claim."""
    dispatch = RecordedReviewedWorkflowDispatch.model_validate(
        await ledger.load_reviewed_workflow_dispatch(
            tenant_id=request.tenant_id,
            run_id=request.run_id,
            operation_key=request.operation_key,
        )
    )
    if dispatch.run_id != request.run_id or len(dispatch.input_text.encode()) > 524288:
        raise ValueError("Reviewed source transport was refused")
    parsed = ReviewedWorkflowInput.model_validate_json(dispatch.input_text)
    normalized: dict[str, Any] = dict(parsed.model_dump(mode="json"))
    if (
        parsed.tenant_id != request.tenant_id
        or canonical_json(normalized) != dispatch.input_text
        or sha256_hex(dispatch.input_text) != dispatch.request_hash
    ):
        raise ValueError("Reviewed source transport was refused")
    claim = ReviewedWorkflowClaim.model_validate(
        await ledger.claim_reviewed_workflow_dispatch(
            tenant_id=request.tenant_id,
            run_id=request.run_id,
            operation_key=request.operation_key,
            request_hash=dispatch.request_hash,
        )
    )
    if claim.run_id != request.run_id:
        raise ValueError("Reviewed source claim was refused")
    if not claim.claimed:
        raise ReviewedWorkflowAlreadyClaimedError("Reviewed source was already claimed")
    return normalized
