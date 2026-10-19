#!/usr/bin/env python3
"""Isolated real SPIRE attestation + BFF verifier acceptance; no application activation.

Requires Docker, pnpm, curl and Python 3.12+. Only allowlisted outcomes leave this
process. Synthetic tokens travel in subprocess memory/stdin, never argv/logs/files.
The issuer has no network, Docker socket or backend credentials. In assessment
mode only the trusted node issuer uses host PID visibility for cross-container
attestation; every job has its own PID namespace and only a read-only API socket.
"""

from __future__ import annotations

import base64
import ctypes
import hashlib
import json
import os
import shutil
import signal
import stat
import platform
import re
import subprocess  # nosec B404 - fixture runner for pinned local docker CLIs; list argv, no shell
import sys
import tarfile
import tempfile
import time
import uuid
from pathlib import Path
from lib.ci_fixture_images import fixture_image, report_public_image_startup

ROOT = Path(__file__).resolve().parents[1]
VERSION = "1.15.3"
HASHES = {
    "arm64": "a9982b3ca7de489def22265fd4586d8e13091ecb6fddf6adcea9291313b18886",
    "amd64": "ca1a4d1155317bdd2afc7f36663828a10410c7c840e54725b90b4064b0a301c7",
}
IMAGE = fixture_image("alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8")
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


def owned_process_birth(pid: int) -> str | None:
    """Kernel birth identity, not wall-clock-second ps output or a process name."""
    if pid <= 1:
        raise RuntimeError("owned process identity refused")
    if platform.system() == "Linux":
        try:
            fields = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()
            ticks = fields[19]
            boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
            if not ticks.isdecimal() or not re.fullmatch(r"[a-f0-9-]{36}", boot):
                raise RuntimeError("owned process birth refused")
            return f"linux:{boot}:{ticks}"
        except FileNotFoundError:
            return None
    if platform.system() == "Darwin":
        # macOS SDK sys/proc_info.h proc_bsdinfo, PROC_PIDTBSDINFO=3.
        class BsdInfo(ctypes.Structure):
            _fields_ = [("prefix", ctypes.c_uint32 * 12), ("comm", ctypes.c_char * 16),
                        ("name", ctypes.c_char * 32), ("counts", ctypes.c_uint32 * 5),
                        ("nice", ctypes.c_int32), ("seconds", ctypes.c_uint64),
                        ("microseconds", ctypes.c_uint64)]
        info = BsdInfo()
        library = ctypes.CDLL("/usr/lib/libproc.dylib")
        library.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
        library.proc_pidinfo.restype = ctypes.c_int
        size = library.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))
        if size == ctypes.sizeof(info) and info.prefix[3] == pid:
            return f"darwin:{info.seconds}:{info.microseconds}"
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return None
    raise RuntimeError("owned process birth unavailable")


def read_owned_browser_json(path: Path) -> dict:
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077 or metadata.st_size > 65536:
        raise RuntimeError("owned browser file refused")
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate key")
            result[key] = value
        return result
    value = json.loads(path.read_text(), object_pairs_hook=pairs)
    if not isinstance(value, dict):
        raise RuntimeError("owned browser file refused")
    return value


def owned_browser_launch_config(directory: Path, nonce: str, code_sha: str) -> dict:
    directory = Path(directory)
    if directory.resolve() != directory or not directory.is_dir() or directory.stat().st_mode & 0o077:
        raise RuntimeError("owned browser directory refused")
    if not re.fullmatch(r"[a-f0-9]{32}", nonce) or not re.fullmatch(r"[a-f0-9]{40}", code_sha):
        raise RuntimeError("owned browser scope refused")
    if directory == ROOT / ".axiom-runtime":
        raise RuntimeError("owned browser directory refused")
    directory.relative_to(ROOT / ".axiom-runtime")
    value = read_owned_browser_json(directory / "launch-config.private.json")
    if set(value) != {"version", "nonce", "codeSha", "root", "node", "python", "next", "chromium"} or value["version"] != 1 or value["nonce"] != nonce or value["codeSha"] != code_sha or value["root"] != str(ROOT):
        raise RuntimeError("owned browser configuration refused")
    if value["python"]["path"] != str(Path(sys.executable).resolve()):
        raise RuntimeError("owned Python executable refused")
    actual = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True, timeout=5).stdout.strip()  # nosec B603 B607 - fixed read-only source identity
    if actual != code_sha:
        raise RuntimeError("owned browser source changed")
    return value


def register_owned_browser_group(directory: Path, nonce: str, code_sha: str, kind: str) -> dict:
    if kind not in {"next", "chromium"} or os.getpid() <= 1 or os.getpgrp() != os.getpid():
        raise RuntimeError("owned browser group refused")
    birth = owned_process_birth(os.getpid())
    if not birth:
        raise RuntimeError("owned browser birth refused")
    value = {"version": 1, "nonce": nonce, "codeSha": code_sha, "kind": kind,
             "pid": os.getpid(), "pgid": os.getpgrp(), "birth": birth}
    path = Path(directory) / f"group-{os.getpid()}.private.json"
    with open(path, "x", opener=lambda name, flags: os.open(name, flags, 0o600)) as output:
        output.write(json.dumps(value))
    return value


def cleanup_owned_browser_groups(directory: Path, nonce: str, code_sha: str, grace: float = 3) -> dict:
    if not 0 <= grace <= 3:
        raise RuntimeError("owned cleanup bound refused")
    paths = sorted(Path(directory).glob("group-*.private.json"))
    if len(paths) > 16:
        raise RuntimeError("owned browser group count refused")
    # Validate EVERY record before sending ANY signal. No names, ports, argv or
    # environment searches establish ownership, and stale PID reuse is refused.
    records = []
    for path in paths:
        value = read_owned_browser_json(path)
        if set(value) != {"version", "nonce", "codeSha", "kind", "pid", "pgid", "birth"} or value["version"] != 1 or value["nonce"] != nonce or value["codeSha"] != code_sha or value["kind"] not in {"next", "chromium"} or type(value["pid"]) is not int or value["pid"] <= 1 or value["pgid"] != value["pid"] or path.name != f"group-{value['pid']}.private.json":
            raise RuntimeError("owned browser registry refused")
        birth = owned_process_birth(value["pid"])
        if birth is not None and (birth != value["birth"] or os.getpgid(value["pid"]) != value["pgid"]):
            raise RuntimeError("owned browser stale identity refused")
        if birth is not None:
            records.append(value)
        else:
            try:
                os.killpg(value["pgid"], 0)
            except ProcessLookupError:
                continue
            raise RuntimeError("owned browser group lost its birth identity")
    for value in records:
        try:
            os.killpg(value["pgid"], signal.SIGINT)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + grace
    while time.monotonic() < deadline and any(owned_process_birth(v["pid"]) is not None for v in records):
        time.sleep(0.05)
    for value in records:
        birth = owned_process_birth(value["pid"])
        if birth is not None:
            if birth != value["birth"] or os.getpgid(value["pid"]) != value["pgid"]:
                raise RuntimeError("owned browser cleanup identity changed")
            try:
                os.killpg(value["pgid"], signal.SIGKILL)
            except ProcessLookupError:
                pass
    return {"registeredGroups": len(paths), "signalledGroups": len(records)}


def launch_owned_browser(kind: str, directory: Path, nonce: str, code_sha: str, arguments: list[str]) -> None:
    config = owned_browser_launch_config(directory, nonce, code_sha)
    selected = ["python", "node", "next"] if kind == "next" else ["python", "chromium"] if kind == "chromium" else []
    if not selected:
        raise RuntimeError("owned browser executable refused")
    for name in selected:
        entry = config[name]
        if not isinstance(entry, dict) or set(entry) != {"path", "sha256"} or not isinstance(entry["path"], str):
            raise RuntimeError("owned browser executable refused")
        path = Path(entry["path"])
        if not path.is_absolute() or path.resolve() != path or not path.is_file():
            raise RuntimeError("owned browser executable changed")
        with path.open("rb") as binary:
            if hashlib.file_digest(binary, "sha256").hexdigest() != entry["sha256"]:
                raise RuntimeError("owned browser executable changed")
    register_owned_browser_group(directory, nonce, code_sha, kind)
    if kind == "next":
        if arguments:
            raise RuntimeError("owned Next arguments refused")
        command = [config["node"]["path"], config["next"]["path"]]
        subprocess.run(command + ["build"], cwd=ROOT / "apps/web", check=True, timeout=120)  # nosec B603 - exact hash-bound executable and fixed arguments
        os.chdir(ROOT / "apps/web")
        os.execv(command[0], command + ["start", "--port", "3301"])  # nosec B606 - exact hash-bound local fixture executable
    else:
        if "--remote-debugging-pipe" not in arguments:
            raise RuntimeError("owned Chromium transport refused")
        # Playwright supplies CDP pipes as fd3/fd4. Preserve these existing
        # inherited pipes across Python exec; never redirect or reconstruct them.
        for descriptor in (3, 4):
            os.fstat(descriptor)
            os.set_inheritable(descriptor, True)
        os.execv(config["chromium"]["path"], [config["chromium"]["path"], *arguments])  # nosec B606 - exact hash-bound Chromium binary; Playwright supplies its launch arguments


def run_owned_verifier(args: list[str], data: str | None, timeout: int) -> subprocess.CompletedProcess[str]:
    """One owned session; original operational timeout plus bounded cleanup."""
    child = subprocess.Popen(  # nosec B603 - exact repository fixture argv, no shell
        args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, cwd=ROOT, start_new_session=True,
    )
    owned_group = child.pid
    if owned_group <= 1 or os.getpgid(child.pid) != owned_group:
        child.kill()
        child.communicate()
        raise RuntimeError("owned verifier process group refused")
    try:
        stdout, stderr = child.communicate(input=data, timeout=timeout)
        return subprocess.CompletedProcess(args, child.returncode, stdout, stderr)
    finally:
        try:
            os.killpg(owned_group, signal.SIGINT)
        except ProcessLookupError:
            pass
        try:
            child.communicate(timeout=3)
        except subprocess.TimeoutExpired:
            pass
        try:
            if os.environ.get("AXIOM_REGISTERED_WEBSITE_BROWSER") == "true":
                directory = Path(os.environ["AXIOM_REGISTERED_WEBSITE_BROWSER_DIRECTORY"])
                if (directory / "launch-config.private.json").exists():
                    config = read_owned_browser_json(directory / "launch-config.private.json")
                    owned_browser_launch_config(directory, config["nonce"], config["codeSha"])
                    cleanup_owned_browser_groups(directory, config["nonce"], config["codeSha"])
        finally:
            try:
                os.killpg(owned_group, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.communicate()


class IsolatedCommandFailure(RuntimeError):
    """Only the public exit code is retained; no command/output/private input."""

    def __init__(self, returncode: int):
        super().__init__("isolated command failed")
        self.returncode = returncode


def prepare_spire_release(archive: Path, temp: Path, arch: str) -> None:
    """Original pinned release gates, with bounded allowlisted diagnostics only."""
    phase = "archive_state"
    try:
        if not archive.exists():
            download = temp / "download.tar.gz"
            phase = "download"
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
            phase = "download_checksum"
            if hashlib.sha256(download.read_bytes()).hexdigest() != HASHES[arch]:
                raise RuntimeError("release checksum mismatch")
            phase = "archive_publish"
            download.replace(archive)
        phase = "archive_checksum"
        if hashlib.sha256(archive.read_bytes()).hexdigest() != HASHES[arch]:
            raise RuntimeError("release checksum mismatch")
        phase = "archive_open"
        with tarfile.open(archive) as source:
            # Extract only the two reviewed executable members, not archive scripts/config.
            for executable in ["spire-server", "spire-agent"]:
                phase = "member_select"
                member = source.getmember(f"spire-{VERSION}/bin/{executable}")
                if not member.isfile():
                    raise RuntimeError("invalid release member")
                phase = "member_read"
                stream = source.extractfile(member)
                if stream is None:
                    raise RuntimeError("missing executable")
                dest = temp / executable
                content = stream.read()
                phase = "executable_write"
                dest.write_bytes(content)
                phase = "executable_mode"
                dest.chmod(0o755)
    except Exception as error:
        # Exception text/args and subprocess output can contain credentials.
        if isinstance(error, IsolatedCommandFailure):
            kind = "command_exit"
        elif isinstance(error, subprocess.TimeoutExpired):
            kind = "timeout"
        elif isinstance(error, OSError):
            kind = "io"
        elif isinstance(error, tarfile.TarError):
            kind = "archive_format"
        elif isinstance(error, KeyError):
            kind = "missing_member"
        elif isinstance(error, RuntimeError):
            kind = "validation"
        else:
            kind = "unexpected"
        code = error.returncode if isinstance(error, IsolatedCommandFailure) else None
        if type(code) is not int or not -255 <= code <= 255:
            code = None
        print(
            "Workload release setup failure: "
            + json.dumps(
                {
                    "phase": phase,
                    "commandId": "spire-release-download"
                    if phase == "download"
                    else "none",
                    "errorKind": kind,
                    "exitCode": code,
                },
                sort_keys=True,
            ),
            flush=True,
        )
        raise


def run(
    args: list[str], *, data: str | None = None, required: bool = True, timeout: int = 60
) -> subprocess.CompletedProcess[str]:
    result = (
        run_owned_verifier(args, data, timeout)
        if args == ["pnpm", "exec", "tsx", "scripts/verify-workload-assessment.ts"]
        else subprocess.run(  # nosec B603 - every call site passes fixed repo/docker argv, no shell
            args, input=data, capture_output=True, text=True, cwd=ROOT, timeout=timeout, check=False
        )
    )
    if required and result.returncode:
        report_public_image_startup(args, result.stderr)
        # Never relay command arguments, stderr or stdout containing identity material.
        raise IsolatedCommandFailure(result.returncode)
    return result


def worker_failure_phase(stderr: str) -> str | None:
    """Extract one fixed phase label, never relay surrounding private output."""
    if len(stderr) > 1048576:
        return None
    phases = set()
    for line in stderr.splitlines():
        label = re.fullmatch(
            r"Workload assessment failed at ([a-z0-9-]{1,100})\. Private output withheld\.",
            line,
        )
        if label:
            phases.add(label[1])
    return next(iter(phases)) if len(phases) == 1 else None


def main() -> None:
    os.umask(0o077)
    state = ROOT / ".axiom-runtime" / "workload-identity"
    state.mkdir(parents=True, exist_ok=True)
    result_path = state / "results.json"
    result_path.unlink(missing_ok=True)
    temp = Path(tempfile.mkdtemp(prefix="run-", dir=state))
    name = "axiom-spire-test-" + uuid.uuid4().hex[:12]
    started = False
    api_volume = "axiom-workload-api-" + uuid.uuid4().hex
    health_volume = "axiom-spire-health-" + uuid.uuid4().hex
    volume_created = False
    assessment = sys.argv[1:] == ["--assessment"]
    if assessment:
        (ROOT / ".axiom-runtime/workload-assessment/results.json").unlink(missing_ok=True)
        (ROOT / ".axiom-runtime/workload-trust/results.json").unlink(missing_ok=True)
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
        prepare_spire_release(archive, temp, arch)
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
 admin_socket_path = "/run/spire-admin/api.sock"
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
            trust_image = "axiom-workload-trust:acceptance"
            run(["docker", "build", "--target", "workload-trust-acceptance", "-f", "infra/docker/Dockerfile.bff", "-t", trust_image, "."], timeout=300)
            trust_image_id = run(["docker", "image", "inspect", trust_image, "--format", "{{.Id}}"]).stdout.strip()
            controller_image = "axiom-vm-controller:acceptance"
            run(["docker", "build", "--target", "vm-controller-acceptance", "-f", "infra/docker/Dockerfile.bff", "-t", controller_image, "."], timeout=300)
            controller_image_id = run(["docker", "image", "inspect", controller_image, "--format", "{{.Id}}"]).stdout.strip()
        node_options = []
        if assessment:
            run(["docker", "volume", "create", api_volume])
            run(["docker", "volume", "create", health_volume])
            volume_created = True
            node_options = ["--pid", "host", "--mount", f"type=volume,src={api_volume},dst=/run/workload", "--mount", f"type=volume,src={health_volume},dst=/run/spire-health"]
        run(
            ["docker", "run", "-d", "--name", name, "--network", "none", *node_options, "--user", "0", "--entrypoint", "sleep", selected_image, "1200"],
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
        if assessment:
            node_info = json.loads(run(["docker", "exec", name, "spire-agent", "debug", "getinfo", "-socketPath", "/run/spire-admin/api.sock", "-output", "json"]).stdout)
            identity = node_info["svid_chain"][0]["id"]
            issuer_node_id = f"spiffe://{identity['trust_domain']}{identity['path']}"
            run(["docker", "cp", str(ROOT / "infra/workload/spire_health.py"), f"{name}:/root/spire_health.py"])
            run(["docker", "exec", name, "python", "/root/spire_health.py", "--once", issuer_node_id])
            run(["docker", "exec", "-d", name, "python", "/root/spire_health.py", "--watch", issuer_node_id])
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
        if assessment:
            run(prefix + ["entry", "create", "-socketPath", "/run/server/api.sock",
                "-parentID", "spiffe://local.axiomproof.test/node/acceptance",
                "-spiffeID", "spiffe://local.axiomproof.test/controller/assessment",
                "-selector", "unix:uid:20000", "-jwtSVIDTTL", "300"])
        cases = []
        outcomes: dict[str, bool] = {}
        trust_outcomes: dict[str, bool] = {}

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
            print("Workload trust acceptance: protected controller socket reads.", flush=True)
            def check_trust(mode: str, uid: int):
                print("Workload trust acceptance: " + mode + ".", flush=True)
                checked = run(["docker", "run", "--rm", "--pull", "never", "-i",
                    "--network", "none", "--read-only", "--cap-drop", "ALL",
                    "--security-opt", "no-new-privileges:true", "--pids-limit", "64",
                    "--memory", "256m", "--memory-swap", "256m", "--cpus", "1",
                    "--log-driver", "none", "--user", str(uid), "--env", "TSX_DISABLE_CACHE=1",
                    "--mount", f"type=volume,src={api_volume},dst=/run/workload,readonly",
                    "--entrypoint", "node", trust_image_id, "--import", "/app/node_modules/tsx/dist/loader.mjs",
                    "/app/scripts/verify-workload-trust.ts"],
                    data=json.dumps({"mode": mode, "token": cases[2]["token"]}), timeout=30, required=False)
                if checked.returncode:
                    import re
                    label = re.fullmatch(r"Protected Workload API acceptance refused at ([a-z-]{1,30})\.\n", checked.stderr)
                    if label:
                        print("Workload trust acceptance failure phase: " + label[1], flush=True)
                    elif "ERR_MODULE_NOT_FOUND" in checked.stderr:
                        print("Workload trust acceptance module packaging failure.", flush=True)
                    elif "EROFS" in checked.stderr or "EACCES" in checked.stderr:
                        print("Workload trust acceptance filesystem refusal.", flush=True)
                    raise RuntimeError("protected trust acceptance failed")
                if json.loads(checked.stdout) != {"passed": True, "mode": mode}:
                    raise RuntimeError("protected trust acceptance failed")
            check_trust("registered", 20000)
            trust_outcomes["workload-api.registered-controller-bundle-verification"] = True
            trust_outcomes["workload-api.exact-controller-role-admission"] = True
            check_trust("wrong-role", 20003)
            trust_outcomes["workload-api.registered-worker-bundles-do-not-admit-controller"] = True
            check_trust("unregistered", 29999)
            trust_outcomes["workload-api.unregistered-controller-refusal"] = True
            run(["docker", "pause", name])
            try:
                check_trust("unavailable", 20000)
            finally:
                run(["docker", "unpause", name])
            trust_outcomes["workload-api.unavailable-node-refusal"] = True
            print("Workload assessment acceptance: isolated worker and real scoped persistence.", flush=True)
            worker_check = run(
                ["pnpm", "exec", "tsx", "scripts/verify-workload-assessment.ts"],
                data=json.dumps({
                    "containerName": name, "jwks": cases[2]["jwks"], "controllerImage": controller_image_id, "healthVolume": health_volume, "issuerNodeId": issuer_node_id,
                    "launcher": {
                        "executable": shutil.which("docker"),
                        "dockerHost": run(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]).stdout.strip(),
                        "image": run(["docker", "image", "inspect", selected_image, "--format", "{{.Id}}"]).stdout.strip(),
                        "workloadApiVolume": api_volume,
                    },
                }), timeout=900 if os.environ.get("AXIOM_REGISTERED_WEBSITE_BROWSER") == "true" else 360, required=False,
            )
            if worker_check.returncode:
                label = worker_failure_phase(worker_check.stderr)
                if label:
                    print("Worker acceptance failure phase: " + label, flush=True)
                raise RuntimeError("worker acceptance failed")
            verified_worker = json.loads(worker_check.stdout)
            if verified_worker.get("passed") is not True:
                raise RuntimeError("worker acceptance failed")
            print(f"Workload assessment passed: {len(verified_worker['outcomes'])} outcomes.", flush=True)
        if assessment:
            trust_result = ROOT / ".axiom-runtime/workload-trust/results.json"
            trust_result.parent.mkdir(parents=True, exist_ok=True)
            trust_result.write_text(json.dumps({
                "schemaVersion": 1, "kind": "protected-workload-api-trust", "passed": True,
                "revision": run(["git", "rev-parse", "HEAD"]).stdout.strip(),
                "dirty": bool(run(["git", "status", "--porcelain"]).stdout),
                "outcomes": trust_outcomes,
            }, indent=2) + "\n")
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
        if volume_created:
            run(["docker", "volume", "rm", api_volume], required=False)
            run(["docker", "volume", "rm", health_volume], required=False)
        shutil.rmtree(temp)


if __name__ == "__main__":
    try:
        if len(sys.argv) >= 6 and sys.argv[1] == "--owned-browser-launch":
            launch_owned_browser(sys.argv[2], Path(sys.argv[3]), sys.argv[4], sys.argv[5], sys.argv[6:])
        elif len(sys.argv) == 5 and sys.argv[1] == "--cleanup-owned-browser-groups":
            selected = Path(sys.argv[2])
            owned_browser_launch_config(selected, sys.argv[3], sys.argv[4])
            print(json.dumps(cleanup_owned_browser_groups(selected, sys.argv[3], sys.argv[4])))
        else:
            main()
    except Exception:
        # Exception text can contain a failed subprocess's private output.
        print("Isolated workload identity acceptance failed. No private output was emitted.")
        raise SystemExit(1) from None
