"""Model router — selects the right model + provider based on the task.

Per Doc 06 §7, the gateway runs a hybrid strategy:
  - Structural / classification / embedding tasks → self-hosted vLLM
    (Qwen 2.5 32B or similar) on the EKS GPU node group
  - High-stakes reasoning (assessment, planning) → hosted Claude
    (Bedrock) behind the redacting gateway

The choice is driven by the `task` field in the request, which the
agent runtime sets. The decision is logged with every call.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .config import Settings
from .model_identity import resolve_model_selector

TaskKind = Literal[
    "structural",
    "reasoning",
    "embedding",
    "classification",
    "summarisation",
    "report",
]


@dataclass(frozen=True)
class RouteDecision:
    provider: Literal[
        "self_hosted", "bedrock", "anthropic_api", "anthropic", "openai", "gemini", "fallback_chain"
    ]
    model: str
    reason: str
    fallback_model: str | None = None
    fallback_chain: tuple[tuple[str, str], ...] = ()


def decide_route(task: TaskKind, requested_model: str, settings: Settings) -> RouteDecision:
    """Pick the provider + model for a given task, configuring the
    Anthropic -> OpenAI -> Gemini fallback chain.
    """
    requested_model = resolve_model_selector(requested_model, settings)
    if settings.environment == "onprem":
        # A caller cannot turn an offline deployment into a hosted-model client.
        return RouteDecision(
            provider="self_hosted",
            model=settings.self_hosted_model,
            reason="onprem_local_model_only",
        )

    default_chain = (
        ("anthropic", settings.anthropic_model),
        ("openai", settings.openai_model),
        ("gemini", settings.gemini_model),
    )

    # Honour explicit requests
    if requested_model:
        if requested_model in (settings.openai_model, settings.openai_fallback_model):
            return RouteDecision(
                provider="openai",
                model=requested_model if "/" in requested_model else f"openai/{requested_model}",
                reason="explicit_openai_request",
                fallback_model=settings.gemini_model,
                fallback_chain=(
                    ("openai", requested_model),
                    ("gemini", settings.gemini_model),
                    ("anthropic", settings.anthropic_model),
                ),
            )
        if requested_model in (settings.gemini_model, settings.gemini_fallback_model):
            return RouteDecision(
                provider="gemini",
                model=requested_model if "/" in requested_model else f"gemini/{requested_model}",
                reason="explicit_gemini_request",
                fallback_model=settings.anthropic_model,
                fallback_chain=(
                    ("gemini", requested_model),
                    ("anthropic", settings.anthropic_model),
                    ("openai", settings.openai_model),
                ),
            )
        if requested_model in (
            settings.anthropic_model,
            settings.anthropic_fallback_model,
            settings.bedrock_model,
            settings.fallback_model,
        ):
            provider: Literal["anthropic", "bedrock"] = (
                "anthropic" if settings.anthropic_api_key else "bedrock"
            )
            model = (
                settings.anthropic_model if settings.anthropic_api_key else settings.bedrock_model
            )
            return RouteDecision(
                provider=provider,
                model=model,
                reason="explicit_claude_request",
                fallback_model=settings.openai_model
                if settings.openai_api_key
                else settings.fallback_model,
                fallback_chain=default_chain,
            )
        if requested_model == settings.self_hosted_model:
            return RouteDecision(
                provider="self_hosted",
                model=requested_model,
                reason="explicit_open_model_request",
                fallback_chain=default_chain,
            )

    # Structural / classification tasks default to self-hosted (open weights / local)
    if task in ("structural", "classification", "embedding"):
        return RouteDecision(
            provider="self_hosted",
            model=settings.self_hosted_model,
            reason="structural_task_routes_to_self_hosted",
            fallback_chain=default_chain,
        )

    # High-stakes reasoning / summarisation / report
    provider = "anthropic" if settings.anthropic_api_key else "bedrock"
    model = settings.anthropic_model if settings.anthropic_api_key else settings.bedrock_model
    return RouteDecision(
        provider=provider,
        model=model,
        reason="high_stakes_reasoning_routes_to_claude",
        fallback_model=settings.openai_model
        if settings.openai_api_key
        else settings.fallback_model,
        fallback_chain=default_chain,
    )
