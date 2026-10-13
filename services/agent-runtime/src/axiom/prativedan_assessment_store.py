"""Scoped, unmounted assessment-v2 RPC capability; no privileged ledger reader."""

from __future__ import annotations

import asyncio
from typing import Any, Protocol

from supabase import Client, create_client
from supabase.lib.client_options import SyncClientOptions

from .canonicalise import sha256_hex
from .config import Settings
from .ledger_client import AppendOnlyLedgerClient, _validated_writer_key
from .prativedan_assessment_draft_codec import AssessmentDraftBinding


class AssessmentRpcPort(Protocol):
    async def call(self, name: str, arguments: dict[str, Any]) -> object: ...


class _ScopedRpc:
    def __init__(self, client: Client) -> None:
        self.client = client

    async def call(self, name: str, arguments: dict[str, Any]) -> object:
        # Timeout leaves write outcome unknown. No retry or late success inference.
        async with asyncio.timeout(10):
            return await asyncio.to_thread(lambda: self.client.rpc(name, arguments).execute().data)


class PrativedanAssessmentStore:
    def __init__(self, rpc: AssessmentRpcPort) -> None:
        self._rpc = rpc

    @classmethod
    def from_settings(
        cls, settings: Settings
    ) -> tuple[PrativedanAssessmentStore, AppendOnlyLedgerClient]:
        key = _validated_writer_key(
            settings.supabase_agent_ledger_writer_key, settings.supabase_service_key
        )
        if not settings.supabase_url or not settings.supabase_anon_key:
            raise ValueError("Scoped assessment writer unavailable")
        client = create_client(
            settings.supabase_url,
            settings.supabase_anon_key,
            options=SyncClientOptions(
                headers={"Authorization": f"Bearer {key}"}, postgrest_client_timeout=10
            ),
        )
        return cls(_ScopedRpc(client)), AppendOnlyLedgerClient(client)

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
