#!/usr/bin/env python3
"""Persistent LOCAL SPIRE node for the retained local custody runtime (item 5).

One container, ``axiom-spire``, runs the pinned SPIRE 1.15.3 server and agent
(release archive SHA-256 verified, only the two executables extracted) plus the
repository's root-only health observer (infra/workload/spire_health.py).

Local substitutions, never for production:
- Node attestation is ``join_token`` (production uses GCP IIT). The token is
  generated once and consumed on first start; the agent re-attests from its
  persisted SVID afterwards.
- Workloads in other containers are attested by Unix UID through the host PID
  namespace (``--pid host``), with one dedicated UID per role. Any process on
  this Docker host running as that UID can obtain the role's SVID, so the UIDs
  below must not be reused by any other container.

State lives in named volumes and survives ``down``/``up``:
``axiom-spire-data`` (server + agent data), ``axiom-spire-workload`` (Workload API
socket, mounted by consumers) and ``axiom-spire-health`` (root-owned status.json,
mounted read-only by consumers). Nothing here creates database rows, custody
policy, credentials or keys.

Usage:
  python3 scripts/local-spire.py up        # build image (once), start node
  python3 scripts/local-spire.py register  # create/verify the role entries
  python3 scripts/local-spire.py status
  python3 scripts/local-spire.py down      # stop only; volumes are kept
"""

from __future__ import annotations

import hashlib
import json
import subprocess  # nosec B404 - fixed docker/curl argv lists, no shell
import sys
import tarfile
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from lib.ci_fixture_images import fixture_image  # noqa: E402
from lib.spire_deployment import RELEASE_SHA256, VERSION  # noqa: E402

TRUST_DOMAIN = "local.axiomproof.test"
NAME = "axiom-spire"
IMAGE = f"axiom-spire:{VERSION}"
NETWORK = "axiom-proof_axiom-network"
VOLUMES = {
    "axiom-spire-data": "/var/lib/spire",
    "axiom-spire-workload": "/run/workload",
    "axiom-spire-health": "/run/spire-health",
}
BASE = fixture_image(
    "python:3.14-alpine3.24@sha256:f6a589d43c42b9e7f7dc67a12d37132491f362859a5d750607710cc56da3bc72"
)
CACHE = ROOT / ".axiom-runtime" / "local-spire"
SERVER_SOCKET = "/run/spire-server/api.sock"
ADMIN_SOCKET = "/run/spire-admin/api.sock"
# One dedicated UID per role; never reused by another container on this host.
ROLES = {
    "local-key-service": (20101, f"spiffe://{TRUST_DOMAIN}/service/local-key-service"),
    "producer": (20102, f"spiffe://{TRUST_DOMAIN}/service/assessment-dispatch-producer"),
    "controller": (20103, f"spiffe://{TRUST_DOMAIN}/controller/assessment"),
    "parikshan": (20000, f"spiffe://{TRUST_DOMAIN}/agent/parikshan"),
}

SERVER_CONF = f"""server {{
 bind_address = "127.0.0.1"
 bind_port = 8081
 socket_path = "{SERVER_SOCKET}"
 trust_domain = "{TRUST_DOMAIN}"
 data_dir = "/var/lib/spire/server"
 log_level = "WARN"
 default_x509_svid_ttl = "1h"
 default_jwt_svid_ttl = "5m"
}}
plugins {{
 DataStore "sql" {{ plugin_data {{ database_type = "sqlite3" connection_string = "/var/lib/spire/server/db.sqlite3" }} }}
 KeyManager "disk" {{ plugin_data {{ keys_path = "/var/lib/spire/server/keys.json" }} }}
 NodeAttestor "join_token" {{ plugin_data {{}} }}
}}
"""
AGENT_CONF = f"""agent {{
 data_dir = "/var/lib/spire/agent"
 log_level = "WARN"
 trust_domain = "{TRUST_DOMAIN}"
 server_address = "127.0.0.1"
 server_port = 8081
 socket_path = "/run/workload/api.sock"
 admin_socket_path = "{ADMIN_SOCKET}"
 trust_bundle_path = "/var/lib/spire/bundle.pem"
}}
plugins {{
 KeyManager "disk" {{ plugin_data {{ directory = "/var/lib/spire/agent" }} }}
 NodeAttestor "join_token" {{ plugin_data {{}} }}
 WorkloadAttestor "unix" {{ plugin_data {{}} }}
}}
"""
# Entrypoint: server, first-start bundle + join token, agent, health observer.
# The node ID is persisted so the observer can verify the exact attested node.
ENTRYPOINT = f"""#!/bin/sh
set -eu
umask 077
mkdir -p /var/lib/spire/server /var/lib/spire/agent /run/spire-server /run/spire-admin
spire-server run -config /etc/spire/server.conf &
until spire-server healthcheck -socketPath {SERVER_SOCKET} >/dev/null 2>&1; do sleep 1; done
spire-server bundle show -socketPath {SERVER_SOCKET} -format pem > /var/lib/spire/bundle.pem
if [ ! -s /var/lib/spire/node-id ]; then
  token=$(spire-server token generate -socketPath {SERVER_SOCKET} -ttl 600 | sed -n 's/^Token: //p')
  printf '%s' "spiffe://{TRUST_DOMAIN}/spire/agent/join_token/$token" > /var/lib/spire/node-id
  printf '%s' "$token" > /var/lib/spire/join-token
fi
if [ -s /var/lib/spire/join-token ] && [ ! -s /var/lib/spire/agent/agent_svid.der ]; then
  spire-agent run -config /etc/spire/agent.conf -joinToken "$(cat /var/lib/spire/join-token)" &
else
  spire-agent run -config /etc/spire/agent.conf &
fi
until spire-agent healthcheck -socketPath /run/workload/api.sock >/dev/null 2>&1; do sleep 1; done
rm -f /var/lib/spire/join-token
chmod 0755 /run/workload
exec python3 -I /usr/local/lib/axiom/spire_health.py --watch "$(cat /var/lib/spire/node-id)"
"""


def run(args: list[str], timeout: int = 300, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, text=True, capture_output=True, timeout=timeout, check=check)  # nosec B603


def exists(kind: str, name: str) -> bool:
    return run(["docker", kind, "inspect", name], check=False).returncode == 0


def release(arch: str, directory: Path) -> None:
    CACHE.mkdir(parents=True, exist_ok=True, mode=0o700)
    archive = CACHE / f"spire-{VERSION}-linux-{arch}-musl.tar.gz"
    if not archive.exists():
        download = CACHE / "download.tar.gz"
        run(["curl", "--fail", "--silent", "--show-error", "--location", "--proto", "=https",
             "--tlsv1.2", "--max-time", "180",
             f"https://github.com/spiffe/spire/releases/download/v{VERSION}/{archive.name}",
             "--output", str(download)], timeout=200)
        if hashlib.sha256(download.read_bytes()).hexdigest() != RELEASE_SHA256[arch]:
            download.unlink()
            raise RuntimeError("SPIRE release checksum mismatch")
        download.replace(archive)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != RELEASE_SHA256[arch]:
        raise RuntimeError("SPIRE release checksum mismatch")
    with tarfile.open(archive) as source:
        for executable in ("spire-server", "spire-agent"):
            member = source.getmember(f"spire-{VERSION}/bin/{executable}")
            stream = source.extractfile(member)
            if not member.isfile() or stream is None:
                raise RuntimeError("invalid release member")
            (directory / executable).write_bytes(stream.read())


def build() -> None:
    if exists("image", IMAGE):
        return
    machine = run(["docker", "info", "--format", "{{.Architecture}}"]).stdout.strip()
    arch = {"aarch64": "arm64", "arm64": "arm64", "x86_64": "amd64", "amd64": "amd64"}[machine]
    with tempfile.TemporaryDirectory(prefix="axiom-spire-") as temp:
        context = Path(temp)
        release(arch, context)
        (context / "server.conf").write_text(SERVER_CONF)
        (context / "agent.conf").write_text(AGENT_CONF)
        (context / "entrypoint.sh").write_text(ENTRYPOINT)
        (context / "spire_health.py").write_bytes((ROOT / "infra/workload/spire_health.py").read_bytes())
        (context / "Dockerfile").write_text(f"""FROM {BASE}
LABEL axiom.local.spire.version="{VERSION}" axiom.local.only="true"
COPY --chmod=0755 spire-server spire-agent /usr/local/bin/
COPY --chmod=0644 server.conf agent.conf /etc/spire/
COPY --chmod=0644 spire_health.py /usr/local/lib/axiom/spire_health.py
COPY --chmod=0755 entrypoint.sh /usr/local/bin/axiom-spire-entrypoint
USER 0
ENTRYPOINT ["/usr/local/bin/axiom-spire-entrypoint"]
""")
        run(["docker", "build", "-t", IMAGE, str(context)], timeout=600)


def up() -> None:
    build()
    for volume in VOLUMES:
        if not exists("volume", volume):
            run(["docker", "volume", "create", "--label", "axiom.purpose=local-spire", volume])
    if exists("container", NAME):
        run(["docker", "start", NAME])
    else:
        mounts = [arg for volume, target in VOLUMES.items()
                  for arg in ("--mount", f"type=volume,src={volume},dst={target}")]
        run(["docker", "run", "-d", "--name", NAME, "--restart", "unless-stopped",
             "--network", NETWORK, "--pid", "host", "--label", "axiom.purpose=local-spire",
             *mounts, IMAGE])
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        probe = run(["docker", "exec", NAME, "spire-agent", "healthcheck",
                     "-socketPath", "/run/workload/api.sock"], check=False)
        if probe.returncode == 0:
            print(f"{NAME}: agent healthy; trust domain {TRUST_DOMAIN}")
            return
        time.sleep(2)
    raise RuntimeError("SPIRE agent did not become healthy")


def node_id() -> str:
    return run(["docker", "exec", NAME, "cat", "/var/lib/spire/node-id"]).stdout.strip()


def entries() -> list[dict]:
    shown = run(["docker", "exec", NAME, "spire-server", "entry", "show",
                 "-socketPath", SERVER_SOCKET, "-output", "json"])
    return json.loads(shown.stdout or "{}").get("entries") or []


def register() -> None:
    parent = node_id()
    current = {(e["spiffe_id"]["path"], e["parent_id"]["path"]): e for e in entries()}
    for role, (uid, spiffe_id) in ROLES.items():
        path = spiffe_id.split(TRUST_DOMAIN, 1)[1]
        key = (path, parent.split(TRUST_DOMAIN, 1)[1])
        if key in current:
            selectors = {(s["type"], s["value"]) for s in current[key]["selectors"]}
            if selectors != {("unix", f"uid:{uid}")}:
                raise RuntimeError(f"{role}: existing entry has unexpected selectors; review it")
            print(f"{role}: present ({spiffe_id}, unix uid {uid})")
            continue
        run(["docker", "exec", NAME, "spire-server", "entry", "create",
             "-socketPath", SERVER_SOCKET, "-parentID", parent, "-spiffeID", spiffe_id,
             "-selector", f"unix:uid:{uid}", "-x509SVIDTTL", "3600", "-jwtSVIDTTL", "300"])
        print(f"{role}: created ({spiffe_id}, unix uid {uid})")


def status() -> None:
    state = run(["docker", "inspect", NAME, "--format", "{{.State.Status}}"], check=False)
    print(f"{NAME}: {state.stdout.strip() or 'absent'}")
    if state.stdout.strip() == "running":
        print("node:", node_id())
        health = run(["docker", "exec", NAME, "cat", "/run/spire-health/status.json"], check=False)
        print("health:", health.stdout.strip() or "unavailable")
        for entry in entries():
            print("entry:", "spiffe://" + TRUST_DOMAIN + entry["spiffe_id"]["path"],
                  [f'{s["type"]}:{s["value"]}' for s in entry["selectors"]])


def down() -> None:
    if exists("container", NAME):
        run(["docker", "stop", NAME])
    print(f"{NAME}: stopped; volumes kept")


if __name__ == "__main__":
    actions = {"up": up, "register": register, "status": status, "down": down}
    if len(sys.argv) != 2 or sys.argv[1] not in actions:
        raise SystemExit(__doc__)
    actions[sys.argv[1]]()
