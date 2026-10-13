"""Reviewed model selectors; identifiers are metadata, never arbitrary prompt text."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .config import Settings

MODEL_ID_PATTERN = r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,299}"


def safe_model_identity(value: object) -> bool:
    return (
        isinstance(value, str) and re.fullmatch(MODEL_ID_PATTERN, value, flags=re.ASCII) is not None
    )


def configured_model_identities(settings: Settings) -> tuple[str, ...]:
    return (
        settings.anthropic_model,
        settings.anthropic_fallback_model,
        settings.openai_model,
        settings.openai_fallback_model,
        settings.gemini_model,
        settings.gemini_fallback_model,
        settings.self_hosted_model,
        settings.bedrock_model,
        settings.fallback_model,
    )


def configured_model_selectors(settings: Settings) -> dict[str, str]:
    """Only exact configured names and their exact provider-prefix-free aliases."""
    selectors: dict[str, str] = {}
    ambiguous: set[str] = set()
    for model in configured_model_identities(settings):
        names = [model]
        prefix, separator, suffix = model.partition("/")
        if separator and prefix in ("anthropic", "openai", "gemini"):
            names.append(suffix)
        for name in names:
            if name in selectors and selectors[name] != model:
                ambiguous.add(name)
            selectors[name] = model
    return {name: model for name, model in selectors.items() if name not in ambiguous}


def resolve_model_selector(requested: str, settings: Settings) -> str:
    if not requested:
        return ""
    if not safe_model_identity(requested):
        raise ValueError("model_selector_unavailable")
    if settings.environment == "onprem" and requested in ("local", "stub-dpdpa-specialist"):
        # Compatibility labels never select another transport/model.
        return settings.self_hosted_model
    model = configured_model_selectors(settings).get(requested)
    if model is None:
        raise ValueError("model_selector_unavailable")
    return model
