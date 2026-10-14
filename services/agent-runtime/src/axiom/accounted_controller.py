"""Unmounted controller lifecycle. Ports never reach credential-free targets."""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Protocol

from axiom_model_accounting import (
    AccountedResult,
    AccountingBinding,
    Contract,
    Digest,
    Identifier,
    JournalReference,
    Receipt,
    legacy_projection,
    verify_accounted_result,
)

from .canonicalise import canonical_json, sha256_hex
from .model_call_store import AccountedComposer, ModelCallStore, PureAccountedTarget


class AccountedDispatchRequest(Contract):
    tenant_id: Identifier
    run_id: Identifier
    request_sha256: Digest


@dataclass(frozen=True)
class ClaimedAccountedTarget:
    binding: AccountingBinding
    target: PureAccountedTarget
    started_receipt: Receipt


class AccountedLifecyclePort(Protocol):
    async def claim(self, request: AccountedDispatchRequest) -> ClaimedAccountedTarget:
        """Independently authorize workload/human/context and claim exactly once."""
        ...

    async def complete(
        self,
        binding: AccountingBinding,
        started: Receipt,
        output_sha256: str | None,
        failure_code: str | None,
    ) -> Receipt:
        """Append terminal receipt; record facts after stop, never new work."""
        ...


class AccountedController:
    def __init__(
        self, lifecycle: AccountedLifecyclePort, composer: AccountedComposer, store: ModelCallStore
    ) -> None:
        self._lifecycle = lifecycle
        self._composer = composer
        self._store = store

    async def invoke(self, request: AccountedDispatchRequest) -> AccountedResult:
        start = time.monotonic()
        claimed = await self._lifecycle.claim(request)
        binding = claimed.binding
        if (binding.tenant_id, binding.run_id, binding.request_sha256) != (
            request.tenant_id,
            request.run_id,
            request.request_sha256,
        ):
            raise ValueError("accounted_dispatch_refused")
        computation = await self._composer.compute(binding, claimed.target)
        # Freeze once; retain these original bytes for hashing and HTTP transport.
        output_text = (
            canonical_json(computation.output) if computation.failure_code is None else None
        )
        completed = await self._lifecycle.complete(
            binding,
            claimed.started_receipt,
            sha256_hex(output_text) if output_text is not None else None,
            computation.failure_code,
        )
        await self._store.seal(binding, claimed.started_receipt, completed)
        expected = await self._store.read_result(binding)
        projection = legacy_projection(expected.seal.summary)
        result = AccountedResult(
            **binding.model_dump(),
            kind="accounted_agent_result",
            status="succeeded" if computation.failure_code is None else "failed",
            latency_ms=min(int((time.monotonic() - start) * 1000), 2147483647),
            **projection.model_dump(),
            error=computation.failure_code,
            runtime_output_text=output_text,
            ledger_entry_ids=[claimed.started_receipt.id, completed.id],
            accounting_reference=JournalReference(
                calls_sha256=expected.seal.calls_sha256, receipt=expected.seal.accounting_receipt
            ),
        )
        return verify_accounted_result(result.model_dump(), expected).result
