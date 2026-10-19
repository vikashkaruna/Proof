#!/usr/bin/env python3
"""Collect PostgREST no-OS evidence for marketing-image-clearance.py.

The scanner cannot analyse the static Haskell binary, so this records three
hash-bound proofs: the single scanned layer (its SHA-256 is the report DiffID),
the binary's own `--version` output from a network-less container, and the raw
OSV Hackage response for exactly that version. It only reads public OSV data;
it never pushes, publishes or changes cloud state.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
import re
import subprocess  # nosec B404  # fixed Docker inspection/run argv, immutable image ID, network-none evidence worker
import tarfile
from pathlib import Path
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

OSV_URL = "https://api.osv.dev/v1/query"
MAXIMUM = 128 * 1024 * 1024


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("OSV redirects refused")


def write(directory: Path, name: str, data: bytes) -> dict[str, str]:
    path = directory / name
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(data)
    return {"path": str(path), "sha256": hashlib.sha256(data).hexdigest()}


def single_layer(image_id: str) -> bytes:
    saved = subprocess.run(["docker", "save", image_id], capture_output=True, check=True, timeout=300).stdout  # nosec B603, B607  # fixed Docker inspection/run argv, immutable image ID, network-none evidence worker
    with tarfile.open(fileobj=io.BytesIO(saved), mode="r:") as archive:
        manifest = json.load(archive.extractfile("manifest.json"))
        if len(manifest) != 1 or len(manifest[0]["Layers"]) != 1:
            raise ValueError("Exactly one image and one layer expected")
        raw = archive.extractfile(manifest[0]["Layers"][0]).read(MAXIMUM + 1)
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    if len(raw) > MAXIMUM:
        raise ValueError("Layer exceeds the bounded proof size")
    return raw


def binary_version(image_id: str) -> dict[str, object]:
    argv = ["/bin/postgrest", "--version"]
    result = subprocess.run(  # nosec B603, B607  # fixed Docker inspection/run argv, immutable image ID, network-none evidence worker
        ["docker", "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
         "--security-opt", "no-new-privileges", "--platform", "linux/amd64",
         "--entrypoint", argv[0], image_id, *argv[1:]],
        capture_output=True, text=True, timeout=120,
    )
    return {"image_id": image_id, "argv": argv, "exit_code": result.returncode, "stdout": result.stdout}


def collect(image_id: str, artifact_id: str, directory: Path) -> dict[str, str]:
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id) or not re.fullmatch(r"sha256:[0-9a-f]{64}", artifact_id):
        raise ValueError("Exact image and artifact identities required")
    directory.mkdir(mode=0o700)
    layer = single_layer(image_id)
    with tarfile.open(fileobj=io.BytesIO(layer), mode="r:") as bundle:
        member = bundle.extractfile("./bin/postgrest") if "./bin/postgrest" in bundle.getnames() else bundle.extractfile("bin/postgrest")
        binary = hashlib.sha256(member.read()).hexdigest()
    output = binary_version(image_id)
    output["binary_sha256"] = binary
    found = re.fullmatch(r"PostgREST ([0-9]+(?:\.[0-9]+){1,3})\n?", str(output["stdout"]))
    if output["exit_code"] != 0 or not found:
        raise ValueError("PostgREST binary version could not be read")
    version = found.group(1)
    query = {"package": {"ecosystem": "Hackage", "name": "postgrest"}, "version": version}
    request = Request(OSV_URL, data=json.dumps(query).encode(), headers={"Content-Type": "application/json"}, method="POST")
    with build_opener(ProxyHandler({}), NoRedirect()).open(request, timeout=60) as response:
        if response.status != 200:
            raise ValueError("OSV query failed")
        osv = response.read(1024 * 1024 + 1)
    if len(osv) > 1024 * 1024:
        raise ValueError("OSV response exceeds bound")
    proofs = {
        "layer": write(directory, "layer.private.tar", layer),
        "version_output": write(directory, "version-output.private.json", (json.dumps(output, indent=2) + "\n").encode()),
        "osv_response": write(directory, "osv-response.private.json", osv),
    }
    evidence = {"format": 1, "component": "rest", "image_id": image_id, "artifact_id": artifact_id,
                "postgrest_version": version, "osv_query": query, "osv_endpoint": OSV_URL, "proofs": proofs}
    return write(directory, "rest-evidence.private.json", (json.dumps(evidence, indent=2) + "\n").encode())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image-id", required=True)
    parser.add_argument("--artifact-id", required=True)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(collect(args.image_id, args.artifact_id, args.output_dir)))
