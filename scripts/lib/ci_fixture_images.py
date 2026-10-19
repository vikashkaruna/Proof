"""Bounded registry transport selection for public acceptance fixtures only.

Every mirror manifest below was compared byte-for-byte with Docker Hub. An
explicit mirror reference avoids Docker's automatic fallback to Hub; failure
remains a failure. Production builds/configuration do not import this module.
"""

import json
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


# Exact public acceptance fixture only. No general build, secret mount, custom
# context, build argument, arbitrary tag or credential-bearing command is logged.
_SPIRE_ACCEPTANCE_BUILD = (
    "docker",
    "build",
    "--target",
    "vm-controller-acceptance",
    "-f",
    "infra/docker/Dockerfile.bff",
    "-t",
    "axiom-spire-health-probe:acceptance",
    ".",
)
_SAFE_TS_CODES = frozenset(
    {
        "TS2304",
        "TS2305",
        "TS2307",
        "TS2322",
        "TS2339",
        "TS2344",
        "TS2345",
        "TS2353",
        "TS2416",
        "TS2459",
        "TS2554",
        "TS2580",
        "TS2688",
        "TS2694",
        "TS2739",
        "TS2741",
        "TS2769",
        "TS2835",
        "TS5055",
        "TS5107",
        "TS6133",
        "TS6192",
        "TS7006",
        "TS7016",
        "TS1479",
        "TS1484",
        "TS18046",
    }
)
_SAFE_PNPM_CODES = frozenset(
    {
        "ERR_PNPM_OUTDATED_LOCKFILE",
        "ERR_PNPM_FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE",
        "ERR_PNPM_NO_MATCHING_VERSION",
        "ERR_PNPM_META_FETCH_FAIL",
        "ERR_PNPM_FETCH_401",
        "ERR_PNPM_FETCH_403",
        "ERR_PNPM_FETCH_404",
        "ERR_PNPM_FETCH_429",
        "ERR_PNPM_FETCH_500",
        "ERR_PNPM_FETCH_502",
        "ERR_PNPM_FETCH_503",
        "ERR_PNPM_FETCH_504",
        "ERR_PNPM_TARBALL_INTEGRITY",
        "ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL",
        "ERR_PNPM_BAD_PM_VERSION",
    }
)


def report_public_fixture_build(args: list[str], stderr: str) -> None:
    """Only a fixed category and allowlisted static tool codes may cross CI logs.

    Classification never changes a failing command's outcome and never retries.
    Inspect a bounded suffix; emit no paths, source lines, URLs or raw stderr.
    """
    if tuple(args) != _SPIRE_ACCEPTANCE_BUILD:
        return
    tail = stderr[-262144:]
    lower = tail.lower()
    ts_codes = set(re.findall(r"\berror (TS[0-9]{4,5})\b", tail)) & _SAFE_TS_CODES
    pnpm_codes = set(re.findall(r"\bERR_PNPM_[A-Z0-9_]+\b", tail)) & _SAFE_PNPM_CODES
    if "no space left on device" in lower or "disk quota exceeded" in lower:
        category = "build storage unavailable"
    elif any(
        value in lower
        for value in (
            "out of memory",
            "cannot allocate memory",
            "signal: killed",
            "exit code: 137",
        )
    ):
        category = "build process resource failure"
    elif re.search(r"\berror ts[0-9]{4,5}\b", lower):
        category = "TypeScript compilation failed"
    elif any("LOCKFILE" in value for value in pnpm_codes):
        category = "dependency lockfile refused"
    elif any(
        value in lower
        for value in ("toomanyrequests", "pull rate limit", "429 too many requests")
    ):
        category = "build registry rate limit"
    elif "manifest unknown" in lower or "no matching manifest" in lower:
        category = "build registry manifest unavailable"
    elif (
        any(
            value in lower
            for value in (
                "digest mismatch",
                "digest did not match",
                "unexpected commit digest",
            )
        )
        or "ERR_PNPM_TARBALL_INTEGRITY" in pnpm_codes
    ):
        category = "build content integrity failed"
    elif "x509:" in lower or "certificate verify failed" in lower:
        category = "build transport certificate refused"
    elif "apk add" in lower and any(
        value in lower
        for value in ("unable to select packages", "temporary error", "failed to fetch")
    ):
        category = "Alpine package installation failed"
    elif "failed to calculate checksum" in lower:
        category = "build context unavailable"
    elif any(
        value.startswith(("ERR_PNPM_FETCH_", "ERR_PNPM_META_"))
        or value == "ERR_PNPM_NO_MATCHING_VERSION"
        for value in pnpm_codes
    ):
        category = "dependency retrieval failed"
    elif any(
        value in lower
        for value in (
            "cannot connect to the docker daemon",
            "error during connect",
            "failed to dial grpc",
        )
    ):
        category = "build daemon unavailable"
    else:
        category = "acceptance image build failed"
    print(
        "SPIRE acceptance image build failure: "
        + json.dumps(
            {"category": category, "codes": sorted(ts_codes | pnpm_codes)[:6]}
        ),
        file=sys.stderr,
    )
