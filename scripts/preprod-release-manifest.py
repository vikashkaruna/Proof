#!/usr/bin/env python3
"""Build or validate a nine-image, exact-source preprod release manifest."""

from __future__ import annotations

import argparse
import json
import re
import subprocess  # nosec B404 - runs gcloud with a fixed argv, no shell
from pathlib import Path

SERVICES = (
    "bff", "web", "agent-runtime", "model-gateway", "temporal-worker",
    "marketing", "supabase-gateway", "gotrue", "postgrest",
)
SHA = re.compile(r"[0-9a-f]{40}\Z")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")


def image_prefix(project: str, region: str) -> str:
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", project):
        raise ValueError("invalid GCP project ID")
    if region != "asia-south1":
        raise ValueError("preprod region must be asia-south1")
    return f"{region}-docker.pkg.dev/{project}/axiom-proof-preprod/"


def validate(manifest: dict, sha: str, project: str, region: str) -> dict:
    prefix = image_prefix(project, region)
    if not SHA.fullmatch(sha):
        raise ValueError("release SHA must be exact")
    if set(manifest) != {"schemaVersion", "releaseSha", "projectId", "region", "images"}:
        raise ValueError("release manifest fields are incomplete")
    if (manifest["schemaVersion"], manifest["releaseSha"], manifest["projectId"], manifest["region"]) != (1, sha, project, region):
        raise ValueError("release manifest identity mismatch")
    images = manifest["images"]
    if not isinstance(images, dict) or set(images) != set(SERVICES):
        raise ValueError("release manifest must cover all nine images")
    for service in SERVICES:
        name = service if service in {"gotrue", "postgrest"} else f"axiom-{service}"
        value = images[service]
        expected = f"{prefix}{name}@"
        if not isinstance(value, str) or not value.startswith(expected) or not DIGEST.fullmatch(value[len(expected):]):
            raise ValueError(f"invalid immutable image for {service}")
    return manifest


def registry_digest(service: str, prefix: str, tag: str) -> str:
    name = service if service in {"gotrue", "postgrest"} else f"axiom-{service}"
    image = f"{prefix}{name}:{tag}"
    result = subprocess.run(  # nosec B603 B607 - gcloud argv; the image reference is validated before this call
        ["gcloud", "artifacts", "docker", "images", "describe", image,
         "--format=value(image_summary.fully_qualified_digest)"],
        check=True, capture_output=True, text=True,
    )
    return result.stdout.strip()


def build(sha: str, project: str, region: str) -> dict:
    prefix = image_prefix(project, region)
    images = {service: registry_digest(service, prefix, f"release-{sha}") for service in SERVICES}
    return validate({"schemaVersion": 1, "releaseSha": sha, "projectId": project,
                     "region": region, "images": images}, sha, project, region)


def verify_registry(manifest: dict) -> None:
    """Require each digest to exist and the exact release tag still to resolve to it."""
    tag = f"release-{manifest['releaseSha']}"
    for service, image in manifest["images"].items():
        name = image.split("@", 1)[0]
        for identity in (image, f"{name}:{tag}"):
            result = subprocess.run(  # nosec B603 B607 - gcloud argv; the image reference is validated before this call
                ["gcloud", "artifacts", "docker", "images", "describe", identity,
                 "--format=value(image_summary.fully_qualified_digest)"],
                check=False, capture_output=True, text=True,
            )
            if result.returncode != 0 or result.stdout.strip() != image:
                raise ValueError(f"registry cannot confirm immutable image for {service}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("build", "validate"))
    parser.add_argument("path", type=Path)
    parser.add_argument("sha")
    parser.add_argument("project")
    parser.add_argument("region")
    args = parser.parse_args()
    if args.mode == "build":
        manifest = build(args.sha, args.project, args.region)
        args.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        args.path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
        args.path.chmod(0o600)
    else:
        manifest = json.loads(args.path.read_text())
        validate(manifest, args.sha, args.project, args.region)
        verify_registry(manifest)
    print(f"Preprod release manifest {args.mode} validated for {args.sha}")


if __name__ == "__main__":
    main()
