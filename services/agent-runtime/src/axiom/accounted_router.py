"""Unmounted HTTP adapter; peer guard alone never grants invocation authority."""

from collections.abc import Callable

from axiom_model_accounting import AccountedResult
from fastapi import APIRouter, HTTPException, Request

from .accounted_controller import AccountedController, AccountedDispatchRequest


def accounted_router(
    *, controller: AccountedController, require_peer: Callable[[Request], None]
) -> APIRouter:
    router = APIRouter()

    @router.post("/accounted-agents/invoke", response_model=AccountedResult)
    async def invoke(body: AccountedDispatchRequest, request: Request) -> AccountedResult:
        require_peer(request)
        try:
            return await controller.invoke(body)
        except Exception:
            raise HTTPException(
                status_code=503, detail="accounted_invocation_unconfirmed"
            ) from None

    return router
