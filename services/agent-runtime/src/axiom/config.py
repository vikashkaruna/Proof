"""Runtime configuration. Loaded once at process start and frozen."""

from __future__ import annotations

import logging
import os
from functools import lru_cache
from typing import Literal

from pydantic import AliasChoices, Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Axiom Proof agent runtime settings.

    All settings are loaded from environment variables. Required
    values fail-fast at boot.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ─── Service identity ───────────────────────────────────────────
    service_name: str = "axiom-agent-runtime"
    environment: Literal["development", "staging", "preprod", "production", "test"] = "development"
    log_level: Literal["debug", "info", "warn", "error"] = "info"
    http_port: int = Field(default_factory=lambda: int(os.environ.get("PORT", "8000")))
    # Containers must listen on all interfaces; exposure is controlled by the
    # platform ingress/network policy, never by this bind address.
    http_host: str = "0.0.0.0"  # nosec B104

    # ─── Supabase ──────────────────────────────────────────────────
    supabase_url: str = Field(
        default="http://127.0.0.1:55321",
        description="Supabase project URL",
    )
    supabase_service_key: str = Field(
        default="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU",
        description="Supabase service-role key (server-side only)",
    )
    supabase_db_url: str | None = None

    # ─── Cloud-Agnostic Storage & Evidence Vault ───────────────────
    axiom_region: str = Field(
        default="ap-south-1",
        validation_alias=AliasChoices("AXIOM_REGION", "AWS_REGION", "GCP_REGION"),
        description="Regional data residency (ap-south-1 or asia-south1)",
    )
    axiom_storage_access_key_id: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "AXIOM_STORAGE_ACCESS_KEY_ID", "AXIOM_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"
        ),
        description="Access key for S3 / GCS HMAC / MinIO",
    )
    axiom_storage_secret_access_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "AXIOM_STORAGE_SECRET_ACCESS_KEY", "AXIOM_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY"
        ),
        description="Secret key for S3 / GCS HMAC / MinIO",
    )
    axiom_evidence_bucket: str = Field(
        default="axiom-proof-evidence",
        validation_alias=AliasChoices(
            "AXIOM_EVIDENCE_BUCKET",
            "AXIOM_STORAGE_BUCKET",
            "S3_EVIDENCE_BUCKET",
            "AWS_S3_EVIDENCE_BUCKET",
        ),
        description="Sovereign WORM evidence vault bucket name",
    )
    axiom_storage_endpoint: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "AXIOM_STORAGE_ENDPOINT", "S3_ENDPOINT", "AWS_S3_ENDPOINT"
        ),
        description="S3-compatible storage endpoint URL (GCS, MinIO, etc.)",
    )
    axiom_project_id: str | None = Field(
        default=None,
        validation_alias=AliasChoices("AXIOM_PROJECT_ID", "GCP_PROJECT_ID"),
    )
    axiom_project_number: str | None = Field(
        default=None,
        validation_alias=AliasChoices("AXIOM_PROJECT_NUMBER", "GCP_PROJECT_NUMBER"),
    )

    # ─── Backward Compatibility Properties ────────────────────────
    @property
    def aws_region(self) -> str:
        return self.axiom_region

    @property
    def aws_access_key_id(self) -> str | None:
        return self.axiom_storage_access_key_id

    @property
    def aws_secret_access_key(self) -> str | None:
        return self.axiom_storage_secret_access_key

    @property
    def s3_evidence_bucket(self) -> str:
        return self.axiom_evidence_bucket

    @property
    def s3_endpoint(self) -> str | None:
        return self.axiom_storage_endpoint

    # ─── Model Gateway ─────────────────────────────────────────────
    # Internal: the gateway is self-hosted on the same EKS cluster.
    model_gateway_url: str = "http://model-gateway.axiom-proof:8000"
    model_gateway_api_key: str | None = None
    # The default model for high-stakes reasoning. Self-hosted for
    # structural-only tasks (see control-library-loader / structural flag).
    default_model: str = "anthropic.claude-3-5-sonnet@20240620"
    fallback_model: str = "anthropic.claude-3-haiku@20240307"

    # ─── Temporal ──────────────────────────────────────────────────
    temporal_address: str = "ap-south-1.aws.api.temporal.io:7233"
    temporal_namespace: str = "axiom-proof"
    temporal_api_key: str | None = None
    temporal_tls: bool = True

    # ─── Approval token signing (mirror of BFF, used in workers) ──
    approval_signing_key: str | None = None

    # ─── Internal token for BFF → agent-runtime calls ────────────
    internal_token: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "AGENT_RUNTIME_INTERNAL_TOKEN", "INTERNAL_TOKEN", "internal_token"
        ),
        description="BFF-to-runtime authentication; canonical deployment variable first",
    )

    # ─── Feature flags ─────────────────────────────────────────────
    feature_dry_run_engine: bool = True
    feature_execution_engine: bool = True
    feature_live_connectors: bool = False
    feature_kill_switch: bool = True

    # ─── Observability ─────────────────────────────────────────────
    otel_exporter_otlp_endpoint: str | None = None
    sentry_dsn: str | None = None

    @model_validator(mode="after")
    def validate_production_security(self) -> "Settings":
        if self.environment == "production":
            if not self.supabase_url or "localhost" in self.supabase_url or "127.0.0.1" in self.supabase_url:
                raise ValueError("Valid production SUPABASE_URL is required")
            if not self.supabase_service_key or self.supabase_service_key.startswith("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1v"):
                raise ValueError("Valid production SUPABASE_SERVICE_KEY is required")
            if self.axiom_region not in ("ap-south-1", "asia-south1"):
                raise ValueError("Production data-plane services must run in Mumbai (ap-south-1 or asia-south1)")
            if not self.internal_token:
                raise ValueError("AGENT_RUNTIME_INTERNAL_TOKEN is required in production")
            if not self.approval_signing_key:
                raise ValueError("APPROVAL_SIGNING_KEY is required in production")
            if not self.model_gateway_api_key:
                raise ValueError("MODEL_GATEWAY_API_KEY is required in production")
        return self


@lru_cache
def get_settings() -> Settings:
    """Cached settings accessor. The same instance is returned for the
    lifetime of the process — no per-request env reads.
    """
    return Settings()  # type: ignore[call-arg]


def setup_logging(settings: Settings) -> None:
    """Configure structlog + stdlib logging for JSON output."""
    import structlog

    level = getattr(logging, settings.log_level.upper())
    logging.basicConfig(level=level, format="%(message)s")

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ],
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )
