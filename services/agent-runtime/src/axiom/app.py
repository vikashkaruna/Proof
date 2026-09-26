"""FastAPI app for the agent runtime.

Exposes the agents over HTTP. The BFF calls these endpoints. The
runtime itself is stateless; all state is in Supabase (or S3 for
evidence). For long-running workflows, Temporal workers (separate
processes) drive the orchestration.
"""

from __future__ import annotations

import secrets
import time
from contextlib import asynccontextmanager
from typing import Any

import structlog
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

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
from .dry_run import DRY_RUN_CONTRACT_VERSION, DryRunOutcome, simulate
from .evidence_client import EvidenceVault
from .ledger_client import LedgerClient
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
                "mutates_client_estate": a.mutates_client_estate,
                "writes_axiom_state": a.writes_axiom_state,
            }
            for a in app.state.agents.values()
        ]
    }


def require_internal_caller(request: Request) -> None:
    """Legacy BFF transport authentication; never workload or grant authority."""
    expected = app.state.settings.internal_token
    supplied = request.headers.get("x-internal-token", "")
    if not expected or not secrets.compare_digest(supplied.encode(), expected.encode()):
        raise HTTPException(status_code=401, detail="invalid internal token")


@app.post("/agents/{agent_name}/invoke", response_model=InvokeResponse)
async def invoke_agent(agent_name: str, request: InvokeRequest, req: Request):
    require_internal_caller(req)
    try:
        agent_enum = AgentName(agent_name)
    except ValueError:
        raise HTTPException(status_code=404, detail=f"Unknown agent: {agent_name}")

    agent = app.state.agents.get(agent_enum)
    if not agent:
        raise HTTPException(status_code=404, detail=f"Agent not initialised: {agent_name}")

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
    require_internal_caller(req)

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


# W5 · M3.2 — the dry-run engine. Sudhaar's declared simulation for one
# action: simulate from the content the BFF read from the stored action,
# then record through `record_dry_run` (migration 0060). A result is
# returned only after it is recorded — a recorded refusal is an outcome
# (the action routes to manual handling); an unrecorded diff returns
# nothing at all.
class InternalDryRunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    contract_version: int
    tenant_id: str
    action_id: str
    action_type: str
    parameters: dict[str, Any]
    blast_radius: dict[str, Any] = Field(default_factory=dict)
    rollback_definition: dict[str, Any]
    correlation_id: str


def _record_dry_run_via_rpc(
    settings: Settings, payload: InternalDryRunRequest, outcome: DryRunOutcome
) -> dict[str, Any]:
    """Call `record_dry_run` (0060) with the service role. Returns the RPC's
    jsonb: `{'dryRun': ...}` on success, `{'error': code}` on refusal."""
    from supabase import create_client

    client = create_client(settings.supabase_url, settings.supabase_service_key)
    result = (
        client.rpc(
            "record_dry_run",
            {
                "p_tenant_id": payload.tenant_id,
                "p_action_id": payload.action_id,
                "p_status": outcome.status,
                "p_diff": outcome.diff,
                "p_refusal_reason": outcome.refusal_reason,
                "p_simulated_by": "sudhaar",
                "p_parameters": payload.parameters,
                "p_rollback_definition": payload.rollback_definition,
                "p_correlation_id": payload.correlation_id,
            },
        )
        .execute()
    )
    return result.data if isinstance(result.data, dict) else {"error": "record_failed"}


# RPC error codes the caller can act on; anything else is reported as a
# generic refusal so the BFF never renders an unknown state as success.
_RECODER_REFUSALS = {
    "action_not_found",
    "action_not_eligible",
    "content_mismatch",
    "invalid_record",
    "invalid_diff",
    "invalid_refusal",
}


@app.post("/internal/dry-run")
async def internal_dry_run(body: InternalDryRunRequest, req: Request):
    require_internal_caller(req)

    if body.contract_version != DRY_RUN_CONTRACT_VERSION:
        raise HTTPException(
            status_code=400,
            detail=(
                f"unsupported dry-run contract version {body.contract_version}; "
                f"this runtime speaks version {DRY_RUN_CONTRACT_VERSION}"
            ),
        )

    settings: Settings = req.app.state.settings
    outcome = simulate(
        body.action_type, body.parameters, body.blast_radius, body.rollback_definition
    )
    try:
        recorded = _record_dry_run_via_rpc(settings, body, outcome)
    except Exception:
        structlog.get_logger().warning("dry_run.record_unavailable", action_id=body.action_id)
        return JSONResponse(
            status_code=503,
            content={"accepted": False, "reason": "recorder_unavailable"},
        )
    if "error" in recorded:
        code = recorded["error"] if recorded["error"] in _RECODER_REFUSALS else "record_refused"
        return JSONResponse(status_code=409, content={"accepted": False, "reason": code})
    return {
        "accepted": True,
        "contract_version": DRY_RUN_CONTRACT_VERSION,
        "correlation_id": body.correlation_id,
        "dry_run": recorded.get("dryRun"),
    }
