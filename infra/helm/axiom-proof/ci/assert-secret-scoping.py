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

for component in deployments:
    has_writer = "SUPABASE_STATUTORY_PROOF_WRITER_KEY" in env_names(component)
    if has_writer != (component == "bff"):
        raise SystemExit(f"{component}: statutory proof writer must be BFF-only")
if "SUPABASE_ARCHIVE_WRITER_KEY" not in env_names("bff"):
    raise SystemExit("BFF is missing the dedicated archive writer key")
for component in ("web", "marketing", "agent-runtime"):
    if "SUPABASE_ARCHIVE_WRITER_KEY" in env_names(component):
        raise SystemExit(f"{component} must not receive SUPABASE_ARCHIVE_WRITER_KEY")
