"""Configuration for the Temporal workers.

Follows the Model Gateway's precedent: preprod is validated at production
strictness rather than treated as a relaxed environment. That service already
enforced this; the TypeScript layer did not, which is what SEC-1 and SEC-13
were about.
"""

from __future__ import annotations

import os
import re
from typing import Literal

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Deployed environments. These differ in topology only and share one security
# ruleset — the same rule @axiom/config applies on the TypeScript side.
HARDENED_ENVIRONMENTS = ("staging", "preprod", "production", "onprem")

# Secrets that were never meant to leave a developer's machine. The literal
# "{{AGENT_RUNTIME_INTERNAL_TOKEN}}" that shipped in workflows.py is caught by
# the "<...>"/"{{...}}" arm.
_PLACEHOLDER = re.compile(
    r"^(dev-|test-|changeme|placeholder|your-)|placeholder|changeme|xxx|\{\{|<[^>]+>",
    re.IGNORECASE,
)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    service_name: str = "axiom-temporal-workers"
    environment: Literal[
        "development", "local", "test", "staging", "preprod", "production", "onprem"
    ] = "development"

    # Agent runtime — topology, so it varies by environment.
    agent_runtime_url: str = "http://agent-runtime.axiom-proof:8000"

    # Service-to-service credential. Security posture, so it does not.
    agent_runtime_internal_token: str | None = None

    @model_validator(mode="after")
    def validate_deployment_security(self) -> "Settings":
        if self.environment not in HARDENED_ENVIRONMENTS:
            return self

        token = self.agent_runtime_internal_token
        if not token:
            raise ValueError(
                "AGENT_RUNTIME_INTERNAL_TOKEN is required in "
                f"{self.environment}. Every call into the agent runtime's "
                "/internal endpoints must be authenticated."
            )
        if _PLACEHOLDER.search(token):
            raise ValueError(
                "AGENT_RUNTIME_INTERNAL_TOKEN looks like an unsubstituted "
                "placeholder. Mint one with `node scripts/mint-supabase-keys.mjs`."
            )
        return self

    @property
    def internal_headers(self) -> dict[str, str]:
        """Headers for a call into the agent runtime's internal API.

        SEC-11: workflows.py sent the literal string
        "{{AGENT_RUNTIME_INTERNAL_TOKEN}}" — the template was never
        substituted — and the three other internal calls sent no credential at
        all. Every internal call now goes through here.
        """
        token = self.agent_runtime_internal_token
        if not token:
            # Reachable only in development/local/test, where the validator
            # above does not run. Still explicit rather than silent.
            return {}
        return {"X-Internal-Token": token}


def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
