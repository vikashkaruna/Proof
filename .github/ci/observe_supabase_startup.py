"""Observe hosted startup before CLI rollback removes exact-project containers.

Docker operations are events/inspect only. The pinned CLI assigns this label:
https://github.com/supabase/cli/blob/v2.116.0/apps/cli-go/internal/utils/docker.go
"""

import json
import os
import re
import subprocess
import threading
import time
import tomllib
from pathlib import Path

SERVICES = {
    "db": "postgres",
    "auth": "auth",
    "rest": "postgrest",
    "kong": "gateway",
    "storage": "storage",
    "inbucket": "mail",
    "realtime": "realtime",
    "edge_runtime": "edge-runtime",
    "pg_meta": "postgres-meta",
    "studio": "studio",
    "analytics": "analytics",
    "vector": "vector",
    "imgproxy": "image-proxy",
    "pooler": "pooler",
}
STATES = {"created", "running", "paused", "restarting", "removing", "exited", "dead"}
HEALTH = {"starting", "healthy", "unhealthy", "none"}
ACTIONS = {
    "create",
    "start",
    "die",
    "oom",
    "destroy",
    "health_status: starting",
    "health_status: healthy",
    "health_status: unhealthy",
}
LABEL = "com.supabase.cli.project"
BASE = ["docker", "--host", "unix:///var/run/docker.sock"]
EVENT_FORMAT = '{"id":{{json .Actor.ID}},"name":{{json .Actor.Attributes.name}},"project":{{json (index .Actor.Attributes "com.supabase.cli.project")}},"action":{{json .Action}},"exit":{{json .Actor.Attributes.exitCode}},"nano":{{json .TimeNano}}}'
INSPECT_FORMAT = '{"id":{{json .Id}},"name":{{json .Name}},"project":{{json (index .Config.Labels "com.supabase.cli.project")}},"status":{{json .State.Status}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}"none"{{end}},"exit":{{json .State.ExitCode}},"pid":{{json .State.Pid}},"oom":{{json .State.OOMKilled}}}'


class Trace:
    def __init__(self, project, start_nano=0):
        if not re.fullmatch(r"axiom-[a-z0-9-]+", project):
            raise ValueError("Invalid isolated observer project")
        if type(start_nano) is not int or not 0 <= start_nano <= 2**63 - 1:
            raise ValueError("Invalid observer subscription timestamp")
        self.project = project
        self.start_nano = start_nano
        self.started = time.monotonic()
        self.names = {
            "supabase_" + suffix + "_" + project: service
            for suffix, service in SERVICES.items()
        }
        self.rows = []
        self.last_nano = start_nano
        self.last_snapshot = {}
        self.instances = {}
        self.current = {}
        self.lock = threading.Lock()

    def owned(self, value, inspection=False):
        if not isinstance(value, dict) or value.get("project") != self.project:
            return None
        name = value.get("name")
        identity = value.get("id")
        if (
            not isinstance(name, str)
            or not isinstance(identity, str)
            or not re.fullmatch(r"[0-9a-f]{64}", identity)
        ):
            return None
        if inspection:
            name = name.removeprefix("/")
        return name if name in self.names else None

    def elapsed(self):
        return max(0, min(int((time.monotonic() - self.started) * 1000), 1200000))

    def add(self, row):
        with self.lock:
            if len(self.rows) < 4096:
                self.rows.append(row)

    def event(self, raw):
        if len(raw) > 16384:
            return None
        try:
            value = json.loads(raw)
        except (ValueError, RecursionError):
            return None
        name = self.owned(value)
        action = value.get("action") if isinstance(value, dict) else None
        if name is None or not isinstance(action, str) or action not in ACTIONS:
            return None
        nano = value.get("nano")
        if type(nano) is not int or not self.start_nano <= nano <= min(
            self.start_nano + 1200 * 10**9, 2**63 - 1
        ):
            return None
        identity = value["id"]
        with self.lock:
            if nano < self.last_nano or self.instances.get(identity, name) != name:
                return None
            self.last_nano = nano
            self.instances[identity] = name
            if action in {"create", "start"}:
                self.current[name] = identity
            if action == "destroy":
                self.instances.pop(identity, None)
                if self.current.get(name) == identity:
                    self.current.pop(name, None)
        row = {
            "source": "event",
            "project": self.project,
            "name": name,
            "service": self.names[name],
            "id": identity,
            "event": action,
            "event_nano": nano,
            "observed_ms": self.elapsed(),
        }
        code = value.get("exit")
        if (
            isinstance(code, str)
            and re.fullmatch(r"[0-9]{1,3}", code)
            and int(code) <= 255
        ):
            row["exit"] = int(code)
        self.add(row)
        return identity

    def snapshot(self, raw, expected_id):
        if (
            not isinstance(expected_id, str)
            or not re.fullmatch(r"[0-9a-f]{64}", expected_id)
            or len(raw) > 16384
        ):
            return
        try:
            value = json.loads(raw)
        except (ValueError, RecursionError):
            return
        name = self.owned(value, inspection=True)
        if (
            name is None
            or value["id"] != expected_id
            or not isinstance(value.get("status"), str)
            or value.get("status") not in STATES
            or not isinstance(value.get("health"), str)
            or value.get("health") not in HEALTH
        ):
            return
        row = {
            "source": "inspection",
            "project": self.project,
            "name": name,
            "service": self.names[name],
            "id": expected_id,
            "state": value["status"],
            "health": value["health"],
        }
        for key, bound in (("exit", 255), ("pid", 2**31 - 1)):
            number = value.get(key)
            if type(number) is int and 0 <= number <= bound:
                row[key] = number
        if type(value.get("oom")) is bool:
            row["oom"] = value["oom"]
        with self.lock:
            if (
                self.instances.get(expected_id) != name
                or self.last_snapshot.get(expected_id) == row
            ):
                return
            self.last_snapshot[expected_id] = row.copy()
        row["observed_ms"] = self.elapsed()
        self.add(row)

    def active_ids(self):
        with self.lock:
            return list(self.instances)


def environment():
    return {
        key: value for key, value in os.environ.items() if not key.startswith("DOCKER_")
    }


def inspect(trace, identity):
    if (
        not isinstance(identity, str)
        or not re.fullmatch(r"[0-9a-f]{64}", identity)
        or identity not in trace.active_ids()
    ):
        return
    try:
        result = subprocess.run(
            BASE
            + ["inspect", "--type", "container", "--format", INSPECT_FORMAT, identity],
            capture_output=True,
            text=True,
            check=False,
            timeout=2,
            env=environment(),
        )
        if result.returncode == 0:
            trace.snapshot(result.stdout, identity)
    except (OSError, subprocess.TimeoutExpired):
        pass


def observe_during(wait_cli, project, evidence):
    """Callback owns CLI flags/lifetime; preserve its exact return or exception.

    Preflight may refuse before the callback is invoked (there is no CLI verdict
    in that case). After invocation, observer failures never change its verdict. Observer children are
    stopped/reaped; no Docker container/project stop or reset is called.
    """
    trace = Trace(project, start_nano=time.time_ns())
    path = Path(evidence)
    if path.is_symlink() or path.exists() or path.parent.is_symlink():
        raise ValueError("Fresh private observer evidence required")
    if path.parent.stat().st_mode & 0o077:
        raise ValueError("Private observer evidence directory required")
    stop = threading.Event()
    watcher = None
    threads = []
    started = time.monotonic()
    since = str(trace.start_nano // 10**9)
    try:
        watcher = subprocess.Popen(
            BASE
            + [
                "events",
                "--since",
                since,
                "--filter",
                "type=container",
                "--filter",
                "label=" + LABEL + "=" + project,
                "--format",
                EVENT_FORMAT,
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            env=environment(),
        )

        def events():
            while not stop.is_set() and time.monotonic() - started < 1200:
                raw = watcher.stdout.readline(16385)
                if not raw:
                    break
                identity = trace.event(raw)
                if identity:
                    inspect(trace, identity)

        def polling():
            while not stop.wait(1) and time.monotonic() - started < 1200:
                for identity in trace.active_ids():
                    if stop.is_set():
                        break
                    inspect(trace, identity)

        for target in (events, polling):
            thread = threading.Thread(target=target, daemon=True)
            threads.append(thread)
            thread.start()
    except OSError:
        trace.add({"observer": "unavailable"})
    try:
        return wait_cli()
    finally:
        stop.set()
        if watcher is not None:
            try:
                if watcher.poll() is None:
                    watcher.terminate()
                try:
                    watcher.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    watcher.kill()
                    watcher.wait(timeout=3)
            except (OSError, subprocess.TimeoutExpired):
                trace.add({"observer": "shutdown unavailable"})
        for thread in threads:
            thread.join(timeout=3)
        # Fixed sanitized JSON only; raw event bodies/errors are never retained.
        try:
            with path.open("x") as stream:
                path.chmod(0o600)
                json.dump(trace.rows, stream)
                stream.write("\n")
        except OSError:
            print("Observer evidence unavailable; CLI verdict unchanged.")


EXCLUDES = "studio,postgres-meta,realtime,logflare,vector,edge-runtime,imgproxy"


def hosted_guard():
    if any(
        os.environ.get(key) != value
        for key, value in (
            ("AXIOM_PARITY_STARTUP_DEBUG", "1"),
            ("GITHUB_ACTIONS", "true"),
            ("RUNNER_ENVIRONMENT", "github-hosted"),
            ("RUNNER_OS", "Linux"),
        )
    ):
        raise ValueError("Hosted Linux startup observation required")
    if any(key.startswith("DOCKER_") for key in os.environ) or os.environ.get(
        "SUPABASE_PROJECT_ID"
    ):
        raise ValueError("Docker or project context override refused")
    result = subprocess.run(
        ["uname", "-s"], capture_output=True, text=True, check=False, timeout=2
    )
    if result.returncode or result.stdout.strip() != "Linux":
        raise ValueError("Hosted Linux startup observation required")


def report_facts(path, project):
    """Validate every serialized field again before emitting fixed fact labels."""
    validator = Trace(project)
    if (
        path.is_symlink()
        or path.stat().st_mode & 0o077
        or path.stat().st_size > 2 * 1024 * 1024
    ):
        raise ValueError("Private bounded observation required")
    rows = json.loads(path.read_text())
    if not isinstance(rows, list) or len(rows) > 4096:
        raise ValueError("Invalid observation schema")
    facts = []
    for row in rows:
        if not isinstance(row, dict):
            raise TypeError("Invalid observation schema")
        if "observer" in row:
            if set(row) != {"observer"} or row["observer"] not in {
                "unavailable",
                "shutdown unavailable",
            }:
                raise ValueError("Invalid observation schema")
            facts.append("Startup observer: unavailable")
            continue
        if (
            row.get("project") != project
            or row.get("name") not in validator.names
            or validator.names[row["name"]] != row.get("service")
        ):
            raise ValueError("Invalid project observation schema")
        identity = row.get("id")
        service = row.get("service")
        elapsed = row.get("observed_ms")
        if (
            not isinstance(identity, str)
            or not re.fullmatch(r"[0-9a-f]{64}", identity)
            or not isinstance(service, str)
            or service not in validator.names.values()
            or type(elapsed) is not int
            or not 0 <= elapsed <= 1200000
        ):
            raise ValueError("Invalid observation schema")
        if row.get("source") == "event":
            if (
                set(row)
                - {
                    "source",
                    "project",
                    "name",
                    "service",
                    "id",
                    "event",
                    "event_nano",
                    "observed_ms",
                    "exit",
                }
                or row.get("event") not in ACTIONS
                or type(row.get("event_nano")) is not int
                or not 0 <= row["event_nano"] <= 2**63 - 1
            ):
                raise ValueError("Invalid event observation schema")
            fact = f"Startup observer service: {service}; container ID: {identity}; event: {row['event']}; event nano: {row['event_nano']}; observed ms: {elapsed}"
        elif row.get("source") == "inspection":
            if (
                set(row)
                - {
                    "source",
                    "project",
                    "name",
                    "service",
                    "id",
                    "state",
                    "health",
                    "exit",
                    "pid",
                    "oom",
                    "observed_ms",
                }
                or row.get("state") not in STATES
                or row.get("health") not in HEALTH
            ):
                raise ValueError("Invalid inspection observation schema")
            fact = f"Startup observer service: {service}; container ID: {identity}; state: {row['state']}; health: {row['health']}; observed ms: {elapsed}"
        else:
            raise ValueError("Invalid observation source")
        for field, bound in (("exit", 255), ("pid", 2**31 - 1)):
            if field in row:
                if type(row[field]) is not int or not 0 <= row[field] <= bound:
                    raise ValueError("Invalid observation number")
                fact += f"; {field}: {row[field]}"
        if "oom" in row:
            if type(row["oom"]) is not bool or row["source"] != "inspection":
                raise ValueError("Invalid OOM observation")
            fact += "; OOM killed: " + ("true" if row["oom"] else "false")
        facts.append(fact)
    return facts or ["Startup observer: no validated service events"]


def main(argv):
    hosted_guard()
    if len(argv) == 3 and argv[0] == "--report":
        project, path = argv[1], Path(argv[2])
        for fact in report_facts(path, project):
            print(fact)
        return 0
    if len(argv) != 10 or argv[2] != "--":
        raise ValueError("Exact startup command required")
    project, path = argv[0], Path(argv[1])
    command = argv[3:]
    if (
        command[:3] != ["supabase", "start", "--workdir"]
        or command[4:] != ["--exclude", EXCLUDES, "--debug"]
        or Path(command[3]).resolve() != path.parent.resolve()
        or not re.fullmatch(r"start-attempt-[123]\.observer\.json", path.name)
    ):
        raise ValueError("Exact startup command required")
    config_path = path.parent / "supabase/config.toml"
    if config_path.is_symlink():
        raise ValueError("Owned startup config required")
    with config_path.open("rb") as stream:
        if tomllib.load(stream).get("project_id") != project:
            raise ValueError("Owned startup config required")
    result = observe_during(
        lambda: subprocess.run(command, check=False).returncode, project, path
    )
    return result if result >= 0 else 128 - result


if __name__ == "__main__":
    import sys

    try:
        raise SystemExit(main(sys.argv[1:]))
    except (OSError, ValueError, TypeError, subprocess.TimeoutExpired):
        print(
            "Startup observer refused or unavailable; protected evidence required.",
            file=sys.stderr,
        )
        raise SystemExit(1)
