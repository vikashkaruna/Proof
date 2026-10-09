"""Emit bounded startup facts without container logs, environment, or credentials.

Supabase CLI 2.116.0 readiness errors name the container and its state, and
rollback can remove that container before `supabase start` returns. Preserve
the full protected startup log; report only allowlisted facts from it and any
surviving exact-project containers. This never changes the startup verdict.
https://github.com/supabase/cli/blob/v2.116.0/apps/cli/src/legacy/shared/db-bootstrap/health-check.ts
"""

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

# Pinned CLI legacy-service-catalog container suffixes, not arbitrary log names.
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
ERROR_TAGS = {
    "LegacyHealthCheckTimeoutError": "health timeout",
    "LegacyHealthCheckProbeError": "health probe",
    "LegacyStartWorkdirError": "project workdir",
    "LegacyStartConfigLoadError": "configuration load",
    "LegacyStartInvalidConfigError": "invalid configuration",
}
CATEGORIES = {
    "image registry/auth/rate-limit failure": (
        "toomanyrequests",
        "pull access denied",
        "manifest unknown",
        "failed to pull",
        "error pulling",
        "unauthorized",
        "429 too many",
    ),
    "container health/startup failure": (
        "unhealthy",
        "health check",
        "failed to start",
    ),
    "host resource/port failure": (
        "no space left",
        "address already in use",
        "port is already allocated",
        "out of memory",
    ),
    "network timeout/connectivity failure": (
        "timeout",
        "connection refused",
        "connection reset",
        "no such host",
        "tls handshake",
    ),
    "image execution format failure": ("exec format error",),
    "CLI configuration failure": (
        "failed to parse config",
        "invalid config",
        "unknown config",
        "unknown flag",
    ),
    "database bootstrap/migration failure": (
        "database system is shut down",
        "database files are incompatible",
        "failed to run migration",
        "migration failed",
        "password authentication failed",
    ),
    "HTTP readiness failure": ("unexpected status ", "http probe failed"),
}


def validate_project(project):
    if not re.fullmatch(r"axiom-[a-z0-9-]+", project):
        raise ValueError("Invalid isolated Supabase diagnostic project")


def log_facts(message, project):
    validate_project(project)
    lower = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", message).lower()
    facts = [
        "Startup diagnostic categories: "
        + (
            ", ".join(
                label
                for label, terms in CATEGORIES.items()
                if any(term in lower for term in terms)
            )
            or "unclassified; protected log required"
        )
    ]
    for tag, label in ERROR_TAGS.items():
        if re.search(rf"(?<![a-z0-9_]){tag.lower()}(?![a-z0-9_])", lower):
            facts.append(f"Startup failure tag: {label}")
    for suffix, service in SERVICES.items():
        name = re.escape(f"supabase_{suffix}_{project}")
        for phrase, allowed, label in (
            ("not ready", HEALTH, "reported health"),
            ("not running", STATES, "reported state"),
        ):
            values = re.findall(
                rf"(?<![a-z0-9_-]){name} container is {phrase}: ([a-z]+)(?![a-z0-9_-])",
                lower,
            )
            values += re.findall(
                rf"[\"']?containerid[\"']?\s*:\s*[\"']{name}[\"'][,\s]+"
                rf"[\"']?reason[\"']?\s*:\s*[\"']container is {phrase}: ([a-z]+)[\"']",
                lower,
            )
            for value in sorted(set(values) & allowed):
                facts.append(f"Startup service: {service}; {label}: {value}")
        http_codes = re.findall(
            rf"(?<![a-z0-9_-]){name} unexpected status ([1-5][0-9]{{2}})(?![a-z0-9_-])",
            lower,
        )
        for code in sorted(set(http_codes)):
            facts.append(f"Startup service: {service}; reported HTTP readiness: {code}")
    return facts


def container_facts(project):
    validate_project(project)
    names = {
        f"supabase_{suffix}_{project}": service for suffix, service in SERVICES.items()
    }
    # Ignore remote Docker contexts. Inspect only these names on the local socket.
    env = {
        key: value for key, value in os.environ.items() if not key.startswith("DOCKER_")
    }
    try:
        result = subprocess.run(
            [
                "docker",
                "--host",
                "unix:///var/run/docker.sock",
                "inspect",
                "--type",
                "container",
                "--format",
                "{{json .Name}} {{json .State}}",
                *names,
            ],
            capture_output=True,
            text=True,
            check=False,
            timeout=10,
            env=env,
        )
    except (OSError, subprocess.TimeoutExpired):
        return ["Startup container inspection: unavailable"]
    if len(result.stdout) > 2 * 1024 * 1024:
        return ["Startup container inspection: unavailable"]
    facts = []
    for line in result.stdout.splitlines():
        try:
            encoded_name, encoded_state = line.split(" ", 1)
            name = json.loads(encoded_name).removeprefix("/")
            state = json.loads(encoded_state)
            if name not in names or not isinstance(state, dict):
                continue
            service = names[name]
            status = state.get("Status")
            if status not in STATES:
                continue
            facts.append(f"Startup service: {service}; observed state: {status}")
            health = state.get("Health", {})
            if isinstance(health, dict) and health.get("Status") in HEALTH:
                facts.append(
                    f"Startup service: {service}; observed health: {health['Status']}"
                )
                probes = health.get("Log", [])
                if isinstance(probes, list) and probes and isinstance(probes[-1], dict):
                    code = probes[-1].get("ExitCode")
                    if type(code) is int and 0 <= code <= 255:
                        facts.append(
                            f"Startup service: {service}; last health exit: {code}"
                        )
            code = state.get("ExitCode")
            if type(code) is int and 0 <= code <= 255:
                facts.append(f"Startup service: {service}; container exit: {code}")
        except (ValueError, TypeError, AttributeError):
            continue
    return facts or ["Startup container inspection: no retained service state"]


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("log", type=Path)
    parser.add_argument("project")
    args = parser.parse_args()
    try:
        for fact in [
            *log_facts(args.log.read_text(), args.project),
            *container_facts(args.project),
        ]:
            print(fact, file=sys.stderr)
    except (OSError, ValueError):
        print(
            "Startup diagnostics unavailable; protected log required", file=sys.stderr
        )
        sys.exit(1)
