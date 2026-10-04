"""Load and verify persisted public-source inputs before any agent work."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict

from .agents.drishti import DrishtiInvocationInput
from .agents.public_source import Digest, Identifier
from .agents.vibhaag import VibhaagInvocationInput
from .canonicalise import canonical_json, sha256_hex
from .ledger_client import LedgerClient


class PublicSourceInvokeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    tenant_id: Identifier
    run_id: Identifier
    correlation_id: Identifier


class RecordedPublicSourceDispatch(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    dispatch_id: Identifier
    request_hash: Digest
    input: dict[str, Any]


class PublicSourceClaim(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    dispatch_id: Identifier
    claimed: bool


class PublicSourceAlreadyClaimedError(ValueError):
    """A recorded dispatch cannot execute again, including after unknown outcomes."""


async def prepare_public_source_input(
    ledger: LedgerClient, request: PublicSourceInvokeRequest, agent: str
) -> dict[str, Any]:
    """Transport consistency checks supplement the SQL authority boundary."""
    if agent not in {"drishti", "vibhaag"}:
        raise ValueError("Public source agent was refused")
    raw = await ledger.load_public_source_dispatch(
        tenant_id=request.tenant_id,
        run_id=request.run_id,
        agent=agent,
        correlation_id=request.correlation_id,
    )
    dispatch = RecordedPublicSourceDispatch.model_validate(raw)
    schema = DrishtiInvocationInput if agent == "drishti" else VibhaagInvocationInput
    parsed = schema.model_validate(dispatch.input)
    normalized: dict[str, Any] = dict(parsed.model_dump(mode="json"))
    if (
        normalized.get("mode") != "public_website"
        or parsed.tenant_id != request.tenant_id
        or sha256_hex(canonical_json(normalized)) != dispatch.request_hash
    ):
        raise ValueError("Public source dispatch consistency was refused")
    raw_claim = await ledger.claim_public_source_dispatch(
        tenant_id=request.tenant_id,
        run_id=request.run_id,
        agent=agent,
        correlation_id=request.correlation_id,
        dispatch_id=dispatch.dispatch_id,
        request_hash=dispatch.request_hash,
    )
    claim = PublicSourceClaim.model_validate(raw_claim)
    if claim.dispatch_id != dispatch.dispatch_id:
        raise ValueError("Public source claim consistency was refused")
    if not claim.claimed:
        raise PublicSourceAlreadyClaimedError("Public source dispatch was already claimed")
    return normalized
