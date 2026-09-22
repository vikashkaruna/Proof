#!/usr/bin/env python3
"""Isolated real SPIRE attestation + BFF verifier acceptance; no application activation.

Requires Docker, pnpm, curl and Python 3.12+. Only allowlisted outcomes leave this
process. Synthetic tokens travel in subprocess memory/stdin, never argv/logs/files.
The container has no network, host PID access, Docker socket or backend credentials.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION = "1.15.3"
HASHES = {
    "arm64": "a9982b3ca7de489def22265fd4586d8e13091ecb6fddf6adcea9291313b18886",
    "amd64": "ca1a4d1155317bdd2afc7f36663828a10410c7c840e54725b90b4064b0a301c7",
}
IMAGE = "alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8"
AGENTS = [
    "drishti",
    "vibhaag",
    "parikshan",
    "saakshi",
    "sudhaar",
    "karya",
    "lekha",
    "nazar",
    "prativedan",
    "sanket",
]


def run(
    args: list[str], *, data: str | None = None, required: bool = True, timeout: int = 60
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        args, input=data, capture_output=True, text=True, cwd=ROOT, timeout=timeout, check=False
    )
    if required and result.returncode:
        # Never relay command arguments, stderr or stdout containing identity material.
        raise RuntimeError("isolated command failed")
    return result


def main() -> None:
    os.umask(0o077)
    state = ROOT / ".axiom-runtime" / "workload-identity"
    state.mkdir(parents=True, exist_ok=True)
    result_path = state / "results.json"
    result_path.unlink(missing_ok=True)
    temp = Path(tempfile.mkdtemp(prefix="run-", dir=state))
    name = "axiom-spire-test-" + uuid.uuid4().hex[:12]
    started = False
    assessment = sys.argv[1:] == ["--assessment"]
    if assessment:
        (ROOT / ".axiom-runtime/workload-assessment/results.json").unlink(missing_ok=True)
    if sys.argv[1:] and not assessment:
        raise RuntimeError("unknown acceptance mode")
    try:
        print("Workload identity acceptance: Docker preflight.", flush=True)
        architecture = run(["docker", "info", "--format", "{{.Architecture}}"]).stdout.strip()
        arch = {"aarch64": "arm64", "arm64": "arm64", "x86_64": "amd64", "amd64": "amd64"}.get(
            architecture
        )
        if arch not in HASHES:
            raise RuntimeError("unsupported Docker architecture")
        archive = state / f"spire-{VERSION}-linux-{arch}-musl.tar.gz"
        print("Workload identity acceptance: verified release setup.", flush=True)
        if not archive.exists():
            download = temp / "download.tar.gz"
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
                    "--retry",
                    "2",
                    "--max-time",
                    "180",
                    f"https://github.com/spiffe/spire/releases/download/v{VERSION}/{archive.name}",
                    "--output",
                    str(download),
                ],
                timeout=190,
            )
            if hashlib.sha256(download.read_bytes()).hexdigest() != HASHES[arch]:
                raise RuntimeError("release checksum mismatch")
            download.replace(archive)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != HASHES[arch]:
            raise RuntimeError("release checksum mismatch")
        with tarfile.open(archive) as source:
            # Extract only the two reviewed executable members, not archive scripts/config.
            for executable in ["spire-server", "spire-agent"]:
                member = source.getmember(f"spire-{VERSION}/bin/{executable}")
                if not member.isfile():
                    raise RuntimeError("invalid release member")
                stream = source.extractfile(member)
                if stream is None:
                    raise RuntimeError("missing executable")
                dest = temp / executable
                dest.write_bytes(stream.read())
                dest.chmod(0o755)
        print("Workload identity acceptance: starting isolated issuer.", flush=True)
        server = """server {
 bind_address = "127.0.0.1"
 bind_port = 8081
 socket_path = "/run/server/api.sock"
 trust_domain = "local.axiomproof.test"
 data_dir = "/var/lib/spire/server"
 log_level = "ERROR"
 default_jwt_svid_ttl = "5m"
}
plugins {
 DataStore "sql" { plugin_data { database_type = "sqlite3" connection_string = "/var/lib/spire/server/db.sqlite3" } }
 KeyManager "disk" { plugin_data { keys_path = "/var/lib/spire/server/keys.json" } }
 NodeAttestor "join_token" { plugin_data {} }
}
"""
        agent = """agent {
 data_dir = "/var/lib/spire/agent"
 log_level = "ERROR"
 trust_domain = "local.axiomproof.test"
 server_address = "127.0.0.1"
 server_port = 8081
 socket_path = "/run/workload/api.sock"
 trust_bundle_path = "/root/bundle.pem"
}
plugins {
 KeyManager "disk" { plugin_data { directory = "/var/lib/spire/agent" } }
 NodeAttestor "join_token" { plugin_data {} }
 WorkloadAttestor "unix" { plugin_data {} }
}
"""
        (temp / "server.conf").write_text(server)
        (temp / "agent.conf").write_text(agent)
        selected_image = IMAGE
        if assessment:
            selected_image = "axiom-assessment-worker:acceptance"
            run(["docker", "build", "-f", "infra/docker/Dockerfile.assessment-worker", "-t", selected_image, "."], timeout=240)
        run(
            ["docker", "run", "-d", "--name", name, "--network", "none", "--user", "0", "--entrypoint", "sleep", selected_image, "1200"],
            timeout=180,
        )
        started = True
        for executable in ["spire-server", "spire-agent"]:
            run(["docker", "cp", str(temp / executable), f"{name}:/usr/local/bin/{executable}"])
        for conf in ["server.conf", "agent.conf"]:
            run(["docker", "cp", str(temp / conf), f"{name}:/root/{conf}"])
        run(
            [
                "docker",
                "exec",
                "-d",
                name,
                "sh",
                "-c",
                "umask 077; exec spire-server run -config /root/server.conf > /root/server.log 2>&1",
            ]
        )

        def wait(binary: str, socket: str) -> None:
            for _ in range(30):
                if (
                    run(
                        ["docker", "exec", name, binary, "healthcheck", "-socketPath", socket],
                        required=False,
                    ).returncode
                    == 0
                ):
                    return
                time.sleep(1)
            raise RuntimeError("SPIRE startup failed")

        wait("spire-server", "/run/server/api.sock")
        prefix = ["docker", "exec", name, "spire-server"]
        run(
            [
                "docker",
                "exec",
                name,
                "sh",
                "-c",
                "umask 077; spire-server bundle show -socketPath /run/server/api.sock -format pem > /root/bundle.pem",
            ]
        )
        join = json.loads(
            run(
                prefix
                + [
                    "token",
                    "generate",
                    "-socketPath",
                    "/run/server/api.sock",
                    "-spiffeID",
                    "spiffe://local.axiomproof.test/node/acceptance",
                    "-output",
                    "json",
                ]
            ).stdout
        )
        run(
            ["docker", "exec", "-i", name, "sh", "-c", "umask 077; cat > /root/join-token"],
            data=join["value"],
        )
        run(["docker", "exec", name, "sh", "-c", "mkdir -p /run/workload; chmod 755 /run/workload"])
        run(
            [
                "docker",
                "exec",
                "-d",
                name,
                "sh",
                "-c",
                "umask 077; exec spire-agent run -config /root/agent.conf -joinTokenFile /root/join-token > /root/agent.log 2>&1",
            ]
        )
        wait("spire-agent", "/run/workload/api.sock")
        for index, agent_name in enumerate(AGENTS):
            run(
                prefix
                + [
                    "entry",
                    "create",
                    "-socketPath",
                    "/run/server/api.sock",
                    "-parentID",
                    "spiffe://local.axiomproof.test/node/acceptance",
                    "-spiffeID",
                    f"spiffe://local.axiomproof.test/agent/{agent_name}",
                    "-selector",
                    f"unix:uid:{20001 + index}",
                    "-jwtSVIDTTL",
                    "300",
                ]
            )
        cases = []
        outcomes: dict[str, bool] = {}

        def fetch(
            uid: int, agent_name: str, required: bool = True
        ) -> subprocess.CompletedProcess[str]:
            return run(
                [
                    "docker",
                    "exec",
                    "--user",
                    str(uid),
                    name,
                    "spire-agent",
                    "api",
                    "fetch",
                    "jwt",
                    "-socketPath",
                    "/run/workload/api.sock",
                    "-audience",
                    "axiom-credential-broker",
                    "-spiffeID",
                    f"spiffe://local.axiomproof.test/agent/{agent_name}",
                    "-output",
                    "json",
                ],
                required=required,
            )

        print("Workload identity acceptance: attestation and verifier checks.", flush=True)
        for index, agent_name in enumerate(AGENTS):
            print(f"Workload identity acceptance: checking {agent_name}.", flush=True)
            issued = fetch(20001 + index, agent_name, required=False)
            for _ in range(10):
                if issued.returncode == 0:
                    break
                time.sleep(1)
                issued = fetch(20001 + index, agent_name, required=False)
            if issued.returncode:
                raise RuntimeError("registered UID attestation failed")
            payload = json.loads(issued.stdout)
            svids = next(part["svids"] for part in payload if "svids" in part)
            bundles = next(part["bundles"] for part in payload if "bundles" in part)
            expected = f"spiffe://local.axiomproof.test/agent/{agent_name}"
            if len(svids) != 1 or svids[0]["spiffe_id"] != expected:
                raise RuntimeError("unexpected identity")
            cases.append(
                {
                    "agent": agent_name,
                    "token": svids[0]["svid"],
                    "jwks": json.loads(
                        base64.b64decode(bundles["spiffe://local.axiomproof.test"], validate=True)
                    ),
                }
            )
            outcomes[agent_name + ".attestation"] = True
            other = "karya" if agent_name != "karya" else "drishti"
            if fetch(20001 + index, other, required=False).returncode == 0:
                raise RuntimeError("cross-agent identity accepted")
            outcomes[agent_name + ".foreign-uid-refusal"] = True
        if fetch(29999, "drishti", required=False).returncode == 0:
            raise RuntimeError("unregistered identity accepted")
        outcomes["unregistered-uid-refusal"] = True
        print("Workload identity acceptance: verifying signed identities in BFF.", flush=True)
        verified = json.loads(
            run(
                ["pnpm", "exec", "tsx", "scripts/verify-workload-identity.ts"],
                data=json.dumps({"cases": cases}),
            ).stdout
        )
        expected_outcomes = {
            agent + "." + check
            for agent in AGENTS
            for check in [
                "signature",
                "audience-refusal",
                "signature-refusal",
                "retired-bundle-refusal",
            ]
        }
        if (
            verified.get("passed") is not True
            or set(verified.get("outcomes", {})) != expected_outcomes
            or any(v is not True for v in verified["outcomes"].values())
        ):
            raise RuntimeError("verifier failed")
        outcomes.update(verified["outcomes"])
        if assessment:
            print("Workload assessment acceptance: isolated worker and real scoped persistence.", flush=True)
            worker_check = run(
                ["pnpm", "exec", "tsx", "scripts/verify-workload-assessment.ts"],
                data=json.dumps({"containerName": name, "jwks": cases[2]["jwks"]}), timeout=180, required=False,
            )
            if worker_check.returncode:
                import re
                label = re.fullmatch(r"Workload assessment failed at ([a-z-]+)\. Private output withheld\.\n", worker_check.stderr)
                if label:
                    print("Worker acceptance failure phase: " + label[1], flush=True)
                raise RuntimeError("worker acceptance failed")
            verified_worker = json.loads(worker_check.stdout)
            if verified_worker.get("passed") is not True:
                raise RuntimeError("worker acceptance failed")
            print(f"Workload assessment passed: {len(verified_worker['outcomes'])} outcomes.", flush=True)
        result_path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "kind": "isolated-workload-identity",
                    "passed": True,
                    "spireVersion": VERSION,
                    "revision": run(["git", "rev-parse", "HEAD"]).stdout.strip(),
                    "dirty": bool(run(["git", "status", "--porcelain"]).stdout),
                    "outcomes": outcomes,
                },
                indent=2,
            )
            + "\n"
        )
        print(
            f"Isolated SPIRE/BFF verification passed: {len(outcomes)} outcomes. No production identity or client access was enabled."
        )
    finally:
        if started:
            run(["docker", "rm", "-f", name], required=False)
        shutil.rmtree(temp)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Exception text can contain a failed subprocess's private output.
        print("Isolated workload identity acceptance failed. No private output was emitted.")
        raise SystemExit(1) from None
