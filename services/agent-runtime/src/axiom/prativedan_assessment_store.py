"""Scoped, unmounted assessment-v2 RPC capability; no privileged ledger reader."""

from __future__ import annotations

from typing import Any, Protocol

from .canonicalise import sha256_hex
from .config import Settings
from .ledger_client import AppendOnlyLedgerClient
from .prativedan_assessment_draft_codec import AssessmentDraftBinding


class AssessmentRpcPort(Protocol):
    async def call(self, name: str, arguments: dict[str, Any]) -> object: ...


class PrativedanAssessmentStore:
    def __init__(self, rpc: AssessmentRpcPort) -> None:
        self._rpc = rpc

    @classmethod
    def from_settings(
        cls, settings: Settings
    ) -> tuple[PrativedanAssessmentStore, AppendOnlyLedgerClient]:
        # Dedicated workers never receive controller credentials. A mounted
        # deployment needs an authenticated private-controller port, not the
        # generic writer, service key, or a caller-supplied identity assertion.
        raise PermissionError("Dedicated Prativedan controller channel is unprovisioned")

    @staticmethod
    def arguments(binding: AssessmentDraftBinding) -> dict[str, Any]:
        return {
            "t": binding.tenant_id,
            "k": binding.operation_key,
            "r": binding.run_id,
            "rh": sha256_hex(binding.request_text),
        }

    async def load(self, binding: AssessmentDraftBinding) -> object:
        return await self._rpc.call("load_prativedan_assessment_dispatch", self.arguments(binding))

    async def claim(self, binding: AssessmentDraftBinding, input_text: str) -> object:
        return await self._rpc.call(
            "claim_prativedan_assessment_draft",
            {**self.arguments(binding), "input_text": input_text},
        )

    async def receipts(
        self, binding: AssessmentDraftBinding, started: str, completed: str
    ) -> object:
        return await self._rpc.call(
            "read_prativedan_assessment_runtime_receipts",
            {**self.arguments(binding), "started": started, "completed": completed},
        )
