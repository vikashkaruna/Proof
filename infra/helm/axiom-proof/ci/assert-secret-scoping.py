"""Assert that rendered chart credentials reach only the services that need them.

Usage: helm template axiom-proof infra/helm/axiom-proof | python3 infra/helm/axiom-proof/ci/assert-secret-scoping.py
"""

import sys

import yaml


deployments = {
    document["metadata"]["name"].removeprefix("axiom-proof-"): document
    for document in yaml.safe_load_all(sys.stdin)
    if isinstance(document, dict) and document.get("kind") == "Deployment"
}

for component in ("web", "marketing", "bff", "agent-runtime"):
    if component not in deployments:
        raise SystemExit(f"missing deployment: {component}")


def env_names(component: str) -> set[str]:
    containers = deployments[component]["spec"]["template"]["spec"]["containers"]
    return {entry["name"] for container in containers for entry in container.get("env", [])}


for component in ("web", "marketing"):
    if "SUPABASE_SERVICE_KEY" in env_names(component):
        raise SystemExit(f"{component} must not receive SUPABASE_SERVICE_KEY")

for component in ("bff", "agent-runtime"):
    if "SUPABASE_SERVICE_KEY" not in env_names(component):
        raise SystemExit(f"{component} is missing SUPABASE_SERVICE_KEY")

for component in ("bff", "agent-runtime"):
    if "SUPABASE_ANON_KEY" not in env_names(component):
        raise SystemExit(f"{component} is missing the public gateway apikey for restricted-role calls")
    if "SUPABASE_AGENT_LEDGER_WRITER_KEY" not in env_names(component):
        raise SystemExit(f"{component} is missing SUPABASE_AGENT_LEDGER_WRITER_KEY")

for component in deployments:
    for key in ("SUPABASE_STATUTORY_PROOF_WRITER_KEY", "SUPABASE_HUMAN_ACTION_WRITER_KEY",
                "SUPABASE_EVIDENCE_INGESTION_WRITER_KEY"):
        has_writer = key in env_names(component)
        if has_writer != (component == "bff"):
            raise SystemExit(f"{component}: {key} must be BFF-only")

for component in deployments:
    has_agent_writer = "SUPABASE_AGENT_LEDGER_WRITER_KEY" in env_names(component)
    if has_agent_writer != (component in ("bff", "agent-runtime")):
        raise SystemExit(f"{component}: SUPABASE_AGENT_LEDGER_WRITER_KEY must be BFF/agent-runtime only")

print("Supabase service key is scoped to BFF and agent runtime")
