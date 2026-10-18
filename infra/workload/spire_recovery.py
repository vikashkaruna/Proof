"""Idempotent, offline local agent state staging; server state is never modified."""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path

# Import before touching state: an inaccessible helper installation must fail closed.
from spire_health import publish


def atomic(path: Path, value: str) -> None:
    temporary = path.with_name(path.name + ".next")
    fd = os.open(
        temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600
    )
    with os.fdopen(fd, "w") as stream:
        stream.write(value)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)
    descriptor = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def stage(
    value: dict,
    base: Path = Path("/var/lib/spire"),
    health: Path = Path("/run/spire-health"),
) -> None:
    stamp, token, node = value["stamp"], value["token"], value["node"]
    if not re.fullmatch(r"[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}", stamp):
        raise RuntimeError("Invalid recovery identifier")
    if (
        not re.fullmatch(r"[A-Za-z0-9_-]{20,200}", token)
        or node != "spiffe://local.axiomproof.test/spire/agent/join_token/" + token
        or node == value["oldNodeId"]
    ):
        raise RuntimeError("Invalid fresh node binding")
    if not isinstance(value["expiresAt"], int) or time.time() >= value["expiresAt"]:
        raise RuntimeError(
            "Unconsumed attestation token expired; preserve recovery state"
        )
    if base.resolve() != base or not base.is_dir():
        raise RuntimeError("Unsafe state directory")
    old, retired = base / "agent", base / ("agent-retired-" + stamp)
    marker = base / ("recovery-" + stamp + ".json")
    expected = {
        "oldNodeId": value["oldNodeId"],
        "node": node,
        "tokenSha256": hashlib.sha256(token.encode()).hexdigest(),
    }
    if any(
        path.is_symlink()
        for path in (marker, old, retired, base / "node-id", base / "join-token")
    ):
        raise RuntimeError("Symlink state refused")
    if marker.exists():
        if json.loads(marker.read_text()) != expected:
            raise RuntimeError("Recovery binding changed")
    else:
        if (
            retired.exists()
            or (base / "node-id").read_text().strip() != value["oldNodeId"]
        ):
            raise RuntimeError("Unexpected original agent state")
        atomic(marker, json.dumps(expected))
    if not retired.exists():
        old.rename(retired)
    if not retired.is_dir():
        raise RuntimeError("Retired agent state missing")
    old.mkdir(mode=0o700, exist_ok=True)
    if any(old.iterdir()):
        raise RuntimeError("New agent has started; offline staging refused")
    # Only our exact old/new identities are safe to replace.
    if (base / "node-id").is_symlink() or (base / "join-token").is_symlink():
        raise RuntimeError("Symlink identity refused")
    if (base / "node-id").read_text().strip() not in (value["oldNodeId"], node):
        raise RuntimeError("Node binding changed")
    if (
        (base / "node-id").read_text().strip() == node
        and (base / "join-token").exists()
        and (base / "join-token").read_text() != token
    ):
        raise RuntimeError("Retained token binding changed")
    atomic(base / "node-id", node)
    atomic(base / "join-token", token)
    publish(
        {
            "schemaVersion": 1,
            "healthy": False,
            "nodeId": node,
            "observedAtMs": time.time_ns() // 1000000,
        },
        directory=health,
    )


if __name__ == "__main__":
    stage(json.load(sys.stdin))
