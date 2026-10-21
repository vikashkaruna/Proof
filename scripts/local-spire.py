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
  python3 scripts/local-spire.py register  # original read/control role entries
  python3 scripts/local-spire.py register-karya  # explicit synthetic writer identity only
  python3 scripts/local-spire.py status
  python3 scripts/local-spire.py down      # stop only; volumes are kept
  python3 scripts/local-spire.py reattest
  python3 scripts/local-spire.py reattest --expired-agent  # explicit stopped/server-only recovery
  python3 scripts/local-spire.py reattest --resume /protected/recovery/intent.json
"""

from __future__ import annotations

import base64
import fcntl
import io
import ssl
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
ROLES["karya"] = (20005, f"spiffe://{TRUST_DOMAIN}/agent/karya")

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
RUN chmod 0755 /usr/local/lib/axiom /etc/spire
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


def node_id(target: str | None = None) -> str:
    target = NAME if target is None else target
    return run(["docker", "exec", target, "cat", "/var/lib/spire/node-id"]).stdout.strip()


def entries(target: str | None = None) -> list[dict]:
    target = NAME if target is None else target
    shown = run(
        [
            "docker",
            "exec",
            target,
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


def register(*, karya_only: bool = False) -> None:
    parent = node_id()
    current = {(e["spiffe_id"]["path"], e["parent_id"]["path"]): e for e in entries()}
    selected = (
        {"karya": ROLES["karya"]}
        if karya_only
        else {name: value for name, value in ROLES.items() if name != "karya"}
    )
    for role, (uid, spiffe_id) in selected.items():
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


def reviewed_roles(old: str, current: list[dict]) -> dict:
    roles = dict(LEGACY_ROLES)
    for name, (_uid, sid) in ROLES.items():
        if name not in LEGACY_ROLES and any(
            item.get("parent_id", {}).get("path") == old.split(TRUST_DOMAIN, 1)[1]
            and item.get("spiffe_id", {}).get("path") == sid.split(TRUST_DOMAIN, 1)[1]
            for item in current
        ):
            roles[name] = ROLES[name]
    recovery_entries(old, current, roles)
    return roles


def public_node_certificate(target: str) -> tuple[str, dict]:
    try:
        return _public_node_certificate(target)
    except Exception:
        raise RuntimeError("Cached public node certificate refused") from None


def _public_node_certificate(target: str) -> tuple[str, dict]:
    """Decode only the cached public certificate, never agent key material."""
    value = subprocess.run(
        ["docker", "cp", target + ":/var/lib/spire/agent/agent-data.json", "-"],
        capture_output=True, timeout=30, check=True,
    )  # nosec B603 B607 - fixed Docker public-certificate path, no shell
    if len(value.stdout) > 262144:
        raise RuntimeError("Cached public certificate oversized")
    with tarfile.open(fileobj=io.BytesIO(value.stdout), mode="r:*") as archive:
        members = archive.getmembers()
        if len(members) != 1 or not members[0].isfile() or not 0 < members[0].size <= 131072:
            raise RuntimeError("Cached public certificate refused")
        stream = archive.extractfile(members[0])
        if stream is None:
            raise RuntimeError("Cached public certificate unavailable")
        cached = json.loads(stream.read(131073))
    chain = cached.get("svid") if isinstance(cached, dict) else None
    if not isinstance(chain, list) or not 1 <= len(chain) <= 8 or not all(
        isinstance(item, str) and 0 < len(item) <= 32768 for item in chain
    ):
        raise RuntimeError("Cached public certificate chain refused")
    public_pem = base64.b64decode(chain[0], validate=True).decode("ascii")
    der = ssl.PEM_cert_to_DER_cert(public_pem)
    if not 0 < len(der) <= 24576:
        raise RuntimeError("Cached public leaf certificate oversized")
    with tempfile.TemporaryDirectory(prefix="axiom-spire-public-cert-") as directory:
        pem = Path(directory) / "certificate.pem"
        pem.write_text(ssl.DER_cert_to_PEM_cert(der))
        pem.chmod(0o600)
        # CPython's OpenSSL-backed decoder is pinned by the reviewed Python tool.
        decoded = ssl._ssl._test_decode_cert(str(pem))
    return hashlib.sha256(der).hexdigest(), decoded


def expired_node_proof(meta: dict) -> dict:
    if not re.fullmatch(r"[a-f0-9]{64}", meta.get("Id", "")) or not re.fullmatch(
        r"sha256:[a-f0-9]{64}", meta.get("Image", "")
    ):
        raise RuntimeError("Pinned original SPIRE identity required")
    mounts = meta.get("Mounts", [])
    expected = {(name, target) for name, target in VOLUMES.items()}
    actual = {(m.get("Name"), m.get("Destination")) for m in mounts}
    if actual != expected or len(mounts) != len(expected) or any(
        m.get("Type") != "volume" or m.get("RW") is not True for m in mounts
    ):
        raise RuntimeError("Exact retained SPIRE volumes required")
    if run(["docker", "exec", NAME, "spire-agent", "healthcheck", "-socketPath",
            "/run/workload/api.sock"], check=False).returncode == 0:
        raise RuntimeError("Healthy agent must not be re-attested")
    # docker cp can read a stopped/restarting container without a timing race.
    # node-id is read separately below using a public-file reader; never decode tar as text.
    old = read_node_id_from_container(NAME)
    sha, cert = public_node_certificate(NAME)
    uris = [value for kind, value in cert.get("subjectAltName", ()) if kind == "URI"]
    if uris != [old] or not re.fullmatch(
        re.escape(f"spiffe://{TRUST_DOMAIN}/spire/agent/join_token/") + r"[A-Za-z0-9_-]+", old
    ):
        raise RuntimeError("Cached certificate node binding refused")
    expiry = int(ssl.cert_time_to_seconds(cert["notAfter"]))
    if expiry > time.time():
        raise RuntimeError("Cached node certificate is not expired")
    return {"oldNodeId": old, "certificateSha256": sha, "certificateExpiredAt": expiry,
            "originalImage": meta["Image"]}


def read_node_id_from_container(target: str) -> str:
    try:
        return _read_node_id_from_container(target)
    except Exception:
        raise RuntimeError("Retained node metadata refused") from None


def _read_node_id_from_container(target: str) -> str:
    result = subprocess.run(["docker", "cp", target + ":/var/lib/spire/node-id", "-"],
                            capture_output=True, timeout=30, check=True)  # nosec B603 B607
    if len(result.stdout) > 16384:
        raise RuntimeError("Node metadata oversized")
    with tarfile.open(fileobj=io.BytesIO(result.stdout), mode="r:*") as archive:
        members = archive.getmembers()
        if len(members) != 1 or not members[0].isfile() or not 1 <= members[0].size <= 2048:
            raise RuntimeError("Node metadata refused")
        stream = archive.extractfile(members[0])
        if stream is None:
            raise RuntimeError("Node metadata unavailable")
        return stream.read(2049).decode().strip()


def offline_original(intent: dict) -> dict:
    meta = container_meta(NAME)
    if meta is None or meta["Id"] != intent["oldContainerId"] or meta.get("Image") != intent["originalImage"]:
        raise RuntimeError("Original offline recovery identity changed")
    expected = {(name, target) for name, target in VOLUMES.items()}
    if {(m.get("Name"), m.get("Destination")) for m in meta.get("Mounts", [])} != expected:
        raise RuntimeError("Original offline recovery volumes changed")
    return meta


def offline_helper_meta(intent: dict, allow_missing: bool = False) -> dict | None:
    helper = intent["offlineServer"]
    target = helper.get("id") or helper["name"]
    result = run(["docker", "inspect", target], check=False)
    if result.returncode:
        named = run(["docker", "inspect", helper["name"]], check=False)
        if named.returncode and allow_missing:
            return None
        raise RuntimeError("Owned recovery server identity unavailable")
    values = json.loads(result.stdout)
    if len(values) != 1:
        raise RuntimeError("Owned recovery server metadata refused")
    meta = values[0]
    if (meta.get("Name") != "/" + helper["name"] or meta.get("Image") != intent["recoveryImage"]
        or (helper.get("id") is not None and meta.get("Id") != helper["id"])
        or meta.get("Config", {}).get("Labels", {}).get("axiom.recovery.owner") != helper["nonce"]
        or meta.get("Config", {}).get("Labels", {}).get("axiom.purpose") != "local-spire-recovery-server"
        or meta.get("Config", {}).get("Entrypoint") != ["spire-server"]
        or meta.get("Config", {}).get("Cmd") != ["run", "-config", "/etc/spire/server.conf"]
        or meta.get("HostConfig", {}).get("NetworkMode") != "none"
        or meta.get("HostConfig", {}).get("PortBindings")
        or meta.get("HostConfig", {}).get("Binds")
        or meta.get("HostConfig", {}).get("Privileged") is not False
        or meta.get("HostConfig", {}).get("ReadonlyRootfs") is not True
        or meta.get("HostConfig", {}).get("CapDrop") != ["ALL"]
        or meta.get("HostConfig", {}).get("PidMode") not in ("", None)
        or meta.get("HostConfig", {}).get("RestartPolicy", {}).get("Name") != "no"
        or meta.get("HostConfig", {}).get("SecurityOpt") != ["no-new-privileges:true"]
        or meta.get("HostConfig", {}).get("Tmpfs") != {"/run/spire-server": "rw,nosuid,noexec,size=16m,mode=0700"}
        or meta.get("Mounts") is None
        or len(meta["Mounts"]) != 1
        or meta["Mounts"][0].get("Type") != "volume"
        or meta["Mounts"][0].get("Name") != next(name for name, path in VOLUMES.items() if path == "/var/lib/spire")
        or meta["Mounts"][0].get("Destination") != "/var/lib/spire"
        or meta["Mounts"][0].get("RW") is not True
    ):
        raise RuntimeError("Foreign recovery server refused")
    return meta


def offline_prepare(record: Path, intent: dict) -> None:
    """Explicit server-only preparation. No agent or workload socket is exposed."""
    def checkpoint(phase: str, **values) -> None:
        intent.setdefault("history", []).append({"phase": phase, "at": int(time.time())})
        intent.update(phase=phase, **values)
        save_intent(record, intent)
    if intent["phase"] == "offline_prepared":
        # The reviewed recovery build fixes directory traversal permissions
        # without granting capabilities to bypass an immutable image defect.
        build(force=True)
        image = run(["docker", "image", "inspect", IMAGE, "--format", "{{.Id}}"]).stdout.strip()
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", image):
            raise RuntimeError("Reviewed recovery image unavailable")
        checkpoint("offline_image_ready", recoveryImage=image)
    if intent["phase"] == "offline_image_ready":
        original = offline_original(intent)
        if original["State"]["Running"]:
            if run(["docker", "exec", NAME, "spire-agent", "healthcheck", "-socketPath",
                    "/run/workload/api.sock"], check=False).returncode == 0:
                raise RuntimeError("Agent recovered; offline re-attestation refused")
            run(["docker", "stop", intent["oldContainerId"]])
        original = offline_original(intent)
        if original["State"]["Running"]:
            raise RuntimeError("Original SPIRE must be stopped")
        sha, cert = public_node_certificate(NAME)
        if sha != intent["certificateSha256"] or read_node_id_from_container(NAME) != intent["oldNodeId"]:
            raise RuntimeError("Expired node proof changed before stopping")
        checkpoint("offline_helper_creating")
        helper = intent["offlineServer"]
        created = run(["docker", "create", "--name", helper["name"], "--network", "none",
            "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
            "--memory", "512m", "--pids-limit", "128", "--tmpfs", "/run/spire-server:rw,nosuid,noexec,size=16m,mode=0700", "--label", "axiom.purpose=local-spire-recovery-server",
            "--label", "axiom.recovery.owner=" + helper["nonce"], "--mount",
            "type=volume,src=" + next(name for name, path in VOLUMES.items() if path == "/var/lib/spire") + ",dst=/var/lib/spire", "--entrypoint", "spire-server",
            intent["recoveryImage"], "run", "-config", "/etc/spire/server.conf"])
        cid = created.stdout.strip()
        if not re.fullmatch(r"[a-f0-9]{64}", cid):
            raise RuntimeError("Recovery server creation outcome unknown")
        helper["id"] = cid
        checkpoint("offline_helper_created")
    if intent["phase"] == "offline_helper_creating":
        # Only the unpredictable, journalled ownership nonce can reconcile an
        # uncertain create. A colliding foreign name is never adopted or removed.
        meta = offline_helper_meta(intent)
        intent["offlineServer"]["id"] = meta["Id"]
        checkpoint("offline_helper_created")
    if intent["phase"] == "offline_helper_created":
        if offline_original(intent)["State"]["Running"]:
            raise RuntimeError("Original must remain stopped beside recovery server")
        meta = offline_helper_meta(intent)
        if not meta["State"]["Running"]:
            run(["docker", "start", meta["Id"]])
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            meta = offline_helper_meta(intent)
            if not meta["State"]["Running"]:
                raise RuntimeError("Owned recovery server exited before readiness")
            if run(["docker", "exec", meta["Id"], "spire-server", "healthcheck",
                    "-socketPath", SERVER_SOCKET], check=False).returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError("Owned recovery server did not become ready")
        current = entries(meta["Id"])
        roles = reviewed_roles(intent["oldNodeId"], current)
        children = recovery_entries(intent["oldNodeId"], current, roles)
        checkpoint("prepared", roles=roles, entries=[item for item, _, _ in children])


def reattest(resume: Path | None = None, *, expired_agent: bool = False) -> None:
    CACHE.mkdir(parents=True, exist_ok=True, mode=0o700)
    private_path(CACHE, directory=True)
    lock = CACHE / "recovery.lock"
    fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        private_path(lock)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Another explicit recovery is in progress") from None
        _reattest(resume, expired_agent=expired_agent)
    finally:
        os.close(fd)


def _reattest(resume: Path | None = None, *, expired_agent: bool = False) -> None:
    if resume is None:
        for prior in CACHE.glob("recovery-*/intent.json"):
            private_path(prior.parent, directory=True)
            private_path(prior)
            if json.loads(prior.read_text()).get("phase") != COMPLETE:
                raise RuntimeError("Unfinished recovery exists; explicitly resume its private intent")
        meta = container_meta(NAME)
        if meta is None:
            raise RuntimeError("Existing local SPIRE container required")
        stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + secrets.token_hex(6)
        backup = CACHE / ("recovery-" + stamp)
        if expired_agent:
            proof = expired_node_proof(meta)
            intent = dict(proof, schemaVersion=1, stamp=stamp,
                oldContainerId=meta["Id"], phase="offline_prepared",
                offlineServer={"name": "axiom-proof-local-spire-offline-" + stamp.lower(),
                               "nonce": secrets.token_hex(16)})
        else:
            processes = run(["docker", "top", NAME, "-eo", "pid,comm"]).stdout.splitlines()[1:]
            if any(item.split() and item.split()[-1] == "spire-agent" for item in processes):
                raise RuntimeError("Stop and investigate the existing agent before re-attestation")
            old = node_id()
            current = entries()
            roles = reviewed_roles(old, current)
            children = recovery_entries(old, current, roles)
            intent = {"schemaVersion": 1, "stamp": stamp, "oldNodeId": old,
                "oldContainerId": meta["Id"], "roles": roles,
                "entries": [item for item, _, _ in children], "phase": "prepared"}
        backup.mkdir(mode=0o700)
        record = backup / "intent.json"
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
            raise RuntimeError("Legacy journal needs explicit operator review; no token regeneration permitted")
    if intent["phase"].startswith("offline_") and intent["phase"] not in {"offline_helper_stopping", "offline_helper_removing"}:
        offline_prepare(record, intent)
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
        if "recoveryImage" in intent:
            image = intent["recoveryImage"]
            if run(["docker", "image", "inspect", image, "--format", "{{.Id}}"]).stdout.strip() != image:
                raise RuntimeError("Pinned recovery image changed")
        else:
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
        target = NAME
        if "offlineServer" in intent:
            if offline_original(intent)["State"]["Running"]:
                raise RuntimeError("Original restarted before token issuance")
            server = offline_helper_meta(intent)
            if not server["State"]["Running"]:
                raise RuntimeError("Recovery server is not running")
            observed = recovery_entries(intent["oldNodeId"], entries(server["Id"]), roles)
            if sorted((item for item, _, _ in observed), key=lambda x: x["id"]) != sorted(intent["entries"], key=lambda x: x["id"]):
                raise RuntimeError("Retained grants changed before token issuance")
            target = server["Id"]
        checkpoint("token_issuing", expiresAt=int(time.time()) + 600)
        issued = run(
            [
                "docker",
                "exec",
                target,
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
        "offline_helper_stopping",
        "offline_helper_removing",
    }
    if "offlineServer" in intent and intent["phase"] in {"token_issued", "offline_helper_stopping", "offline_helper_removing"}:
        if offline_original(intent)["State"]["Running"]:
            raise RuntimeError("Original restarted during offline recovery")
        if intent["phase"] == "token_issued":
            checkpoint("offline_helper_stopping")
        if intent["phase"] == "offline_helper_stopping":
            server = offline_helper_meta(intent)
            if server["State"]["Running"]:
                run(["docker", "stop", server["Id"]])
            if offline_helper_meta(intent)["State"]["Running"]:
                raise RuntimeError("Recovery server stop unconfirmed")
            checkpoint("offline_helper_removing")
        if intent["phase"] == "offline_helper_removing":
            server = offline_helper_meta(intent, allow_missing=True)
            if server is not None:
                if server["State"]["Running"]:
                    raise RuntimeError("Recovery server unexpectedly restarted")
                run(["docker", "rm", server["Id"]])
            if offline_helper_meta(intent, allow_missing=True) is not None:
                raise RuntimeError("Recovery server removal unconfirmed")
            checkpoint("node_stopped", offlineHelperRemoved=True)
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
                "type=volume,src=" + next(name for name, target in VOLUMES.items() if target == "/var/lib/spire") + ",dst=/var/lib/spire",
                "--mount",
                "type=volume,src=" + next(name for name, target in VOLUMES.items() if target == "/run/spire-health") + ",dst=/run/spire-health",
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
        "register-karya": lambda: register(karya_only=True),
        "status": status,
        "down": down,
        "migrate-parikshan-uid": migrate_parikshan_uid,
        "reattest": reattest,
    }
    if sys.argv[1:] == ["reattest", "--expired-agent"]:
        try:
            reattest(expired_agent=True)
        except (Exception, KeyboardInterrupt):  # never expose retained node/token diagnostics
            raise SystemExit("Expired local SPIRE recovery refused; retain the private journal for review") from None
        raise SystemExit(0)
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
