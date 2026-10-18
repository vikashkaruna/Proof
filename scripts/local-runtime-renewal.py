#!/usr/bin/env python3
"""Explicitly install/status/uninstall a reviewed macOS local renewal LaunchAgent.

The job runs at login and every five minutes while logged in, including after
sleep. It composes existing renew-due commands only; no new issuance authority.
Source or deployment registry changes require uninstall and explicit reinstall.
LaunchAgents require an interactive login after reboot; Docker must be running.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
import plistlib
import re
import shutil
import stat
import subprocess  # nosec B404 - fixed argv, no shell
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MAX = 2_000_000


def digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def owned(path: Path, directory: bool = False, private: bool = True) -> None:
    info = path.lstat()
    if (
        path.resolve() != path
        or info.st_uid != os.getuid()
        or (
            not stat.S_ISDIR(info.st_mode)
            if directory
            else not stat.S_ISREG(info.st_mode)
        )
    ):
        raise ValueError("Owned regular path required")
    mode = stat.S_IMODE(info.st_mode)
    if (private and mode != (0o700 if directory else 0o600)) or (
        not private and mode & 0o022
    ):
        raise ValueError("Protected permissions required")


def read_private(path: Path) -> bytes:
    owned(path.parent, True)
    owned(path)
    if path.stat().st_size > MAX:
        raise ValueError("Oversized configuration refused")
    return path.read_bytes()


def write_private(path: Path, raw: bytes) -> None:
    owned(path.parent, True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())


def run(args: list[str], *, env: dict | None = None, timeout: int = 30) -> int:
    try:
        return subprocess.run(
            args,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
            check=False,
        ).returncode  # nosec B603
    except (OSError, subprocess.SubprocessError):
        return 1


def source_hashes(root: Path) -> dict[str, str]:
    result = subprocess.run(
        ["/usr/bin/git", "-C", str(root), "ls-files", "-z", "scripts", "infra"],
        capture_output=True,
        timeout=30,
        check=True,
    )  # nosec B603
    hashes = {}
    for name in result.stdout.decode().split("\0"):
        if not name:
            continue
        path = root / name
        if path.resolve() != path or not path.is_file():
            raise ValueError("Source symlink or missing file refused")
        hashes[name] = digest(path.read_bytes())
    if not hashes:
        raise ValueError("Reviewed source required")
    return hashes


def validate_sources(config: dict) -> None:
    selected_docker = shutil.which("docker", path=config["environment"]["PATH"])
    if (
        not selected_docker
        or str(Path(selected_docker).resolve()) != config["dockerExecutable"]
    ):
        raise ValueError("Reviewed Docker executable selection changed")
    root = Path(config["workspace"])
    if not root.is_absolute() or root.resolve() != root:
        raise ValueError("Absolute workspace required")
    for relative, expected in config["sources"].items():
        path = root / relative
        if (
            Path(relative).is_absolute()
            or ".." in Path(relative).parts
            or path.resolve() != path
            or digest(path.read_bytes()) != expected
        ):
            raise ValueError("Reviewed source changed; explicitly reinstall")
    for path, expected in config["tools"].items():
        tool = Path(path)
        if (
            tool.resolve() != tool
            or not tool.is_file()
            or digest(tool.read_bytes()) != expected
        ):
            raise ValueError("Reviewed tool changed; explicitly reinstall")


def registry(config: dict) -> dict:
    # Import only after all selected source bytes are verified.
    spec = importlib.util.spec_from_file_location(
        "renewal_registry",
        Path(config["workspace"]) / "scripts/lib/local_tenant_registry.py",
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    raw = read_private(Path(config["environment"]["AXIOM_LOCAL_TENANT_REGISTRY_FILE"]))
    if digest(raw) != config["environment"]["AXIOM_LOCAL_TENANT_REGISTRY_SHA256"]:
        raise ValueError("Reviewed registry changed")
    deployments = module.parse_registry(raw)
    if (
        not config["tenants"]
        or len(set(config["tenants"])) != len(config["tenants"])
        or any(alias not in deployments for alias in config["tenants"])
    ):
        raise ValueError("Explicit reviewed tenants required")
    return deployments


def load(record: Path, expected: str) -> dict:
    raw = read_private(record)
    if digest(raw) != expected:
        raise ValueError("Installed configuration changed")
    config = json.loads(raw)
    if config["schemaVersion"] != 1 or not re.fullmatch(
        r"axiom-proof-local-runtime-renewal", config["label"]
    ):
        raise ValueError("Local job identity refused")
    if set(config["environment"]) != {
        "HOME",
        "PATH",
        "AXIOM_LOCAL_TENANT_REGISTRY_FILE",
        "AXIOM_LOCAL_TENANT_REGISTRY_SHA256",
        "AXIOM_LOCAL_CUSTODY_ISSUER_DIR",
        "AXIOM_LOCAL_CONTROLLER_DIR",
    }:
        raise ValueError("Unexpected environment authority")
    return config


def unexpired(config: dict, alias: str, tenant: str, component: str) -> bool:
    """Renewal cannot revive expired/missing authority after logout or sleep."""
    try:
        if component == "controller":
            request = json.loads(
                read_private(
                    Path(config["environment"]["AXIOM_LOCAL_CONTROLLER_DIR"])
                    / alias
                    / "credentials/current.json"
                )
            )
            requests = [request]
        else:
            base = (
                Path(config["environment"]["AXIOM_LOCAL_CUSTODY_ISSUER_DIR"])
                / "credentials"
                / tenant
            )
            requests = []
            for kind in ("operator", "producer", "controller"):
                pointer = base / (kind + ".last")
                if not pointer.exists():
                    continue
                credential = read_private(pointer).decode().strip()
                if not re.fullmatch(r"[a-f0-9-]{36}", credential):
                    return False
                value = json.loads(read_private(base / (credential + ".request.json")))
                if (
                    value.get("credentialId") != credential
                    or value.get("purpose") != "local-custody-credential-issue"
                ):
                    return False
                value = dict(
                    value, expiresAt=min(value["expiresAt"], value["issuedAt"] + 3600)
                )
                requests.append(value)
        return bool(requests) and all(
            type(value.get("expiresAt")) is int and value["expiresAt"] > time.time()
            for value in requests
        )
    except (OSError, ValueError, TypeError, KeyError):
        return False


def once(record: Path, expected: str) -> int:
    config = load(record, expected)
    owned(record.parent / "renewal.lock")
    descriptor = os.open(record.parent / "renewal.lock", os.O_RDWR | os.O_NOFOLLOW)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0  # Another scheduled/manual invocation owns the entire cycle.
        outcomes = []
        refused = False
        try:
            validate_sources(config)
            deployments = registry(config)
            for alias in config["tenants"]:
                commands = (
                    [
                        config["python"],
                        "-I",
                        str(
                            Path(config["workspace"])
                            / "scripts/local-custody-credentials.py"
                        ),
                        "renew-due",
                        "--tenant-id",
                        deployments[alias].tenant_id,
                        "--margin",
                        "1200",
                    ],
                    [
                        config["python"],
                        "-I",
                        str(
                            Path(config["workspace"])
                            / "scripts/local-assessment-controller.py"
                        ),
                        "renew-due",
                        "--tenant",
                        alias,
                        "--renew-margin",
                        "1200",
                    ],
                )
                for component, command in zip(
                    ("custody", "controller"), commands, strict=True
                ):
                    if not unexpired(
                        config, alias, deployments[alias].tenant_id, component
                    ):
                        outcomes.append(
                            {
                                "tenant": alias,
                                "component": component,
                                "ok": False,
                                "requiresFreshIssue": True,
                            }
                        )
                        continue
                    result = run(command, env=config["environment"], timeout=420)
                    outcomes.append(
                        {"tenant": alias, "component": component, "ok": result == 0}
                    )
        except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
            refused = True
        # Only non-secret outcome metadata; child output is never retained.
        state = {
            "schemaVersion": 1,
            "checkedAt": int(time.time()),
            "outcomes": outcomes,
            "refused": refused,
        }
        temporary = record.parent / "status.next"
        if temporary.exists():
            owned(temporary)
            temporary.unlink()
        write_private(temporary, json.dumps(state).encode())
        target = record.parent / "status.json"
        if target.exists():
            owned(target)
        temporary.replace(target)
        return int(refused or any(not item["ok"] for item in outcomes))
    finally:
        os.close(descriptor)


def plist(config: dict, state: Path, config_sha: str) -> dict:
    return {
        "Label": config["label"],
        "ProgramArguments": [
            config["python"],
            "-I",
            str(state / "runner.py"),
            "once",
            "--config",
            str(state / "config.json"),
            "--config-sha256",
            config_sha,
        ],
        "WorkingDirectory": config["workspace"],
        "EnvironmentVariables": config["environment"],
        "RunAtLoad": True,
        "StartInterval": 300,
        "ProcessType": "Background",
        "Umask": 0o077,
        "StandardOutPath": str(state / "stdout.log"),
        "StandardErrorPath": str(state / "stderr.log"),
        "ThrottleInterval": 60,
    }


def job_loaded(label: str, destination: Path) -> bool:
    result = subprocess.run(
        ["/bin/launchctl", "print", f"gui/{os.getuid()}/{label}"],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )  # nosec B603
    if result.returncode:
        return False
    if "path = " + str(destination) not in [
        line.strip() for line in result.stdout.splitlines()
    ]:
        raise ValueError("Foreign loaded job refused")
    return True


def install(args) -> None:
    if sys.platform != "darwin":
        raise ValueError("macOS LaunchAgent required")
    script = Path(__file__).resolve()
    if digest(script.read_bytes()) != args.source_sha256:
        raise ValueError("Explicit reviewed source digest required")
    root = ROOT.resolve()
    env_file = args.environment_file
    owned(env_file, private=False)
    selected = [
        line.split("=", 1)[1].strip()
        for line in env_file.read_text().splitlines()
        if line.startswith("LOCAL_RUNTIME_RENEWAL_LABEL=")
    ]
    if selected != ["axiom-proof-local-runtime-renewal"]:
        raise ValueError("Reviewed local environment job label required")
    state = args.state_dir
    owned(state.parent, True)
    destination = (
        Path.home().resolve() / "Library/LaunchAgents" / (selected[0] + ".plist")
    )
    owned(destination.parent, True, private=False)
    if (
        state.exists()
        or state.is_symlink()
        or destination.exists()
        or destination.is_symlink()
        or job_loaded(selected[0], destination)
    ):
        raise ValueError("Existing state/job refused; explicitly uninstall first")
    if any(not Path(item).is_absolute() for item in args.path.split(":")):
        raise ValueError("Explicit absolute PATH required")
    for item in args.path.split(":"):
        directory = Path(item)
        if directory.exists():
            info = directory.stat()
            if (
                not directory.is_dir()
                or info.st_uid not in (0, os.getuid())
                or stat.S_IMODE(info.st_mode) & 0o022
            ):
                raise ValueError("Untrusted executable search directory")
    python = Path(sys.executable).resolve()
    docker = shutil.which("docker", path=args.path)
    if not docker:
        raise ValueError("Docker executable unavailable")
    docker = Path(docker).resolve()
    for directory in (args.custody_dir, args.controller_dir):
        owned(directory, True)
    config = {
        "schemaVersion": 1,
        "label": selected[0],
        "workspace": str(root),
        "python": str(python),
        "dockerExecutable": str(docker),
        "tenants": args.tenant,
        "sources": source_hashes(root),
        "tools": {
            str(python): digest(python.read_bytes()),
            str(docker): digest(docker.read_bytes()),
        },
        "environment": {
            "HOME": str(Path.home().resolve()),
            "PATH": args.path,
            "AXIOM_LOCAL_TENANT_REGISTRY_FILE": str(args.registry_file),
            "AXIOM_LOCAL_TENANT_REGISTRY_SHA256": args.registry_sha256,
            "AXIOM_LOCAL_CUSTODY_ISSUER_DIR": str(args.custody_dir),
            "AXIOM_LOCAL_CONTROLLER_DIR": str(args.controller_dir),
        },
    }
    validate_sources(config)
    registry(config)
    state.mkdir(mode=0o700)
    write_private(state / "runner.py", script.read_bytes())
    raw = json.dumps(config, sort_keys=True).encode()
    write_private(state / "config.json", raw)
    for filename in ("renewal.lock", "stdout.log", "stderr.log"):
        write_private(state / filename, b"")
    rendered = plistlib.dumps(plist(config, state, digest(raw)))
    write_private(state / "job.plist", rendered)
    # LaunchAgents directory is conventionally 0755; the plist itself stays 0600.
    fd = os.open(
        destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600
    )
    with os.fdopen(fd, "wb") as stream:
        stream.write(rendered)
    if run(["/bin/launchctl", "bootstrap", f"gui/{os.getuid()}", str(destination)]):
        raise ValueError(
            "Bootstrap failed; retained reviewed installation can be inspected/uninstalled"
        )
    print("Reviewed local runtime renewal LaunchAgent installed.")


def inspect_job(record: Path, expected: str, remove: bool = False) -> None:
    config = load(record, expected)
    state = record.parent
    destination = (
        Path.home().resolve() / "Library/LaunchAgents" / (config["label"] + ".plist")
    )
    owned(destination)
    if destination.read_bytes() != read_private(state / "job.plist") or plistlib.loads(
        destination.read_bytes()
    ) != plist(config, state, expected):
        raise ValueError("Foreign or changed job refused")
    loaded = job_loaded(config["label"], destination)
    if remove:
        if loaded and run(
            ["/bin/launchctl", "bootout", f"gui/{os.getuid()}/{config['label']}"]
        ):
            raise ValueError("Job unload unconfirmed; preserve files")
        destination.unlink()
        print(
            "Renewal LaunchAgent removed; protected configuration/status retained. Choose a new state directory when reinstalling."
        )
    else:
        print("Renewal LaunchAgent: " + ("loaded" if loaded else "not loaded"))
        status = state / "status.json"
        if status.exists():
            value = json.loads(read_private(status))
            print(
                json.dumps(
                    {
                        "checkedAt": value["checkedAt"],
                        "failedComponents": sum(
                            not item["ok"] for item in value["outcomes"]
                        ),
                        "refused": value.get("refused", False),
                        "requiresFreshIssue": sum(
                            item.get("requiresFreshIssue", False)
                            for item in value["outcomes"]
                        ),
                        "stale": time.time() - value["checkedAt"] > 900,
                    }
                )
            )
        else:
            print("No completed renewal cycle recorded.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("install")
    for option in ("source-sha256", "registry-sha256"):
        p.add_argument("--" + option, required=True)
    for option in (
        "environment-file",
        "state-dir",
        "registry-file",
        "custody-dir",
        "controller-dir",
    ):
        p.add_argument("--" + option, required=True, type=Path)
    p.add_argument("--tenant", action="append", required=True)
    p.add_argument(
        "--path",
        default="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    )
    for name in ("once", "status", "uninstall"):
        p = sub.add_parser(name)
        p.add_argument("--config", required=True, type=Path)
        p.add_argument("--config-sha256", required=True)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if args.command == "install":
            install(args)
        elif args.command == "once":
            return once(args.config, args.config_sha256)
        else:
            inspect_job(args.config, args.config_sha256, args.command == "uninstall")
        return 0
    except (Exception, KeyboardInterrupt):  # noqa: BLE001 - never expose issuer/backend diagnostics
        print(
            "Local renewal refused or incomplete; inspect protected status and explicitly reconcile/redeploy reviewed configuration.",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
