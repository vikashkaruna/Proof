"""Measured no-write rollback roundtrip for an explicitly registered owned fixture.

The target's audited reducer must be shared by its real write and simulation
paths. Exact captured state, registered implementation digest and capabilities
are bound to the result; a declaration of boolean shape alone is insufficient.
This module records no approval, application receipt or rollback-validation flag.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, StrictInt

from .owned_target import MeasuredReview, OwnedTarget, Snapshot
from .owned_target_semantics import CAPABILITIES, ENGINE, capability_sha256, project
from .write_adapters import WriteRefused


class EngineCapabilities(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    engine: str
    implementation_sha256: str = Field(pattern="^[a-f0-9]{64}$")
    capability_sha256: str = Field(pattern="^[a-f0-9]{64}$")
    capabilities: tuple[str, ...]


class Roundtrip(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    engine: EngineCapabilities
    before: Snapshot
    projected_after: Snapshot
    restored: Snapshot
    persistent_mutations: StrictInt = Field(ge=0, le=0)
    resources_measured: StrictInt = Field(ge=1, le=1)


async def validate_owned_roundtrip(
    target: OwnedTarget, *, registered_engine_sha256: str, registered_capability_sha256: str
) -> Roundtrip:
    before = await target.read()
    if before.audit_log_enabled:
        raise WriteRefused("owned_target_no_change")
    raw = await target._request("GET", "/validation/audit-log-enable")
    try:
        proof = Roundtrip.model_validate(raw)
    except ValueError:
        raise WriteRefused("owned_target_rollback_validation_unconfirmed") from None
    if (
        proof.engine.engine != ENGINE
        or proof.engine.implementation_sha256 != registered_engine_sha256
        or proof.engine.capability_sha256 != registered_capability_sha256
        or proof.engine.capability_sha256 != capability_sha256()
        or proof.engine.capabilities != CAPABILITIES
        or proof.before != before
        or proof.projected_after != project(before, enabled=True)
        or proof.restored != project(proof.projected_after, enabled=before.audit_log_enabled)
        or proof.restored.content_sha256 != before.content_sha256
    ):
        raise WriteRefused("owned_target_rollback_validation_unconfirmed")
    if await target.read() != before:
        raise WriteRefused("owned_target_source_changed")
    return proof


async def measure_validated_review(
    target: OwnedTarget, *, registered_engine_sha256: str, registered_capability_sha256: str
) -> tuple[MeasuredReview, Roundtrip]:
    """Measure through the bound target rather than accepting a caller-built proof.

    The domain producer must persist this proof with the registered binding and
    original human request before granting any application rollback eligibility.
    """
    proof = await validate_owned_roundtrip(
        target,
        registered_engine_sha256=registered_engine_sha256,
        registered_capability_sha256=registered_capability_sha256,
    )
    return MeasuredReview(proof.before, True), proof
