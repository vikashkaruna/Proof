#!/usr/bin/env python3
"""Fixed private-VPC synthetic READ ONLY Job and independently verified result.

Never accepts SQL, credentials or executable command overrides. Runtime result
is deliberately private synthetic evidence for protected provider log readback.
"""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import os
import re
import subprocess  # nosec B404  # fixed psql commands, SQL via stdin; no shell
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MAX_EXPECTED = 16384


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


readback = load("acceptance_job_readback", "scripts/marketing-acceptance-readback.py")
bootstrap = readback.job_helper


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def expected_binding(expected, project, release):
    readback.validate_expected(expected)
    if (
        expected.get("project") != project
        or expected.get("releaseSha") != release
        or not re.fullmatch(r"[a-f0-9]{40}", release)
        or not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", project)
        or len(canonical(expected)) > MAX_EXPECTED
    ):
        raise ValueError("Bounded source-bound synthetic scope required")


def descriptor(source, browser, library):
    expected = readback.expected_source(browser, library)
    project = source["GCP_PROJECT_ID"]
    release = source["AXIOM_RELEASE_SHA"]
    expected_binding(expected, project, release)
    job = bootstrap.job_payload(source, "inspect")
    name = source["MARKETING_ACCEPTANCE_JOB_NAME"]
    if not bootstrap.COMPONENT.fullmatch(name):
        raise ValueError("Dedicated preprod acceptance Job name required")
    if name == source["MARKETING_MIGRATION_JOB_NAME"]:
        raise ValueError("Acceptance must not reuse the migration Job")
    job["name"] = f"projects/{project}/locations/asia-south1/jobs/{name}"
    task = job["template"]["template"]
    task["timeout"] = "60s"
    container = task["containers"][0]
    container["command"] = ["python3"]
    container["args"] = ["/app/scripts/marketing-acceptance-job.py", "run"]
    container["env"] += [
        {"name": key, "value": value}
        for key, value in {
            "GCP_PROJECT_ID": project,
            "AXIOM_RELEASE_SHA": release,
            "AXIOM_MARKETING_ACCEPTANCE_EXPECTED": base64.b64encode(
                canonical(expected)
            ).decode(),
            "AXIOM_MARKETING_ACCEPTANCE_EXPECTED_SHA256": digest(expected),
        }.items()
    ]
    return {
        "schema_version": 1,
        "phase": "acceptance-readback",
        "database_connection_name": f"{project}:asia-south1:{source['CLOUD_SQL_INSTANCE_NAME']}",
        "project": project,
        "release_sha": release,
        "expected": expected,
        "expected_sha256": digest(expected),
        "browser_sha256": digest(browser),
        "library_sha256": digest(library),
        "job": job,
        "job_sha256": digest(job),
    }


def runtime(source, runner=subprocess.run):
    encoded = source["AXIOM_MARKETING_ACCEPTANCE_EXPECTED"]
    if len(encoded) > MAX_EXPECTED * 2:
        raise ValueError("Oversized synthetic scope refused")
    expected = json.loads(base64.b64decode(encoded, validate=True))
    expected_binding(expected, source["GCP_PROJECT_ID"], source["AXIOM_RELEASE_SHA"])
    if digest(expected) != source["AXIOM_MARKETING_ACCEPTANCE_EXPECTED_SHA256"]:
        raise ValueError("Expected source digest differs")
    environment = bootstrap.runtime_environment(source)
    result = runner(
        ["psql", "-X", "-q", "-w", "-v", "ON_ERROR_STOP=1", "-At"],
        input=readback.readback_sql(expected),
        env=environment,
        capture_output=True,
        text=True,
        timeout=25,
        check=True,
    )
    if len(result.stdout.encode()) > 1024 * 1024:
        raise ValueError("Oversized SQL result refused")
    actual = json.loads(result.stdout)
    if (
        actual.get("database") != source["CLOUD_SQL_DATABASE_NAME"]
        or actual.get("role") != source["CLOUD_SQL_ADMIN_USER"]
    ):
        raise ValueError("Actual database identity differs")
    proof = readback.validate_readback(expected, actual)
    return {
        "axiom_marketing_readback": {
            "schema_version": 1,
            "expected_sha256": digest(expected),
            "proof": proof,
        }
    }


def verify_execution(prepared, actual_job, execution, entries):
    if (
        not isinstance(entries, list)
        or len(entries) > 1000
        or len(canonical(entries)) > 4 * 1024 * 1024
    ):
        raise ValueError("Bounded exact execution log entries required")
    job = prepared["job"]
    expected_binding(prepared["expected"], prepared["project"], prepared["release_sha"])
    if (
        digest(job) != prepared["job_sha256"]
        or digest(prepared["expected"]) != prepared["expected_sha256"]
        or actual_job.get("name") != job["name"]
        or actual_job.get("template") != job["template"]
    ):
        raise ValueError("Actual Job differs from approved immutable descriptor")
    name = execution.get("name", "")
    if (
        not re.fullmatch(re.escape(job["name"]) + r"/executions/[a-z0-9-]+", name)
        or execution.get("template") != job["template"]["template"]
        or execution.get("taskCount") != 1
        or execution.get("succeededCount") != 1
        or execution.get("failedCount", 0) != 0
        or execution.get("cancelledCount", 0) != 0
        or not execution.get("completionTime")
        or not execution.get("startTime")
    ):
        raise ValueError("Exact successful private readback execution required")
    project = prepared["project"]
    short_job = job["name"].rsplit("/", 1)[1]
    short_execution = name.rsplit("/", 1)[1]
    start = datetime.fromisoformat(execution["startTime"])
    end = datetime.fromisoformat(execution["completionTime"])
    if start.tzinfo is None or end.tzinfo is None or end < start:
        raise ValueError("Actual execution chronology required")
    results = []
    for entry in entries:
        payload = entry.get("jsonPayload", {})
        if "axiom_marketing_readback" not in payload:
            continue
        if (
            entry.get("logName")
            != f"projects/{project}/logs/run.googleapis.com%2Fstdout"
            or entry.get("resource", {}).get("type") != "cloud_run_job"
            or entry["resource"].get("labels")
            != {"project_id": project, "location": "asia-south1", "job_name": short_job}
            or entry.get("labels", {}).get("run.googleapis.com/execution_name")
            not in (name, short_execution)
        ):
            raise ValueError("Result belongs to another provider execution")
        timestamp = datetime.fromisoformat(entry["timestamp"])
        if timestamp.tzinfo is None or not start <= timestamp <= end:
            raise ValueError("Result timestamp outside exact execution")
        result = payload["axiom_marketing_readback"]
        proof = result["proof"]
        if (
            result.get("schema_version") != 1
            or result.get("expected_sha256") != prepared["expected_sha256"]
            or proof
            != readback.validate_readback(prepared["expected"], proof["observations"])
        ):
            raise ValueError("Actual SQL observations differ from synthetic source")
        results.append(proof)
    if len(results) != 1:
        raise ValueError("Exactly one independently validated SQL result required")
    return {
        "schema_version": 1,
        "phase": "acceptance-readback",
        "project": project,
        "release_sha": prepared["release_sha"],
        "job": job["name"],
        "execution": name,
        "completion_time": execution["completionTime"],
        "descriptor_sha256": digest(prepared),
        "actual_execution_sha256": digest(execution),
        "sql_proof": results[0],
        "remaining_gates": ["lifecycle-cold-stop-wake-and-inflight-refusal"],
    }


if __name__ == "__main__":
    import sys

    try:
        if sys.argv[1:] != ["run"]:
            raise ValueError("Fixed runtime entrypoint required")
        print(canonical(runtime(dict(os.environ))).decode())
    except (ValueError, TypeError, KeyError, OSError, subprocess.SubprocessError):
        print(
            "Private synthetic readonly Job refused; credentials and SQL output withheld",
            file=sys.stderr,
        )
        raise SystemExit(1)
