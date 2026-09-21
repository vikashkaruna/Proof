"""FastAPI app for the agent runtime.

Exposes the agents over HTTP. The BFF calls these endpoints. The
runtime itself is stateless; all state is in Supabase (or S3 for
evidence). For long-running workflows, Temporal workers (separate
processes) drive the orchestration.
"""

from __future__ import annotations

import time
import uuid
from contextlib import asynccontextmanager
from typing import Any

import structlog
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from .agents import (
    DrishtiAgent,
    KaryaAgent,
    LekhaAgent,
    NazarAgent,
    ParikshanAgent,
    PrativedanAgent,
    SaakshiAgent,
    SanketAgent,
    SudhaarAgent,
    VibhaagAgent,
)
from .agents.base import AgentName, AgentRunResult
from .config import Settings, get_settings, setup_logging
from .ledger_client import LedgerClient
from .evidence_client import EvidenceVault
from .model_gateway import ModelGateway


AGENTS: dict[AgentName, Any] = {
    AgentName.DRISHTI: DrishtiAgent,
    AgentName.VIBHAAG: VibhaagAgent,
    AgentName.PARIKSHAN: ParikshanAgent,
    AgentName.SAAKSHI: SaakshiAgent,
    AgentName.SUDHAAR: SudhaarAgent,
    AgentName.KARYA: KaryaAgent,
    AgentName.LEKHA: LekhaAgent,
    AgentName.NAZAR: NazarAgent,
    AgentName.PRATIVEDAN: PrativedanAgent,
    AgentName.SANKET: SanketAgent,
}


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    setup_logging(settings)
    log = structlog.get_logger()
    log.info("agent_runtime.startup", env=settings.environment, port=settings.http_port)

    # Shared resources
    ledger = LedgerClient.from_settings(settings)
    evidence = EvidenceVault(settings)
    gateway = ModelGateway(settings)

    app.state.settings = settings
    app.state.ledger = ledger
    app.state.evidence = evidence
    app.state.gateway = gateway

    # Construct agent instances
    app.state.agents = {
        name: AgentCls(settings=settings, ledger=ledger, evidence=evidence, model_gateway=gateway)
        for name, AgentCls in AGENTS.items()
    }

    log.info("agent_runtime.ready", agents=[a.value for a in app.state.agents.keys()])
    try:
        yield
    finally:
        await gateway.aclose()
        log.info("agent_runtime.shutdown")


app = FastAPI(
    title="Axiom Proof — Agent Runtime",
    version="0.1.0",
    description=(
        "10 named agents for agentic DPDPA compliance: Drishti, Vibhaag, "
        "Parikshan, Saakshi, Sudhaar, Karya, Lekha, Nazar, Prativedan, Sanket."
    ),
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class InvokeRequest(BaseModel):
    correlation_id: str | None = None
    input: dict[str, Any]


class InvokeResponse(BaseModel):
    agent: str
    correlation_id: str
    status: str
    latency_ms: int
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    error: str | None = None
    output: dict[str, Any] | None = None
    ledger_entry_ids: list[str] = []


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/ready")
async def ready():
    settings: Settings = app.state.settings
    gateway: ModelGateway = app.state.gateway
    return {
        "status": "ready",
        "gateway_healthy": await gateway.health(),
        "env": settings.environment,
    }


@app.get("/agents")
async def list_agents():
    return {
        "agents": [
            {
                "name": a.name.value,
                "version": a.version,
                "autonomy": a.autonomy.value,
                "one_liner": a.one_liner,
                "tool_scopes": list(a.tool_scopes),
                "can_mutate": a.can_mutate,
            }
            for a in app.state.agents.values()
        ]
    }


@app.post("/agents/{agent_name}/invoke", response_model=InvokeResponse)
async def invoke_agent(agent_name: str, request: InvokeRequest, req: Request):
    try:
        agent_enum = AgentName(agent_name)
    except ValueError:
        raise HTTPException(status_code=404, detail=f"Unknown agent: {agent_name}")

    agent = app.state.agents.get(agent_enum)
    if not agent:
        raise HTTPException(status_code=404, detail=f"Agent not initialised: {agent_name}")

    # Internal-token check (BFF only)
    expected = app.state.settings.internal_token
    if expected:
        auth = req.headers.get("x-internal-token", "")
        if auth != expected:
            raise HTTPException(status_code=401, detail="invalid internal token")

    t0 = time.monotonic()
    result: AgentRunResult = await agent.invoke(
        request.input, correlation_id=request.correlation_id
    )
    latency_ms = int((time.monotonic() - t0) * 1000)

    return InvokeResponse(
        agent=agent.name.value,
        correlation_id=result.correlation_id,
        status=result.status,
        latency_ms=latency_ms,
        input_tokens=result.input_tokens,
        output_tokens=result.output_tokens,
        cost_usd=result.cost_usd,
        error=result.error,
        output=result.output,
        ledger_entry_ids=result.ledger_entry_ids,
    )


# ─── Internal-only: BFF calls this after a successful approval+execute
#     to trigger the agent runtime to actually do the work.
# W5 · R-05. The BFF sent camelCase to a model that requires snake_case and
# defines no aliases, so every dispatch was a 422 — and the BFF never checked
# the response, so it reported the batch as accepted. Aliases are deliberately
# NOT added: accepting both shapes would preserve the ambiguity that caused it.
# The contract is versioned instead, so a mismatch refuses with a reason.
EXECUTION_CONTRACT_VERSION = 2


class InternalExecuteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    contract_version: int
    tenant_id: str
    plan_id: str
    correlation_id: str
    action_ids: list[str]
    # The BFF's Idempotency-Key for this batch. Carried so the runtime can be
    # made idempotent against a redelivery when W5 adds the durable outbox.
    request_key: str
    mode: str
    concurrency: int
    stop_on_failure: bool
    approval_token: dict[str, Any]
    # v2: the content snapshot this batch was authorised for. The claim read it
    # from the approval token's signed payload, so it is what the approver
    # agreed to. A real executor must recompute the digest and refuse to mutate
    # anything that no longer matches — this runtime records it and refuses to
    # execute at all, which is the honest state until there is an executor.
    content_digest: str


@app.post("/internal/execute")
async def internal_execute(body: InternalExecuteRequest, req: Request):
    expected = app.state.settings.internal_token
    if not expected or req.headers.get("x-internal-token", "") != expected:
        raise HTTPException(status_code=401, detail="invalid internal token")

    if body.contract_version != EXECUTION_CONTRACT_VERSION:
        # A deployment error, and it says so. The BFF records this against the
        # batch and returns the actions to `approved` rather than reporting
        # work as running.
        raise HTTPException(
            status_code=400,
            detail=(
                f"unsupported execution contract version {body.contract_version}; "
                f"this runtime speaks version {EXECUTION_CONTRACT_VERSION}"
            ),
        )

    # No durable consumer exists yet. Logging an intent does not transfer
    # responsibility for execution; report a refusal until enqueueing exists.
    return JSONResponse(status_code=501, content={
        "accepted": False,
        "contract_version": EXECUTION_CONTRACT_VERSION,
        "correlation_id": body.correlation_id,
        "reason": "execution_not_implemented",
    })
