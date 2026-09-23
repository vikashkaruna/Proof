#!/usr/bin/env python3
"""Real separate SPIRE issuer/node persistence and Docker image admission.

Local join-token attestation substitutes ONLY for GCP IIT. Production configs are
validated with pinned SPIRE binaries; real GCP attestation remains a deployment
gate. No application credentials, client data, or registration activation.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import traceback
import uuid
from pathlib import Path

from lib.spire_deployment import RELEASE_SHA256, SERVER_SOCKET, VERSION, WORKLOAD_SOCKET, deployment_bundle

ROOT = Path(__file__).resolve().parents[1]
IMAGE = "alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8"


def run(args: list[str], *, data: str | None = None, required: bool = True, timeout: int = 60) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(args, input=data, capture_output=True, text=True, cwd=ROOT, timeout=timeout, check=False)
    if required and result.returncode:
        raise RuntimeError("SPIRE deployment acceptance command refused")
    return result


def normalized(value: object) -> object:
    """Registry output order is not an identity or persistence guarantee."""
    if isinstance(value, dict):
        return {key: normalized(item) for key, item in value.items()}
    if isinstance(value, list):
        return sorted((normalized(item) for item in value), key=lambda item: json.dumps(item, sort_keys=True))
    return value


def main() -> None:
    os.umask(0o077)
    state = ROOT / ".axiom-runtime/spire-deployment"
    state.mkdir(parents=True, exist_ok=True)
    output = state / "results.json"
    output.unlink(missing_ok=True)
    temp = Path(tempfile.mkdtemp(prefix="run-", dir=state))
    # Linux bind mounts preserve the host runner's UID. Capability-less root
    # must be able to read these PUBLIC fixture inputs without DAC overrides.
    # No token/private key is ever stored here; node/issuer state stays in their
    # separate private volumes. Production review bundles remain mode 0600.
    temp.chmod(0o755)
    prefix = "axiom-spire-deploy-" + uuid.uuid4().hex[:12]
    issuer, node, network = prefix + "-issuer", prefix + "-node", prefix + "-net"
    volumes = [prefix + suffix for suffix in ("-issuer-state", "-node-state", "-api")]
    wrong_tag = prefix + ":wrong-image"
    outcomes: dict[str, bool] = {}
    created_volumes: list[str] = []
    probes: list[str] = []
    try:
        print("SPIRE deployment acceptance: verified release and separate hosts.", flush=True)
        architecture = run(["docker", "info", "--format", "{{.Architecture}}"]).stdout.strip()
        arch = {"aarch64": "arm64", "arm64": "arm64", "x86_64": "amd64", "amd64": "amd64"}.get(architecture)
        if arch not in RELEASE_SHA256:
            raise RuntimeError("unsupported architecture")
        archive = ROOT / f".axiom-runtime/workload-identity/spire-{VERSION}-linux-{arch}-musl.tar.gz"
        if not archive.exists():
            archive = temp / "spire.tar.gz"
            run(["curl", "--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--tlsv1.2", "--max-time", "180", f"https://github.com/spiffe/spire/releases/download/v{VERSION}/spire-{VERSION}-linux-{arch}-musl.tar.gz", "--output", str(archive)], timeout=190)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != RELEASE_SHA256[arch]:
            raise RuntimeError("release checksum mismatch")
        with tarfile.open(archive) as source:
            for binary in ("spire-server", "spire-agent"):
                member = source.getmember(f"spire-{VERSION}/bin/{binary}")
                if not member.isfile():
                    raise RuntimeError("release member refused")
                stream = source.extractfile(member)
                if stream is None:
                    raise RuntimeError("missing binary")
                (temp / binary).write_bytes(stream.read())
                (temp / binary).chmod(0o755)
        if run(["docker", "image", "inspect", IMAGE], required=False).returncode:
            run(["docker", "pull", IMAGE], timeout=180)
        image = run(["docker", "image", "inspect", IMAGE, "--format", "{{.Id}}"]).stdout.strip()
        run(["docker", "build", "-t", wrong_tag, "-"], data=f"FROM {IMAGE}\nLABEL axiom.acceptance.variant=wrong-image\n", timeout=120)
        wrong_image = run(["docker", "image", "inspect", wrong_tag, "--format", "{{.Id}}"]).stdout.strip()
        if image == wrong_image:
            raise RuntimeError("distinct images required")
        policy = {
            "schemaVersion": 1, "trustDomain": "deployment.axiomproof.test",
            "projectId": "axiom-local-test", "runnerInstanceId": "1234567890",
            "issuerPrivateIp": "10.23.0.10", "controllerImageConfigDigest": wrong_image,
            "assessmentImageConfigDigest": image,
        }
        bundle = deployment_bundle(policy)
        for filename, content in bundle.items():
            (temp / filename).write_text(content)
        # Test transport/attestation substitution; production renderer has no
        # join-token switch, hostname override or arbitrary plugin interface.
        (temp / "server-test.conf").write_text(bundle["server.conf"].replace('bind_address = "10.23.0.10"', 'bind_address = "0.0.0.0"').replace('NodeAttestor "gcp_iit" { plugin_data { projectid_allow_list = ["axiom-local-test"] use_instance_metadata = false } }', 'NodeAttestor "join_token" { plugin_data {} }'))
        (temp / "agent-test.conf").write_text(bundle["agent.conf"].replace('server_address = "10.23.0.10"', 'server_address = "issuer"').replace('NodeAttestor "gcp_iit"', 'NodeAttestor "join_token"'))
        for config in temp.glob("*.conf"):
            config.chmod(0o644)
        for volume in volumes:
            run(["docker", "volume", "create", volume])
            created_volumes.append(volume)
        run(["docker", "network", "create", "--internal", network])

        def start_host(name: str, is_node: bool) -> None:
            mounts = ["--mount", f"type=bind,src={temp},dst=/etc/axiom/spire,readonly"]
            for binary in ("spire-agent",) if is_node else ("spire-server",):
                mounts += ["--mount", f"type=bind,src={temp / binary},dst=/usr/local/bin/{binary},readonly"]
            mounts += ["--mount", f"type=volume,src={volumes[1 if is_node else 0]},dst=/var/lib/spire/{'agent' if is_node else 'server'}"]
            if is_node:
                # Only the trusted node sees host PIDs/cgroups and daemon.
                mounts += ["--pid", "host", "--cgroupns", "host", "--mount", "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock,readonly", "--mount", f"type=volume,src={volumes[2]},dst=/run/workload"]
            run(["docker", "run", "-d", "--name", name, "--network", network, "--network-alias", "node" if is_node else "issuer", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--log-driver", "none", "--memory", "256m", "--pids-limit", "128", "--tmpfs", "/run:rw,nosuid,nodev,noexec,size=8m", *mounts, "--entrypoint", "sleep", image, "1200"])

        def wait(name: str, binary: str, socket: str) -> None:
            for _ in range(30):
                if run(["docker", "exec", name, binary, "healthcheck", "-socketPath", socket], required=False, timeout=5).returncode == 0:
                    return
                time.sleep(1)
            raise RuntimeError("SPIRE host startup failed")

        def launch_server() -> None:
            run(["docker", "exec", "-d", issuer, "spire-server", "run", "-config", "/etc/axiom/spire/server-test.conf"])
            wait(issuer, "spire-server", SERVER_SOCKET)

        def launch_node(first: bool = False) -> None:
            run(["docker", "exec", node, "sh", "-c", "mkdir -p /run/spire-admin /run/workload; chmod 700 /run/spire-admin; chmod 755 /run/workload"])
            command = ["docker", "exec", "-d", node, "spire-agent", "run", "-config", "/etc/axiom/spire/agent-test.conf"]
            if first:
                command += ["-joinTokenFile", "/run/join-token"]
            run(command)
            wait(node, "spire-agent", WORKLOAD_SOCKET)

        start_host(issuer, False)
        start_host(node, True)
        for name, binary, config in ((issuer, "spire-server", "server.conf"), (node, "spire-agent", "agent.conf")):
            run(["docker", "exec", name, binary, "validate", "-config", f"/etc/axiom/spire/{config}"])
        outcomes["production-gcp-configs-validate-with-pinned-spire"] = True
        launch_server()
        server = ["docker", "exec", issuer, "spire-server"]
        bootstrap = run(server + ["bundle", "show", "-socketPath", SERVER_SOCKET, "-format", "pem"]).stdout
        (temp / "bootstrap.pem").write_text(bootstrap)
        (temp / "bootstrap.pem").chmod(0o644)
        # /spire/agent is reserved for node attestors and cannot be used as a
        # join-token alias. Substitute only this parent in the local fixture.
        parent = "spiffe://deployment.axiomproof.test/node/acceptance"
        token = json.loads(run(server + ["token", "generate", "-socketPath", SERVER_SOCKET, "-spiffeID", parent, "-output", "json"]).stdout)["value"]
        run(["docker", "exec", "-i", node, "sh", "-c", "umask 077; cat > /run/join-token"], data=token)
        launch_node(True)
        run(["docker", "exec", node, "rm", "/run/join-token"])
        registrations = json.loads(bundle["registration-argv.json"])
        for command in registrations:
            command[command.index("-parentID") + 1] = parent
            run(["docker", "exec", issuer, *command])
        foreign = registrations[1].copy()
        foreign[foreign.index("-parentID") + 1] = parent + "-foreign"
        foreign[foreign.index("-spiffeID") + 1] = "spiffe://deployment.axiomproof.test/agent/foreign-node"
        run(["docker", "exec", issuer, *foreign])

        def fetch(uid: int = 20003, selected: str = image, path: str = "agent/parikshan", *, accepted: bool) -> None:
            # A killed CLI transport must not strand an unnamed fixture process.
            probe = prefix + f"-probe-{len(probes)}"
            probes.append(probe)
            command = ["docker", "run", "--rm", "--name", probe, "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--log-driver", "none", "--user", str(uid), "--mount", f"type=volume,src={volumes[2]},dst=/run/workload,readonly", "--mount", f"type=bind,src={temp / 'spire-agent'},dst=/usr/local/bin/spire-agent,readonly", "--entrypoint", "timeout", selected, "10", "spire-agent", "api", "fetch", "jwt", "-socketPath", WORKLOAD_SOCKET, "-audience", "axiom-assessment-tools", "-spiffeID", f"spiffe://deployment.axiomproof.test/{path}", "-output", "json"]
            result = run(command, required=False, timeout=15)
            if accepted:
                for _ in range(12):
                    if result.returncode == 0:
                        break
                    time.sleep(1)
                    result = run(command, required=False, timeout=15)
                if result.returncode:
                    raise RuntimeError("registered image refused")
                payload = json.loads(result.stdout)
                svids = next(part["svids"] for part in payload if "svids" in part)
                if len(svids) != 1 or svids[0]["spiffe_id"] != f"spiffe://deployment.axiomproof.test/{path}":
                    raise RuntimeError("unexpected workload identity")
            elif result.returncode == 0:
                raise RuntimeError("unregistered image admitted")

        print("SPIRE deployment acceptance: node, UID and immutable-image boundaries.", flush=True)
        fetch(accepted=True)
        outcomes["exact-node-uid-image-assessment-admitted"] = True
        fetch(20000, wrong_image, "controller/assessment", accepted=True)
        outcomes["separate-controller-image-and-uid-admitted"] = True
        fetch(selected=wrong_image, accepted=False)
        outcomes["same-uid-wrong-image-refused"] = True
        fetch(uid=20004, accepted=False)
        outcomes["same-image-wrong-uid-refused"] = True
        fetch(path="agent/foreign-node", accepted=False)
        outcomes["same-uid-image-wrong-node-parent-refused"] = True
        fetch(20000, image, "controller/assessment", accepted=False)
        outcomes["assessment-image-cannot-acquire-controller-identity"] = True
        fetch(20003, wrong_tag, accepted=False)
        outcomes["mutable-tag-cannot-bypass-config-digest"] = True

        print("SPIRE deployment acceptance: persistent issuer and node restart.", flush=True)
        before_entries = json.loads(run(server + ["entry", "show", "-socketPath", SERVER_SOCKET, "-output", "json"]).stdout)
        # SPIFFE format includes JWT signing keys as well as X.509 roots.
        before_bundle = json.loads(run(server + ["bundle", "show", "-socketPath", SERVER_SOCKET, "-format", "spiffe"]).stdout)
        run(["docker", "rm", "-f", issuer])
        fetch(accepted=True)
        # This is a demonstrated LIMIT, not a readiness check. A live local
        # Workload API alone cannot establish issuer availability/freshness.
        outcomes["issuer-offline-cached-identity-demonstrates-health-gap"] = True
        start_host(issuer, False)
        launch_server()
        if normalized(json.loads(run(server + ["entry", "show", "-socketPath", SERVER_SOCKET, "-output", "json"]).stdout)) != normalized(before_entries):
            raise RuntimeError("registration persistence failed")
        if normalized(json.loads(run(server + ["bundle", "show", "-socketPath", SERVER_SOCKET, "-format", "spiffe"]).stdout)) != normalized(before_bundle):
            raise RuntimeError("issuer trust changed on restart")
        outcomes["issuer-recreation-preserves-registry-and-trust"] = True
        run(["docker", "rm", "-f", node])
        start_host(node, True)
        launch_node()  # No token, no re-enrollment or replacement key state.
        fetch(accepted=True)
        fetch(selected=wrong_image, accepted=False)
        outcomes["node-recreation-recovers-without-bootstrap-token"] = True
        outcomes["image-admission-survives-both-host-restarts"] = True
        # Host boundaries are inspected without exposing environment/selectors.
        for name, is_node in ((issuer, False), (node, True)):
            inspected = json.loads(run(["docker", "inspect", name]).stdout)[0]
            destinations = {item["Destination"] for item in inspected["Mounts"]}
            if is_node:
                if "/var/lib/spire/server" in destinations or inspected["HostConfig"]["PidMode"] != "host":
                    raise RuntimeError("node boundary failed")
            elif "/var/run/docker.sock" in destinations or "/var/lib/spire/agent" in destinations or inspected["HostConfig"]["PidMode"] == "host":
                raise RuntimeError("issuer boundary failed")
            if inspected["HostConfig"]["NetworkMode"] != network or inspected["HostConfig"]["PortBindings"]:
                raise RuntimeError("host network boundary failed")
        outcomes["separate-host-state-and-admin-boundaries"] = True
        print("SPIRE deployment acceptance: missing node state refuses recovery.", flush=True)
        run(["docker", "rm", "-f", node])
        original_volume = volumes[1]
        volumes[1] = prefix + "-empty-node-state"
        run(["docker", "volume", "create", volumes[1]])
        created_volumes.append(volumes[1])
        start_host(node, True)
        # The agent can retry attestation, but must not regain workload
        # authority. Probe while it is running, not after stopping its process.
        run(["docker", "exec", "-d", node, "spire-agent", "run", "-config", "/etc/axiom/spire/agent-test.conf"])
        for _ in range(5):
            time.sleep(1)
            if run(["docker", "exec", node, "spire-agent", "healthcheck", "-socketPath", WORKLOAD_SOCKET], required=False, timeout=5).returncode == 0:
                raise RuntimeError("empty node state exposed a healthy Workload API")
        fetch(accepted=False)
        run(["docker", "rm", "-f", node])
        volumes[1] = original_volume
        start_host(node, True)
        launch_node()
        fetch(accepted=True)
        outcomes["missing-node-state-refused-with-original-state-recoverable"] = True
        output.write_text(json.dumps({
            "revision": run(["git", "rev-parse", "HEAD"]).stdout.strip(),
            "dirty": bool(run(["git", "status", "--porcelain"]).stdout.strip()),
            "passed": True, "spire_version": VERSION,
            "attestation": "local-join-token-not-gcp", "outcomes": outcomes,
        }, indent=2) + "\n")
        print(f"SPIRE deployment acceptance: {len(outcomes)} outcomes passed.", flush=True)
    finally:
        for probe in probes:
            run(["docker", "rm", "-f", probe], required=False)
        for name in (node, issuer):
            run(["docker", "rm", "-f", name], required=False)
        run(["docker", "network", "rm", network], required=False)
        for volume in reversed(created_volumes):
            run(["docker", "volume", "rm", volume], required=False)
        run(["docker", "image", "rm", wrong_tag], required=False)
        shutil.rmtree(temp, ignore_errors=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        locations = [f"{frame.name}:{frame.lineno}" for frame in traceback.extract_tb(error.__traceback__) if frame.filename == __file__]
        print(f"SPIRE deployment acceptance failed at {' / '.join(locations)}; private diagnostics withheld.", file=sys.stderr)
        sys.exit(1)
