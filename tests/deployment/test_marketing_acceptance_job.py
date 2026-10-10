"""Mock private Job/SQL/provider proofs only, never live acceptance."""

import base64
import copy
import importlib.util
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


job = load("private_acceptance_job", "scripts/marketing-acceptance-job.py")
inputs = load(
    "readonly_test_inputs", "tests/deployment/test_marketing_acceptance_readback.py"
)
bootstrap = load("bootstrap_test_inputs", "tests/deployment/test_marketing_db_job.py")


@pytest.fixture
def fixture():
    captured = {}
    original = inputs.readback.expected_source

    def capture(browser, library):
        captured.update(browser=browser, library=library)
        return original(browser, library)

    inputs.readback.expected_source = capture
    try:
        expected, actual = inputs.fixture()
    finally:
        inputs.readback.expected_source = original
    browser, library = captured["browser"], captured["library"]
    source = bootstrap.configuration()
    source.update(
        AXIOM_RELEASE_SHA="a" * 40,
        MARKETING_ACCEPTANCE_JOB_NAME="axiom-proof-preprod-acceptance",
    )
    prepared = job.descriptor(source, browser, library)
    actual["database"] = source["CLOUD_SQL_DATABASE_NAME"]
    actual["role"] = source["CLOUD_SQL_ADMIN_USER"]
    execution = {
        "name": prepared["job"]["name"] + "/executions/acceptance-123",
        "template": copy.deepcopy(prepared["job"]["template"]["template"]),
        "taskCount": 1,
        "succeededCount": 1,
        "failedCount": 0,
        "cancelledCount": 0,
        "startTime": "2026-10-10T00:00:00Z",
        "completionTime": "2026-10-10T00:00:30Z",
    }
    result = {
        "schema_version": 1,
        "expected_sha256": prepared["expected_sha256"],
        "proof": job.readback.validate_readback(expected, actual),
    }
    entry = {
        "logName": "projects/test-project/logs/run.googleapis.com%2Fstdout",
        "resource": {
            "type": "cloud_run_job",
            "labels": {
                "project_id": "test-project",
                "location": "asia-south1",
                "job_name": "axiom-proof-preprod-acceptance",
            },
        },
        "labels": {"run.googleapis.com/execution_name": "acceptance-123"},
        "timestamp": "2026-10-10T00:00:15Z",
        "jsonPayload": {"axiom_marketing_readback": result},
    }
    return source, prepared, actual, execution, entry


def test_fixed_private_job_bound_to_browser_source(fixture):
    source, prepared = fixture[:2]
    task = prepared["job"]["template"]["template"]
    assert task["maxRetries"] == 0 and task["timeout"] == "60s"
    assert task["vpcAccess"]["egress"] == "PRIVATE_RANGES_ONLY"
    container = task["containers"][0]
    assert container["args"] == ["/app/scripts/marketing-acceptance-job.py", "run"]
    assert container["image"] == source["MARKETING_MIGRATION_IMAGE"]
    assert len([r for r in container["env"] if "valueSource" in r]) == 1
    assert "private-admin-password" not in json.dumps(prepared)


def test_runtime_fixed_readonly_sql_and_timeout(fixture):
    source, prepared, actual = fixture[:3]
    source["SUPABASE_DB_URL"] = (
        f"postgres://{source['CLOUD_SQL_ADMIN_USER']}:SYNTHETIC_SECRET@10.73.1.2:5432/{source['CLOUD_SQL_DATABASE_NAME']}?sslmode=require"
    )
    source.update(
        {
            r["name"]: r["value"]
            for r in prepared["job"]["template"]["template"]["containers"][0]["env"]
            if "value" in r
        }
    )

    def run(argv, **kwargs):
        assert argv == ["psql", "-X", "-q", "-w", "-v", "ON_ERROR_STOP=1", "-At"]
        assert kwargs["timeout"] == 25 and kwargs["check"] is True
        assert "begin transaction read only" in kwargs["input"].lower()
        assert "rollback;" in kwargs["input"].lower()
        assert "SYNTHETIC_SECRET" not in kwargs["input"]
        return SimpleNamespace(stdout=json.dumps(actual))

    value = job.runtime(source, run)
    assert value["axiom_marketing_readback"]["proof"]["observations"] == actual


def test_successful_execution_independent_observations(fixture):
    _, prepared, _, execution, entry = fixture
    result = job.verify_execution(prepared, prepared["job"], execution, [entry])
    assert result["sql_proof"]["observations"]["transaction_read_only"] == "on"
    assert result["remaining_gates"] == [
        "lifecycle-cold-stop-wake-and-inflight-refusal"
    ]


@pytest.mark.parametrize(
    "failure",
    [
        "image",
        "command",
        "retry",
        "vpc",
        "execution",
        "failed",
        "pending",
        "duplicate",
        "absent",
        "foreignlog",
        "foreignproject",
        "oldexecution",
        "staletimestamp",
        "sqlwrite",
        "rows",
        "digest",
    ],
)
def test_changed_provider_or_sql_proof_refused(fixture, failure):
    _, prepared, _, execution, entry = fixture
    actual_job = copy.deepcopy(prepared["job"])
    task = actual_job["template"]["template"]
    entries = [entry]
    if failure == "image":
        task["containers"][0]["image"] += "BAD"
    elif failure == "command":
        task["containers"][0]["args"] = ["arbitrary-command"]
    elif failure == "retry":
        task["maxRetries"] = 1
    elif failure == "vpc":
        task["vpcAccess"]["egress"] = "ALL_TRAFFIC"
    elif failure == "execution":
        execution["name"] += "/foreign"
    elif failure == "failed":
        execution["failedCount"] = 1
    elif failure == "pending":
        execution.pop("completionTime")
    elif failure == "duplicate":
        entries.append(copy.deepcopy(entry))
    elif failure == "absent":
        entries = []
    elif failure == "foreignlog":
        entry["logName"] = "projects/foreign/logs/run.googleapis.com%2Fstdout"
    elif failure == "foreignproject":
        entry["resource"]["labels"]["project_id"] = "foreign"
    elif failure == "oldexecution":
        entry["labels"]["run.googleapis.com/execution_name"] = "old-123"
    elif failure == "staletimestamp":
        entry["timestamp"] = "2026-10-09T00:00:15Z"
    elif failure == "sqlwrite":
        entry["jsonPayload"]["axiom_marketing_readback"]["proof"]["observations"][
            "transaction_read_only"
        ] = "off"
    elif failure == "rows":
        entry["jsonPayload"]["axiom_marketing_readback"]["proof"]["observations"][
            "contacts"
        ].pop()
    else:
        entry["jsonPayload"]["axiom_marketing_readback"]["expected_sha256"] = "0" * 64
    with pytest.raises((ValueError, KeyError)):
        job.verify_execution(prepared, actual_job, execution, entries)


@pytest.mark.parametrize("failure", ["digest", "scope", "timeout"])
def test_runtime_scope_and_timeout_fail_closed(fixture, failure):
    source, prepared = fixture[:2]
    source.update(
        {
            r["name"]: r["value"]
            for r in prepared["job"]["template"]["template"]["containers"][0]["env"]
            if "value" in r
        }
    )
    source["SUPABASE_DB_URL"] = (
        f"postgres://{source['CLOUD_SQL_ADMIN_USER']}:SYNTHETIC_SECRET@10.73.1.2:5432/{source['CLOUD_SQL_DATABASE_NAME']}?sslmode=require"
    )
    if failure == "digest":
        source["AXIOM_MARKETING_ACCEPTANCE_EXPECTED_SHA256"] = "0" * 64
    elif failure == "scope":
        value = copy.deepcopy(prepared["expected"])
        value["contacts"][0]["email"] = "real-person@example.com"
        source["AXIOM_MARKETING_ACCEPTANCE_EXPECTED"] = base64.b64encode(
            job.canonical(value)
        ).decode()

    calls = []

    def timeout(*args, **kwargs):
        calls.append(args)
        raise subprocess.TimeoutExpired("psql", 25)

    if failure == "timeout":
        with pytest.raises(subprocess.TimeoutExpired):
            job.runtime(source, timeout)
        assert len(calls) == 1
    else:
        with pytest.raises(ValueError):
            job.runtime(source, timeout)
        assert calls == []
