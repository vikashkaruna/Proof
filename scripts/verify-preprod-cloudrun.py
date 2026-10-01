#!/usr/bin/env python3
"""Read back nine deployed Cloud Run image digests after a preprod rollout."""

from __future__ import annotations

import json
import runpy
import subprocess
import sys
from pathlib import Path

SERVICE_NAMES = {
    "bff": "axiom-bff-preprod",
    "web": "axiom-web-preprod",
    "agent-runtime": "axiom-agent-runtime-preprod",
    "model-gateway": "axiom-model-gateway-preprod",
    "temporal-worker": "axiom-temporal-worker-preprod",
    "marketing": "axiom-marketing-preprod",
    "supabase-gateway": "axiom-supabase-preprod",
    "gotrue": "axiom-supabase-auth-preprod",
    "postgrest": "axiom-supabase-rest-preprod",
}


def deployed_image(service: str, project: str, run=subprocess.run) -> str:
    result = run(
        ["gcloud", "run", "services", "describe", SERVICE_NAMES[service],
         "--project", project, "--region", "asia-south1", "--format=json"],
        check=False, capture_output=True, text=True,
    )
    if result.returncode:
        raise ValueError(f"Cloud Run readback failed for {service}")
    data = json.loads(result.stdout)
    template = data.get("template") or data.get("spec", {}).get("template", {}).get("spec", {})
    containers = template.get("containers") or template.get("spec", {}).get("containers")
    if not isinstance(containers, list) or len(containers) != 1:
        raise ValueError(f"Cloud Run container identity missing for {service}")
    return containers[0]["image"]


def verify(manifest: dict, run=subprocess.run) -> None:
    project = manifest["projectId"]
    for service, expected in manifest["images"].items():
        if deployed_image(service, project, run) != expected:
            raise ValueError(f"Cloud Run image digest differs from release manifest for {service}")


if __name__ == "__main__":
    try:
        release_manifest = json.loads(Path(sys.argv[1]).read_text())
        validate = runpy.run_path(str(Path(__file__).with_name("preprod-release-manifest.py")))["validate"]
        validate(release_manifest, sys.argv[2], sys.argv[3], "asia-south1")
        verify(release_manifest)
    except (IndexError, OSError, KeyError, ValueError, json.JSONDecodeError) as exc:
        print(f"Cloud Run release readback failed: {exc}", file=sys.stderr)
        sys.exit(1)
    print(f"All nine Cloud Run services run exact immutable release images for {sys.argv[2]}")
