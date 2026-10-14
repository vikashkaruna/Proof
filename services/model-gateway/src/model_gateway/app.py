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
from pydantic import BaseModel, Field
from structlog.typing import FilteringBoundLogger

from .completion_provenance import (
    Attempt,
    Commitments,
    CompletionProvenance,
    DispatchResult,
    Provider,
    RouteIdentity,
    ServingIdentity,
    object_hash,
    price_usage,
    read_usage,
    reported_model,
    text_hash,
)
from .config import Settings, get_settings
from .model_identity import configured_model_identities, safe_model_identity
from .redaction import RedactionSummary, redact, redact_variables
from .router import RouteDecision, TaskKind, decide_route

# ─── Request / response shapes ───────────────────────────────────────


class CompleteRequest(BaseModel):
    model: str = ""  # Bound/review before logging; avoid echoing rejected model in a 422.
    prompt: str
    task: TaskKind = "reasoning"
    temperature: float = Field(default=0.2, ge=0, le=2, allow_inf_nan=False)
    max_tokens: int = Field(default=4096, ge=1, le=2147483647)
    variables: dict[str, Any] = {}
    pii_redact: bool = True
    response_format: dict[str, Any] | None = None
    prompt_hash: str | None = Field(
        default=None, pattern=r"^[a-f0-9]{64}$"
    )  # untrusted caller commitment


class CompleteResponse(BaseModel):
    schema_version: int = 2
    text: str
    input_tokens: int | None
    output_tokens: int | None
    total_tokens: int | None
    cost_usd: float | None
    latency_ms: int
    model_id: str
    pii_redacted: bool
    redactions: dict[str, int] = {}
    prompt_hash: str
    route_reason: str
    correlation_id: str
    provenance: CompletionProvenance


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatCompletionRequest(BaseModel):
    model: str = "stub-dpdpa-specialist"
    messages: list[ChatMessage]
    temperature: float = Field(default=0.2, ge=0, le=2, allow_inf_nan=False)
    max_tokens: int = Field(default=4096, ge=1, le=2147483647)
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
    usage: dict[str, int | None]
    provenance: CompletionProvenance
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

    request_json_hash = _incoming_request_hash(await request.json())

    # PII redaction — applied to the prompt and to all variables. Hosted
    # routes are always redacted even if a caller asks for pii_redact=false;
    # raw personal data must never cross the gateway boundary.
    redactions: dict[str, int] = {}
    pii_redacted = False
    redacted_prompt = req.prompt
    redacted_variables = req.variables
    if not all(safe_model_identity(model) for model in configured_model_identities(settings)):
        raise HTTPException(status_code=503, detail="model_configuration_unavailable")
    try:
        decision = decide_route(req.task, req.model, settings)
    except ValueError:
        raise HTTPException(status_code=400, detail="model_selector_unavailable") from None
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
        dispatched = await _dispatch(
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

    transport_redaction = dispatched.redaction
    if transport_redaction is not None:
        pii_redacted = True
        for kind, count in transport_redaction.redactions.items():
            redactions[kind] = redactions.get(kind, 0) + count

    latency_ms = int((time.monotonic() - t0) * 1000)
    provenance = _provenance(
        req.prompt,
        composed_prompt,
        req.prompt_hash,
        decision,
        dispatched,
        settings,
        request_json_hash,
    )
    return CompleteResponse(
        text=dispatched.text,
        input_tokens=dispatched.usage.input_tokens,
        output_tokens=dispatched.usage.output_tokens,
        total_tokens=dispatched.usage.total_tokens,
        cost_usd=provenance.pricing.cost_usd,
        latency_ms=latency_ms,
        model_id=dispatched.serving.model,
        pii_redacted=pii_redacted,
        redactions=redactions,
        prompt_hash=dispatched.transport_prompt_sha256,
        route_reason=decision.reason,
        correlation_id=correlation_id,
        provenance=provenance,
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

    request_json_hash = _incoming_request_hash(await request.json())

    # Extract user prompt from messages
    user_prompts = [m.content for m in req.messages if m.role == "user"]
    raw_prompt = "\n".join(user_prompts) if user_prompts else ""

    redactions: dict[str, int] = {}
    pii_redacted = False
    redacted_prompt = raw_prompt

    if not all(safe_model_identity(model) for model in configured_model_identities(settings)):
        raise HTTPException(status_code=503, detail="model_configuration_unavailable")
    try:
        decision = decide_route(req.task, req.model, settings)
    except ValueError:
        raise HTTPException(status_code=400, detail="model_selector_unavailable") from None
    must_redact = decision.provider != "self_hosted"
    if settings.pii_redaction_enabled and (req.pii_redact or must_redact):
        try:
            r = redact(raw_prompt)
            redacted_prompt = r.redacted_text
            pii_redacted = True
            redactions = dict(r.redactions)
        except Exception:  # noqa: BLE001 - refuse initial chat redactor errors before local dispatch
            raise HTTPException(status_code=503, detail="redaction_unavailable") from None

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
            dispatched = await _dispatch(redacted_prompt, decision, completion, settings, log)
        except Exception:  # noqa: BLE001 - every local provider failure is an unavailable result
            log.error("model_gateway.local_model_unavailable")
            raise HTTPException(status_code=503, detail="local_model_unavailable") from None
    return ChatCompletionResponse(
        id=completion_id,
        created=int(time.time()),
        model=dispatched.serving.model,
        choices=[
            ChatChoice(
                index=0,
                message=ChatChoiceMessage(role="assistant", content=dispatched.text),
                finish_reason="stop",
            )
        ],
        usage={
            "prompt_tokens": dispatched.usage.input_tokens,
            "completion_tokens": dispatched.usage.output_tokens,
            "total_tokens": dispatched.usage.total_tokens,
        },
        pii_redacted=pii_redacted,
        redactions=redactions,
        provenance=_provenance(
            raw_prompt, redacted_prompt, None, decision, dispatched, settings, request_json_hash
        ),
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
) -> DispatchResult:
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
            handoff = {
                "model": settings.self_hosted_model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": req.temperature,
                "max_tokens": req.max_tokens,
            }
            handoff_hash = object_hash(handoff)
            response = await client.post(
                f"{settings.self_hosted_base_url.rstrip('/')}/v1/chat/completions",
                json=handoff,
            )
            response.raise_for_status()
            payload = response.json()
        content = payload["choices"][0]["message"]["content"]
        if not isinstance(content, str) or not content.strip():
            raise RuntimeError("local_model_unavailable")
        return DispatchResult(
            text=content,
            serving=ServingIdentity(
                provider="self_hosted",
                model=settings.self_hosted_model,
                reported_model=reported_model(payload.get("model")),
            ),
            usage=read_usage(payload.get("usage")),
            transport_prompt_sha256=text_hash(prompt),
            sdk_handoff_sha256=handoff_hash,
            redaction=None,
            attempts=(
                Attempt(
                    provider="self_hosted", model=settings.self_hosted_model, outcome="succeeded"
                ),
            ),
        )

    # Build candidate list based on decision fallback_chain or settings
    candidates: list[tuple[Provider, str, str | None]] = []

    # If decision has a fallback chain, use it
    chain = getattr(decision, "fallback_chain", ())
    if chain:
        for provider_name, model_name in chain:
            if provider_name == "anthropic":
                key = settings.anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY")
                if key:
                    candidates.append(("anthropic", model_name, key))
            elif provider_name == "openai":
                key = settings.openai_api_key or os.environ.get("OPENAI_API_KEY")
                if key:
                    candidates.append(("openai", model_name, key))
            elif provider_name == "gemini":
                key = (
                    settings.gemini_api_key
                    or os.environ.get("GEMINI_API_KEY")
                    or os.environ.get("GOOGLE_API_KEY")
                )
                if key:
                    candidates.append(("gemini", model_name, key))
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

    attempts: list[Attempt] = []
    # Try live providers in order
    if candidates:
        for provider_name, model_name, api_key in candidates:
            # The route decision is not the serving provider. Recheck at each
            # hosted transport boundary, after template/variable composition.
            # Refusal is outside provider failover: it cannot become a stub or
            # another unredacted hosted attempt.
            if not safe_model_identity(model_name):
                raise HTTPException(status_code=503, detail="model_configuration_unavailable")
            transport_redaction = _redact_hosted_prompt(prompt, settings)
            try:
                import litellm

                # Explicit connector prevents a configured label/model prefix mismatch
                # from being recorded as a different serving provider.
                if "/" not in model_name:
                    model_name = f"{provider_name}/{model_name}"
                if not model_name.startswith(f"{provider_name}/"):
                    raise ValueError("provider_model_mismatch")
                handoff = {
                    "model": model_name,
                    "messages": [{"role": "user", "content": transport_redaction.redacted_text}],
                    "temperature": req.temperature,
                    "max_tokens": req.max_tokens,
                }
                handoff_hash = object_hash(handoff)
                response = await litellm.acompletion(**handoff, api_key=api_key)
                text = response.choices[0].message.content
                if not isinstance(text, str) or not text.strip():
                    raise RuntimeError("model_provider_unavailable")
                usage = read_usage(getattr(response, "usage", None))
                log.info(
                    "model_gateway.llm_dispatched_success",
                    provider=provider_name,
                    model=model_name,
                    usage_availability=usage.availability,
                )
                attempts.append(
                    Attempt(provider=provider_name, model=model_name, outcome="succeeded")
                )
                return DispatchResult(
                    text=text,
                    serving=ServingIdentity(
                        provider=provider_name,
                        model=model_name,
                        reported_model=reported_model(getattr(response, "model", None)),
                    ),
                    usage=usage,
                    transport_prompt_sha256=text_hash(transport_redaction.redacted_text),
                    sdk_handoff_sha256=handoff_hash,
                    redaction=transport_redaction,
                    attempts=tuple(attempts),
                )
            except Exception as e:  # noqa: BLE001 - hosted-provider fallback is existing behavior
                attempts.append(Attempt(provider=provider_name, model=model_name, outcome="failed"))
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


def _provenance(
    template: str,
    composed: str,
    caller_hash: str | None,
    decision: RouteDecision,
    result: DispatchResult,
    settings: Settings,
    request_json_hash: str,
) -> CompletionProvenance:
    return CompletionProvenance(
        planned=RouteIdentity(provider=decision.provider, model=decision.model),
        serving=result.serving,
        usage=result.usage,
        pricing=price_usage(
            result.serving.model,
            result.usage,
            settings.cost_per_input_token,
            settings.cost_per_output_token,
        ),
        commitments=Commitments(
            request_json_sha256=request_json_hash,
            template_sha256=text_hash(template),
            composed_sha256=text_hash(composed),
            transport_prompt_sha256=result.transport_prompt_sha256,
            sdk_handoff_sha256=result.sdk_handoff_sha256,
            caller_prompt_sha256=caller_hash,
        ),
        attempts=list(result.attempts),
    )


def _incoming_request_hash(decoded: object) -> str:
    # This is the original decoded JSON body, not Pydantic's coerced/defaulted
    # representation or HTTP-wire bytes. No values are retained beyond a hash.
    try:
        return object_hash(decoded)
    except ValueError, TypeError:
        raise HTTPException(status_code=422, detail="request_commitment_invalid") from None
