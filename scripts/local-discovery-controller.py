#!/usr/bin/env python3
"""Stage/check/serve the secret-less local Drishti controller on reviewed images.

No database/grant/custody enrollment is performed here. BFF must mount the
client/socket volumes read-only and join GID20112. UID20105 controller and
UID20004 Drishti worker are dedicated identities, never shared runtime UIDs.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import subprocess
import tempfile
from pathlib import Path

NAME = "axiom-discovery-controller"
PURPOSE = "local-discovery-controller"
UID = 20105
GROUP = 20112
CONF = "/etc/axiom/discovery-controller"
SOCKET = "/run/axiom-discovery"
HELPER = "alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8"


def run(args: list[str], **kw):
    return subprocess.run(
        args, check=True, capture_output=True, text=True, timeout=120, **kw
    )


def image_id(value: str) -> str:
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", value):
        raise ValueError("Reviewed image ID required")
    if (
        run(["docker", "image", "inspect", value, "--format", "{{.Id}}"]).stdout.strip()
        != value
    ):
        raise ValueError("Reviewed image unavailable")
    return value


def volume(name: str):
    result = subprocess.run(
        ["docker", "volume", "inspect", name],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode:
        run(["docker", "volume", "create", "--label", f"axiom.purpose={PURPOSE}", name])
    elif json.loads(result.stdout)[0].get("Labels", {}).get("axiom.purpose") != PURPOSE:
        raise ValueError("Existing volume ownership refused")


def configuration(worker: str, workload_volume: str, broker_port: int) -> dict:
    if (
        not re.fullmatch(r"axiom-workload-api-[a-z0-9-]{1,64}", workload_volume)
        or not 1 <= broker_port <= 65535
    ):
        raise ValueError("Discovery deployment refused")
    return {
        "schemaVersion": 1,
        "environment": "local",
        "container": {
            "executable": "/usr/bin/docker",
            "dockerHost": "unix:///var/run/docker.sock",
            "image": worker,
            "workloadApiVolume": workload_volume,
        },
        "brokerUrl": f"http://127.0.0.1:{broker_port}/internal/discovery/retained",
        "socket": {"directory": SOCKET, "socketGroup": GROUP},
    }


def stage(args):
    controller = image_id(args.controller_image)
    worker = image_id(args.worker_image)
    if not 0 <= args.docker_gid <= 2147483647:
        raise ValueError("Reviewed daemon GID required")
    if (
        subprocess.run(
            ["docker", "inspect", NAME], check=False, capture_output=True
        ).returncode
        == 0
    ):
        raise ValueError("Stop the owned discovery controller before staging")
    conf = configuration(worker, args.workload_volume, args.broker_port)
    run(["docker", "volume", "inspect", args.workload_volume])
    for suffix in ("conf", "socket", "client"):
        volume(f"{NAME}-{suffix}")
    helper = "axiom-discovery-stage-" + secrets.token_hex(8)
    run(
        [
            "docker",
            "create",
            "--name",
            helper,
            "--pull",
            "never",
            "--network",
            "none",
            "--label",
            f"axiom.purpose={PURPOSE}",
            "--mount",
            f"type=volume,src={NAME}-conf,dst=/conf",
            "--mount",
            f"type=volume,src={NAME}-socket,dst=/socket",
            "--mount",
            f"type=volume,src={NAME}-client,dst=/client",
            HELPER,
            "sh",
            "-c",
            f"chown {UID}:{UID} /conf /socket /conf/config.json && chmod 700 /conf /socket /client && chmod 600 /conf/config.json /conf/runtime.json && chown 0:0 /client /client/config.json && chmod 600 /client/config.json",
        ]
    )
    try:
        with tempfile.TemporaryDirectory(prefix="axiom-discovery-") as temporary:
            path = Path(temporary)
            path.chmod(0o700)
            payloads = {
                "config.json": conf,
                "client.json": {
                    "socketPath": SOCKET + "/discovery.sock",
                    "controllerUid": UID,
                    "socketGroup": GROUP,
                },
                "runtime.json": {
                    "controllerImage": controller,
                    "dockerGid": args.docker_gid,
                },
            }
            for name, value in payloads.items():
                file = path / name
                with os.fdopen(
                    os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w"
                ) as stream:
                    json.dump(value, stream)
            run(
                [
                    "docker",
                    "cp",
                    str(path / "config.json"),
                    helper + ":/conf/config.json",
                ]
            )
            run(
                [
                    "docker",
                    "cp",
                    str(path / "runtime.json"),
                    helper + ":/conf/runtime.json",
                ]
            )
            run(
                [
                    "docker",
                    "cp",
                    str(path / "client.json"),
                    helper + ":/client/config.json",
                ]
            )
            run(["docker", "start", "-a", helper])
    finally:
        run(["docker", "rm", "-f", helper])
    print("Protected discovery controller configuration staged.")


def runtime_args(image: str, gid: int, serve: bool) -> list[str]:
    image_id(image)
    if not 0 <= gid <= 2147483647:
        raise ValueError("Reviewed daemon GID required")
    return [
        "docker",
        "run",
        "--pull",
        "never",
        *(
            [
                "-d",
                "--name",
                NAME,
                "--restart",
                "unless-stopped",
                "--stop-timeout",
                "55",
            ]
            if serve
            else ["--rm"]
        ),
        "--label",
        f"axiom.purpose={PURPOSE}",
        "--user",
        f"{UID}:{UID}",
        "--group-add",
        str(GROUP),
        "--group-add",
        str(gid),
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
        "/tmp:rw,nosuid,nodev,size=64m,mode=1777",
        "--mount",
        f"type=volume,src={NAME}-conf,dst={CONF},readonly",
        "--mount",
        f"type=volume,src={NAME}-socket,dst={SOCKET}",
        "--mount",
        "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock",
        "--entrypoint",
        "node",
        image,
        "--import",
        "tsx",
        "src/local-discovery-controller.ts",
        CONF + "/config.json",
        *([] if serve else ["--check"]),
    ]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    p = commands.add_parser("stage")
    p.add_argument("--controller-image", required=True)
    p.add_argument("--worker-image", required=True)
    p.add_argument("--docker-gid", type=int, required=True)
    p.add_argument("--workload-volume", default="axiom-workload-api-local")
    p.add_argument("--broker-port", type=int, default=4000)
    for command in ("check", "serve"):
        p = commands.add_parser(command)
        p.add_argument("--controller-image", required=True)
        p.add_argument("--docker-gid", type=int, required=True)
    commands.add_parser("down")
    args = parser.parse_args()
    try:
        if args.command == "stage":
            stage(args)
        elif args.command in ("check", "serve"):
            run(
                runtime_args(
                    args.controller_image, args.docker_gid, args.command == "serve"
                )
            )
            print("Discovery controller " + args.command + " completed.")
        else:
            info = json.loads(run(["docker", "inspect", NAME]).stdout)[0]
            if info.get("Config", {}).get("Labels", {}).get("axiom.purpose") != PURPOSE:
                raise ValueError("Container ownership refused")
            run(["docker", "stop", "--time", "55", NAME])
            run(["docker", "rm", NAME])
            print("Owned discovery controller stopped.")
    except (ValueError, OSError, subprocess.SubprocessError):
        raise SystemExit(
            "Local discovery controller command refused; inspect reviewed prerequisites."
        ) from None


if __name__ == "__main__":
    main()
