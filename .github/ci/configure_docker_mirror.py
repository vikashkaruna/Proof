"""Configure only an empty, disposable GitHub-hosted Linux CI Docker daemon.

Google's cache falls back to Docker Hub on a miss; source image references and
content digest verification remain Docker's responsibility. No daemon restart.
https://docs.cloud.google.com/artifact-registry/docs/pull-cached-dockerhub-images
https://docs.docker.com/reference/cli/dockerd/#configuration-reload-behavior
"""

import json
import os
import platform
import subprocess  # nosec B404  # fixed disposable hosted-CI Docker/system commands, remote context stripped
import tempfile
import time
from pathlib import Path

MIRROR = "https://mirror.gcr.io"
CONFIG = Path("/etc/docker/daemon.json")
DOCKER = ["docker", "--host", "unix:///var/run/docker.sock"]


def run(argv):
    # Never inherit a remote Docker host/context from the caller.
    env = {
        key: value for key, value in os.environ.items() if not key.startswith("DOCKER_")
    }
    return subprocess.run(  # nosec B603  # fixed disposable hosted-CI Docker/system commands, remote context stripped
        argv, check=True, capture_output=True, text=True, timeout=30, env=env
    ).stdout


def require_disposable_runner():
    if (
        os.environ.get("GITHUB_ACTIONS") != "true"
        or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted"
        or os.environ.get("RUNNER_OS") != "Linux"
        or platform.system() != "Linux"
        or os.geteuid() != 0
    ):
        raise RuntimeError(
            "Refusing Docker configuration outside root on GitHub-hosted Linux CI"
        )
    if run([*DOCKER, "ps", "--all", "--quiet"]).strip():
        raise RuntimeError(
            "Refusing Docker configuration after containers have been initialized"
        )


def configure(config=CONFIG):
    require_disposable_runner()
    if config.is_symlink():
        raise RuntimeError("Refusing a symlinked Docker configuration")
    previous = config.read_bytes() if config.exists() else None
    settings = json.loads(previous) if previous is not None else {}
    if not isinstance(settings, dict):
        raise TypeError("Docker configuration must be a JSON object")
    mirrors = settings.get("registry-mirrors", [])
    if not isinstance(mirrors, list) or not all(
        isinstance(item, str) for item in mirrors
    ):
        raise RuntimeError("Invalid existing registry-mirrors configuration")
    settings["registry-mirrors"] = [
        MIRROR,
        *[item for item in mirrors if item.rstrip("/") != MIRROR],
    ]
    # Validate before touching the original; preserve every unrelated setting.
    with tempfile.NamedTemporaryFile(
        dir=config.parent, prefix=".axiom-ci-docker-", delete=False
    ) as candidate:
        temporary = Path(candidate.name)
        candidate.write((json.dumps(settings, indent=2) + "\n").encode())
    try:
        run(["dockerd", "--validate", "--config-file", str(temporary)])
        os.chmod(
            temporary, config.stat().st_mode & 0o777 if previous is not None else 0o644
        )
        temporary.replace(config)
    finally:
        temporary.unlink(missing_ok=True)
    try:
        run(["systemctl", "reload", "docker"])
        # SIGHUP reload is asynchronous. Fail the job if Docker never applies it.
        for attempt in range(10):
            active = json.loads(
                run([*DOCKER, "info", "--format", "{{json .RegistryConfig.Mirrors}}"])
            )
            if MIRROR in [item.rstrip("/") for item in active]:
                print("Docker Hub cache configured for this disposable CI runner")
                return
            if attempt < 9:
                time.sleep(1)
        raise RuntimeError("Docker did not apply the CI registry mirror")
    except Exception:
        if previous is None:
            config.unlink()
        else:
            config.write_bytes(previous)
        run(["systemctl", "reload", "docker"])
        raise


if __name__ == "__main__":
    configure()
