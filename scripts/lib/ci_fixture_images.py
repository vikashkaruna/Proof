"""Bounded registry transport selection for public acceptance fixtures only.

Every mirror manifest below was compared byte-for-byte with Docker Hub. An
explicit mirror reference avoids Docker's automatic fallback to Hub; failure
remains a failure. Production builds/configuration do not import this module.
"""

import os
import platform
import re
import sys

_MIRRORS = {
    "alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8": "mirror.gcr.io/library/alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8",
    "python:3.14-alpine3.24@sha256:f6a589d43c42b9e7f7dc67a12d37132491f362859a5d750607710cc56da3bc72": "mirror.gcr.io/library/python:3.14-alpine3.24@sha256:f6a589d43c42b9e7f7dc67a12d37132491f362859a5d750607710cc56da3bc72",
    "ubuntu:24.04@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3": "mirror.gcr.io/library/ubuntu:24.04@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3",
    "docker.io/library/golang@sha256:4ed690d6649d63c312b99a6120025ec79ce3b542968a37da53d6236c7c61a848": "mirror.gcr.io/library/golang@sha256:4ed690d6649d63c312b99a6120025ec79ce3b542968a37da53d6236c7c61a848",
}


def fixture_image(source: str) -> str:
    """Preserve the reviewed source unless disposable hosted CI opts in."""
    if source not in _MIRRORS:
        raise ValueError("Unreviewed public fixture image refused")
    selected = os.environ.get("AXIOM_CI_DOCKER_MIRROR")
    if selected is None:
        return source
    if (
        selected != "1"
        or os.environ.get("GITHUB_ACTIONS") != "true"
        or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted"
        or os.environ.get("RUNNER_OS") != "Linux"
        or platform.system() != "Linux"
    ):
        raise ValueError(
            "CI fixture mirror requires explicit opt-in on GitHub-hosted Linux"
        )
    return _MIRRORS[source]


def report_public_image_startup(args: list[str], stderr: str) -> None:
    """Print fixed failure categories only for public-image pulls/initial sleep.

    Never forward command argv, container output, paths, or arbitrary stderr.
    Token/credential operations and builds cannot enter this diagnostic path.
    """
    approved = {*_MIRRORS, *_MIRRORS.values()}
    public_pull = (
        len(args) == 3 and args[:2] == ["docker", "pull"] and args[2] in approved
    )
    initial_sleep = (
        len(args) >= 7
        and args[:2] == ["docker", "run"]
        and args[-2] in approved
        and args[-1] == "1200"
        and ["--entrypoint", "sleep"] == args[-4:-2]
    )
    if not (public_pull or initial_sleep):
        return
    lower = stderr.lower()
    if (
        "toomanyrequests" in lower
        or "pull rate limit" in lower
        or "429 too many requests" in lower
    ):
        category = "registry rate limit"
    elif "manifest unknown" in lower or "no matching manifest" in lower:
        category = "registry manifest unavailable"
    elif "unauthorized" in lower or "access denied" in lower:
        category = "registry access refused"
    elif "no space left on device" in lower or "disk quota exceeded" in lower:
        category = "image storage unavailable"
    elif any(
        value in lower
        for value in (
            "digest mismatch",
            "digest did not match",
            "unexpected commit digest",
        )
    ):
        category = "registry content integrity failed"
    elif "x509:" in lower or "certificate verify failed" in lower:
        category = "registry certificate refused"
    elif re.search(
        r"(?:status(?: code)?[: ]+|http/\d(?:\.\d)? +)5\d{2}\b", lower
    ) or any(
        value in lower
        for value in (
            "500 internal server error",
            "502 bad gateway",
            "503 service unavailable",
            "504 gateway timeout",
        )
    ):
        category = "registry server failed"
    elif any(
        value in lower
        for value in (
            "timeout",
            "connection refused",
            "tls handshake",
            "no such host",
            "unexpected eof",
            "connection reset by peer",
            "context deadline exceeded",
        )
    ):
        category = "registry connection failed"
    else:
        category = "public image startup failed"
    print("Public fixture Docker preflight refused: " + category + ".", file=sys.stderr)
