"""FastAPI app for the Model Gateway."""

from __future__ import annotations

import os
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any

import structlog
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from .config import Settings, get_settings
from .redaction import redact, redact_variables
from .router import TaskKind, decide_route

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
async def lifespan(app: FastAPI):
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


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/ready")
async def ready():
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
async def complete(req: CompleteRequest, request: Request):
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
        r = redact(req.prompt)
        redacted_prompt = r.redacted_text
        pii_redacted = True
        for k, v in r.redactions.items():
            redactions[k] = redactions.get(k, 0) + v
        redacted_variables, var_red = redact_variables(req.variables)
        for k, v in var_red.items():
            redactions[k] = redactions.get(k, 0) + v

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
        text, input_tokens, output_tokens = await _dispatch(
            composed_prompt,
            decision,
            req,
            settings,
            log,
        )
    except Exception as e:
        if settings.environment == "onprem":
            log.error("model_gateway.local_model_unavailable", error_type=type(e).__name__)
            raise HTTPException(status_code=503, detail="local_model_unavailable") from None
        log.error("model_gateway.dispatched_error", err=str(e))
        raise HTTPException(status_code=502, detail=f"provider_error: {e}") from e

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
async def chat_completions(req: ChatCompletionRequest, request: Request):
    settings: Settings = app.state.settings
    log = structlog.get_logger()
    completion_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"

    # Auth check if configured
    if settings.api_key:
        provided = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
        if provided != settings.api_key:
            raise HTTPException(status_code=401, detail="invalid api key")

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
            content, in_tokens, out_tokens = await _dispatch(
                redacted_prompt, decision, completion, settings, log
            )
        except Exception:  # noqa: BLE001 - every local provider failure is an unavailable result
            log.error("model_gateway.local_model_unavailable")
            raise HTTPException(status_code=503, detail="local_model_unavailable") from None
    elif req.model.startswith("stub"):
        content = f"Model Gateway received prompt with PII redacted: {redacted_prompt}"
    else:
        content = (
            f"[Model Gateway · {decision.provider}/{decision.model}] "
            f"Processed prompt with PII redacted: {redacted_prompt}"
        )

    if settings.environment != "onprem":
        in_tokens = max(1, len(raw_prompt) // 4)
        out_tokens = max(1, len(content) // 4)

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


async def _dispatch(
    prompt: str,
    decision,
    req: CompleteRequest,
    settings: Settings,
    log,
) -> tuple[str, int, int]:
    """Dispatch through the multi-model fallback chain:
    1. Anthropic (Primary)
    2. OpenAI (Fallback 1)
    3. Gemini (Fallback 2)
    4. Deterministic synthetic stub (Offline / test resilience)
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
            try:
                import litellm

                response = await litellm.acompletion(
                    model=model_name,
                    messages=[{"role": "user", "content": prompt}],
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
                return text, in_tokens, out_tokens
            except Exception as e:  # noqa: BLE001 - hosted-provider fallback is existing behavior
                log.warning(
                    "model_gateway.provider_failover",
                    failed_provider=provider_name,
                    failed_model=model_name,
                    error=str(e),
                )
                continue

    # Deterministic fallback stub
    text = _stub_completion(prompt, decision, req)
    input_tokens = max(1, len(prompt) // 4)
    output_tokens = max(1, len(text) // 4)
    return text, input_tokens, output_tokens


def _stub_completion(prompt: str, decision, req: CompleteRequest) -> str:
    # A small, deterministic stub that varies by task. The agent
    # runtime can be tested end-to-end without a real model.
    if req.task == "classification":
        return '{"category": "other", "confidence": 0.5, "rationale": "stub"}'
    if req.task == "structural":
        return '{"ok": true}'
    if req.task == "embedding":
        # Return 8-dim zero vector as a placeholder
        return "[" + ",".join(["0.0"] * 8) + "]"
    return (
        f"[Model Gateway stub · {decision.provider}/{decision.model} · task={req.task}] "
        f"Acknowledged. (Phase 0/1 — replace with real LiteLLM call in Phase 2.)"
    )


def _hash(s: str) -> str:
    import hashlib

    return hashlib.sha256(s.encode("utf-8")).hexdigest()
