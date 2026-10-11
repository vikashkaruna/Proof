"""Unwired controller-mediated owned PostgreSQL target contract.

The controller owns the target resource and human-plan writer transaction domain.
Runtime callers receive fixed methods and server-resolved IDs, never SQL, database
credentials or a target-registration facility. This component issues no approval
and performs no named-agent invocation or application ledger settlement.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol
from uuid import UUID

from .owned_target import Snapshot
from .owned_target_semantics import CAPABILITIES, ENGINE, capability_sha256, project
from .owned_target_validation import Roundtrip
from .write_adapters import WriteRefused


@dataclass(frozen=True)
class RegisteredPostgresTarget:
    tenant_id: UUID
    binding_id: UUID
    engagement_id: UUID
    fixture_id: UUID
    resource_id: UUID
    engine_sha256: str
    capability_sha256: str


class OwnedControllerPort(Protocol):
    """Authenticated controller transport; only a reviewed server binding selects IDs."""

    async def read(self, binding: RegisteredPostgresTarget) -> object: ...

    async def measure(self, binding: RegisteredPostgresTarget) -> object: ...

    async def cas(
        self,
        binding: RegisteredPostgresTarget,
        operation_id: UUID,
        original: Snapshot,
        enabled: bool,
    ) -> object: ...


class OwnedPostgresTarget:
    def __init__(self, binding: RegisteredPostgresTarget, controller: OwnedControllerPort):
        if (
            len(binding.engine_sha256) != 64
            or any(c not in "0123456789abcdef" for c in binding.engine_sha256)
            or binding.capability_sha256 != capability_sha256()
        ):
            raise ValueError("reviewed owned PostgreSQL registration required")
        self.binding = binding
        self._controller = controller

    def _snapshot(self, raw: object) -> Snapshot:
        try:
            value = Snapshot.model_validate(raw)
        except ValueError:
            raise WriteRefused("owned_postgres_snapshot_unconfirmed") from None
        if (
            value.fixture_id != self.binding.fixture_id
            or value.resource_id != self.binding.resource_id
            or value.version > 9_007_199_254_740_989
        ):
            raise WriteRefused("owned_postgres_identity_mismatch")
        return value

    async def read(self) -> Snapshot:
        return self._snapshot(await self._controller.read(self.binding))

    async def measure(self) -> Roundtrip:
        before = await self.read()
        if before.audit_log_enabled:
            raise WriteRefused("owned_postgres_no_change")
        try:
            proof = Roundtrip.model_validate(await self._controller.measure(self.binding))
        except ValueError:
            raise WriteRefused("owned_postgres_validation_unconfirmed") from None
        if (
            proof.before != before
            or proof.engine.engine != ENGINE
            or proof.engine.implementation_sha256 != self.binding.engine_sha256
            or proof.engine.capability_sha256 != self.binding.capability_sha256
            or proof.engine.capabilities != CAPABILITIES
            or proof.projected_after != project(before, enabled=True)
            or proof.restored != project(proof.projected_after, enabled=False)
            or proof.restored.content_sha256 != before.content_sha256
        ):
            raise WriteRefused("owned_postgres_validation_unconfirmed")
        if await self.read() != before:
            raise WriteRefused("owned_postgres_source_changed")
        # PostgreSQL writer must recheck and lock this source through its atomic commit.
        return proof

    async def change(self, operation_id: UUID, original: Snapshot, enabled: bool) -> Snapshot:
        if type(enabled) is not bool:
            raise WriteRefused("owned_postgres_parameters_invalid")
        before = self._snapshot(original.model_dump(mode="json"))
        if before.audit_log_enabled is enabled:
            raise WriteRefused("owned_postgres_no_change")
        # The controller CAS resolves the exact original journal before checking current
        # state, making a retry after a committed lost response safe for the same body.
        result = self._snapshot(
            await self._controller.cas(self.binding, operation_id, before, enabled)
        )
        if result != project(before, enabled=enabled):
            raise WriteRefused("owned_postgres_operation_unconfirmed")
        if await self.read() != result:
            raise WriteRefused("owned_postgres_readback_mismatch")
        return result
