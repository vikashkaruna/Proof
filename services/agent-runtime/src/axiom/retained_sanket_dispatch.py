"""Restricted IDs-only retained-source transport; never caller-supplied captures.

This module is not mounted. SQL supplies current source/actor authority and the
exclusive claim; the factory validates exact bytes before any claim or work.
The scoped source client is retained by the dispatcher, never given to an agent.
"""

from __future__ import annotations

import asyncio
from typing import Protocol

from pydantic import BaseModel, ConfigDict
from supabase import Client, create_client
from supabase.lib.client_options import SyncClientOptions

from .agents.public_source import Digest, Identifier
from .config import Settings
from .ledger_client import _validated_writer_key
from .retained_sanket_source import (
    PreparedRetainedSanketSource,
    RecordedSanketSource,
    RetainedSanketScope,
    prepare_retained_sanket_source,
)


class RetainedSanketInvokeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    tenant_id: Identifier
    run_id: Identifier
    operation_key: Identifier


class RetainedSanketClaim(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    run_id: Identifier
    claimed: bool


class RetainedSanketAlreadyClaimedError(ValueError):
    """A claimed or uncertain attempt never authorizes another invocation."""


class RetainedSanketStore(Protocol):
    async def load(self, request: RetainedSanketInvokeRequest) -> object: ...

    async def claim(self, request: RetainedSanketInvokeRequest, input_hash: str) -> object: ...


class RestrictedRetainedSanketStore:
    """Only the scoped writer's two narrow SQL RPCs; no table/read fallback.

    PostgREST authenticates the JWT and SQL restricts function grants. Local
    configuration validation does not purport to verify a JWT signature.
    Each client's PostgREST timeout is bounded. A lost claim is never retried.
    """

    def __init__(self, client: Client):
        self._client = client

    @classmethod
    def from_settings(cls, settings: Settings) -> RestrictedRetainedSanketStore:
        try:
            writer = _validated_writer_key(
                settings.supabase_agent_ledger_writer_key, settings.supabase_service_key
            )
            if not settings.supabase_anon_key:
                raise ValueError("unavailable")
            client = create_client(
                settings.supabase_url,
                settings.supabase_anon_key,
                options=SyncClientOptions(
                    headers={"Authorization": f"Bearer {writer}"}, postgrest_client_timeout=10
                ),
            )
            return cls(client)
        except Exception:
            raise RuntimeError("Retained source writer configuration was refused") from None

    async def load(self, request: RetainedSanketInvokeRequest) -> object:
        return await asyncio.to_thread(
            lambda: (
                self._client.rpc(
                    "read_retained_sanket_dispatch",
                    {
                        "p_tenant_id": request.tenant_id,
                        "p_run_id": request.run_id,
                        "p_operation_key": request.operation_key,
                    },
                )
                .execute()
                .data
            )
        )

    async def claim(self, request: RetainedSanketInvokeRequest, input_hash: str) -> object:
        # Explicitly validate the digest even if this method is used outside the
        # composed prepare function. Never send arbitrary body data to the RPC.
        digest = DigestValidator(input_hash=input_hash).input_hash
        return await asyncio.to_thread(
            lambda: (
                self._client.rpc(
                    "claim_retained_sanket_dispatch",
                    {
                        "p_tenant_id": request.tenant_id,
                        "p_run_id": request.run_id,
                        "p_operation_key": request.operation_key,
                        "p_request_hash": digest,
                    },
                )
                .execute()
                .data
            )
        )


class DigestValidator(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    input_hash: Digest


async def prepare_claimed_retained_sanket_source(
    store: RetainedSanketStore, request: RetainedSanketInvokeRequest
) -> PreparedRetainedSanketSource:
    row = RecordedSanketSource.model_validate(await store.load(request))
    if (
        row.tenant_id != request.tenant_id
        or row.run_id != request.run_id
        or row.operation_key != request.operation_key
    ):
        raise ValueError("Retained source dispatch context was refused")
    # Actor/engagement are supplied ONLY by the restricted SQL row; the HTTP
    # caller can neither choose them nor replace the saved input or witness.
    expected_scope = RetainedSanketScope.model_validate(
        row.model_dump(include=set(RetainedSanketScope.model_fields))
    )
    prepared = prepare_retained_sanket_source(row, expected_scope=expected_scope)
    claim = RetainedSanketClaim.model_validate(await store.claim(request, row.input_hash))
    if claim.run_id != request.run_id:
        raise ValueError("Retained source claim context was refused")
    if not claim.claimed:
        raise RetainedSanketAlreadyClaimedError("Retained source was already claimed")
    return prepared
