"""Configuration for the Model Gateway."""

from __future__ import annotations

import os
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    service_name: str = "axiom-model-gateway"
    environment: Literal["development", "staging", "preprod", "production", "test"] = "development"
    # Containers must listen on all interfaces; exposure is controlled by the
    # platform ingress/network policy, never by this bind address.
    http_host: str = "0.0.0.0"  # nosec B104
    http_port: int = Field(default_factory=lambda: int(os.environ.get("PORT", "8001")))
    log_level: Literal["debug", "info", "warn", "error"] = "info"

    # Auth
    api_key: str | None = None

    # Multi-model Provider API Keys & Fallback Hierarchy (Anthropic -> OpenAI -> Gemini):
    # 1. Anthropic (Primary)
    anthropic_api_key: str | None = Field(default_factory=lambda: os.environ.get("ANTHROPIC_API_KEY"))
    anthropic_model: str = "anthropic/claude-3-5-sonnet-20241022"
    anthropic_fallback_model: str = "anthropic/claude-3-5-haiku-20241022"

    # 2. OpenAI (Fallback 1)
    openai_api_key: str | None = Field(default_factory=lambda: os.environ.get("OPENAI_API_KEY"))
    openai_model: str = "openai/gpt-4o"
    openai_fallback_model: str = "openai/gpt-4o-mini"

    # 3. Gemini (Fallback 2)
    gemini_api_key: str | None = Field(
        default_factory=lambda: os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    )
    gemini_model: str = "gemini/gemini-2.0-flash"
    gemini_fallback_model: str = "gemini/gemini-1.5-pro"

    # Provider configuration
    # Self-hosted vLLM (open-weight model on GPU node group — planned for later phase)
    self_hosted_base_url: str | None = None
    self_hosted_model: str = "Qwen/Qwen2.5-32B-Instruct-AWQ"
    # AWS Bedrock (Claude) — optional alternative
    aws_region: str = "ap-south-1"
    bedrock_model: str = "anthropic.claude-3-5-sonnet-20240620-v1:0"
    fallback_model: str = "anthropic.claude-3-haiku-20240307-v1:0"

    # PII redaction
    pii_redaction_enabled: bool = True
    pii_min_confidence: float = 0.6

    # Cache
    cache_backend: Literal["memory", "redis"] = "memory"
    cache_ttl_seconds: int = 3600
    redis_url: str | None = None

    # Cost tracking
    cost_per_input_token: dict[str, float] = Field(
        default_factory=lambda: {
            "anthropic.claude-3-5-sonnet-20240620-v1:0": 0.000003,
            "anthropic.claude-3-haiku-20240307-v1:0": 0.00000025,
            "anthropic/claude-3-5-sonnet-20241022": 0.000003,
            "anthropic/claude-3-5-haiku-20241022": 0.00000025,
            "openai/gpt-4o": 0.0000025,
            "openai/gpt-4o-mini": 0.00000015,
            "gemini/gemini-2.0-flash": 0.0000001,
            "gemini/gemini-1.5-pro": 0.00000125,
            "Qwen/Qwen2.5-32B-Instruct-AWQ": 0.0,
        }
    )
    cost_per_output_token: dict[str, float] = Field(
        default_factory=lambda: {
            "anthropic.claude-3-5-sonnet-20240620-v1:0": 0.000015,
            "anthropic.claude-3-haiku-20240307-v1:0": 0.00000125,
            "anthropic/claude-3-5-sonnet-20241022": 0.000015,
            "anthropic/claude-3-5-haiku-20241022": 0.00000125,
            "openai/gpt-4o": 0.00001,
            "openai/gpt-4o-mini": 0.0000006,
            "gemini/gemini-2.0-flash": 0.0000004,
            "gemini/gemini-1.5-pro": 0.000005,
            "Qwen/Qwen2.5-32B-Instruct-AWQ": 0.0,
        }
    )

    # Observability
    otel_exporter_otlp_endpoint: str | None = None

    @model_validator(mode="after")
    def validate_production_security(self) -> "Settings":
        if self.environment in ("production", "preprod"):
            if self.aws_region not in ("ap-south-1", "asia-south1"):
                raise ValueError("Production/Preprod model gateway must run in Mumbai (ap-south-1 or asia-south1)")
            if self.environment == "production" and not self.api_key:
                raise ValueError("API_KEY is required in production")
            if not self.pii_redaction_enabled:
                raise ValueError("PII redaction cannot be disabled in production/preprod")
        return self


def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
