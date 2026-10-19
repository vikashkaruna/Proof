#!/usr/bin/env python3
"""Default-off local synthetic enrollment operator. No independent mint authority.

The protected host administrator polls the pinned BFF over private stdin into
that exact running container. Preflight performs read-only inspection. Every
installation action first obtains its exact recorded signed authorization;
uncertain provider effects are retained and must never be automatically retried.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import fcntl
import hashlib
import importlib.util
import json
import os
import re
import stat
import subprocess  # nosec B404  # fixed argv, no shell and no credential argv
import time
import uuid
from datetime import datetime
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
const allowed=/^\/internal\/owned-deployments\/(?:tasks\/(?:claim|read)|tasks\/[a-f0-9-]{36}\/(?:preflight|authorize|confirm|unconfirmed)|credentials\/(?:authorize|complete|renew))$/;
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
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


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


def protected_ancestors(path: Path) -> None:
    if not path.is_absolute() or path.resolve(strict=True) != path:
        raise ValueError("Protected operator file refused")
    for directory in (path.parent, *path.parent.parents):
        info = directory.lstat()
        sticky_root = info.st_uid == 0 and bool(info.st_mode & stat.S_ISVTX)
        if (
            not stat.S_ISDIR(info.st_mode)
            or info.st_uid not in (0, os.getuid())
            or (info.st_mode & 0o022 and not sticky_root)
        ):
            raise ValueError("Protected operator directory refused")


def protected_bytes(path: Path, *, source: bool = False) -> bytes:
    protected_ancestors(path)
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
                name: hashlib.sha256(protected_bytes(root / name, source=True)).hexdigest()
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
    return subprocess.run(  # nosec B603  # owned deployment/identity selectors and fixed CLI list argv
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
        or actual.get("Config", {}).get("Labels", {}).get("com.docker.compose.service") != "bff"
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
        or set(credential) != {"schemaVersion", "purpose", "existingOperatorAccessToken"}
        or type(credential.get("schemaVersion")) is not int
        or credential.get("schemaVersion") != 1
        or credential.get("purpose") != "owned_synthetic_installer_transport"
        or not isinstance(credential.get("existingOperatorAccessToken"), str)
        or not re.fullmatch(r"[A-Za-z0-9._~-]{32,8192}", credential["existingOperatorAccessToken"])
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


def _readonly_host_preflight(manifest: dict, configuration: dict, deadline: float) -> dict:
    def inspect(arguments: list[str]):
        return run(arguments, deadline=deadline)

    if (
        manifest.get("environment") != "local"
        or manifest.get("purpose") != "owned_synthetic_enrollment_v1"
        or manifest.get("source", {}).get("hostInstallerSha256") != host_source_sha256()
        or manifest.get("deployment", {}).get("dockerGid") != configuration.get("dockerGid")
        or manifest.get("deployment", {}).get("brokerPort") != configuration.get("internalBffPort")
        or manifest.get("deployment", {}).get("bffImage") != configuration.get("bffImage")
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
    source = json.loads(inspect(["docker", "volume", "inspect", "axiom-spire-workload"]).stdout)
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
        or volume[0].get("Labels", {}).get("axiom.purpose") != "local-assessment-controller"
    ):
        raise ValueError("Workload API alias changed")
    container = bff_container(configuration, deadline=deadline)
    bff = parse_json(inspect(["docker", "inspect", container]).stdout.encode())[0]
    environment = bff.get("Config", {}).get("Env", [])
    configured_root = [
        v for v in environment if v.startswith("AXIOM_OWNED_TARGET_CREDENTIAL_DIRECTORY=")
    ]
    mounts = bff.get("Mounts", [])
    if configured_root != ["AXIOM_OWNED_TARGET_CREDENTIAL_DIRECTORY=" + CREDENTIAL_ROOT] or not any(
        m.get("Type") == "volume"
        and m.get("Name") == deployment["controllerName"] + "-socket"
        and m.get("Destination") == "/run/axiom-proof-local-owned-execution"
        and m.get("RW") is False
        for m in mounts
    ):
        raise ValueError("Pinned BFF credential/socket prerequisites unavailable")
    credential_root = parse_json(
        inspect(
            ["docker", "exec", container, "node", "--input-type=module", "-e", BFF_ROOT]
        ).stdout.encode()
    )
    runtime_name = configuration.get("runtimeContainer")
    if not isinstance(runtime_name, str) or not re.fullmatch(
        r"axiom-proof(?:-local)?-agent-runtime(?:-[a-z0-9]{1,12})?", runtime_name
    ):
        raise ValueError("Owned execution runtime refused")
    runtime = parse_json(inspect(["docker", "inspect", runtime_name]).stdout.encode())
    if not isinstance(runtime, list) or len(runtime) != 1:
        raise ValueError("Owned execution runtime refused")
    runtime = runtime[0]
    runtime_env = runtime.get("Config", {}).get("Env", [])
    socket_volume = deployment["controllerName"] + "-socket"
    if (
        not re.fullmatch(r"[a-f0-9]{64}", runtime.get("Id", ""))
        or not re.fullmatch(r"sha256:[a-f0-9]{64}", runtime.get("Image", ""))
        or runtime.get("State", {}).get("Running") is not True
        or runtime.get("Config", {}).get("Labels", {}).get("com.docker.compose.service")
        != "agent-runtime"
        or "20113" not in runtime.get("HostConfig", {}).get("GroupAdd", [])
        or [e for e in runtime_env if e.startswith("AXIOM_OWNED_EXECUTION_ENABLED=")]
        != ["AXIOM_OWNED_EXECUTION_ENABLED=true"]
        or [e for e in runtime_env if e.startswith("AXIOM_OWNED_EXECUTION_SOCKET=")]
        != [
            "AXIOM_OWNED_EXECUTION_SOCKET=/run/axiom-proof-local-owned-execution/owned-execution.sock"
        ]
        or not any(
            m.get("Type") == "volume"
            and m.get("Name") == socket_volume
            and m.get("Destination") == "/run/axiom-proof-local-owned-execution"
            and m.get("RW") is False
            for m in runtime.get("Mounts", [])
        )
    ):
        raise ValueError("Owned execution runtime prerequisites unavailable")
    runtime_observation = {
        "containerId": runtime["Id"],
        "image": runtime["Image"],
        "socketVolume": socket_volume,
        "socketGroup": 20113,
        "adapterEnabled": True,
    }
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
            or {(item.get("type"), item.get("value")) for item in entry.get("selectors", [])}
            != {("unix", "uid:20005")}
        ):
            raise ValueError("Reviewed Karya identity changed")
    return {
        "hostInstallerSha256": host_source_sha256(),
        "runtime": runtime_observation,
        "controller": controller_observation(configuration, manifest, deadline=deadline),
        "credentialRoot": credential_root,
        "images": images,
        "bffContainerId": container,
        "workloadApiVolume": workload,
        "nodeId": node,
        "karyaIdentity": None
        if not matching
        else {
            "entryId": matching[0]["id"],
            "spiffeId": "spiffe://local.axiomproof.test/agent/karya",
            "parentId": node,
            "workerUid": 20005,
        },
        "persistentMutations": 0,
    }


STEPS = (
    "enroll_synthetic_resource",
    "authorize_role_switch",
    "publish_scoped_credential",
    "register_karya_identity",
    "stage_owned_controller",
    "verify_installed_scope",
)
CREDENTIAL_ROOT = "/var/lib/axiom/owned-target-credentials"
# A fixed, root-owned BFF destination; no arbitrary file path or shell command.
# The protected credential travels only in private stdin, never argv/env/stdout.
BFF_PUBLISH = r"""
import fs from 'node:fs';import crypto from 'node:crypto';
let raw='';for await(const p of process.stdin){raw+=p;if(Buffer.byteLength(raw)>32768)throw Error('refused');}
const x=JSON.parse(raw),root='/var/lib/axiom/owned-target-credentials';
if(process.getuid()!==0||process.env.AXIOM_OWNED_TARGET_CREDENTIAL_DIRECTORY!==root||
 !/^[a-f0-9-]{36}$/.test(x.bindingId)||!/^[a-f0-9-]{36}$/.test(x.credentialId)||
 !/^[a-f0-9]{64}$/.test(x.sha256))throw Error('refused');
const data=Buffer.from(x.base64,'base64');
if(data.length>16384||crypto.createHash('sha256').update(data).digest('hex')!==x.sha256)throw Error('refused');
const object=JSON.parse(data.toString('utf8'));
if(object.bindingId!==x.bindingId||object.credentialId!==x.credentialId)throw Error('refused');
for(const path of ['/var','/var/lib','/var/lib/axiom',root,root+'/'+x.bindingId,root+'/'+x.bindingId+'/'+x.credentialId]){
 if(!fs.existsSync(path)){fs.mkdirSync(path,{mode:0o700});}
 const st=fs.lstatSync(path);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==0||(st.mode&0o022))throw Error('refused');
}
const path=root+'/'+x.bindingId+'/'+x.credentialId+'/backend.key';
try{const fd=fs.openSync(path,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
 try{fs.writeFileSync(fd,data);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
catch(e){if(e.code!=='EEXIST')throw e;}
const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
try{const st=fs.fstatSync(fd);if(!st.isFile()||st.uid!==0||(st.mode&0o077)||st.size!==data.length)throw Error('refused');
 if(crypto.createHash('sha256').update(fs.readFileSync(fd)).digest('hex')!==x.sha256)throw Error('refused');}
finally{fs.closeSync(fd);data.fill(0);}
const directory=fs.openSync(root+'/'+x.bindingId+'/'+x.credentialId,fs.constants.O_RDONLY);try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
process.stdout.write(JSON.stringify({credentialId:x.credentialId,credentialSha256:x.sha256,filePublished:true}));
"""
BFF_CONFIGURATION = r"""
import fs from 'node:fs';import crypto from 'node:crypto';
let raw='';for await(const part of process.stdin){raw+=part;if(Buffer.byteLength(raw)>131072)throw Error('refused');}
const x=JSON.parse(raw),root='/etc/axiom/owned-deployment';if(process.getuid()!==0)throw Error('refused');
for(const directory of ['/etc/axiom',root]){if(!fs.existsSync(directory))fs.mkdirSync(directory,{mode:0o700});const st=fs.lstatSync(directory);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==0||(st.mode&0o022)||(directory===root&&(st.mode&0o777)!==0o700))throw Error('refused');}
if(fs.readdirSync(root).some(name=>!['manifests.json','transport.json'].includes(name)))throw Error('refused');
const result={};for(const name of ['manifests.json','transport.json']){
 const entry=x[name],bytes=Buffer.from(entry.base64,'base64');if(bytes.length>65536||crypto.createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw Error('refused');JSON.parse(bytes.toString('utf8'));
 const target=root+'/'+name;
 try{const fd=fs.openSync(target,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
 catch(error){if(error.code!=='EEXIST')throw error;}
 const fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const st=fs.fstatSync(fd);if(!st.isFile()||st.uid!==0||(st.mode&0o777)!==0o600||st.size!==bytes.length||crypto.createHash('sha256').update(fs.readFileSync(fd)).digest('hex')!==entry.sha256)throw Error('refused');}finally{fs.closeSync(fd);bytes.fill(0);}
 result[name]=entry.sha256;
}
const fd=fs.openSync(root,fs.constants.O_RDONLY);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}process.stdout.write(JSON.stringify(result));
"""
CONTROLLER_CONFIGURATION = r"""
import fs from 'node:fs';
const fd=fs.openSync('/etc/axiom/owned-execution-controller/config.json',fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
try{const st=fs.fstatSync(fd);if(!st.isFile()||st.uid!==20106||(st.mode&0o777)!==0o600||st.size<1||st.size>32768)throw Error('refused');process.stdout.write(JSON.stringify({base64:fs.readFileSync(fd).toString('base64')}));}finally{fs.closeSync(fd);}
"""
BFF_ROOT = r"""
import fs from 'node:fs';
const path='/var/lib/axiom/owned-target-credentials';const st=fs.lstatSync(path);
if(process.getuid()!==0||!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&0o777)!==0o700)throw Error('refused');
process.stdout.write(JSON.stringify({path,ownerUid:0,mode:'0700',storage:'container_layer'}));
"""
BFF_SOCKET = r"""
import fs from 'node:fs';
const socket='/run/axiom-proof-local-owned-execution/owned-execution.sock';
const st=fs.lstatSync(socket);if(!st.isSocket()||st.uid!==20106||st.gid!==20113||(st.mode&0o777)!==0o660)throw Error('refused');
process.stdout.write('{"socketReady":true}');
"""


def identifier(value: object) -> str:
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError("Owned operation identifier refused")
    return value


def write_private(path: Path, value: object, *, exclusive: bool = False) -> None:
    data = canonical(value) + b"\n"
    temporary = path if exclusive else path.with_name(path.name + "." + uuid.uuid4().hex)
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if not exclusive:
            os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if not exclusive and temporary.exists():
            temporary.unlink()


def owned_directory(path: Path, *, create: bool = False) -> None:
    if not path.is_absolute() or path.resolve() != path:
        raise ValueError("Owned journal directory refused")
    if create:
        path.mkdir(mode=0o700)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("Owned journal directory refused")
    # Reuse the ancestor checks without trusting an arbitrary marker name.
    marker = path / "owner.json"
    expected = {
        "purpose": "axiom-proof-local-owned-deployment",
        "ownerUid": os.getuid(),
    }
    if create:
        write_private(marker, expected, exclusive=True)
    if parse_json(protected_bytes(marker)) != expected:
        raise ValueError("Foreign journal ownership refused")


@contextlib.contextmanager
def journal_lock(directory: Path):
    owned_directory(directory)
    descriptor = os.open(directory / "operator.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("Operator lock refused")
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(descriptor)


def load_configuration(path: Path) -> dict:
    value = parse_json(protected_bytes(path))
    required = {
        "schemaVersion",
        "enabled",
        "bffContainer",
        "bffContainerId",
        "bffImage",
        "hostInstallerSha256",
        "internalBffPort",
        "transportFile",
        "stateDirectory",
        "issuerConfigurationFile",
        "pythonExecutable",
        "dockerGid",
        "runtimeContainer",
        "manifestRegistryFile",
    }
    if (
        not isinstance(value, dict)
        or set(value) != required
        or type(value.get("schemaVersion")) is not int
        or value.get("schemaVersion") != 1
    ):
        raise ValueError("Protected host configuration refused")
    if value.get("enabled") is not True or value.get("hostInstallerSha256") != host_source_sha256():
        raise ValueError("Reviewed host operator is disabled or changed")
    if type(value["dockerGid"]) is not int or not 0 <= value["dockerGid"] <= 2147483647:
        raise ValueError("Reviewed Docker group refused")
    for key in (
        "transportFile",
        "issuerConfigurationFile",
        "pythonExecutable",
        "manifestRegistryFile",
    ):
        if not isinstance(value[key], str):
            raise ValueError("Protected host path refused")
        path = Path(value[key])
        if key == "pythonExecutable":
            protected_ancestors(path)
            info = path.lstat()
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_uid not in (0, os.getuid())
                or info.st_mode & 0o022
                or not os.access(path, os.X_OK)
            ):
                raise ValueError("Fixed Python executable refused")
        else:
            protected_bytes(path)
    return value


def call(configuration: dict, path: str, body: dict) -> object:
    reply = operator_request(configuration, "/internal/owned-deployments/" + path, body)
    if not isinstance(reply, dict) or set(reply) != {"data"}:
        raise ValueError("Private operator response unconfirmed")
    return reply["data"]


def child(
    configuration: dict,
    script: str,
    arguments: list[str],
    *,
    controller: str | None = None,
):
    if script not in HOST_SOURCES or configuration["hostInstallerSha256"] != host_source_sha256():
        raise ValueError("Reviewed helper bundle changed")
    environment = {
        "PATH": "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",
        "HOME": str(Path.home()),
    }
    if controller is not None:
        environment["AXIOM_OWNED_EXECUTION_CONTROLLER_NAME"] = controller
    # No credentials in argv/env. Source helpers are fixed and bundle-pinned.
    return subprocess.run(  # nosec B603  # owned deployment/identity selectors and fixed CLI list argv
        [configuration["pythonExecutable"], "-I", str(ROOT / script), *arguments],
        env=environment,
        capture_output=True,
        text=True,
        timeout=180,
        check=True,
    )


def prepare_configuration(configuration: dict) -> dict:
    registry_raw = protected_bytes(Path(configuration["manifestRegistryFile"]))
    registry = parse_json(registry_raw)
    if (
        not isinstance(registry, dict)
        or set(registry) != {"schemaVersion", "manifests"}
        or type(registry["schemaVersion"]) is not int
        or registry["schemaVersion"] != 1
        or not isinstance(registry["manifests"], list)
        or not 1 <= len(registry["manifests"]) <= 32
    ):
        raise ValueError("Reviewed enrollment registry refused")
    for manifest in registry["manifests"]:
        if (
            not isinstance(manifest, dict)
            or manifest.get("purpose") != "owned_synthetic_enrollment_v1"
            or manifest.get("source", {}).get("hostInstallerSha256") != host_source_sha256()
            or manifest.get("deployment", {}).get("bffContainerId")
            != configuration["bffContainerId"]
            or manifest.get("deployment", {}).get("bffImage") != configuration["bffImage"]
        ):
            raise ValueError("Reviewed enrollment registry pins refused")
    transport_raw = protected_bytes(Path(configuration["transportFile"]))
    transport = parse_json(transport_raw)
    if (
        not isinstance(transport, dict)
        or set(transport) != {"schemaVersion", "purpose", "existingOperatorAccessToken"}
        or type(transport.get("schemaVersion")) is not int
        or transport.get("schemaVersion") != 1
        or transport.get("purpose") != "owned_synthetic_installer_transport"
        or not isinstance(transport.get("existingOperatorAccessToken"), str)
        or not re.fullmatch(r"[A-Za-z0-9._~-]{32,8192}", transport["existingOperatorAccessToken"])
    ):
        raise ValueError("Existing protected transport refused")
    payload = {
        name: {
            "base64": base64.b64encode(raw).decode(),
            "sha256": hashlib.sha256(raw).hexdigest(),
        }
        for name, raw in (
            ("manifests.json", registry_raw),
            ("transport.json", transport_raw),
        )
    }
    result = parse_json(
        run(
            [
                "docker",
                "exec",
                "-i",
                bff_container(configuration),
                "node",
                "--input-type=module",
                "-e",
                BFF_CONFIGURATION,
            ],
            private_input=canonical(payload).decode(),
        ).stdout.encode()
    )
    expected = {name: entry["sha256"] for name, entry in payload.items()}
    if result != expected:
        raise ValueError("Protected BFF configuration publication unconfirmed")
    return {"state": "prepared", "files": result}


def publish_credential(configuration: dict, scope: dict, file: Path) -> dict:
    raw = protected_bytes(file)
    candidate = parse_json(raw)
    if not isinstance(candidate, dict) or any(
        candidate.get(k) != scope[k]
        for k in ("bindingId", "credentialId", "tenantId", "enrollmentId")
    ):
        raise ValueError("Issued credential source refused")
    payload = {
        "bindingId": scope["bindingId"],
        "credentialId": scope["credentialId"],
        "sha256": hashlib.sha256(raw).hexdigest(),
        "base64": base64.b64encode(raw).decode(),
    }
    container = bff_container(configuration)
    return parse_json(
        run(
            [
                "docker",
                "exec",
                "-i",
                container,
                "node",
                "--input-type=module",
                "-e",
                BFF_PUBLISH,
            ],
            private_input=canonical(payload).decode(),
        ).stdout.encode()
    )


def expected_controller_configuration(configuration: dict, manifest: dict) -> dict:
    filename = ROOT / "scripts/local-owned-execution-controller.py"
    spec = importlib.util.spec_from_file_location("axiom_reviewed_owned_controller", filename)
    if spec is None or spec.loader is None:
        raise ValueError("Reviewed controller source unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.NAME = manifest["deployment"]["controllerName"]
    return module.configuration(
        manifest["deployment"]["workerImage"],
        manifest["deployment"]["workloadApiVolume"],
        manifest["deployment"]["brokerPort"],
    )


def existing_controller(
    configuration: dict, manifest: dict, *, deadline: float | None = None
) -> str | None:
    expected_controller_configuration(
        configuration, manifest
    )  # Validates fixed name/port/mount grammar.
    name = manifest["deployment"]["controllerName"]
    found = run(
        [
            "docker",
            "container",
            "ls",
            "-a",
            "--no-trunc",
            "--filter",
            "name=^/" + re.escape(name) + "$",
            "--format",
            "{{.ID}}",
        ],
        deadline=deadline,
    ).stdout.strip()
    if not found:
        return None
    if not re.fullmatch(r"[a-f0-9]{64}", found):
        raise ValueError("Ambiguous owned controller refused")
    return found


def controller_proof(
    configuration: dict, manifest: dict, *, deadline: float | None = None
) -> tuple[dict, str]:
    deployment = manifest["deployment"]
    container = existing_controller(configuration, manifest, deadline=deadline)
    if container is None:
        raise ValueError("Owned controller unavailable")
    actual = parse_json(run(["docker", "inspect", container], deadline=deadline).stdout.encode())
    if not isinstance(actual, list) or len(actual) != 1:
        raise ValueError("Owned controller readback refused")
    info = actual[0]
    host = info.get("HostConfig", {})
    config = info.get("Config", {})
    daemon_mounts = [
        mount
        for mount in info.get("Mounts", [])
        if mount.get("Type") == "bind" and mount.get("Destination") == "/var/run/docker.sock"
    ]
    if len(daemon_mounts) != 1 or daemon_mounts[0].get("Source") not in {
        "/var/run/docker.sock",
        "/run/host-services/docker.proxy.sock",
    }:
        raise ValueError("Unreviewed Docker daemon socket refused")
    daemon_source = daemon_mounts[0]["Source"]
    expected_tmpfs = {"/tmp": "rw,nosuid,nodev,size=64m,mode=1777"}  # nosec B108  # container-only bounded tmpfs mount/spec, not a host temporary file
    expected_mounts = {
        (
            "volume",
            deployment["controllerName"] + "-conf",
            "/etc/axiom/owned-execution-controller",
            False,
        ),
        (
            "volume",
            deployment["controllerName"] + "-socket",
            "/run/axiom-proof-local-owned-execution",
            True,
        ),
        ("bind", daemon_source, "/var/run/docker.sock", True),
    }
    mounts = {
        (
            m.get("Type"),
            m.get("Name") if m.get("Type") == "volume" else m.get("Source"),
            m.get("Destination"),
            m.get("RW"),
        )
        for m in info.get("Mounts", [])
    }
    host_mounts = {
        (
            mount.get("Type"),
            mount.get("Source"),
            mount.get("Target"),
            not mount.get("ReadOnly", False),
        )
        for mount in host.get("Mounts", [])
    }
    if (
        info.get("Id") != container
        or info.get("Image") != deployment["controllerImage"]
        or info.get("State", {}).get("Running") is not True
        or config.get("User") != "20106:20106"
        or config.get("Labels", {}).get("axiom.purpose") != "local-owned-execution-controller"
        or config.get("Entrypoint") != ["node"]
        or config.get("Cmd")
        != [
            "--import",
            "tsx",
            "src/local-owned-execution-controller.ts",
            "/etc/axiom/owned-execution-controller/config.json",
        ]
        or host.get("NetworkMode") != "container:" + bff_container(configuration, deadline=deadline)
        or host.get("Privileged") is not False
        or host.get("ReadonlyRootfs") is not True
        or host.get("CapDrop") != ["ALL"]
        or bool(host.get("CapAdd"))
        or set(host.get("GroupAdd", [])) != {"20113", str(deployment["dockerGid"])}
        or set(host.get("SecurityOpt", [])) != {"no-new-privileges:true"}
        or host.get("PidsLimit") != 128
        or host.get("Memory") != 512 * 1024 * 1024
        or mounts != expected_mounts
        or host_mounts != expected_mounts
        or host.get("Tmpfs") != expected_tmpfs
    ):
        raise ValueError("Owned controller isolation/readback refused")
    image = parse_json(
        run(
            ["docker", "image", "inspect", deployment["controllerImage"]],
            deadline=deadline,
        ).stdout.encode()
    )
    if (
        not isinstance(image, list)
        or len(image) != 1
        or config.get("Env") != image[0].get("Config", {}).get("Env")
    ):
        raise ValueError("Owned controller inherited environment changed")
    encoded = parse_json(
        run(
            [
                "docker",
                "exec",
                "--user",
                "20106:20106",
                container,
                "node",
                "--input-type=module",
                "-e",
                CONTROLLER_CONFIGURATION,
            ],
            deadline=deadline,
        ).stdout.encode()
    )
    if (
        not isinstance(encoded, dict)
        or set(encoded) != {"base64"}
        or not isinstance(encoded["base64"], str)
    ):
        raise ValueError("Actual controller configuration unavailable")
    observed = parse_json(base64.b64decode(encoded["base64"], validate=True))
    if observed != expected_controller_configuration(configuration, manifest):
        raise ValueError("Actual controller configuration changed")
    ready = parse_json(
        run(
            [
                "docker",
                "exec",
                bff_container(configuration, deadline=deadline),
                "node",
                "--input-type=module",
                "-e",
                BFF_SOCKET,
            ],
            deadline=deadline,
        ).stdout.encode()
    )
    if ready != {"socketReady": True}:
        raise ValueError("Owned controller socket unconfirmed")
    return (
        {
            "containerId": container,
            "controllerName": deployment["controllerName"],
            "controllerImage": deployment["controllerImage"],
            "workerImage": observed["container"]["image"],
            "workerUid": 20005,
            "controllerUid": 20106,
            "socketGid": 20113,
            "bffContainerId": configuration["bffContainerId"],
            "bffImage": configuration["bffImage"],
            "socketReady": True,
        },
        hashlib.sha256(
            canonical(
                {
                    "configuration": observed,
                    "daemonSocketSource": daemon_source,
                    "tmpfs": expected_tmpfs,
                }
            )
        ).hexdigest(),
    )


def controller_readback(configuration: dict, manifest: dict) -> dict:
    return controller_proof(configuration, manifest)[0]


def controller_observation(
    configuration: dict, manifest: dict, *, deadline: float | None = None
) -> dict | None:
    if existing_controller(configuration, manifest, deadline=deadline) is None:
        return None
    proof, digest = controller_proof(configuration, manifest, deadline=deadline)
    return {"containerId": proof["containerId"], "configurationSha256": digest}


def fixed_effect(
    configuration: dict,
    configuration_file: Path,
    directory: Path,
    task: dict,
    step: str,
    authorization: dict,
    prior: dict,
) -> dict:
    manifest = task["manifest"]
    deployment = manifest["deployment"]
    if step in STEPS[:2]:
        actual = authorization.get("authorization", {})
        if (
            actual.get("state") != "confirmed"
            or actual.get("step") != step
            or not actual.get("readback")
        ):
            raise ValueError("SQL installation effect unconfirmed")
        return actual["readback"]
    if step == "publish_scoped_credential":
        scope = authorization.get("reservation")
        if not isinstance(scope, dict):
            raise ValueError("Credential reservation unconfirmed")
        request = {
            key: scope[key]
            for key in (
                "tenantId",
                "bindingId",
                "enrollmentId",
                "credentialId",
                "reservationSha256",
                "manifestSha256",
                "custodyEpoch",
                "issuerConfigurationSha256",
            )
        }
        request.update(
            schemaVersion=1,
            purpose="owned-target-credential-issue",
            hostConfigurationFile=str(configuration_file),
            hostConfigurationSha256=hashlib.sha256(protected_bytes(configuration_file)).hexdigest(),
        )
        review = directory / (scope["credentialId"] + "-request.json")
        write_private(review, request, exclusive=True)
        target = directory / (scope["credentialId"] + "-credential")
        child(
            configuration,
            "infra/credential-issuer/issuer.py",
            [
                "--owned-target",
                str(review),
                hashlib.sha256(protected_bytes(review)).hexdigest(),
                configuration["issuerConfigurationFile"],
                str(target),
            ],
        )
        return publish_credential(configuration, scope, target / "backend.key")
    if step == "register_karya_identity":
        before = readonly_host_preflight(manifest, configuration)
        if before["karyaIdentity"] is None:
            child(configuration, "scripts/local-spire.py", ["register-karya"])
        after = readonly_host_preflight(manifest, configuration)
        if after["karyaIdentity"] is None:
            raise ValueError("Karya registration unconfirmed")
        return after["karyaIdentity"]
    if step == "stage_owned_controller":
        reviewed_controller = task.get("reviewedHost", {}).get("controller")
        current_controller = controller_observation(configuration, manifest)
        if reviewed_controller is not None:
            if current_controller != reviewed_controller:
                raise ValueError("Founder-reviewed shared controller changed")
            readback, digest = controller_proof(configuration, manifest)
            if {
                "containerId": readback["containerId"],
                "configurationSha256": digest,
            } != reviewed_controller:
                raise ValueError("Founder-reviewed shared controller changed during readback")
            return readback
        if current_controller is not None:
            raise ValueError("Unreviewed controller appeared before creation")
        controller = deployment["controllerName"]
        common = [
            "--controller-image",
            deployment["controllerImage"],
            "--docker-gid",
            str(configuration["dockerGid"]),
        ]
        child(
            configuration,
            "scripts/local-owned-execution-controller.py",
            [
                "stage",
                *common,
                "--worker-image",
                deployment["workerImage"],
                "--workload-volume",
                deployment["workloadApiVolume"],
                "--broker-port",
                str(configuration["internalBffPort"]),
            ],
            controller=controller,
        )
        for command in ("check", "serve"):
            child(
                configuration,
                "scripts/local-owned-execution-controller.py",
                [
                    command,
                    *common,
                    "--bff-container-id",
                    deployment["bffContainerId"],
                    "--bff-image",
                    deployment["bffImage"],
                ],
                controller=controller,
            )
        # Observe actual socket via the BFF namespace, not a successful docker start.
        deadline = time.monotonic() + 20
        while True:
            try:
                return controller_readback(configuration, manifest)
            except (ValueError, subprocess.SubprocessError):
                if time.monotonic() >= deadline:
                    raise ValueError("Controller startup unconfirmed") from None
                time.sleep(0.25)
    if step == "verify_installed_scope":
        host = readonly_host_preflight(manifest, configuration)
        return {
            "credential": prior["publish_scoped_credential"],
            "identity": host["karyaIdentity"],
            "controller": controller_readback(configuration, manifest),
            "cryptoTransportVerified": True,
            "allSixReadBack": True,
        }
    raise ValueError("Unknown fixed deployment step")


def once(configuration_file: Path) -> str:
    configuration = load_configuration(configuration_file)
    directory = Path(configuration["stateDirectory"])
    with journal_lock(directory):
        journal = directory / "current.json"
        if journal.exists():
            state = parse_json(protected_bytes(journal))
            if (
                not isinstance(state, dict)
                or state.get("configurationSha256")
                != hashlib.sha256(protected_bytes(configuration_file)).hexdigest()
            ):
                raise ValueError("Retained operator configuration changed")
            if state.get("state") not in (
                "completed",
                "authority_revoked_with_original_effect_history",
            ):
                # Never repeat a possibly applied host mutation/issuer operation.
                raise ValueError("Retained deployment outcome requires exact readback")
            archive = directory / (identifier(state["claimId"]) + ".json")
            if "task" not in state:
                journal.unlink()  # Confirmed idle/no-effect metadata only.
            else:
                if archive.exists():
                    raise ValueError("Duplicate retained claim refused")
                os.rename(journal, archive)
        state = {
            "schemaVersion": 1,
            "claimId": str(uuid.uuid4()),
            "state": "claim_pending",
            "configurationSha256": hashlib.sha256(protected_bytes(configuration_file)).hexdigest(),
            "steps": {},
        }
        write_private(journal, state, exclusive=True)
        claimed = call(configuration, "tasks/claim", {"claimId": state["claimId"]})
        if not isinstance(claimed, dict) or claimed.get("kind") not in (
            "idle",
            "preflight",
            "installation",
        ):
            raise ValueError("Retained task claim unconfirmed")
        if claimed["kind"] == "idle":
            state["state"] = "completed"
            write_private(journal, state)
            return "idle"
        task = claimed["task"]
        if not isinstance(task, dict) or task.get("claimId") != state["claimId"]:
            raise ValueError("Retained task claim refused")
        for key in ("taskId", "tenantId", "requestId"):
            identifier(task[key])
        manifest = task["manifest"]
        if hashlib.sha256(canonical(manifest)).hexdigest() != task.get("manifestSha256"):
            raise ValueError("Retained task manifest changed")
        state.update(task=task, state="claimed")
        write_private(journal, state)
        if claimed["kind"] == "preflight":
            observation = readonly_host_preflight(manifest, configuration)
            state.update(state="publishing_observation", observation=observation)
            write_private(journal, state)
            call(
                configuration,
                "tasks/" + task["taskId"] + "/preflight",
                {"claimId": state["claimId"], "observation": observation},
            )
        else:
            readbacks = {}
            for step in STEPS:
                body = {
                    "tenantId": task["tenantId"],
                    "claimId": state["claimId"],
                    "step": step,
                }
                state.update(state="authorization_pending", step=step)
                write_private(journal, state)
                try:
                    same_reviewed_host(
                        manifest,
                        configuration,
                        task.get("reviewedHost"),
                        readbacks.get("stage_owned_controller"),
                    )
                    authorization = call(
                        configuration, "tasks/" + task["requestId"] + "/authorize", body
                    )
                    state.update(state="effect_pending")
                    state["steps"][step] = {"authorization": authorization}
                    write_private(journal, state)
                    # Every effect checks the complete reviewed source immediately
                    # before any host child/write. No signing authority in this process.
                    if host_source_sha256() != configuration["hostInstallerSha256"]:
                        raise ValueError("Reviewed source changed before effect")
                    readback = fixed_effect(
                        configuration,
                        configuration_file,
                        directory,
                        task,
                        step,
                        authorization,
                        readbacks,
                    )
                    readbacks[step] = readback
                    state.update(state="confirmation_pending")
                    state["steps"][step]["readback"] = readback
                    write_private(journal, state)
                    if step not in STEPS[:2]:
                        call(
                            configuration,
                            "tasks/" + task["requestId"] + "/confirm",
                            {**body, "readback": readback},
                        )
                    state["steps"][step]["confirmed"] = True
                    write_private(journal, state)
                except (
                    ValueError,
                    KeyError,
                    TypeError,
                    OSError,
                    subprocess.SubprocessError,
                ):
                    state["state"] = "unconfirmed"
                    write_private(journal, state)
                    # The original journal retains uncertainty even if the
                    # private publication is unavailable or scope has expired.
                    with contextlib.suppress(ValueError, OSError, subprocess.SubprocessError):
                        call(
                            configuration,
                            "tasks/" + task["requestId"] + "/unconfirmed",
                            body,
                        )
                    raise ValueError("Retained deployment step unconfirmed") from None
        state["state"] = "completed"
        write_private(journal, state)
        return "completed"


def reconcile(configuration_file: Path, selected_claim: str | None = None) -> dict:
    configuration = load_configuration(configuration_file)
    directory = Path(configuration["stateDirectory"])
    with journal_lock(directory):
        journal = directory / "current.json"
        if selected_claim is not None:
            selected_claim = identifier(selected_claim)
            current = parse_json(protected_bytes(journal)) if journal.exists() else {}
            if not isinstance(current, dict) or current.get("claimId") != selected_claim:
                journal = directory / (selected_claim + ".json")
        if not journal.exists():
            return {"state": "blocked", "detail": "No captured selected claim"}
        original_raw = protected_bytes(journal)
        state = parse_json(original_raw)
        if not isinstance(state, dict) or not isinstance(state.get("task"), dict):
            return {"state": "blocked", "detail": "Original task scope not captured"}
        task = state["task"]
        claim_id = identifier(state["claimId"])
        if selected_claim is not None and claim_id != selected_claim:
            raise ValueError("Foreign selected claim journal refused")
        receipt = call(configuration, "tasks/read", {"claimId": claim_id})
        fields = {
            "claimId",
            "kind",
            "tenantId",
            "requestId",
            "taskId",
            "manifestSha256",
            "terminal",
            "receiptId",
            "hostSha256",
            "stepReceipts",
        }
        if (
            not isinstance(receipt, dict)
            or set(receipt) != fields
            or any(
                receipt.get(key) != expected
                for key, expected in (
                    ("claimId", claim_id),
                    ("tenantId", task["tenantId"]),
                    ("requestId", task["requestId"]),
                    ("taskId", task["taskId"]),
                    ("manifestSha256", task["manifestSha256"]),
                )
            )
        ):
            raise ValueError("Foreign or missing captured task proof refused")
        terminal = receipt["terminal"]
        if not isinstance(receipt["receiptId"], str) or not re.fullmatch(
            r"[1-9][0-9]*", receipt["receiptId"]
        ):
            return {
                "state": "blocked",
                "detail": "Original outcome remains unconfirmed",
            }
        if terminal == "readonly_observation_recorded":
            if (
                receipt["kind"] != "preflight"
                or "observation" not in state
                or receipt["hostSha256"]
                != hashlib.sha256(canonical(state["observation"])).hexdigest()
            ):
                raise ValueError("Original read-only observation proof refused")
            final_state = "completed"
        elif terminal == "installation_confirmed_history":
            steps = receipt["stepReceipts"]
            if (
                receipt["kind"] != "installation"
                or not isinstance(steps, list)
                or len(steps) != 6
                or {step.get("step") for step in steps if isinstance(step, dict)} != set(STEPS)
                or any(
                    step.get("state") != "confirmed"
                    or not isinstance(step.get("receiptId"), str)
                    or not re.fullmatch(r"[1-9][0-9]*", step["receiptId"])
                    for step in steps
                )
            ):
                raise ValueError("Original six-step receipt proof refused")
            final_state = "completed"
        elif terminal == "authority_revoked_with_original_effect_history":
            if receipt["kind"] != "installation":
                raise ValueError("Original stop receipt proof refused")
            final_state = terminal
        else:
            return {
                "state": "blocked",
                "detail": "Original outcome remains unconfirmed",
            }
        pending_file = directory / ("renewal-pending-" + identifier(task["requestId"]) + ".json")
        if terminal == "authority_revoked_with_original_effect_history" and pending_file.exists():
            pending = parse_json(protected_bytes(pending_file))
            if not isinstance(pending, dict) or not isinstance(pending.get("intent"), dict):
                raise ValueError("Original renewal intent refused")
            intent = pending["intent"]
            if (
                intent.get("tenantId") != task["tenantId"]
                or intent.get("enrollmentId") != task["requestId"]
            ):
                raise ValueError("Foreign renewal scope refused")
            identifier(intent.get("credentialId"))
            renewal_evidence = directory / (
                "renewal-stopped-" + intent["credentialId"] + "-" + receipt["receiptId"] + ".json"
            )
            if renewal_evidence.exists():
                prior = parse_json(protected_bytes(renewal_evidence))
                if not isinstance(prior, dict) or prior.get("receipt") != receipt:
                    raise ValueError("Retained renewal stop proof conflict")
                if pending == prior.get("original"):
                    pending.update(state=terminal, stopReceiptId=receipt["receiptId"])
                    write_private(pending_file, pending)
                elif (
                    pending.get("state") != terminal
                    or pending.get("stopReceiptId") != receipt["receiptId"]
                ):
                    raise ValueError("Retained renewal stop proof conflict")
            else:
                write_private(
                    renewal_evidence,
                    {"original": pending, "receipt": receipt, "disposition": terminal},
                    exclusive=True,
                )
                # No issuance/mutation is retried or asserted absent. The fresh
                # scoped stop fences late authorization/issuance transactions.
                pending.update(state=terminal, stopReceiptId=receipt["receiptId"])
                write_private(pending_file, pending)

        # The original unknown journal/steps remain intact in a protected receipt.
        # Revocation proves only authority stopped; no target/no-effect or worker
        # state is inferred. No claim, authorization, token, JTI or effect retry.
        evidence = directory / ("reconciled-" + claim_id + "-" + receipt["receiptId"] + ".json")
        record = {
            "original": state,
            "originalSha256": hashlib.sha256(original_raw).hexdigest(),
            "receipt": receipt,
            "disposition": terminal,
        }
        if evidence.exists():
            retained = parse_json(protected_bytes(evidence))
            if (
                isinstance(retained, dict)
                and retained.get("receipt") == receipt
                and state.get("reconciliation")
                == {
                    "disposition": terminal,
                    "receiptId": receipt["receiptId"],
                    "originalSha256": retained.get("originalSha256"),
                }
                and state.get("state") == final_state
            ):
                return {
                    "state": final_state,
                    "disposition": terminal,
                    "receiptId": receipt["receiptId"],
                }
            if retained != record:
                raise ValueError("Retained reconciliation receipt conflict")
        else:
            write_private(evidence, record, exclusive=True)
        state.update(
            state=final_state,
            reconciliation={
                "disposition": terminal,
                "receiptId": receipt["receiptId"],
                "originalSha256": record["originalSha256"],
            },
        )
        write_private(journal, state)
        return {
            "state": final_state,
            "disposition": terminal,
            "receiptId": receipt["receiptId"],
        }


def same_reviewed_host(
    manifest: dict,
    configuration: dict,
    reviewed: object,
    created_controller: dict | None = None,
) -> None:
    fresh = readonly_host_preflight(manifest, configuration)
    if not isinstance(reviewed, dict) or any(
        fresh.get(key) != reviewed.get(key)
        for key in (
            "hostInstallerSha256",
            "images",
            "bffContainerId",
            "runtime",
            "credentialRoot",
            "nodeId",
            "workloadApiVolume",
        )
    ):
        raise ValueError("Founder-reviewed host/runtime pins changed")
    expected_controller = reviewed.get("controller")
    observed_controller = fresh.get("controller")
    if expected_controller is not None and observed_controller != expected_controller:
        raise ValueError("Founder-reviewed controller changed")
    if (
        expected_controller is None
        and observed_controller is not None
        and (
            created_controller is None
            or observed_controller.get("containerId") != created_controller.get("containerId")
        )
    ):
        raise ValueError("Unreviewed replacement controller refused")


def renew_due(configuration_file: Path, *, now: float | None = None) -> dict:
    configuration = load_configuration(configuration_file)
    directory = Path(configuration["stateDirectory"])
    outcome = {"renewed": 0, "expired": 0}
    with journal_lock(directory):
        for archive in sorted(directory.glob("*.json")):
            if archive.name in ("owner.json", "current.json") or not re.fullmatch(
                r"[a-f0-9-]{36}\.json", archive.name
            ):
                continue
            installation = parse_json(protected_bytes(archive))
            if (
                not isinstance(installation, dict)
                or installation.get("state") != "completed"
                or not installation.get("steps", {})
                .get("verify_installed_scope", {})
                .get("confirmed")
            ):
                continue
            task = installation["task"]
            request_id = identifier(task["requestId"])
            head_file = directory / ("renewal-head-" + request_id + ".json")
            pending_file = directory / ("renewal-pending-" + request_id + ".json")
            if pending_file.exists():
                raise ValueError("Retained renewal outcome requires exact readback")
            if head_file.exists():
                previous = parse_json(protected_bytes(head_file))
                scope = previous["reservation"]
            else:
                scope = installation["steps"]["publish_scoped_credential"]["authorization"][
                    "reservation"
                ]
            deadline = datetime.fromisoformat(scope["expiresAt"])
            if deadline.tzinfo is None:
                raise ValueError("Retained renewal expiry refused")
            remaining = deadline.timestamp() - (time.time() if now is None else now)
            if remaining > 300:
                continue
            if remaining <= 0:
                outcome["expired"] += 1
                # Expired tokens do not bootstrap new authority. A fresh human
                # enrollment/review is needed if the approved lifecycle lapses.
                continue
            same_reviewed_host(
                task["manifest"],
                configuration,
                task.get("reviewedHost"),
                installation["steps"].get("stage_owned_controller", {}).get("readback"),
            )
            intent = {
                "tenantId": task["tenantId"],
                "enrollmentId": request_id,
                "credentialId": str(uuid.uuid4()),
            }
            state = {
                "state": "reservation_pending",
                "intent": intent,
                "configurationSha256": hashlib.sha256(
                    protected_bytes(configuration_file)
                ).hexdigest(),
            }
            write_private(pending_file, state, exclusive=True)
            reserved = call(configuration, "credentials/renew", intent)
            if not isinstance(reserved, dict) or reserved.get("reviewedHost") != task.get(
                "reviewedHost"
            ):
                raise ValueError("Reviewed renewal source changed")
            same_reviewed_host(
                task["manifest"],
                configuration,
                reserved["reviewedHost"],
                installation["steps"].get("stage_owned_controller", {}).get("readback"),
            )
            state.update(state="effect_pending", reservation=reserved["reservation"])
            write_private(pending_file, state)
            readback = fixed_effect(
                configuration,
                configuration_file,
                directory,
                task,
                "publish_scoped_credential",
                reserved,
                {},
            )
            state.update(state="completed", readback=readback)
            write_private(pending_file, state)
            receipt = directory / ("renewal-" + identifier(intent["credentialId"]) + ".json")
            # Publish the head while pending still blocks every fresh mint.
            # A crash at any cut leaves either this blocking intent or the
            # durable new head+receipt, never the old head without a pending key.
            write_private(head_file, state)
            if receipt.exists():
                raise ValueError("Retained renewal receipt already exists")
            os.rename(pending_file, receipt)
            parent = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(parent)
            finally:
                os.close(parent)
            outcome["renewed"] += 1
    return outcome


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command",
        choices=(
            "init-state",
            "prepare-config",
            "once",
            "serve",
            "status",
            "renew-due",
            "reconcile",
        ),
    )
    parser.add_argument("configuration", type=Path)
    parser.add_argument("--interval", type=int, default=15)
    parser.add_argument(
        "--claim",
        default=None,
        help="Exact previously captured claim UUID for read-only reconciliation",
    )
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if args.claim is not None and args.command != "reconcile":
            raise ValueError("Claim selection is read-only reconciliation only")
        configuration = load_configuration(args.configuration)
        directory = Path(configuration["stateDirectory"])
        if args.command == "init-state":
            owned_directory(directory, create=True)
        elif args.command == "reconcile":
            print(json.dumps(reconcile(args.configuration, args.claim)))
        elif args.command == "prepare-config":
            print(json.dumps(prepare_configuration(configuration)))
        elif args.command == "renew-due":
            print(json.dumps(renew_due(args.configuration)))
        elif args.command == "status":
            owned_directory(directory)
            retained = directory / "current.json"
            state = parse_json(protected_bytes(retained)) if retained.exists() else {}
            print(json.dumps({"state": state.get("state", "idle"), "sourceMatches": True}))
        else:
            if not 5 <= args.interval <= 300:
                raise ValueError("Polling bound refused")
            while True:
                # Renew first so a busy queue cannot consume the final lifetime.
                renewal = renew_due(args.configuration)
                outcome = once(args.configuration)
                print(json.dumps({"state": outcome, "renewal": renewal}), flush=True)
                if args.command == "once":
                    break
                time.sleep(args.interval)
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError):
        raise SystemExit(
            "Owned deployment unconfirmed or refused; retained intent requires exact readback before retry."
        ) from None


if __name__ == "__main__":
    main()
