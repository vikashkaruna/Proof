#!/usr/bin/env python3
"""Default-off local synthetic enrollment operator. No independent mint authority.

The protected host administrator polls the pinned BFF over private stdin into
that exact running container. Preflight performs read-only inspection. A future
installation action must first obtain its exact recorded signed authorization;
uncertain provider effects are retained and must never be automatically retried.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import subprocess  # nosec B404 - fixed argv, no shell and no credential argv
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HOST_SOURCES = (
    "scripts/local-owned-deployment.py",
    "scripts/local-owned-execution-controller.py",
    "scripts/local-spire.py",
    "scripts/lib/ci_fixture_images.py",
    "scripts/lib/spire_deployment.py",
    "infra/workload/spire_health.py",
    "infra/workload/spire_recovery.py",
    "infra/credential-issuer/issuer.py",
    "infra/credential-issuer/owned_target.py",
)
MAX_PRIVATE_BYTES = 131072
# Fixed code only. The existing transport bearer and request travel through
# private stdin, never argv/env/logs; stdout stays private captured metadata.
BFF_REQUEST = r"""
let input='';
for await (const part of process.stdin) {input+=part;if(Buffer.byteLength(input)>131072)throw Error('refused');}
const value=JSON.parse(input);
const allowed=/^\/internal\/owned-deployments\/(?:tasks\/claim|tasks\/[a-f0-9-]{36}\/(?:preflight|authorize|confirm|unconfirmed)|credentials\/(?:authorize|complete|renew))$/;
if(!Number.isInteger(value.port)||value.port<1||value.port>65535||
 !allowed.test(value.path)) throw Error('refused');
const response=await fetch('http://127.0.0.1:'+value.port+value.path,{
 method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
 headers:{'content-type':'application/json','x-axiom-local-operator':value.credential},body:JSON.stringify(value.body)});
let output='';for await(const part of response.body){output+=new TextDecoder().decode(part);if(Buffer.byteLength(output)>65536)throw Error('refused');}
if(!response.ok)throw Error('operator request refused');
JSON.parse(output);process.stdout.write(output);
"""


def canonical(value: object) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode()


def pairs(values: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in values:
        if key in result:
            raise ValueError("Duplicate protected JSON refused")
        result[key] = value
    return result


def parse_json(value: bytes) -> object:
    if not 0 < len(value) <= MAX_PRIVATE_BYTES:
        raise ValueError("Protected JSON refused")
    return json.loads(value.decode("utf-8", errors="strict"), object_pairs_hook=pairs)


def protected_bytes(path: Path, *, source: bool = False) -> bytes:
    if not path.is_absolute() or path.resolve(strict=True) != path:
        raise ValueError("Protected operator file refused")
    for directory in (path.parent, *path.parent.parents):
        info = directory.lstat()
        sticky_root = info.st_uid == 0 and bool(info.st_mode & stat.S_ISVTX)
        if (
            not stat.S_ISDIR(info.st_mode)
            or info.st_uid not in (0, os.getuid())
            or info.st_mode & 0o022
            and not sticky_root
        ):
            raise ValueError("Protected operator directory refused")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid not in (0, os.getuid())
            or info.st_mode & (0o022 if source else 0o077)
            or not 0 < info.st_size <= MAX_PRIVATE_BYTES
        ):
            raise ValueError("Protected operator file refused")
        value = os.read(descriptor, info.st_size + 1)
        if len(value) != info.st_size:
            raise ValueError("Protected operator file changed")
        return value
    finally:
        os.close(descriptor)


def host_source_sha256(root: Path = ROOT) -> str:
    return hashlib.sha256(
        canonical(
            {
                name: hashlib.sha256(
                    protected_bytes(root / name, source=True)
                ).hexdigest()
                for name in HOST_SOURCES
            }
        )
    ).hexdigest()


def run(
    arguments: list[str],
    *,
    private_input: str | None = None,
    deadline: float | None = None,
):
    remaining = 30.0 if deadline is None else min(30.0, deadline - time.monotonic())
    if remaining <= 0:
        raise ValueError("Protected operator deadline elapsed")
    return subprocess.run(
        arguments,
        check=True,
        capture_output=True,
        text=True,
        input=private_input,
        timeout=remaining,
    )


def image_id(value: object) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", value):
        raise ValueError("Pinned deployment image refused")
    return value


def bff_container(configuration: dict, *, deadline: float | None = None) -> str:
    name = configuration.get("bffContainer")
    if not isinstance(name, str) or not re.fullmatch(
        r"axiom-proof(?:-local)?-(?:bff|api)(?:-[a-z0-9]{1,12})?", name
    ):
        raise ValueError("Owned BFF container refused")
    pinned_id = configuration.get("bffContainerId")
    if not isinstance(pinned_id, str) or not re.fullmatch(r"[a-f0-9]{64}", pinned_id):
        raise ValueError("Pinned BFF container identity refused")
    expected = image_id(configuration.get("bffImage"))
    info = json.loads(run(["docker", "inspect", name], deadline=deadline).stdout)
    if len(info) != 1:
        raise ValueError("Owned BFF container refused")
    actual = info[0]
    container_id = actual.get("Id", "")
    if (
        not re.fullmatch(r"[a-f0-9]{64}", container_id)
        or container_id != pinned_id
        or actual.get("Image") != expected
        or actual.get("State", {}).get("Running") is not True
        or actual.get("Config", {}).get("Labels", {}).get("com.docker.compose.service")
        != "bff"
    ):
        raise ValueError("Owned BFF container refused")
    return container_id


def operator_request(configuration: dict, path: str, body: dict) -> object:
    if configuration.get("enabled") is not True:
        raise ValueError("Owned deployment operator is disabled")
    if configuration.get("hostInstallerSha256") != host_source_sha256():
        raise ValueError("Reviewed host source changed")
    port = configuration.get("internalBffPort")
    if (
        type(port) is not int
        or not 1 <= port <= 65535
        or not re.fullmatch(r"/internal/owned-deployments/[a-z0-9_/-]{1,200}", path)
    ):
        raise ValueError("Private operator endpoint refused")
    filename = configuration.get("transportFile")
    if not isinstance(filename, str):
        raise TypeError("Private operator transport refused")
    credential = parse_json(protected_bytes(Path(filename)))
    if (
        not isinstance(credential, dict)
        or set(credential)
        != {"schemaVersion", "purpose", "existingOperatorAccessToken"}
        or credential.get("schemaVersion") != 1
        or credential.get("purpose") != "owned_synthetic_installer_transport"
        or not isinstance(credential.get("existingOperatorAccessToken"), str)
        or not re.fullmatch(
            r"[A-Za-z0-9._~-]{32,8192}", credential["existingOperatorAccessToken"]
        )
    ):
        raise ValueError("Private operator transport refused")
    container = bff_container(configuration)
    try:
        reply = run(
            [
                "docker",
                "exec",
                "-i",
                container,
                "node",
                "--input-type=module",
                "-e",
                BFF_REQUEST,
            ],
            private_input=canonical(
                {
                    "port": port,
                    "path": path,
                    "body": body,
                    "credential": credential["existingOperatorAccessToken"],
                }
            ).decode(),
        )
        return parse_json(reply.stdout.encode())
    except (ValueError, OSError, subprocess.SubprocessError):
        raise ValueError("Private operator request unconfirmed") from None


def readonly_host_preflight(manifest: dict, configuration: dict) -> dict:
    # Every inspection consumes one original bound; many individually bounded
    # Docker calls must not stretch a five-minute retained task indefinitely.
    deadline = time.monotonic() + 30
    return _readonly_host_preflight(manifest, configuration, deadline)


def _readonly_host_preflight(
    manifest: dict, configuration: dict, deadline: float
) -> dict:
    def inspect(arguments: list[str]):
        return run(arguments, deadline=deadline)

    if (
        manifest.get("environment") != "local"
        or manifest.get("purpose") != "owned_synthetic_enrollment_v1"
        or manifest.get("source", {}).get("hostInstallerSha256") != host_source_sha256()
        or manifest.get("deployment", {}).get("bffImage")
        != configuration.get("bffImage")
        or manifest.get("deployment", {}).get("bffContainerId")
        != configuration.get("bffContainerId")
    ):
        raise ValueError("Reviewed host source changed")
    deployment = manifest["deployment"]
    images = {}
    for field in ("controllerImage", "workerImage", "bffImage"):
        expected = image_id(deployment.get(field))
        actual = inspect(
            ["docker", "image", "inspect", expected, "--format", "{{.Id}}"]
        ).stdout.strip()
        if actual != expected:
            raise ValueError("Reviewed image unavailable")
        images[field] = actual
    workload = deployment.get("workloadApiVolume", "")
    if not re.fullmatch(r"axiom-workload-api-[a-z0-9-]{1,64}", workload):
        raise ValueError("Reviewed workload mount refused")
    volume = json.loads(inspect(["docker", "volume", "inspect", workload]).stdout)
    if len(volume) != 1 or volume[0].get("Name") != workload:
        raise ValueError("Reviewed workload mount refused")
    source = json.loads(
        inspect(["docker", "volume", "inspect", "axiom-spire-workload"]).stdout
    )
    if (
        len(source) != 1
        or source[0].get("Driver") != "local"
        or source[0].get("Labels", {}).get("axiom.purpose") != "local-spire"
    ):
        raise ValueError("Workload API source refused")
    mount = source[0].get("Mountpoint", "")
    if (
        not re.fullmatch(r"/[A-Za-z0-9_./-]+/axiom-spire-workload/_data", mount)
        or ".." in mount.split("/")
        or volume[0].get("Driver") != "local"
        or volume[0].get("Options") != {"type": "none", "o": "bind", "device": mount}
        or volume[0].get("Labels", {}).get("axiom.purpose")
        != "local-assessment-controller"
    ):
        raise ValueError("Workload API alias changed")
    container = bff_container(configuration, deadline=deadline)
    # The existing SPIRE deployment is inspected, never created/re-attested.
    node = inspect(
        ["docker", "exec", "axiom-spire", "cat", "/var/lib/spire/node-id"]
    ).stdout.strip()
    if node != deployment.get("nodeId"):
        raise ValueError("Reviewed workload parent changed")
    entries = json.loads(
        inspect(
            [
                "docker",
                "exec",
                "axiom-spire",
                "spire-server",
                "entry",
                "show",
                "-socketPath",
                "/run/spire-server/api.sock",
                "-output",
                "json",
            ]
        ).stdout
    )
    matching = [
        entry
        for entry in entries.get("entries", [])
        if entry.get("spiffe_id", {}).get("path") == "/agent/karya"
    ]
    if len(matching) > 1:
        raise ValueError("Ambiguous Karya identity refused")
    if matching:
        entry = matching[0]
        if (
            entry.get("spiffe_id", {}).get("trust_domain") != "local.axiomproof.test"
            or entry.get("parent_id", {}).get("trust_domain") != "local.axiomproof.test"
            or entry.get("parent_id", {}).get("path")
            != node.removeprefix("spiffe://local.axiomproof.test")
            or not entry.get("id")
            or entry.get("admin")
            or entry.get("downstream")
            or {
                (item.get("type"), item.get("value"))
                for item in entry.get("selectors", [])
            }
            != {("unix", "uid:20005")}
        ):
            raise ValueError("Reviewed Karya identity changed")
    return {
        "hostInstallerSha256": host_source_sha256(),
        "images": images,
        "bffContainerId": container,
        "workloadApiVolume": workload,
        "nodeId": node,
        "karyaEntries": matching,
        "persistentMutations": 0,
    }
