#!/usr/bin/env python3
"""Build the three actual Python Dockerfiles and check their frozen production locks.

Own images only; no databases, servers, ports, volumes or runtime credentials.
Docker is resolved explicitly; all subprocess argv are fixed or internally generated.
"""

import json
import os
import secrets
import shutil
import signal
import subprocess  # nosec B404
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVICES = {
    "agent-runtime": "agent-runtime",
    "model-gateway": "model-gateway",
    "temporal-workers": "temporal-worker",
}


def main() -> None:
    docker = shutil.which("docker")
    if not docker or not Path(docker).is_absolute():
        raise RuntimeError("Docker unavailable")
    run_id = secrets.token_hex(6)
    proof = ROOT / ".axiom-runtime" / "review" / "python-image-lock-parity" / run_id
    proof.mkdir(parents=True, mode=0o700)
    os.chmod(proof, 0o700)
    tags = []
    results = []

    def interrupted(_signal, _frame):
        raise KeyboardInterrupt("Image parity gate interrupted")

    previous = signal.signal(signal.SIGTERM, interrupted)
    try:
        for service, filename in SERVICES.items():
            tag = f"axiom-python-lock-{service}-{run_id}"
            tags.append(tag)
            path = proof / ("build-" + service + ".log")
            with path.open("xb") as log:
                os.chmod(path, 0o600)
                # Resolved Docker executable, fixed build argv, internal owned tag and source paths.
                subprocess.run(  # nosec B603
                    [
                        docker,
                        "build",
                        "--label",
                        "com.axiom.fixture=python-image-lock-parity",
                        "--label",
                        "com.axiom.owner-worktree=" + str(ROOT),
                        "--label",
                        "com.axiom.fixture.run=" + run_id,
                        "-f",
                        str(ROOT / "infra/docker" / ("Dockerfile." + filename)),
                        "-t",
                        tag,
                        str(ROOT),
                    ],
                    check=True,
                    timeout=600,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                )
            # Current Python runs the fixed reviewed checker with an internal owned image tag.
            completed = subprocess.run(  # nosec B603
                [
                    sys.executable,
                    str(ROOT / "scripts/check-python-image-lock-parity.py"),
                    "--service",
                    service,
                    "--image",
                    tag,
                ],
                capture_output=True,
                text=True,
                timeout=180,
                check=False,
            )
            probe_log = proof / ("probe-" + service + ".log")
            probe_log.write_text(completed.stdout + completed.stderr)
            os.chmod(probe_log, 0o600)
            if completed.returncode:
                raise RuntimeError(
                    "Image parity probe failed; protected probe log retained"
                )
            result = json.loads(completed.stdout)
            results.append(result)
            path = proof / ("parity-" + service + ".json")
            path.write_text(json.dumps(result, indent=2) + "\n")
            os.chmod(path, 0o600)
            print(json.dumps(result), flush=True)
    finally:
        signal.signal(signal.SIGTERM, previous)
        # Partial builds can still have created a tag. Never remove a foreign image.
        for tag in tags:
            # Read-only inspection of one internally generated image tag.
            inspected = subprocess.run(  # nosec B603
                [docker, "image", "inspect", tag],
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            if inspected.returncode:
                if "no such image:" in inspected.stderr.lower():
                    continue
                raise RuntimeError("Owned image cleanup unconfirmed")
            image = json.loads(inspected.stdout)[0]
            labels = image["Config"]["Labels"] or {}
            if (
                labels.get("com.axiom.fixture") != "python-image-lock-parity"
                or labels.get("com.axiom.owner-worktree") != str(ROOT)
                or labels.get("com.axiom.fixture.run") != run_id
            ):
                raise RuntimeError("Owned image cleanup refused")
            # Remove only the immutable image ID after all three ownership labels match.
            subprocess.run(  # nosec B603
                [docker, "image", "rm", image["Id"]],
                check=True,
                capture_output=True,
                timeout=30,
            )
    if len(results) != 3 or any(result["mismatches"] != 0 for result in results):
        raise RuntimeError("Complete image parity evidence absent")


if __name__ == "__main__":
    main()
