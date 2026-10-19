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
  python3 scripts/local-spire.py reattest
  python3 scripts/local-spire.py reattest --resume /protected/recovery/intent.json
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import stat
import subprocess  # nosec B404 - fixed docker/curl argv lists, no shell
import sys
import tarfile
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from lib.ci_fixture_images import fixture_image
from lib.spire_deployment import RELEASE_SHA256, VERSION

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
    "producer": (
        20102,
        f"spiffe://{TRUST_DOMAIN}/service/assessment-dispatch-producer",
    ),
    "controller": (20103, f"spiffe://{TRUST_DOMAIN}/controller/assessment"),
    "parikshan": (20003, f"spiffe://{TRUST_DOMAIN}/agent/parikshan"),
}
LEGACY_ROLES = dict(ROLES)
# Created only by the explicit register command, never by recovery.
ROLES["drishti"] = (20004, f"spiffe://{TRUST_DOMAIN}/agent/drishti")

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
agent_pid=$!
# A prior success is not today's health. Publish refusal before waiting and
# stop if the agent dies; explicit re-attestation preserves the old identity.
python3 -I /usr/local/lib/axiom/spire_health.py --once "$(cat /var/lib/spire/node-id)" >/dev/null 2>&1 || true
until spire-agent healthcheck -socketPath /run/workload/api.sock >/dev/null 2>&1; do
  kill -0 "$agent_pid" 2>/dev/null || exit 1
  sleep 1
done
rm -f /var/lib/spire/join-token
chmod 0755 /run/workload
exec python3 -I /usr/local/lib/axiom/spire_health.py --watch "$(cat /var/lib/spire/node-id)"
"""


def run(
    args: list[str], timeout: int = 300, check: bool = True, input: str | None = None
) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            args,
            text=True,
            capture_output=True,
            timeout=timeout,
            check=check,
            input=input,
        )  # nosec B603
    except (subprocess.SubprocessError, OSError):
        # Never leak command argv, stdin, Docker diagnostics or a fresh identity.
        raise RuntimeError(
            "Local SPIRE subprocess failed; preserve the recovery journal and retry explicitly"
        ) from None


def exists(kind: str, name: str) -> bool:
    return run(["docker", kind, "inspect", name], check=False).returncode == 0


def release(arch: str, directory: Path) -> None:
    CACHE.mkdir(parents=True, exist_ok=True, mode=0o700)
    archive = CACHE / f"spire-{VERSION}-linux-{arch}-musl.tar.gz"
    if not archive.exists():
        download = CACHE / "download.tar.gz"
        run(
            [
                "curl",
                "--fail",
                "--silent",
                "--show-error",
                "--location",
                "--proto",
                "=https",
                "--tlsv1.2",
                "--max-time",
                "180",
                f"https://github.com/spiffe/spire/releases/download/v{VERSION}/{archive.name}",
                "--output",
                str(download),
            ],
            timeout=200,
        )
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


def build(force: bool = False) -> None:
    if not force and exists("image", IMAGE):
        return
    machine = run(["docker", "info", "--format", "{{.Architecture}}"]).stdout.strip()
    arch = {"aarch64": "arm64", "arm64": "arm64", "x86_64": "amd64", "amd64": "amd64"}[
        machine
    ]
    with tempfile.TemporaryDirectory(prefix="axiom-spire-") as temp:
        context = Path(temp)
        release(arch, context)
        (context / "server.conf").write_text(SERVER_CONF)
        (context / "agent.conf").write_text(AGENT_CONF)
        (context / "entrypoint.sh").write_text(ENTRYPOINT)
        for helper in ("spire_health.py", "spire_recovery.py"):
            (context / helper).write_bytes(
                (ROOT / "infra/workload" / helper).read_bytes()
            )
        (context / "Dockerfile").write_text(f"""FROM {BASE}
LABEL axiom.local.spire.version="{VERSION}" axiom.local.only="true"
COPY --chmod=0755 spire-server spire-agent /usr/local/bin/
COPY --chmod=0644 server.conf agent.conf /etc/spire/
COPY --chmod=0644 spire_health.py spire_recovery.py /usr/local/lib/axiom/
COPY --chmod=0755 entrypoint.sh /usr/local/bin/axiom-spire-entrypoint
RUN chmod 0755 /usr/local/lib/axiom
USER 0
ENTRYPOINT ["/usr/local/bin/axiom-spire-entrypoint"]
""")
        run(["docker", "build", "-t", IMAGE, str(context)], timeout=600)


def up(image: str = IMAGE) -> None:
    if image == IMAGE:
        build()
    for volume in VOLUMES:
        if not exists("volume", volume):
            run(
                [
                    "docker",
                    "volume",
                    "create",
                    "--label",
                    "axiom.purpose=local-spire",
                    volume,
                ]
            )
    if exists("container", NAME):
        run(["docker", "start", NAME])
    else:
        mounts = [
            arg
            for volume, target in VOLUMES.items()
            for arg in ("--mount", f"type=volume,src={volume},dst={target}")
        ]
        run(
            [
                "docker",
                "run",
                "-d",
                "--name",
                NAME,
                "--restart",
                "unless-stopped",
                "--network",
                NETWORK,
                "--pid",
                "host",
                "--label",
                "axiom.purpose=local-spire",
                *mounts,
                image,
            ]
        )
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        probe = run(
            [
                "docker",
                "exec",
                NAME,
                "spire-agent",
                "healthcheck",
                "-socketPath",
                "/run/workload/api.sock",
            ],
            check=False,
        )
        if probe.returncode == 0:
            print(f"{NAME}: agent healthy; trust domain {TRUST_DOMAIN}")
            return
        time.sleep(2)
    raise RuntimeError("SPIRE agent did not become healthy")


def node_id() -> str:
    return run(["docker", "exec", NAME, "cat", "/var/lib/spire/node-id"]).stdout.strip()


def entries() -> list[dict]:
    shown = run(
        [
            "docker",
            "exec",
            NAME,
            "spire-server",
            "entry",
            "show",
            "-socketPath",
            SERVER_SOCKET,
            "-output",
            "json",
        ]
    )
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
                raise RuntimeError(
                    f"{role}: existing entry has unexpected selectors; review it"
                )
            print(f"{role}: present ({spiffe_id}, unix uid {uid})")
            continue
        run(
            [
                "docker",
                "exec",
                NAME,
                "spire-server",
                "entry",
                "create",
                "-socketPath",
                SERVER_SOCKET,
                "-parentID",
                parent,
                "-spiffeID",
                spiffe_id,
                "-selector",
                f"unix:uid:{uid}",
                "-x509SVIDTTL",
                "3600",
                "-jwtSVIDTTL",
                "300",
            ]
        )
        print(f"{role}: created ({spiffe_id}, unix uid {uid})")


def migrate_parikshan_uid() -> None:
    """Explicit reviewed correction of the old local UID selector only."""
    parent = node_id()
    spiffe_id = ROLES["parikshan"][1]
    wanted_path = spiffe_id.split(TRUST_DOMAIN, 1)[1]
    parent_path = parent.split(TRUST_DOMAIN, 1)[1]
    matching = [
        entry
        for entry in entries()
        if entry["spiffe_id"]["path"] == wanted_path
        and entry["parent_id"]["path"] == parent_path
    ]
    if len(matching) != 1:
        raise RuntimeError("Expected exactly one retained parikshan entry")
    entry = matching[0]
    selectors = {(item["type"], item["value"]) for item in entry["selectors"]}
    if selectors == {("unix", "uid:20003")}:
        print("parikshan: dedicated worker selector already correct")
        return
    if (
        selectors != {("unix", "uid:20000")}
        or not isinstance(entry.get("id"), str)
        or not entry["id"]
    ):
        raise RuntimeError("Unexpected parikshan selector; explicit review required")
    run(
        [
            "docker",
            "exec",
            NAME,
            "spire-server",
            "entry",
            "update",
            "-socketPath",
            SERVER_SOCKET,
            "-entryID",
            entry["id"],
            "-parentID",
            parent,
            "-spiffeID",
            spiffe_id,
            "-selector",
            "unix:uid:20003",
            "-x509SVIDTTL",
            "3600",
            "-jwtSVIDTTL",
            "300",
        ]
    )
    fresh = [item for item in entries() if item.get("id") == entry["id"]]
    if len(fresh) != 1 or {
        (item["type"], item["value"]) for item in fresh[0]["selectors"]
    } != {("unix", "uid:20003")}:
        raise RuntimeError(
            "Worker selector update unconfirmed; inspect the retained entry"
        )
    print("parikshan: reviewed dedicated worker UID selector updated")


def recovery_entries(
    parent: str, current: list[dict], roles: dict | None = None
) -> list[tuple[dict, int, str]]:
    """Move only the exact reviewed role snapshot, defaulting to the original four."""
    roles = LEGACY_ROLES if roles is None else roles
    if not set(LEGACY_ROLES).issubset(roles) or any(
        name not in ROLES or tuple(binding) != ROLES[name]
        for name, binding in roles.items()
    ):
        raise RuntimeError("Unreviewed recovery role binding")
    prefix = f"spiffe://{TRUST_DOMAIN}"
    if not re.fullmatch(
        re.escape(prefix) + r"/spire/agent/join_token/[A-Za-z0-9_-]+", parent
    ):
        raise RuntimeError("Unexpected local node identity")
    parent_path = parent[len(prefix) :]
    owned = [
        item for item in current if item.get("parent_id", {}).get("path") == parent_path
    ]
    if len(owned) != len(roles):
        raise RuntimeError("Unexpected local child registration set")
    result = []
    for uid, spiffe_id in roles.values():
        matches = [
            item
            for item in owned
            if item.get("spiffe_id", {}).get("path") == spiffe_id[len(prefix) :]
        ]
        if len(matches) != 1:
            raise RuntimeError("Local child registration missing or duplicated")
        item = matches[0]
        if (
            item.get("spiffe_id", {}).get("trust_domain") != TRUST_DOMAIN
            or item.get("parent_id", {}).get("trust_domain") != TRUST_DOMAIN
            or not item.get("id")
            or item.get("admin")
            or item.get("downstream")
            or {(s["type"], s["value"]) for s in item.get("selectors", [])}
            != {("unix", f"uid:{uid}")}
        ):
            raise RuntimeError("Unexpected local child authority")
        result.append((item, uid, spiffe_id))
    return result


COMPLETE = "reattested_and_children_verified"


def private_path(path: Path, directory: bool = False) -> None:
    info = path.lstat()
    expected = 0o700 if directory else 0o600
    if (
        path.resolve() != path
        or info.st_uid != os.getuid()
        or stat.S_IMODE(info.st_mode) != expected
        or (
            not stat.S_ISDIR(info.st_mode)
            if directory
            else not stat.S_ISREG(info.st_mode)
        )
    ):
        raise RuntimeError(
            "Recovery journal requires an owned private directory and regular 0600 file"
        )


def save_intent(record: Path, intent: dict) -> None:
    private_path(record.parent, directory=True)
    temporary = record.with_name("intent.next")
    fd = os.open(
        temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600
    )
    with os.fdopen(fd, "w") as stream:
        json.dump(intent, stream)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(record)
    descriptor = os.open(record.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def container_meta(name: str) -> dict | None:
    result = run(["docker", "inspect", name], check=False)
    if result.returncode:
        return None
    meta = json.loads(result.stdout)[0]
    if meta.get("Config", {}).get("Labels", {}).get("axiom.purpose") != "local-spire":
        raise RuntimeError("Foreign SPIRE container refused")
    return meta


def reattest(resume: Path | None = None) -> None:
    """Explicit recovery with an immutable grant snapshot and protected resume journal.

    Resume never issues another token. Failed/uncertain token generation needs
    operator review; expired unconsumed tokens are refused without resetting state.
    """
    if resume is None:
        CACHE.mkdir(parents=True, exist_ok=True, mode=0o700)
        for prior in CACHE.glob("recovery-*/intent.json"):
            private_path(prior.parent, directory=True)
            private_path(prior)
            if json.loads(prior.read_text()).get("phase") != COMPLETE:
                raise RuntimeError(
                    "Unfinished recovery exists; use reattest --resume with its private intent"
                )
        meta = container_meta(NAME)
        if meta is None:
            raise RuntimeError("Existing local SPIRE container required")
        processes = run(["docker", "top", NAME, "-eo", "pid,comm"]).stdout.splitlines()[
            1:
        ]
        if any(
            item.split() and item.split()[-1] == "spire-agent" for item in processes
        ):
            raise RuntimeError(
                "Stop and investigate the existing agent before re-attestation"
            )
        old = node_id()
        current = entries()
        roles = dict(LEGACY_ROLES)
        if any(
            item.get("parent_id", {}).get("path") == old.split(TRUST_DOMAIN, 1)[1]
            and item.get("spiffe_id", {}).get("path") == "/agent/drishti"
            for item in current
        ):
            roles["drishti"] = ROLES["drishti"]
        children = recovery_entries(old, current, roles)
        stamp = (
            time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + secrets.token_hex(6)
        )
        backup = CACHE / ("recovery-" + stamp)
        backup.mkdir(mode=0o700)
        record = backup / "intent.json"
        intent = {
            "schemaVersion": 1,
            "stamp": stamp,
            "oldNodeId": old,
            "oldContainerId": meta["Id"],
            "roles": roles,
            "entries": [item for item, _, _ in children],
            "phase": "prepared",
        }
        save_intent(record, intent)
    else:
        record = Path(os.path.abspath(resume))
        private_path(record.parent, directory=True)
        private_path(record)
        if record.stat().st_size > 65536:
            raise RuntimeError("Oversized recovery journal")
        intent = json.loads(record.read_text())
        backup = record.parent
        if intent.get("schemaVersion") != 1:
            raise RuntimeError(
                "Legacy journal needs explicit operator review; no token regeneration permitted"
            )
    roles = intent["roles"]
    children = recovery_entries(intent["oldNodeId"], intent["entries"], roles)
    if len({item["id"] for item, _, _ in children}) != len(children):
        raise RuntimeError("Duplicate retained registration identity")
    stamp = intent["stamp"]
    if not re.fullmatch(r"[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}", stamp):
        raise RuntimeError("Invalid journal identifier")

    def checkpoint(phase: str, **values) -> None:
        intent.setdefault("history", []).append(
            {"phase": phase, "at": int(time.time())}
        )
        intent.update(phase=phase, **values)
        save_intent(record, intent)

    if intent["phase"] == "prepared":
        build(force=True)
        image = run(
            ["docker", "image", "inspect", IMAGE, "--format", "{{.Id}}"]
        ).stdout.strip()
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", image):
            raise RuntimeError("Recovery image identity unavailable")
        # Verify installation before issuing or consuming any token.
        run(
            [
                "docker",
                "run",
                "--rm",
                "--network",
                "none",
                "--read-only",
                "--cap-drop",
                "ALL",
                "--entrypoint",
                "python3",
                image,
                "-I",
                "-c",
                "import sys;sys.path.insert(0,'/usr/local/lib/axiom');import spire_recovery",
            ]
        )
        checkpoint("image_ready", image=image)
    if intent["phase"] == "image_ready":
        checkpoint("token_issuing", expiresAt=int(time.time()) + 600)
        issued = run(
            [
                "docker",
                "exec",
                NAME,
                "spire-server",
                "token",
                "generate",
                "-socketPath",
                SERVER_SOCKET,
                "-ttl",
                "600",
            ]
        ).stdout
        token = next(
            (
                line.removeprefix("Token: ").strip()
                for line in issued.splitlines()
                if line.startswith("Token: ")
            ),
            "",
        )
        if not re.fullmatch(r"[A-Za-z0-9_-]{20,200}", token) or intent[
            "oldNodeId"
        ].endswith("/" + token):
            raise RuntimeError("Fresh attestation refused; preserve recovery intent")
        checkpoint(
            "token_issued",
            newNodeId=f"spiffe://{TRUST_DOMAIN}/spire/agent/join_token/{token}",
        )
    if intent["phase"] == "token_issuing":
        raise RuntimeError(
            "Token issuance outcome unknown; operator review required; token will not be regenerated"
        )
    image = intent["image"]
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", image):
        raise RuntimeError("Invalid retained image")
    new = intent["newNodeId"]
    token = new.rsplit("/", 1)[-1]
    if (
        not re.fullmatch(r"[A-Za-z0-9_-]{20,200}", token)
        or new != f"spiffe://{TRUST_DOMAIN}/spire/agent/join_token/{token}"
        or new == intent["oldNodeId"]
    ):
        raise RuntimeError("Invalid retained fresh identity")
    retired = "axiom-proof-local-spire-rollback-" + stamp.lower()
    pre_start = {
        "token_issued",
        "node_stopped",
        "backup_ready",
        "state_ready",
        "container_retiring",
    }
    if intent["phase"] in pre_start and time.time() >= intent["expiresAt"]:
        raise RuntimeError(
            "Unconsumed attestation token expired; preserve recovery state for review"
        )
    if intent["phase"] == "token_issued":
        meta = container_meta(NAME)
        if meta is None or meta["Id"] != intent["oldContainerId"]:
            raise RuntimeError("Original container binding changed")
        if meta["State"]["Running"]:
            run(["docker", "stop", NAME])
        checkpoint("node_stopped")
    if intent["phase"] in {"node_stopped", "backup_ready", "state_ready"}:
        stopped = container_meta(NAME)
        if (
            stopped is None
            or stopped["Id"] != intent["oldContainerId"]
            or stopped["State"]["Running"]
        ):
            raise RuntimeError(
                "Original container must remain stopped during offline staging"
            )
    if intent["phase"] == "node_stopped":
        # A failed copy is retained, never overwritten or treated as complete.
        destination = backup / ("data-" + secrets.token_hex(6))
        run(["docker", "cp", "-q", NAME + ":/var/lib/spire", str(destination)])
        for path in backup.rglob("*"):
            if not path.is_symlink():
                path.chmod(0o700 if path.is_dir() else 0o600)
        checkpoint("backup_ready", dataBackup=destination.name)
    if intent["phase"] == "backup_ready":
        run(
            [
                "docker",
                "run",
                "--rm",
                "-i",
                "--network",
                "none",
                "--read-only",
                "--cap-drop",
                "ALL",
                "--mount",
                "type=volume,src=axiom-spire-data,dst=/var/lib/spire",
                "--mount",
                "type=volume,src=axiom-spire-health,dst=/run/spire-health",
                "--entrypoint",
                "python3",
                image,
                "-I",
                "-c",
                "import sys;sys.path.insert(0,'/usr/local/lib/axiom');import spire_recovery;import json;spire_recovery.stage(json.load(sys.stdin))",
            ],
            input=json.dumps(
                {
                    "stamp": stamp,
                    "oldNodeId": intent["oldNodeId"],
                    "node": new,
                    "token": token,
                    "expiresAt": intent["expiresAt"],
                }
            ),
        )
        checkpoint("state_ready")
    if intent["phase"] in {"state_ready", "container_retiring"}:
        checkpoint("container_retiring")
        original = container_meta(retired)
        if original is None:
            original = container_meta(NAME)
            if (
                original is None
                or original["Id"] != intent["oldContainerId"]
                or original["State"]["Running"]
            ):
                raise RuntimeError("Stopped original container binding unconfirmed")
            run(["docker", "rename", NAME, retired])
        elif original["Id"] != intent["oldContainerId"]:
            raise RuntimeError("Retired container binding changed")
        run(["docker", "update", "--restart", "no", retired])
        checkpoint("starting", retiredContainer=retired)
    if intent["phase"] == "starting":
        # A previous start may have consumed the token before reporting failure.
        meta = container_meta(NAME)
        if meta is not None and (
            meta["Id"] == intent["oldContainerId"] or meta.get("Image") != image
        ):
            raise RuntimeError("Replacement container/image binding changed")
        healthy = (
            meta is not None
            and run(
                [
                    "docker",
                    "exec",
                    NAME,
                    "spire-agent",
                    "healthcheck",
                    "-socketPath",
                    "/run/workload/api.sock",
                ],
                check=False,
            ).returncode
            == 0
        )
        if not healthy and time.time() >= intent["expiresAt"]:
            raise RuntimeError(
                "Attestation expired without verified healthy agent; preserve state"
            )
        up(image=image)
        if node_id() != new:
            raise RuntimeError("New node binding unconfirmed")
        checkpoint("children_updating")
    if intent["phase"] in {"children_updating", COMPLETE}:
        if node_id() != new:
            raise RuntimeError("New node binding unconfirmed")
        current = entries()
        expected = {item["id"] for item, _, _ in children}
        parents = {
            intent["oldNodeId"].split(TRUST_DOMAIN, 1)[1],
            new.split(TRUST_DOMAIN, 1)[1],
        }
        actual = [
            item for item in current if item.get("parent_id", {}).get("path") in parents
        ]
        if (
            len(actual) != len(expected)
            or {item.get("id") for item in actual} != expected
        ):
            raise RuntimeError("Retained child registration set changed")
        by_id = {item["id"]: item for item in actual}
        for item, uid, spiffe_id in children:
            observed = by_id[item["id"]]
            parent = "spiffe://" + TRUST_DOMAIN + observed["parent_id"]["path"]
            # Validate full authority against the immutable snapshot before updating.
            if (
                observed.get("parent_id", {}).get("trust_domain") != TRUST_DOMAIN
                or observed.get("spiffe_id") != item["spiffe_id"]
            ):
                raise RuntimeError("Retained child authority changed")
            candidate = dict(observed, parent_id=item["parent_id"])
            peers = [
                candidate if peer["id"] == item["id"] else peer
                for peer, _, _ in children
            ]
            recovery_entries(intent["oldNodeId"], peers, roles)
            if parent == new:
                continue
            run(
                [
                    "docker",
                    "exec",
                    NAME,
                    "spire-server",
                    "entry",
                    "update",
                    "-socketPath",
                    SERVER_SOCKET,
                    "-entryID",
                    item["id"],
                    "-parentID",
                    new,
                    "-spiffeID",
                    spiffe_id,
                    "-selector",
                    f"unix:uid:{uid}",
                    "-x509SVIDTTL",
                    "3600",
                    "-jwtSVIDTTL",
                    "300",
                ]
            )
        recovery_entries(new, entries(), roles)
        checkpoint(COMPLETE)
    else:
        raise RuntimeError("Unknown recovery phase; preserve journal for review")
    print(
        "Local node re-attested and retained grants verified; old state preserved. Restage dependent services for the new identity."
    )


def status() -> None:
    state = run(
        ["docker", "inspect", NAME, "--format", "{{.State.Status}}"], check=False
    )
    print(f"{NAME}: {state.stdout.strip() or 'absent'}")
    if state.stdout.strip() == "running":
        print("node:", node_id())
        health = run(
            ["docker", "exec", NAME, "cat", "/run/spire-health/status.json"],
            check=False,
        )
        print("health:", health.stdout.strip() or "unavailable")
        for entry in entries():
            print(
                "entry:",
                "spiffe://" + TRUST_DOMAIN + entry["spiffe_id"]["path"],
                [f"{s['type']}:{s['value']}" for s in entry["selectors"]],
            )


def down() -> None:
    if exists("container", NAME):
        run(["docker", "stop", NAME])
    print(f"{NAME}: stopped; volumes kept")


if __name__ == "__main__":
    actions = {
        "up": up,
        "register": register,
        "status": status,
        "down": down,
        "migrate-parikshan-uid": migrate_parikshan_uid,
        "reattest": reattest,
    }
    if len(sys.argv) == 4 and sys.argv[1:3] == ["reattest", "--resume"]:
        try:
            reattest(Path(sys.argv[3]))
        except (RuntimeError, ValueError, KeyError, OSError):
            raise SystemExit(
                "Local SPIRE recovery refused; retain the private journal for review"
            ) from None
        raise SystemExit(0)
    if len(sys.argv) != 2 or sys.argv[1] not in actions:
        raise SystemExit(__doc__)
    try:
        actions[sys.argv[1]]()
    except (RuntimeError, ValueError, KeyError, OSError):
        raise SystemExit(
            "Local SPIRE operation refused; retain protected diagnostics and recovery journal for review"
        ) from None
