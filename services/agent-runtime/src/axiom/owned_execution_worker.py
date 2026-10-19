"""Credentialless Karya worker: fixed synthetic execution tool over private supervised pipes.

No network/database/model client. The controller proxies the fresh SVID to the
BFF, which verifies signed human approval, exact accepted batch and target binding.
"""

from __future__ import annotations

import os

# Fixed reviewed local SPIRE client, without a shell.
import subprocess  # nosec B404
from collections.abc import Callable
from functools import partial

from .assessment_worker import parse_json, read_frame, write_frame
from .process_lifetime import bind_parent_lifetime

SPIFFE_ID = "spiffe://local.axiomproof.test/agent/karya"
MAX_SVID_BYTES = 32768


def fetch_svid() -> str:
    # Constant argv only; no shell or secret arguments.
    result = subprocess.run(  # nosec B603
        [
            "/usr/local/bin/spire-agent",
            "api",
            "fetch",
            "jwt",
            "-socketPath",
            "/run/workload/api.sock",
            "-audience",
            "axiom-owned-synthetic-execution",
            "-spiffeID",
            SPIFFE_ID,
            "-output",
            "json",
        ],
        capture_output=True,
        timeout=10,
        check=False,
        preexec_fn=partial(bind_parent_lifetime, os.getpid()),
    )
    if result.returncode or len(result.stdout) > MAX_SVID_BYTES:
        raise ValueError("Owned execution identity unavailable")
    parts = parse_json(result.stdout.decode("utf8"))
    if not isinstance(parts, list):
        raise ValueError("Owned execution identity unavailable")
    matches = [part["svids"] for part in parts if isinstance(part, dict) and "svids" in part]
    if len(matches) != 1 or not isinstance(matches[0], list) or len(matches[0]) != 1:
        raise ValueError("Owned execution identity unavailable")
    item = matches[0][0]
    if not isinstance(item, dict) or item.get("spiffe_id") != SPIFFE_ID:
        raise ValueError("Owned execution identity unavailable")
    token = item.get("svid")
    if not isinstance(token, str) or not 1 <= len(token) <= 16384:
        raise ValueError("Owned execution identity unavailable")
    return token


def execute(assignment: object, identity: Callable[[], str] = fetch_svid) -> None:
    if not isinstance(assignment, dict) or set(assignment) != {
        "tenantId",
        "planId",
        "actionId",
        "requestKey",
        "token",
        "operation",
    }:
        raise ValueError("Owned assignment refused")
    if assignment["operation"] not in {
        "inspect",
        "forward",
        "simulate_rollback",
        "rollback",
        "verify",
    }:
        raise ValueError("Owned assignment refused")
    write_frame({"tool": "owned.execute", "request": {**assignment, "workloadProof": identity()}})
    response = read_frame()
    if (
        not isinstance(response, dict)
        or set(response) != {"ok", "value"}
        or response["ok"] is not True
    ):
        raise ValueError("Owned execution unavailable")
    # The trusted channel validates and binds the fixed metadata response before
    # giving it to this credentialless child; the child cannot substitute it.
    write_frame({"result": response["value"]})


def main() -> int:
    try:
        execute(read_frame())
        return 0
    except Exception:
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
