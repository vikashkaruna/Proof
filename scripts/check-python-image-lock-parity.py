#!/usr/bin/env python3
"""Compare an owned built image's actual production environment to frozen uv export.

No server, database, credentials, volumes or network are available to the probe.
This checks active target-platform markers, not every alternative in a universal lock.
Docker/uv subprocesses use reviewed argv and resolved executables, never a shell.
"""

import argparse
import json
import re
import secrets
import shutil
import subprocess  # nosec B404
import tomllib
from pathlib import Path

from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

ROOT = Path(__file__).resolve().parent.parent
SERVICES = {"agent-runtime", "model-gateway", "temporal-workers"}
PROBE = """
import importlib.metadata as m, json, os, sys
from packaging.markers import default_environment
import axiom_offline_license
rows = []
for d in m.distributions():
    direct = d.read_text('direct_url.json')
    rows.append({'name': d.metadata['Name'], 'version': d.version,
                 'editable': bool(direct and json.loads(direct).get('dir_info', {}).get('editable'))})
print(json.dumps({'distributions': rows, 'markers': default_environment(),
                  'prefix': sys.prefix, 'executable': sys.executable, 'uid': os.getuid(),
                  'offline_license_imported': True}))
"""


def expected_versions(export: str, project: dict, markers: dict) -> dict[str, str]:
    expected = {canonicalize_name(project["name"]): project["version"]}
    for line in export.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or line == ".":
            continue
        req = Requirement(line)
        if req.marker and not req.marker.evaluate(markers):
            continue
        specs = list(req.specifier)
        if (
            req.url
            or len(specs) != 1
            or specs[0].operator != "=="
            or "*" in specs[0].version
        ):
            raise ValueError("Frozen export must contain exact versions")
        name, version = canonicalize_name(req.name), specs[0].version
        if name in expected and expected[name] != version:
            raise ValueError("Conflicting active locked versions")
        expected[name] = version
    return expected


def verify(export: str, project: dict, observed: dict, service: str) -> dict:
    expected = expected_versions(export, project, observed["markers"])
    actual = {}
    for row in observed["distributions"]:
        name = canonicalize_name(row["name"])
        if name in actual or row["editable"]:
            raise ValueError("Duplicate or editable installed distribution")
        actual[name] = row["version"]
    if actual != expected:
        mismatches = {
            name: {"locked": expected.get(name), "installed": actual.get(name)}
            for name in sorted(expected.keys() | actual.keys())
            if expected.get(name) != actual.get(name)
        }
        raise ValueError(
            "Installed/lock mismatch: " + json.dumps(mismatches, sort_keys=True)
        )
    prefix = f"/app/services/{service}/.venv"
    if (
        observed["prefix"] != prefix
        or not observed["executable"].startswith(prefix + "/bin/")
        or observed["uid"] == 0
        or observed["offline_license_imported"] is not True
    ):
        raise ValueError("Runtime virtual environment/non-root/import proof refused")
    return {"service": service, "installed_count": len(actual), "mismatches": 0}


def command(args: list[str]) -> str:
    if not args or args[0] not in {"docker", "uv"}:
        raise ValueError("Probe executable refused")
    executable = shutil.which(args[0])
    if executable is None or not Path(executable).is_absolute():
        raise ValueError("Probe executable unavailable")
    # Docker targets are owned, label-checked images; uv exports only the local frozen lock.
    result = subprocess.run(  # nosec B603
        [executable, *args[1:]], capture_output=True, text=True, timeout=120, check=True
    )
    return result.stdout


def remove_probe(name: str) -> None:
    if not re.fullmatch(r"axiom-python-lock-probe-[a-f0-9]{12}", name):
        raise ValueError("Probe cleanup name refused")
    try:
        info = json.loads(command(["docker", "inspect", name]))[0]
    except subprocess.CalledProcessError as exc:
        if (
            "no such object:" in exc.stderr.lower()
            or "no such container:" in exc.stderr.lower()
        ):
            return
        raise ValueError("Probe cleanup unconfirmed") from exc
    labels = info["Config"]["Labels"] or {}
    if labels.get("com.axiom.fixture") != "python-image-lock-parity" or labels.get(
        "com.axiom.owner-worktree"
    ) != str(ROOT):
        raise ValueError("Foreign probe cleanup refused")
    # Resolve the random owned name once; deletion targets only its immutable ID.
    command(["docker", "rm", "-f", info["Id"]])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--service", choices=sorted(SERVICES), required=True)
    parser.add_argument("--image", required=True)
    args = parser.parse_args()
    if not re.fullmatch(
        r"axiom-python-lock-" + args.service + r"-[a-f0-9]{12}", args.image
    ):
        raise ValueError("Owned image name required")
    image = json.loads(command(["docker", "image", "inspect", args.image]))[0]
    labels = image["Config"]["Labels"] or {}
    if labels.get("com.axiom.fixture") != "python-image-lock-parity" or labels.get(
        "com.axiom.owner-worktree"
    ) != str(ROOT):
        raise ValueError("Owned image labels required")
    project_dir = ROOT / "services" / args.service
    export = command(
        [
            "uv",
            "export",
            "--project",
            str(project_dir),
            "--locked",
            "--no-dev",
            "--no-editable",
            "--no-hashes",
            "--no-annotate",
            "--no-header",
        ]
    )
    project = tomllib.loads((project_dir / "pyproject.toml").read_text())["project"]
    probe_name = "axiom-python-lock-probe-" + secrets.token_hex(6)
    try:
        observed = json.loads(
            command(
                [
                    "docker",
                    "run",
                    "--rm",
                    "--network",
                    "none",
                    "--read-only",
                    "--name",
                    probe_name,
                    "--label",
                    "com.axiom.fixture=python-image-lock-parity",
                    "--label",
                    "com.axiom.owner-worktree=" + str(ROOT),
                    "--entrypoint",
                    "python",
                    image["Id"],
                    "-c",
                    PROBE,
                ]
            )
        )
    finally:
        remove_probe(probe_name)
    print(
        json.dumps(
            {**verify(export, project, observed, args.service), "image_id": image["Id"]}
        )
    )


if __name__ == "__main__":
    main()
