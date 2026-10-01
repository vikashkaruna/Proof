"""Render each local deployment mode and assert restricted keys stay in BFF."""

import json
import os
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
COMPOSE_FILES = [
    "docker-compose.yml",
    "infra/docker/docker-compose.staging.yml",
    "infra/docker/docker-compose.preprod.yml",
    "infra/docker/docker-compose.prod.yml",
    "infra/docker/docker-compose.onprem.yml",
]
WRITER_KEYS = (
    "SUPABASE_STATUTORY_PROOF_WRITER_KEY",
    "SUPABASE_HUMAN_ACTION_WRITER_KEY",
    "SUPABASE_EVIDENCE_INGESTION_WRITER_KEY",
)
# Appends agent/system ledger events only; the BFF (connector broker) and the
# agent runtime hold it, nothing else.
AGENT_LEDGER_KEY = "SUPABASE_AGENT_LEDGER_WRITER_KEY"
AGENT_LEDGER_HOLDERS = {"bff", "agent-runtime"}
env = os.environ.copy()
for key in (
    *WRITER_KEYS,
    AGENT_LEDGER_KEY,
    "MODEL_GATEWAY_API_KEY",
    "AGENT_RUNTIME_INTERNAL_TOKEN",
    "APPROVAL_SIGNING_KEY",
    "AXIOM_MFA_ENCRYPTION_KEY",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
):
    env[key] = "synthetic-compose-check-only"

for file in COMPOSE_FILES:
    files = [file] if file == "docker-compose.yml" else ["docker-compose.yml", file]
    command = ["docker", "compose"]
    for source in files:
        command.extend(["-f", str(ROOT / source)])
    command.extend(["config", "--format", "json"])
    rendered = subprocess.run(
        command,
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    if rendered.returncode:
        raise AssertionError(f"{file}: Compose render failed: {rendered.stderr.strip()}")
    services = json.loads(rendered.stdout)["services"]
    if "bff" not in services:
        raise AssertionError(f"{file}: BFF is missing")
    for name, service in services.items():
        configured = service.get("environment", {})
        for key in WRITER_KEYS:
            if (key in configured) != (name == "bff"):
                raise AssertionError(f"{file}: {key} has incorrect scope on {name}")
        if (AGENT_LEDGER_KEY in configured) != (name in AGENT_LEDGER_HOLDERS):
            raise AssertionError(f"{file}: {AGENT_LEDGER_KEY} has incorrect scope on {name}")

print(f"Compose writer-secret scoping passed for {len(COMPOSE_FILES)} deployment modes")
