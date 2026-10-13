"""FastAPI app for the Model Gateway."""

from __future__ import annotations

import os
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any

import structlog
from axiom_offline_license import verify_offline_license
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from structlog.typing import FilteringBoundLogger

from .config import Settings, get_settings
from .redaction import RedactionSummary, redact, redact_variables
from .router import RouteDecision, TaskKind, decide_route

# ─── Request / response shapes ───────────────────────────────────────


class CompleteRequest(BaseModel):
    model: str = ""  # optional override
    prompt: str
    task: TaskKind = "reasoning"
    temperature: float = 0.2
    max_tokens: int = 4096
    variables: dict[str, Any] = {}
    pii_redact: bool = True
    response_format: dict[str, Any] | None = None
    prompt_hash: str | None = None  # computed by the caller; recorded for the ledger


class CompleteResponse(BaseModel):
    text: str
    input_tokens: int
    output_tokens: int
    total_tokens: int
    cost_usd: float
    latency_ms: int
    model_id: str
    pii_redacted: bool
    redactions: dict[str, int] = {}
    prompt_hash: str
    route_reason: str
    correlation_id: str


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatCompletionRequest(BaseModel):
    model: str = "stub-dpdpa-specialist"
    messages: list[ChatMessage]
    temperature: float = 0.2
    max_tokens: int = 4096
    tenant_id: str | None = None
    task: TaskKind = "reasoning"
    pii_redact: bool = True


class ChatChoiceMessage(BaseModel):
    role: str = "assistant"
    content: str


class ChatChoice(BaseModel):
    index: int = 0
    message: ChatChoiceMessage
    finish_reason: str = "stop"


class ChatCompletionResponse(BaseModel):
    id: str
    object: str = "chat.completion"
    created: int
    model: str
    choices: list[ChatChoice]
    usage: dict[str, int]
    pii_redacted: bool
    redactions: dict[str, int] = {}


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    structlog.configure(
        processors=[
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.JSONRenderer(),
        ]
    )
    log = structlog.get_logger()
    log.info("model_gateway.startup", env=settings.environment, port=settings.http_port)
    app.state.settings = settings
    app.state.log = log
    yield


app = FastAPI(
    title="Axiom Proof — Model Gateway",
    version="0.1.0",
    description=(
        "Self-hosted LLM routing with PII redaction. Per Doc 05 §6 and "
        "Doc 06 §7, the gateway is the single chokepoint for every LLM call."
    ),
    lifespan=lifespan,
)


@app.middleware("http")
async def require_onprem_license(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    if (
        os.environ.get("ENVIRONMENT") == "onprem"
        and request.url.path != "/health"
        and not verify_offline_license(os.environ.get("AXIOM_OFFLINE_LICENSE"))
    ):
        status = 503 if request.url.path == "/ready" else 403
        return JSONResponse({"error": "offline_license_invalid"}, status_code=status)
    return await call_next(request)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/ready")
async def ready() -> dict[str, object]:
    settings: Settings = app.state.settings
    return {
        "status": "ready",
        "providers": {
            "self_hosted": bool(settings.self_hosted_base_url),
            "bedrock": bool(settings.aws_region),
        },
        "redaction_enabled": settings.pii_redaction_enabled,
    }


@app.post("/v1/complete", response_model=CompleteResponse)
async def complete(req: CompleteRequest, request: Request) -> CompleteResponse:
    settings: Settings = app.state.settings
    log = structlog.get_logger()
    correlation_id = str(uuid.uuid4())

    # Auth
    if settings.api_key:
        provided = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
        if provided != settings.api_key:
            raise HTTPException(status_code=401, detail="invalid api key")

    # PII redaction — applied to the prompt and to all variables. Hosted
    # routes are always redacted even if a caller asks for pii_redact=false;
    # raw personal data must never cross the gateway boundary.
    redactions: dict[str, int] = {}
    pii_redacted = False
    redacted_prompt = req.prompt
    redacted_variables = req.variables
    decision = decide_route(req.task, req.model, settings)
    must_redact = decision.provider != "self_hosted"
    if settings.pii_redaction_enabled and (req.pii_redact or must_redact):
        try:
            r = redact(req.prompt)
            redacted_prompt = r.redacted_text
            pii_redacted = True
            for k, v in r.redactions.items():
                redactions[k] = redactions.get(k, 0) + v
            redacted_variables, var_red = redact_variables(req.variables)
            for k, v in var_red.items():
                redactions[k] = redactions.get(k, 0) + v
        except Exception:  # noqa: BLE001 - refuse every initial redactor failure before dispatch
            raise HTTPException(status_code=503, detail="redaction_unavailable") from None

    log.info(
        "model_gateway.route_decision",
        task=req.task,
        requested=req.model,
        provider=decision.provider,
        model=decision.model,
        reason=decision.reason,
        pii_redacted=pii_redacted,
        correlation_id=correlation_id,
    )

    # Compose the actual prompt (variables substituted)
    composed_prompt = redacted_prompt
    for k, v in (redacted_variables or {}).items():
        composed_prompt = composed_prompt.replace(f"{{{{{k}}}}}", str(v))

    t0 = time.monotonic()
    try:
        text, input_tokens, output_tokens, transport_redaction = await _dispatch(
            composed_prompt,
            decision,
            req,
            settings,
            log,
        )
    except HostedRedactionUnavailable:
        raise HTTPException(status_code=503, detail="hosted_redaction_unavailable") from None
    except Exception as e:  # noqa: BLE001 - provider failures are bounded unavailable results
        if settings.environment == "onprem":
            log.error("model_gateway.local_model_unavailable", error_type=type(e).__name__)
            raise HTTPException(status_code=503, detail="local_model_unavailable") from None
        log.error("model_gateway.dispatched_error", error_type=type(e).__name__)
        raise HTTPException(status_code=503, detail="model_provider_unavailable") from None

    if transport_redaction is not None:
        pii_redacted = True
        for kind, count in transport_redaction.redactions.items():
            redactions[kind] = redactions.get(kind, 0) + count

    latency_ms = int((time.monotonic() - t0) * 1000)
    cost_in = settings.cost_per_input_token.get(decision.model, 0)
    cost_out = settings.cost_per_output_token.get(decision.model, 0)
    cost_usd = input_tokens * cost_in + output_tokens * cost_out

    return CompleteResponse(
        text=text,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=input_tokens + output_tokens,
        cost_usd=cost_usd,
        latency_ms=latency_ms,
        model_id=decision.model,
        pii_redacted=pii_redacted,
        redactions=redactions,
        prompt_hash=req.prompt_hash or _hash(redacted_prompt),
        route_reason=decision.reason,
        correlation_id=correlation_id,
    )


@app.post("/v1/chat/completions", response_model=ChatCompletionResponse)
async def chat_completions(req: ChatCompletionRequest, request: Request) -> ChatCompletionResponse:
    settings: Settings = app.state.settings
    log = structlog.get_logger()
    completion_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"

    # Auth check if configured
    if settings.api_key:
        provided = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
        if provided != settings.api_key:
            raise HTTPException(status_code=401, detail="invalid api key")

    if settings.environment != "onprem":
        # No authenticated canonical demo eligibility exists at this boundary.
        # Model names and caller-supplied tenant IDs cannot authorize simulation.
        raise HTTPException(status_code=503, detail="chat_provider_unavailable")

    # Extract user prompt from messages
    user_prompts = [m.content for m in req.messages if m.role == "user"]
    raw_prompt = "\n".join(user_prompts) if user_prompts else ""

    redactions: dict[str, int] = {}
    pii_redacted = False
    redacted_prompt = raw_prompt

    decision = decide_route(req.task, req.model, settings)
    must_redact = decision.provider != "self_hosted"
    if settings.pii_redaction_enabled and (req.pii_redact or must_redact):
        r = redact(raw_prompt)
        redacted_prompt = r.redacted_text
        pii_redacted = True
        redactions = dict(r.redactions)

    log.info(
        "model_gateway.chat_completions",
        model=req.model,
        pii_redacted=pii_redacted,
        redactions=redactions,
        id=completion_id,
    )

    if settings.environment == "onprem":
        completion = CompleteRequest(
            model=req.model,
            prompt=redacted_prompt,
            task=req.task,
            temperature=req.temperature,
            max_tokens=req.max_tokens,
            pii_redact=False,
        )
        try:
            content, in_tokens, out_tokens, _transport_redaction = await _dispatch(
                redacted_prompt, decision, completion, settings, log
            )
        except Exception:  # noqa: BLE001 - every local provider failure is an unavailable result
            log.error("model_gateway.local_model_unavailable")
            raise HTTPException(status_code=503, detail="local_model_unavailable") from None
    return ChatCompletionResponse(
        id=completion_id,
        created=int(time.time()),
        model=decision.model,
        choices=[
            ChatChoice(
                index=0,
                message=ChatChoiceMessage(role="assistant", content=content),
                finish_reason="stop",
            )
        ],
        usage={
            "prompt_tokens": in_tokens,
            "completion_tokens": out_tokens,
            "total_tokens": in_tokens + out_tokens,
        },
        pii_redacted=pii_redacted,
        redactions=redactions,
    )


class HostedRedactionUnavailable(RuntimeError):
    """Hosted transport must not proceed without final prompt redaction."""


def _redact_hosted_prompt(prompt: str, settings: Settings) -> RedactionSummary:
    if not settings.pii_redaction_enabled:
        raise HostedRedactionUnavailable()
    try:
        summary = redact(prompt)
        if not isinstance(summary, RedactionSummary) or not isinstance(summary.redacted_text, str):
            raise HostedRedactionUnavailable()
        return summary
    except Exception:  # noqa: BLE001 - any redactor failure must refuse hosted egress
        # Redactor exceptions can contain original values. Neither the caller
        # nor the hosted-provider fallback handler receives their text.
        raise HostedRedactionUnavailable() from None


async def _dispatch(
    prompt: str,
    decision: RouteDecision,
    req: CompleteRequest,
    settings: Settings,
    log: FilteringBoundLogger,
) -> tuple[str, int, int, RedactionSummary | None]:
    """Dispatch through the multi-model fallback chain:
    1. Anthropic (Primary)
    2. OpenAI (Fallback 1)
    3. Gemini (Fallback 2)
    Missing or exhausted providers fail closed; simulation has no authority here.
    """
    if settings.environment == "onprem":
        if not settings.self_hosted_base_url:
            raise RuntimeError("local_model_unavailable")
        import httpx

        async with httpx.AsyncClient(timeout=60.0, trust_env=False) as client:
            response = await client.post(
                f"{settings.self_hosted_base_url.rstrip('/')}/v1/chat/completions",
                json={
                    "model": settings.self_hosted_model,
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": req.temperature,
                    "max_tokens": req.max_tokens,
                },
            )
            response.raise_for_status()
            payload = response.json()
        content = payload["choices"][0]["message"]["content"]
        if not isinstance(content, str) or not content:
            raise RuntimeError("local_model_unavailable")
        usage = payload.get("usage") or {}
        return (
            content,
            int(usage.get("prompt_tokens", max(1, len(prompt) // 4))),
            int(usage.get("completion_tokens", max(1, len(content) // 4))),
            None,
        )

    # Build candidate list based on decision fallback_chain or settings
    candidates: list[tuple[str, str, str | None]] = []

    # If decision has a fallback chain, use it
    chain = getattr(decision, "fallback_chain", ())
    if chain:
        for provider_name, model_name in chain:
            if provider_name == "anthropic":
                key = settings.anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY")
                if key:
                    candidates.append((provider_name, model_name, key))
            elif provider_name == "openai":
                key = settings.openai_api_key or os.environ.get("OPENAI_API_KEY")
                if key:
                    candidates.append((provider_name, model_name, key))
            elif provider_name == "gemini":
                key = (
                    settings.gemini_api_key
                    or os.environ.get("GEMINI_API_KEY")
                    or os.environ.get("GOOGLE_API_KEY")
                )
                if key:
                    candidates.append((provider_name, model_name, key))
    else:
        # Default priority: Anthropic -> OpenAI -> Gemini
        ant_key = settings.anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY")
        if ant_key:
            candidates.append(("anthropic", settings.anthropic_model, ant_key))
        oai_key = settings.openai_api_key or os.environ.get("OPENAI_API_KEY")
        if oai_key:
            candidates.append(("openai", settings.openai_model, oai_key))
        gem_key = (
            settings.gemini_api_key
            or os.environ.get("GEMINI_API_KEY")
            or os.environ.get("GOOGLE_API_KEY")
        )
        if gem_key:
            candidates.append(("gemini", settings.gemini_model, gem_key))

    # Try live providers in order
    if candidates:
        for provider_name, model_name, api_key in candidates:
            # The route decision is not the serving provider. Recheck at each
            # hosted transport boundary, after template/variable composition.
            # Refusal is outside provider failover: it cannot become a stub or
            # another unredacted hosted attempt.
            transport_redaction = _redact_hosted_prompt(prompt, settings)
            try:
                import litellm

                response = await litellm.acompletion(
                    model=model_name,
                    messages=[{"role": "user", "content": transport_redaction.redacted_text}],
                    api_key=api_key,
                    temperature=req.temperature,
                    max_tokens=req.max_tokens,
                )
                text = response.choices[0].message.content or ""
                in_tokens = getattr(response.usage, "prompt_tokens", max(1, len(prompt) // 4))
                out_tokens = getattr(response.usage, "completion_tokens", max(1, len(text) // 4))
                log.info(
                    "model_gateway.llm_dispatched_success",
                    provider=provider_name,
                    model=model_name,
                    in_tokens=in_tokens,
                    out_tokens=out_tokens,
                )
                return text, in_tokens, out_tokens, transport_redaction
            except Exception as e:  # noqa: BLE001 - hosted-provider fallback is existing behavior
                log.warning(
                    "model_gateway.provider_failover",
                    failed_provider=provider_name,
                    failed_model=model_name,
                    error_type=type(e).__name__,
                )
                continue

    # An unavailable provider is a failed call in every current environment.
    # The existing organisation UI demo flag supplies no gateway authority.
    raise RuntimeError("model_provider_unavailable")


def _hash(s: str) -> str:
    import hashlib

    return hashlib.sha256(s.encode("utf-8")).hexdigest()
