#!/usr/bin/env python3
"""Protected per-tenant LOCAL controller, issuer and scheduler composition.

prepare-issuer derives strict controller-issuer settings from an already reviewed
local-custody issuer. issue/renew-due invoke the unchanged protected issuer; no
credential is minted here. stage/check/serve compose an existing reviewed Docker
controller image (Dockerfile.bff assessment-controller target), worker image and
one dedicated Temporal namespace per tenant. No authority or image is synthesized.
"""

from __future__ import annotations

import argparse
import configparser
import hashlib
import importlib.util
import io
import json
import os
import re
import subprocess  # nosec B404
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from lib.ci_fixture_images import fixture_image
from lib.local_controller_runtime import (
    SCHEDULER_UID,
    SOCKET_GROUP,
    TENANTS,
    UID,
    WORKLOAD_ALIAS,
    alias_options,
    build_configuration,
    canonical,
    identifier,
    issue_request,
    renewal_due,
)
from lib.local_tenant_registry import scheduler_port

BASE = Path(
    os.environ.get(
        "AXIOM_LOCAL_CONTROLLER_DIR",
        ROOT / ".axiom-runtime/local-assessment-controller",
    )
)
CUSTODY = Path(
    os.environ.get(
        "AXIOM_LOCAL_CUSTODY_ISSUER_DIR", ROOT / ".axiom-runtime/local-custody-issuer"
    )
)
CONF = "/etc/axiom/assessment-controller"
SOCKET = "/run/assessment-controller"
PURPOSE = "local-assessment-controller"
HELPER = fixture_image(
    "alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8"
)


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ValueError("Protected implementation unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


issuer = load_module(
    "axiom_protected_controller_issuer", ROOT / "infra/credential-issuer/issuer.py"
)


def run(args: list[str], check: bool = True, **kwargs):
    return subprocess.run(
        args, text=True, capture_output=True, check=check, timeout=300, **kwargs
    )  # nosec B603 B607


def private_directory(path: Path):
    issuer.ancestry(path.parent)
    path.mkdir(mode=0o700, exist_ok=True)
    if (
        path.is_symlink()
        or path.stat().st_uid != os.geteuid()
        or path.stat().st_mode & 0o777 != 0o700
    ):
        raise ValueError("Protected directory refused")


def atomic(path: Path, data: bytes):
    issuer.ancestry(path.parent)
    temporary = path.with_name("." + path.name + "." + str(time.time_ns()))
    issuer.create(temporary, data)
    os.replace(temporary, path)
    issuer.sync(path.parent)


def prepare_issuer(source: Path, expected: str):
    custody = load_module(
        "axiom_existing_custody_issuer", ROOT / "infra/local-custody-issuer/issuer.py"
    )
    original = custody.configuration(source, expected)
    private_directory(BASE)
    settings = {key: value for key, value in original.items() if key != "version"}
    settings["schemaVersion"] = 1
    ini = configparser.ConfigParser(interpolation=None, strict=True)
    ini.read_string(custody.source(original["service"]).decode())
    fields = dict(ini[custody.SERVICE])
    renamed = configparser.ConfigParser(interpolation=None)
    renamed[issuer.SERVICE] = fields
    stream = io.StringIO()
    # libpq service files reject spaces in option names before '='. Python's
    # ConfigParser default renders those spaces and cannot be used verbatim.
    renamed.write(stream, space_around_delimiters=False)
    service_path = BASE / "controller-db.service"
    if service_path.exists() or (BASE / "settings.json").exists():
        raise ValueError("Issuer settings already exist; review them in place")
    raw_service = stream.getvalue().encode()
    issuer.create(service_path, raw_service)
    settings["service"] = {
        "path": str(service_path),
        "sha256": hashlib.sha256(raw_service).hexdigest(),
    }
    raw = canonical(settings)
    issuer.create(BASE / "settings.json", raw)
    digest = hashlib.sha256(raw).hexdigest()
    issuer.configuration(BASE / "settings.json", digest)
    issuer.create(BASE / "settings.sha256", (digest + "\n").encode())
    print(
        "Dedicated controller issuer settings prepared; scoped issuer DB membership must pass check-issuer before issue."
    )


def settings():
    digest = issuer.read(BASE / "settings.sha256").decode().strip()
    return issuer.configuration(BASE / "settings.json", digest), digest


def check_issuer():
    config, _ = settings()
    env = {
        "PATH": "/usr/bin:/bin",
        "HOME": "/nonexistent",
        "LC_ALL": "C",
        "PGSERVICEFILE": config["service"]["path"],
        "PGSYSCONFDIR": "/nonexistent",
        "PGPASSFILE": "/nonexistent",
        "PGGSSENCMODE": "disable",
    }
    result = run(
        [
            config["psql"],
            "-X",
            "-qAt",
            "-w",
            "-v",
            "ON_ERROR_STOP=1",
            "--dbname=service=" + issuer.SERVICE,
        ],
        env=env,
        input="begin read only; select pg_has_role(session_user,'axiom_controller_issuer','SET') and exists(select 1 from pg_roles where rolname=session_user and rolcanlogin and not(rolsuper or rolinherit or rolcreaterole or rolcreatedb or rolreplication or rolbypassrls)); rollback;",
    )
    if result.stdout.strip() != "t":
        raise ValueError("Dedicated issuer membership unavailable")
    print("Protected TLS controller issuer membership verified read-only.")


def issue(
    slug: str,
    approval_reference: str | None,
    renew: bool = False,
    resume: str | None = None,
):
    _, digest = settings()
    private_directory(BASE / slug)
    private_directory(BASE / slug / "credentials")
    directory = BASE / slug / "credentials"
    previous = (
        json.loads(issuer.read(directory / "current.json"))
        if (directory / "current.json").exists()
        else None
    )
    pending_path = directory / "pending.json"
    pending = json.loads(issuer.read(pending_path)) if pending_path.exists() else None
    if pending and pending["credentialId"] != resume:
        raise ValueError(
            "Uncertain issuance retained; resume the same request explicitly"
        )
    if resume:
        if pending is None:
            raise ValueError("No unresolved issuance to resume")
        credential_id = identifier(resume)
        raw = issuer.read(directory / (credential_id + ".request.json"), 4096)
        request = issuer.request(raw, hashlib.sha256(raw).hexdigest(), "issue")
        if (
            request["tenantId"] != TENANTS[slug][0]
            or request["configurationSha256"] != digest
        ):
            raise ValueError("Resumed request scope refused")
    else:
        if renew:
            if previous is None:
                raise ValueError("No predecessor to renew")
            renewal_due(previous, int(time.time()))
        approval = approval_reference or (
            previous["approvalReference"] if renew and previous else None
        )
        if approval is None:
            raise ValueError("Recorded approval reference required")
        raw, _ = issue_request(
            TENANTS[slug][0],
            digest,
            approval,
            int(time.time()) - 5,
            previous["credentialId"] if renew else None,
        )
        request = json.loads(raw)
        credential_id = request["credentialId"]
        issuer.create(directory / (credential_id + ".request.json"), raw)
    request_sha = hashlib.sha256(raw).hexdigest()
    target = directory / credential_id
    if pending is None:
        issuer.create(
            pending_path,
            canonical({"credentialId": credential_id, "requestSha256": request_sha}),
        )
    elif pending["requestSha256"] != request_sha:
        raise ValueError("Retained request changed")
    # No new request on uncertainty: resume the exact retained request explicitly.
    run(
        [
            sys.executable,
            "-I",
            str(ROOT / "infra/credential-issuer/issuer.py"),
            "--resume-issue" if resume else "--issue",
            str(directory / (credential_id + ".request.json")),
            request_sha,
            str(BASE / "settings.json"),
            str(target),
        ]
    )
    ready = issuer.checked_receipt(json.loads(issuer.read(target / "ready.json")))
    if (
        any(
            ready[key] != request[key]
            for key in (
                "credentialId",
                "tenantId",
                "predecessorId",
                "issuedAt",
                "expiresAt",
            )
        )
        or ready["requestSha256"] != request_sha
        or ready["status"] != "active"
    ):
        raise ValueError("Issuance receipt refused")
    credential = issuer.read(target / "backend.key")
    atomic(directory / "backend.key", credential)
    atomic(directory / "current.json", raw)
    pending_path.unlink()
    issuer.sync(directory)
    print("Protected tenant-scoped controller credential published.")


def name(slug: str):
    if slug not in TENANTS:
        raise ValueError("Tenant refused")
    return "axiom-assessment-controller-" + slug


def remove_owned(container: str):
    allowed = {
        name(slug) + suffix
        for slug in TENANTS
        for suffix in ("", "-stage", "-scheduler")
    }
    if container not in allowed:
        raise ValueError("Foreign container refused")
    result = run(["docker", "inspect", container], check=False)
    if result.returncode == 0:
        info = json.loads(result.stdout)[0]
        if info.get("Config", {}).get("Labels", {}).get("axiom.purpose") != PURPOSE:
            raise ValueError("Foreign container refused")
        if container.endswith("-stage"):
            run(["docker", "rm", "-f", container])
        else:
            run(["docker", "stop", "--time", "95", container])
            run(["docker", "rm", container])


def ensure_volume(volume: str):
    existing = run(["docker", "volume", "inspect", volume], check=False)
    if existing.returncode == 0:
        if (
            json.loads(existing.stdout)[0].get("Labels", {}).get("axiom.purpose")
            != PURPOSE
        ):
            raise ValueError("Foreign volume refused")
    else:
        run(
            [
                "docker",
                "volume",
                "create",
                "--label",
                f"axiom.purpose={PURPOSE}",
                volume,
            ]
        )


def provision_workload_alias():
    source = json.loads(
        run(["docker", "volume", "inspect", "axiom-spire-workload"]).stdout
    )[0]
    wanted = alias_options(source)
    found = run(["docker", "volume", "inspect", WORKLOAD_ALIAS], check=False)
    if found.returncode == 0:
        existing = json.loads(found.stdout)[0]
        if (
            existing.get("Driver") != "local"
            or existing.get("Options") != wanted
            or existing.get("Labels", {}).get("axiom.purpose") != PURPOSE
        ):
            raise ValueError("Workload API alias changed")
    else:
        run(
            [
                "docker",
                "volume",
                "create",
                "--driver",
                "local",
                "--label",
                f"axiom.purpose={PURPOSE}",
                *[
                    arg
                    for key, value in wanted.items()
                    for arg in ("--opt", f"{key}={value}")
                ],
                WORKLOAD_ALIAS,
            ]
        )


def image_id(image: str):
    if not image or image.startswith("-") or re.search(r"\s", image):
        raise ValueError("Reviewed image required")
    value = run(
        ["docker", "image", "inspect", image, "--format", "{{.Id}}"]
    ).stdout.strip()
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", value):
        raise ValueError("Immutable local image required")
    return value


def validate_runtime(runtime: dict):
    if (
        "monitoringReadDispatch" in runtime
        and type(runtime["monitoringReadDispatch"]) is not bool
    ):
        raise TypeError("Explicit monitoring read deployment boolean required")
    from urllib.parse import urlsplit

    if any(
        not re.fullmatch(r"sha256:[a-f0-9]{64}", runtime[key])
        for key in ("controllerImage", "workerImage", "schedulerImage")
    ):
        raise ValueError("Pinned images required")
    if (
        type(runtime["dockerGid"]) is not int
        or not 0 <= runtime["dockerGid"] <= 2147483647
    ):
        raise ValueError("Docker GID refused")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,254}", runtime["namespace"]):
        raise ValueError("Namespace refused")
    if not re.fullmatch(
        r"(?:host\.docker\.internal|127\.0\.0\.1|localhost|[a-z0-9][a-z0-9_-]{0,62}):[0-9]{1,5}",
        runtime["temporalAddress"],
    ):
        raise ValueError("Local Temporal address required")
    if not 1 <= int(runtime["temporalAddress"].rsplit(":", 1)[1]) <= 65535:
        raise ValueError("Temporal port refused")
    url = urlsplit(runtime["supabaseUrl"])
    if (
        url.scheme not in ("http", "https")
        or url.username
        or url.password
        or url.query
        or url.fragment
        or not url.hostname
    ):
        raise ValueError("Backend URL refused")
    if (
        url.scheme == "http"
        and url.hostname not in ("localhost", "127.0.0.1", "host.docker.internal")
        and not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,62}", url.hostname)
    ):
        raise ValueError("Local backend required")


def validate_monitoring_socket_volume(runtime: dict):
    if not runtime.get("monitoringReadDispatch", False):
        return
    value = json.loads(
        run(["docker", "volume", "inspect", "axiom-discovery-controller-socket"]).stdout
    )
    if (
        len(value) != 1
        or value[0].get("Name") != "axiom-discovery-controller-socket"
        or value[0].get("Driver") != "local"
        or value[0].get("Labels", {}).get("axiom.purpose")
        != "local-discovery-controller"
    ):
        raise ValueError("Reviewed Drishti socket volume required")


def stage(slug: str, runtime: dict):
    validate_runtime(runtime)
    validate_monitoring_socket_volume(runtime)
    # This helper only reads retained policy state. Its existing function refuses
    # absent active heads and returns the original activation event for the epoch.
    custody = load_module(
        "axiom_existing_local_custody_commands",
        ROOT / "scripts/local-custody-credentials.py",
    )
    active = custody.active_policy(TENANTS[slug][0])
    manifest = json.loads((CUSTODY / "manifests" / (slug + ".json")).read_text())
    node = run(
        ["docker", "exec", "axiom-spire", "cat", "/var/lib/spire/node-id"]
    ).stdout.strip()
    configuration = build_configuration(
        slug, active, manifest, node, runtime["workerImage"], runtime["namespace"]
    )
    if runtime.get("monitoringReadDispatch", False):
        configuration["controller"]["monitoring"] = {
            "socketPath": "/run/axiom-discovery/discovery.sock",
            "controllerUid": 20105,
            "socketGroup": 20112,
        }
    retained_current = BASE / slug / "runtime.json"
    if (
        retained_current.exists()
        and json.loads(issuer.read(retained_current))["namespace"]
        != runtime["namespace"]
    ):
        raise ValueError(
            "Retained tenant namespace cannot change without a separate migration review"
        )
    for other in TENANTS:
        retained = BASE / other / "runtime.json"
        if (
            other != slug
            and retained.exists()
            and json.loads(issuer.read(retained))["namespace"] == runtime["namespace"]
        ):
            raise ValueError("Each tenant requires a distinct Temporal namespace")
    current = json.loads(issuer.read(BASE / slug / "credentials/current.json"))
    if (
        current["tenantId"] != TENANTS[slug][0]
        or current["expiresAt"] <= time.time() + 60
    ):
        raise ValueError("Fresh controller backend credential required")
    credential = issuer.read(BASE / slug / "credentials/backend.key")
    provision_workload_alias()
    controller = name(slug)
    remove_owned(controller)
    for suffix in ("conf", "socket"):
        ensure_volume(controller + "-" + suffix)
    helper = controller + "-stage"
    remove_owned(helper)
    command = f'chown -R {UID}:{UID} /conf && chmod 0700 /conf && chmod 0600 /conf/* && test -z "$(find /socket -mindepth 1 ! -name controller.sock -print -quit)" && rm -f /socket/controller.sock && chown {UID}:{SOCKET_GROUP} /socket && chmod 0700 /socket'
    run(
        [
            "docker",
            "create",
            "--pull",
            "never",
            "--name",
            helper,
            "--network",
            "none",
            "--label",
            f"axiom.purpose={PURPOSE}",
            "--mount",
            f"type=volume,src={controller}-conf,dst=/conf",
            "--mount",
            f"type=volume,src={controller}-socket,dst=/socket",
            HELPER,
            "sh",
            "-c",
            command,
        ]
    )
    try:
        with tempfile.TemporaryDirectory(prefix="axiom-controller-") as temp:
            for filename, payload in (
                ("config.json", canonical(configuration)),
                ("backend.key", credential),
            ):
                path = Path(temp) / filename
                with os.fdopen(
                    os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb"
                ) as stream:
                    stream.write(payload)
                run(["docker", "cp", "-q", str(path), helper + ":/conf/" + filename])
            run(["docker", "start", "-a", helper])
    finally:
        remove_owned(helper)
    atomic(BASE / slug / "runtime.json", canonical(runtime))
    print("Local controller configuration staged with protected tenant credential.")


def controller_args(slug: str, runtime: dict, mode: str):
    validate_monitoring_socket_volume(runtime)
    validate_runtime(runtime)
    if (
        mode not in ("check", "serve")
        or type(runtime["dockerGid"]) is not int
        or not 0 <= runtime["dockerGid"] <= 2147483647
    ):
        raise ValueError("Launcher refused")
    controller = name(slug)
    return [
        "docker",
        "run",
        "--pull",
        "never",
        *(
            [
                "-d",
                "--name",
                controller,
                "--restart",
                "unless-stopped",
                "--stop-timeout",
                "95",
            ]
            if mode == "serve"
            else ["--rm"]
        ),
        "--label",
        f"axiom.purpose={PURPOSE}",
        "--user",
        f"{UID}:{UID}",
        "--group-add",
        str(SOCKET_GROUP),
        "--group-add",
        str(runtime["dockerGid"]),
        *(
            [
                "--group-add",
                "20112",
                "--mount",
                "type=volume,src=axiom-discovery-controller-socket,dst=/run/axiom-discovery,readonly",
            ]
            if runtime.get("monitoringReadDispatch", False)
            else []
        ),
        "--network",
        "container:axiom-bff",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--pids-limit",
        "128",
        "--memory",
        "512m",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m,mode=1777",  # nosec B108
        "-e",
        "AXIOM_REGION=ap-south-1",
        "-e",
        "SUPABASE_URL=" + runtime["supabaseUrl"],
        "--mount",
        f"type=volume,src={controller}-conf,dst={CONF},readonly",
        "--mount",
        f"type=volume,src={controller}-socket,dst={SOCKET}",
        "--mount",
        f"type=volume,src={WORKLOAD_ALIAS},dst=/run/workload,readonly",
        "--mount",
        "type=volume,src=axiom-spire-health,dst=/run/spire-health,readonly",
        "--mount",
        "type=bind,src=/var/run/docker.sock,dst=/run/docker.sock,readonly",
        "--workdir",
        "/app/services/bff",
        "--entrypoint",
        "/sbin/tini",
        runtime["controllerImage"],
        "--",
        "node",
        "--import",
        "/app/services/bff/node_modules/tsx/dist/loader.mjs",
        "src/local-assessment-controller.ts",
        "--" + mode,
        CONF + "/config.json",
    ]


def serve(slug: str, runtime: dict, mode: str):
    validate_monitoring_socket_volume(runtime)
    if mode == "serve":
        remove_owned(name(slug))
    run(controller_args(slug, runtime, mode))
    print("Local controller operation completed.")


def scheduler_args(slug: str, runtime: dict):
    validate_runtime(runtime)
    return [
        "docker",
        "run",
        "--pull",
        "never",
        "-d",
        "--name",
        name(slug) + "-scheduler",
        "--restart",
        "unless-stopped",
        "--label",
        f"axiom.purpose={PURPOSE}",
        "--user",
        f"{SCHEDULER_UID}:{SCHEDULER_UID}",
        "--group-add",
        str(SOCKET_GROUP),
        "--network",
        "container:axiom-bff",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--pids-limit",
        "128",
        "--memory",
        "512m",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m,mode=1777",  # nosec B108
        "-e",
        "ENVIRONMENT=local",
        "-e",
        "TEMPORAL_TLS=false",
        "-e",
        "TEMPORAL_ADDRESS=" + runtime["temporalAddress"],
        "-e",
        "TEMPORAL_NAMESPACE=" + runtime["namespace"],
        "-e",
        "PORT=" + str(scheduler_port(slug)),
        "--mount",
        f"type=volume,src={name(slug)}-socket,dst={SOCKET},readonly",
        "--entrypoint",
        "python",
        runtime["schedulerImage"],
        "-m",
        "temporal_workers.worker",
        "--assessment-controller-socket",
        SOCKET + "/controller.sock",
        "--assessment-controller-uid",
        str(UID),
        "--assessment-outbox-pump",
        *(
            ["--monitoring-read-pump"]
            if runtime.get("monitoringReadDispatch", False)
            else []
        ),
    ]


def scheduler(slug: str, runtime: dict):
    remove_owned(name(slug) + "-scheduler")
    run(scheduler_args(slug, runtime))
    print("Dedicated tenant namespace assessment scheduler started.")


def provision_namespace(runtime: dict):
    validate_runtime(runtime)
    code = """import asyncio,sys
from temporalio.client import Client
from temporalio.api.workflowservice.v1 import DescribeNamespaceRequest, RegisterNamespaceRequest
from temporalio.service import RPCError, RPCStatusCode
from google.protobuf.duration_pb2 import Duration
async def main():
 client=await Client.connect(sys.argv[1],namespace=sys.argv[2],tls=False)
 try: await client.workflow_service.describe_namespace(DescribeNamespaceRequest(namespace=sys.argv[2]))
 except RPCError as error:
  if error.status != RPCStatusCode.NOT_FOUND: raise
  await client.workflow_service.register_namespace(RegisterNamespaceRequest(namespace=sys.argv[2],workflow_execution_retention_period=Duration(seconds=86400),description="Local per-tenant assessment namespace"))
asyncio.run(main())
"""
    run(
        [
            "docker",
            "run",
            "--rm",
            "--pull",
            "never",
            "--network",
            "container:axiom-bff",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges:true",
            "--entrypoint",
            "python",
            runtime["schedulerImage"],
            "-c",
            code,
            runtime["temporalAddress"],
            runtime["namespace"],
        ]
    )
    print("Dedicated local Temporal namespace verified or provisioned.")


def renew(slug: str, margin: int):
    current_path = BASE / slug / "credentials/current.json"
    previous = json.loads(issuer.read(current_path))
    if renewal_due(previous, int(time.time()), margin):
        runtime = json.loads(issuer.read(BASE / slug / "runtime.json"))
        issue(slug, None, renew=True)
        stage(slug, runtime)
        serve(slug, runtime, "check")
        serve(slug, runtime, "serve")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "action",
        choices=(
            "prepare-issuer",
            "check-issuer",
            "issue",
            "stage",
            "check",
            "serve",
            "scheduler",
            "renew-due",
            "provision-namespace",
        ),
    )
    parser.add_argument("--tenant", choices=sorted(TENANTS))
    parser.add_argument("--source-settings", type=Path)
    parser.add_argument("--source-sha256")
    parser.add_argument("--approval-reference")
    parser.add_argument("--renew", action="store_true")
    parser.add_argument("--resume")
    parser.add_argument("--controller-image")
    parser.add_argument(
        "--monitoring-read-dispatch",
        action="store_true",
        help="Reviewed local Drishti socket mount and scoped scheduled-read consumer; default off",
    )
    parser.add_argument("--worker-image")
    parser.add_argument("--scheduler-image")
    parser.add_argument("--namespace")
    parser.add_argument("--temporal-address")
    parser.add_argument("--supabase-url", default="http://host.docker.internal:57121")
    parser.add_argument("--docker-gid", type=int)
    parser.add_argument("--watch", type=int, default=0)
    parser.add_argument("--renew-margin", type=int, default=1200)
    args = parser.parse_args()
    try:
        if args.action == "prepare-issuer":
            if not args.source_settings or not args.source_sha256:
                raise ValueError("Reviewed source settings required")
            prepare_issuer(args.source_settings, args.source_sha256)
            return
        if args.action == "check-issuer":
            check_issuer()
            return
        if not args.tenant:
            raise ValueError("Explicit tenant required")
        slug = args.tenant
        if args.action == "issue":
            issue(slug, args.approval_reference, args.renew, args.resume)
        elif args.action == "stage":
            if (
                not all(
                    (
                        args.controller_image,
                        args.worker_image,
                        args.scheduler_image,
                        args.namespace,
                        args.temporal_address,
                    )
                )
                or args.docker_gid is None
            ):
                raise ValueError(
                    "Reviewed images, namespace, address and Docker GID required"
                )
            runtime = {
                "controllerImage": image_id(args.controller_image),
                "workerImage": image_id(args.worker_image),
                "schedulerImage": image_id(args.scheduler_image),
                "namespace": args.namespace,
                "temporalAddress": args.temporal_address,
                "supabaseUrl": args.supabase_url,
                "dockerGid": args.docker_gid,
            }
            if args.monitoring_read_dispatch:
                runtime["monitoringReadDispatch"] = True
            stage(slug, runtime)
        elif args.action == "renew-due":
            if args.watch and not 30 <= args.watch <= 600:
                raise ValueError("Bounded renewal interval required")
            while True:
                renew(slug, args.renew_margin)
                if not args.watch:
                    break
                time.sleep(args.watch)
        else:
            runtime = json.loads(issuer.read(BASE / slug / "runtime.json"))
            if args.action == "provision-namespace":
                provision_namespace(runtime)
            elif args.action == "scheduler":
                scheduler(slug, runtime)
            else:
                serve(slug, runtime, args.action)
    except (Exception, KeyboardInterrupt):  # noqa: BLE001 - sanitize all issuer/backend failures at CLI boundary
        print(
            "Local controller operation refused or uncertain; preserve retained issuance requests and reconcile the same request.",
            file=sys.stderr,
        )
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
