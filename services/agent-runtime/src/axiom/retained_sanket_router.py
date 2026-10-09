"""Unmounted peer-protected Sanket route for a retained SQL source only."""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict

from .agents.base import DispatchContext
from .canonicalise import canonical_json, sha256_hex
from .config import Settings
from .ledger_client import LedgerClient
from .retained_sanket_dispatch import (
    RetainedSanketAlreadyClaimedError,
    RetainedSanketInvokeRequest,
    RetainedSanketStore,
    prepare_claimed_retained_sanket_source,
)
from .retained_sanket_source import RetainedSanketAgent


class RetainedSanketInvokeResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    agent: str
    correlation_id: str
    status: str
    latency_ms: int
    input_tokens: int
    output_tokens: int
    cost_usd: float
    error: str | None
    output: dict[str, Any] | None
    ledger_entry_ids: list[str]


def retained_sanket_router(
    *,
    store: RetainedSanketStore,
    ledger: LedgerClient,
    settings: Settings,
    require_peer: Callable[[Request], None],
) -> APIRouter:
    """Mount only with the existing authenticated peer guard/scoped writer.

    No generic runtime registry mutation, service reader, caller-capture input,
    launch loop or startup data registration exists here. Losing a claim is
    uncertain, never permission to run a second time. Output persistence and
    controller settlement remain the BFF's atomic restricted SQL operation.
    """
    router = APIRouter()

    @router.post(
        "/retained-public-sources/agents/sanket/invoke",
        response_model=RetainedSanketInvokeResponse,
    )
    async def invoke_retained_sanket(
        body: RetainedSanketInvokeRequest, request: Request
    ) -> RetainedSanketInvokeResponse:
        require_peer(request)
        started = time.monotonic()
        try:
            prepared = await prepare_claimed_retained_sanket_source(store, body)
        except RetainedSanketAlreadyClaimedError:
            raise HTTPException(status_code=409, detail="retained_sanket_already_claimed") from None
        except Exception:
            raise HTTPException(status_code=503, detail="retained_sanket_unconfirmed") from None
        try:
            # Source-read/claim capability stays in this closure. The agent has
            # neither that store nor the runtime's privileged read client.
            agent = RetainedSanketAgent(
                prepared=prepared, settings=settings, ledger=ledger.append_only_view()
            )
            result = await agent.invoke(
                prepared.input,
                correlation_id=body.operation_key,
                dispatch_context=DispatchContext.model_validate(
                    {
                        "run_id": body.run_id,
                        "request_hash": sha256_hex(
                            canonical_json(prepared.input.model_dump(mode="json"))
                        ),
                    }
                ),
            )
        except Exception:
            raise HTTPException(status_code=503, detail="retained_sanket_unconfirmed") from None
        return RetainedSanketInvokeResponse(
            agent="sanket",
            correlation_id=result.correlation_id,
            status=result.status,
            latency_ms=int((time.monotonic() - started) * 1000),
            input_tokens=result.input_tokens,
            output_tokens=result.output_tokens,
            cost_usd=result.cost_usd,
            error=result.error,
            output=result.output,
            ledger_entry_ids=result.ledger_entry_ids,
        )

    return router
