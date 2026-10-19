"""Credential-less Drishti worker: fixed read tool over private supervised pipes.

No network/database/model client. The controller proxies the fresh SVID to the
BFF, which loads the retained human request and rechecks all connector authority.
"""

from __future__ import annotations

import os
import subprocess  # nosec B404 - constant reviewed local SPIRE client
from collections.abc import Callable
from functools import partial
from uuid import UUID

from .assessment_worker import parse_json, read_frame, write_frame
from .process_lifetime import bind_parent_lifetime

SPIFFE_ID = "spiffe://local.axiomproof.test/agent/drishti"
MAX_SVID_BYTES = 32768


def fetch_svid() -> str:
    result = subprocess.run(  # nosec B603 - constant argv only; no shell or secret arguments
        [
            "/usr/local/bin/spire-agent",
            "api",
            "fetch",
            "jwt",
            "-socketPath",
            "/run/workload/api.sock",
            "-audience",
            "axiom-postgresql-discovery",
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
        raise ValueError("Discovery identity unavailable")
    parts = parse_json(result.stdout.decode("utf8"))
    if not isinstance(parts, list):
        raise ValueError("Discovery identity unavailable")
    matches = [part["svids"] for part in parts if isinstance(part, dict) and "svids" in part]
    if len(matches) != 1 or not isinstance(matches[0], list) or len(matches[0]) != 1:
        raise ValueError("Discovery identity unavailable")
    item = matches[0][0]
    if not isinstance(item, dict) or item.get("spiffe_id") != SPIFFE_ID:
        raise ValueError("Discovery identity unavailable")
    token = item.get("svid")
    if not isinstance(token, str) or not 1 <= len(token) <= 16384:
        raise ValueError("Discovery identity unavailable")
    return token


def canonical_id(value: object) -> str:
    if not isinstance(value, str) or str(UUID(value)) != value or UUID(value).int == 0:
        raise ValueError("Discovery assignment refused")
    return value


def discover(assignment: object, identity: Callable[[], str] = fetch_svid) -> None:
    if not isinstance(assignment, dict) or set(assignment) != {"tenantId", "requestId"}:
        raise ValueError("Discovery assignment refused")
    tenant = canonical_id(assignment["tenantId"])
    request = canonical_id(assignment["requestId"])
    # Neither assignment nor result contains a credential or a workload proof.
    write_frame(
        {
            "tool": "discovery.read",
            "request": {
                "tenantId": tenant,
                "requestId": request,
                "workloadProof": identity(),
            },
        }
    )
    response = read_frame()
    if (
        not isinstance(response, dict)
        or set(response) != {"ok", "value"}
        or response["ok"] is not True
    ):
        raise ValueError("Discovery read unavailable")
    value = response["value"]
    if not isinstance(value, dict) or set(value) != {"requestId", "discoveryRunId"}:
        raise ValueError("Discovery read unavailable")
    if value["requestId"] != request:
        raise ValueError("Discovery read unavailable")
    run = canonical_id(value["discoveryRunId"])
    write_frame({"result": {"requestId": request, "discoveryRunId": run}})


def main() -> int:
    try:
        discover(read_frame())
        return 0
    except Exception:
        write_frame({"error": "discovery_worker_failed"})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
