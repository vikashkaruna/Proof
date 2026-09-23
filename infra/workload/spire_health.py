#!/usr/bin/env python3
"""Root-only SPIRE sync observer. Publishes metadata, never SVIDs or admin API.

Requires a protected, pinned spire-agent binary and root-controlled /run mounts.
The controller receives only /run/spire-health read-only, never spire-admin.
"""
from __future__ import annotations

import json
import os
import re
import selectors
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

DIRECTORY = Path("/run/spire-health")
COMMAND = ["/usr/local/bin/spire-agent", "debug", "getinfo", "-socketPath", "/run/spire-admin/api.sock", "-output", "json"]
MAX_SYNC_AGE_MS = 30000


def node_id(value: object) -> str:
    if not isinstance(value, str) or len(value) > 2048 or not re.fullmatch(r"spiffe://[a-z0-9]+(?:[.-][a-z0-9]+)*/spire/agent/[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)+", value):
        raise ValueError("node binding refused")
    return value


def _timestamp(value: object) -> int:
    if not isinstance(value, str) or not re.fullmatch(r"[1-9][0-9]{0,12}", value):
        raise ValueError("timestamp refused")
    result = int(value) * 1000
    if result > 9007199254740991:
        raise ValueError("timestamp refused")
    return result


def snapshot(info: object, expected: str, now_ms: int) -> dict[str, object]:
    node_id(expected)
    if type(now_ms) is not int or now_ms <= 0 or not isinstance(info, dict):
        raise ValueError("observation refused")
    chain = info.get("svid_chain")
    if not isinstance(chain, list) or not 1 <= len(chain) <= 8:
        raise ValueError("node certificate refused")
    leaf = chain[0]
    if not isinstance(leaf, dict) or not isinstance(leaf.get("id"), dict):
        raise ValueError("node certificate refused")
    identity = leaf["id"]
    if node_id(f"spiffe://{identity.get('trust_domain')}{identity.get('path')}") != expected:
        raise ValueError("node binding refused")
    sync = _timestamp(info.get("last_sync_success"))
    expiry = _timestamp(leaf.get("expires_at"))
    if not now_ms - MAX_SYNC_AGE_MS < sync <= now_ms < expiry:
        raise ValueError("node synchronization refused")
    return {"schemaVersion": 1, "healthy": True, "nodeId": expected,
            "observedAtMs": now_ms, "syncAtMs": sync, "certificateExpiresAtMs": expiry}


def query() -> object:
    # Fixed command and minimal environment; bounded output, deadline, no shell
    # or private stderr. CLI process is killed/reaped even on oversized output.
    with subprocess.Popen(COMMAND, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, env={"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/nonexistent"}) as process:
        try:
            with selectors.DefaultSelector() as selector:
                assert process.stdout is not None
                selector.register(process.stdout, selectors.EVENT_READ)
                data = bytearray()
                deadline = time.monotonic() + 2
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or not selector.select(remaining):
                        raise ValueError("node observation timed out")
                    chunk = os.read(process.stdout.fileno(), 4096)
                    if not chunk:
                        break
                    data.extend(chunk)
                    if len(data) > 65536:
                        raise ValueError("node observation oversized")
                remaining = deadline - time.monotonic()
                if remaining <= 0 or process.wait(timeout=remaining) != 0:
                    raise ValueError("node observation refused")
                return json.loads(data)
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()


def publish(value: dict[str, object], directory: Path = DIRECTORY) -> None:
    # The CLI requires root. The function also supports unprivileged isolated
    # unit fixtures; its directory must always belong to the publishing UID.
    if directory.resolve() != directory:
        raise ValueError("health directory refused")
    directory.mkdir(mode=0o755, exist_ok=True)
    meta = directory.lstat()
    if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != os.geteuid() or meta.st_mode & 0o022:
        raise ValueError("health directory refused")
    os.chmod(directory, 0o755)
    fd, temporary = tempfile.mkstemp(prefix=".status-", dir=directory)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
            os.fchmod(stream.fileno(), 0o644)
        os.replace(temporary, directory / "status.json")
    finally:
        Path(temporary).unlink(missing_ok=True)


def observe(expected: str) -> bool:
    try:
        info = query()
        value = snapshot(info, expected, time.time_ns() // 1000000)
    except Exception:
        value = {"schemaVersion": 1, "healthy": False, "nodeId": expected,
                 "observedAtMs": time.time_ns() // 1000000}
    publish(value)
    return value["healthy"] is True


def main() -> int:
    if os.geteuid() != 0 or len(sys.argv) != 3 or sys.argv[1] not in ("--once", "--watch"):
        raise ValueError("invocation refused")
    expected = node_id(sys.argv[2])
    os.umask(0o077)
    while True:
        healthy = observe(expected)
        if sys.argv[1] == "--once":
            return 0 if healthy else 1
        time.sleep(2)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print("SPIRE health publication refused.", file=sys.stderr)
        sys.exit(1)
