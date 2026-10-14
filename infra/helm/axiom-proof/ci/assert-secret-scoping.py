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
    return {
        entry["name"] for container in containers for entry in container.get("env", [])
    }


for component in ("web", "marketing"):
    if "SUPABASE_SERVICE_KEY" in env_names(component):
        raise SystemExit(f"{component} must not receive SUPABASE_SERVICE_KEY")

for component in ("bff", "agent-runtime"):
    if "SUPABASE_SERVICE_KEY" not in env_names(component):
        raise SystemExit(f"{component} is missing SUPABASE_SERVICE_KEY")

for component in ("bff", "agent-runtime"):
    if "SUPABASE_ANON_KEY" not in env_names(component):
        raise SystemExit(
            f"{component} is missing the public gateway apikey for restricted-role calls"
        )
    if "SUPABASE_AGENT_LEDGER_WRITER_KEY" not in env_names(component):
        raise SystemExit(f"{component} is missing SUPABASE_AGENT_LEDGER_WRITER_KEY")

for component in deployments:
    for key in (
        "SUPABASE_STATUTORY_PROOF_WRITER_KEY",
        "SUPABASE_ARCHIVE_WRITER_KEY",
        "SUPABASE_HUMAN_ACTION_WRITER_KEY",
        "SUPABASE_EVIDENCE_INGESTION_WRITER_KEY",
    ):
        has_writer = key in env_names(component)
        if has_writer != (component == "bff"):
            raise SystemExit(f"{component}: {key} must be BFF-only")

for component in deployments:
    has_agent_writer = "SUPABASE_AGENT_LEDGER_WRITER_KEY" in env_names(component)
    if has_agent_writer != (component in ("bff", "agent-runtime")):
        raise SystemExit(
            f"{component}: SUPABASE_AGENT_LEDGER_WRITER_KEY must be BFF/agent-runtime only"
        )

print("Supabase service key is scoped to BFF and agent runtime")

# On-prem license custody and scoped S3 adapter credentials are explicit.
for component, deployment in deployments.items():
    entries = {
        entry["name"]: entry
        for container in deployment["spec"]["template"]["spec"]["containers"]
        for entry in container.get("env", [])
    }
    # Offline issuance stays outside service pods. Approval signing remains valid.
    for private_key_name in (
        "AXIOM_LICENSE_AUTHORITY_PRIVATE_KEY",
        "AXIOM_LICENSE_ROOT_PRIVATE_KEY",
        "AXIOM_OFFLINE_LICENSE_PRIVATE_KEY",
    ):
        if private_key_name in entries:
            raise SystemExit(
                f"{component}: {private_key_name} must stay outside service pods"
            )
    onprem = entries.get("ENVIRONMENT", {}).get("value") == "onprem"
    for key, secret_key in (
        ("AXIOM_OFFLINE_LICENSE", "license"),
        ("AXIOM_LICENSE_ROOT_PUBLIC_KEY", "root-public-key"),
    ):
        expected = onprem and component in (
            "bff",
            "agent-runtime",
            "model-gateway",
            "temporal-worker",
        )
        if (key in entries) != expected:
            raise SystemExit(f"{component}: {key} violates offline license custody")
        if expected:
            ref = entries[key].get("valueFrom", {}).get("secretKeyRef", {})
            if (
                not ref.get("name")
                or ref.get("key") != secret_key
                or ref.get("optional")
            ):
                raise SystemExit(
                    f"{component}: {key} must reference required Secret key {secret_key}"
                )
    for key in ("AXIOM_STORAGE_ACCESS_KEY_ID", "AXIOM_STORAGE_SECRET_ACCESS_KEY"):
        if (key in entries) != (onprem and component in ("bff", "agent-runtime")):
            raise SystemExit(f"{component}: {key} violates storage credential custody")
