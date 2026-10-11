"""Causal coordinator tests. All provider responses/clocks here are synthetic."""

import copy
import importlib.util
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    m = importlib.util.module_from_spec(spec)
    sys.modules[name] = m
    spec.loader.exec_module(m)
    return m


helper = load(
    "lifecycle_deployment_acceptance",
    "scripts/marketing-lifecycle-deployment-acceptance.py",
)
controller = load("native_lifecycle_model", "services/marketing-lifecycle/lifecycle.py")


class Clock:
    def __init__(self):
        self.value = 1800000000.0
        self.elapsed = 0.0
        self.sleeps = []

    def wall(self):
        return self.value

    def monotonic(self):
        return self.elapsed

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.value += seconds
        self.elapsed += seconds


def source():
    p = {
        "schema_version": 1,
        "kind": "marketing-lifecycle-deployment-acceptance-plan",
        "environment": "preprod",
        "project": "test-project",
        "region": "asia-south1",
        "release_sha": "a" * 40,
        "instance": "axiom-proof-preprod-sql",
        "bucket": "axiom-proof-preprod-state",
        "object": "marketing-preprod/lifecycle/state.json",
        "targetHash": "b" * 64,
        "controllerUrl": "https://controller.run.app",
        "lifecycle_service": "axiom-proof-preprod-lifecycle",
        "scheduler_job": "axiom-proof-preprod-idle",
        "scheduler_account": "axiom-proof-preprod-scheduler@test-project.iam.gserviceaccount.com",
        "lifecycle_image": "asia-south1-docker.pkg.dev/test-project/images/lifecycle@sha256:"
        + "c" * 64,
        "idle_seconds": 120,
        "lease_seconds": 120,
        "hashes": {
            k: "d" * 64
            for k in ("env", "release", "services", "seed", "browser", "baseline")
        },
        "readback_job": "projects/test-project/locations/asia-south1/jobs/axiom-proof-preprod-migrations-readback",
        "baseline_sql_proof": {"original": "retained"},
        "service_bindings": {},
        "seed_generation": "10",
        "database_connection_name": "test-project:asia-south1:axiom-proof-preprod-sql",
        "browser_semantic_sha256": "f" * 64,
        "migration_image": "asia-south1-docker.pkg.dev/test-project/images/migrations@sha256:"
        + "f" * 64,
    }
    p["service_bindings"] = {
        c: {
            "name": "axiom-proof-preprod-" + c,
            "uri": "https://" + c + ".run.app",
            "image": p["lifecycle_image"],
        }
        for c in ("marketing", "bff", "auth", "rest", "gateway")
    }
    p["targetHash"] = helper.digest(
        {k: p[k] for k in ("environment", "project", "instance", "bucket", "object")}
    )
    return p


def approve(p, phase, clock, **extra):
    return {
        "kind": "marketing-preprod-lifecycle-deployment-acceptance",
        "project": p["project"],
        "release_sha": p["release_sha"],
        "plan_sha256": helper.digest(p),
        "phase": phase,
        "actions": helper.ACTIONS[phase],
        "approved_by": "Recorded local deployment testing user authorization",
        "expires_unix": int(clock.wall() + 5000),
        **extra,
    }


class Store:
    def __init__(self, p, clock):
        self.generation = 10
        self.state = controller.bootstrap_state(
            controller.Target(
                p["project"], p["instance"], p["bucket"], p["object"], p["targetHash"]
            ),
            now=int(clock.wall()),
            phase="running",
        )

    def read(self):
        return str(self.generation), copy.deepcopy(self.state)

    def write(self, generation, state):
        assert generation == str(self.generation)
        self.state = copy.deepcopy(state)
        self.generation += 1


class Cloud:
    def __init__(self, p, clock):
        self.p = p
        self.clock = clock
        self.policy = "ALWAYS"
        self.version = 1
        self.operations = {}

    def instance(self):
        return {"state": "RUNNABLE", "activationPolicy": self.policy}

    def activate(self, policy):
        self.policy = policy
        self.version += 1
        name = "operation-" + str(self.version)
        date = datetime.fromtimestamp(self.clock.wall(), timezone.utc).isoformat()
        self.operations[name] = {
            "name": name,
            "targetId": self.p["instance"],
            "targetProject": self.p["project"],
            "status": "DONE",
            "operationType": "UPDATE",
            "startTime": date,
            "endTime": date,
        }
        return name

    def operation_done(self, name):
        return self.operations[name]["status"] == "DONE"


class Provider:
    def __init__(self, p, clock):
        self.p = p
        self.clock = clock
        self.store = Store(p, clock)
        self.cloud = Cloud(p, clock)
        self.control = controller.Controller(
            controller.Target(
                p["project"],
                p["instance"],
                p["bucket"],
                p["object"],
                p["targetHash"],
                idle_seconds=p["idle_seconds"],
            ),
            self.store,
            self.cloud,
            clock.wall,
        )
        self.calls = []
        self.mutant = None
        self.scheduler = "PAUSED"

    def __call__(self, url, token, body=None):
        self.calls.append((url, body))
        if "storage.googleapis.com" in url:
            result = (
                copy.deepcopy(self.store.state)
                if "alt=media" in url
                else {
                    "bucket": self.p["bucket"],
                    "name": self.p["object"],
                    "generation": str(self.store.generation),
                }
            )
        elif "/operations/" in url:
            result = copy.deepcopy(self.cloud.operations[url.rsplit("/", 1)[1]])
        elif "sqladmin.googleapis.com" in url:
            result = {
                "name": self.p["instance"],
                "project": self.p["project"],
                "state": "RUNNABLE",
                "settings": {
                    "activationPolicy": self.cloud.policy,
                    "settingsVersion": str(self.cloud.version),
                },
            }
        elif "run.googleapis.com" in url:
            result = {
                "name": f"projects/{self.p['project']}/locations/asia-south1/services/{self.p['lifecycle_service']}",
                "uri": self.p["controllerUrl"],
                "latestCreatedRevision": "ready-revision",
                "latestReadyRevision": "ready-revision",
                "terminalCondition": {"state": "CONDITION_SUCCEEDED"},
                "reconciling": False,
                "generation": "1",
                "observedGeneration": "1",
                "trafficStatuses": [{"percent": 100, "revision": "ready-revision"}],
                "template": {
                    "containers": [
                        {
                            "image": self.p["lifecycle_image"],
                            "env": [
                                {"name": k, "value": v}
                                for k, v in {
                                    "AXIOM_IDLE_INTERVAL_SECONDS": str(
                                        self.p["idle_seconds"]
                                    ),
                                    "AXIOM_IDLE_LEASE_SECONDS": str(
                                        self.p["lease_seconds"]
                                    ),
                                    "AXIOM_IDLE_TARGET_MANIFEST_SHA256": self.p[
                                        "targetHash"
                                    ],
                                    "GCP_PROJECT_ID": self.p["project"],
                                    "CLOUD_SQL_INSTANCE_NAME": self.p["instance"],
                                }.items()
                            ],
                        }
                    ]
                },
            }
            for binding in self.p["service_bindings"].values():
                if url.endswith("/" + binding["name"]):
                    result.update(
                        name=f"projects/{self.p['project']}/locations/asia-south1/services/{binding['name']}",
                        uri=binding["uri"],
                    )
                    result["template"]["containers"][0]["image"] = binding["image"]
        elif "cloudscheduler.googleapis.com" in url:
            if url.endswith(":resume"):
                self.scheduler = "ENABLED"
            result = {
                "name": f"projects/{self.p['project']}/locations/asia-south1/jobs/{self.p['scheduler_job']}",
                "state": self.scheduler,
                "httpTarget": {
                    "uri": self.p["controllerUrl"] + "/idle/check",
                    "httpMethod": "POST",
                    "oidcToken": {
                        "audience": self.p["controllerUrl"],
                        "serviceAccountEmail": self.p["scheduler_account"],
                    },
                },
            }
        else:
            reply = self.control.handle(url.removeprefix(self.p["controllerUrl"]), body)
            status, result = reply.status, copy.deepcopy(reply.body)
            if self.mutant:
                status, result = self.mutant(url, status, result)
            return status, result
        if self.mutant:
            return self.mutant(url, 200, result)
        return 200, result


def cycle(mutant=None):
    p = source()
    clock = Clock()
    provider = Provider(p, clock)
    provider.mutant = mutant
    saved = []
    runner = helper.Coordinator(
        p,
        approve(p, "cycle", clock),
        {"accessToken": "test-access", "controllerIdToken": "test-id"},
        lambda value: saved.append(copy.deepcopy(value)),
        transport=provider,
        wall=clock.wall,
        clock=clock.monotonic,
        sleep=clock.sleep,
    )
    return runner, provider, clock, saved


def test_actual_protocol_model_requires_real_elapsed_idle_and_two_operations():
    runner, provider, clock, saved = cycle()
    proof = runner.cycle()
    assert (
        proof["status"] == "cold-cycle-green-postwake-readback-pending"
        and proof["inflight_refusal_verified"] is True
    )
    assert clock.elapsed >= runner.plan["idle_seconds"] and max(clock.sleeps) <= 30
    assert (
        proof["stop_operation"] != proof["wake_operation"]
        and len(provider.cloud.operations) == 2
    )
    assert (
        provider.store.state["leases"] == {}
        and provider.store.state["phase"] == "running"
        and provider.scheduler == "PAUSED"
    )
    assert all(
        "sqladmin" not in url for url, body in provider.calls if body is not None
    )
    assert not any(
        "storage.googleapis.com" in url
        for url, body in provider.calls
        if body is not None
    )
    assert any(
        action["outcome"] == "unknown"
        for saved_proof in saved
        for action in saved_proof["actions"]
    )


@pytest.mark.parametrize(
    "field,value",
    [
        ("phase", "resume"),
        ("project", "another-project"),
        ("release_sha", "e" * 40),
        ("plan_sha256", "e" * 64),
        ("actions", []),
        ("approved_by", ""),
        ("expires_unix", 1800000000),
    ],
)
def test_wrong_scope_refuses_before_any_provider_request(field, value):
    runner, provider, _clock, _saved = cycle()
    runner.approval[field] = value
    with pytest.raises(ValueError):
        runner.cycle()
    assert provider.calls == []


@pytest.mark.parametrize(
    "fault",
    [
        "scheduler",
        "image",
        "interval",
        "operation_target",
        "operation_error",
        "operation_old",
        "held_reply",
        "release_reply",
    ],
)
def test_causal_fault_preserves_evidence_and_never_resumes(fault):
    def mutate(url, status, result):
        if fault == "scheduler" and "cloudscheduler" in url:
            result["state"] = "ENABLED"
        if fault == "image" and "run.googleapis.com" in url:
            result["template"]["containers"][0]["image"] = "unreviewed"
        if fault == "interval" and "run.googleapis.com" in url:
            result["template"]["containers"][0]["env"][0]["value"] = "1"
        if "/operations/" in url:
            if fault == "operation_target":
                result["targetId"] = "selected-other-instance"
            if fault == "operation_error":
                result["error"] = {"errors": [{"code": "failure"}]}
            if fault == "operation_old":
                result["startTime"] = "1999-01-01T00:00:00Z"
                result["endTime"] = "1999-01-01T00:00:01Z"
        if (
            fault == "held_reply"
            and result.get("status") == "in_flight_or_completion_unknown"
        ):
            return 200, {"status": "active"}
        if fault == "release_reply" and url.endswith("/gate/release"):
            return 500, {"status": "unknown"}
        return status, result

    runner, provider, _clock, _saved = cycle(mutate)
    with pytest.raises(ValueError):
        runner.cycle()
    assert not any(url.endswith(":resume") for url, _ in provider.calls)
    assert len(provider.cloud.operations) <= 1


def test_expired_lease_is_not_pruned_to_make_idle_eligible():
    runner, provider, clock, _saved = cycle()
    provider.store.state["leases"]["01234567-89ab-4cde-8fab-012345678901"] = {
        "tokenHash": "f" * 64,
        "expiresAt": int(clock.wall() - 100),
    }
    with pytest.raises(ValueError, match="Existing lease"):
        runner.cycle()
    assert provider.store.state["leases"] and not provider.cloud.operations


def test_old_last_activity_cannot_shorten_actual_elapsed_wait():
    runner, provider, clock, _saved = cycle()
    original = provider.__call__

    # Only mutate observations, never the controller's source clock/state. The
    # monotonic minimum remains mandatory despite misleading old read telemetry.
    def transport(url, token, body=None):
        status, value = original(url, token, body)
        if "alt=media" in url and not value["leases"]:
            value["lastActivity"] = 0
        return status, value

    runner.transport = transport
    runner.cycle()
    assert clock.elapsed >= runner.plan["idle_seconds"]


def test_uncertain_stop_is_sent_once_without_wake_or_retry():
    runner, provider, _clock, saved = cycle()
    original = provider.__call__

    def transport(url, token, body=None):
        status, value = original(url, token, body)
        if value.get("status") == "stopping":
            raise OSError("response lost after provider write")
        return status, value

    runner.transport = transport
    with pytest.raises(OSError):
        runner.cycle()
    assert (
        len(provider.cloud.operations) == 1
        and provider.store.state["phase"] == "stopping"
    )
    assert saved[-1]["actions"][-1]["outcome"] == "unknown"
    assert not any(
        action.get("response", {}).get("status") == "starting"
        for action in runner.proof["actions"]
    )


def postwake_descriptor(p):
    return {
        "project": p["project"],
        "release_sha": p["release_sha"],
        "database_connection_name": p["database_connection_name"],
        "browser_sha256": p["browser_semantic_sha256"],
        "job": {
            "name": p["readback_job"].removesuffix("-readback") + "-readback-postwake",
            "template": {
                "taskCount": 1,
                "parallelism": 1,
                "template": {
                    "maxRetries": 0,
                    "timeout": "60s",
                    "containers": [
                        {
                            "image": p["migration_image"],
                            "command": ["python3"],
                            "args": ["/app/scripts/marketing-acceptance-job.py", "run"],
                        }
                    ],
                },
            },
        },
    }


def test_complete_requires_verified_postwake_execution_after_wake_and_identical_rows(
    monkeypatch,
):
    runner, _provider, clock, _saved = cycle()
    pending = runner.cycle()
    p = runner.plan
    prepared = postwake_descriptor(p)
    actual = {
        "startTime": datetime.fromtimestamp(clock.wall() + 1, timezone.utc).isoformat()
    }
    verified = {
        "project": p["project"],
        "release_sha": p["release_sha"],
        "sql_proof": p["baseline_sql_proof"],
        "completion_time": datetime.fromtimestamp(
            clock.wall() + 2, timezone.utc
        ).isoformat(),
    }
    called = []
    monkeypatch.setattr(
        helper.readback,
        "verify_execution",
        lambda *args: called.append(args) or verified,
    )
    approval = approve(
        p,
        "complete",
        clock,
        cycle_sha256=helper.digest(pending),
        postwake_plan_sha256=helper.digest(prepared),
    )
    result = helper.complete(
        p, pending, approval, prepared, {}, actual, [], now=clock.wall() + 3
    )
    assert (
        called
        and result["status"]
        == "actual-lifecycle-and-postwake-readback-green-scheduler-paused"
    )
    verified["sql_proof"] = {"changed": "row"}
    with pytest.raises(ValueError):
        helper.complete(
            p, pending, approval, prepared, {}, actual, [], now=clock.wall() + 3
        )
    verified["sql_proof"] = p["baseline_sql_proof"]
    actual["startTime"] = "1999-01-01T00:00:00Z"
    with pytest.raises(ValueError):
        helper.complete(
            p, pending, approval, prepared, {}, actual, [], now=clock.wall() + 3
        )


def test_scheduler_resume_requires_separate_exact_green_receipt_approval():
    runner, provider, clock, saved = cycle()
    p = runner.plan
    completed = {
        "status": "actual-lifecycle-and-postwake-readback-green-scheduler-paused",
        "plan_sha256": helper.digest(p),
    }
    approval = approve(p, "resume", clock, completed_sha256=helper.digest(completed))
    result = helper.resume(
        p,
        completed,
        approval,
        runner.tokens,
        lambda value: saved.append(copy.deepcopy(value)),
        transport=provider,
        now=clock.wall(),
        wall=clock.wall,
    )
    assert (
        result["status"] == "actual-lifecycle-acceptance-green-scheduler-enabled"
        and provider.scheduler == "ENABLED"
    )
    assert sum(url.endswith(":resume") for url, _ in provider.calls) == 1
    approval["completed_sha256"] = "f" * 64
    with pytest.raises(ValueError):
        helper.resume(
            p,
            completed,
            approval,
            runner.tokens,
            lambda value: None,
            transport=provider,
            now=clock.wall(),
            wall=clock.wall,
        )


def plan_inputs():
    p = source()
    components = ("marketing", "bff", "auth", "rest", "gateway")
    env = {
        "ENVIRONMENT": "preprod",
        "GCP_REGION": "asia-south1",
        "AXIOM_DEPLOYMENT_PROFILE": "marketing",
        "GCP_PROJECT_ID": p["project"],
        "CLOUD_SQL_INSTANCE_NAME": p["instance"],
        "CLOUD_SQL_DATABASE_NAME": "axiom_proof_preprod",
        "AXIOM_IDLE_STATE_BUCKET": p["bucket"],
        "AXIOM_IDLE_STATE_OBJECT": p["object"],
        "AXIOM_IDLE_TIMEOUT_SECONDS": "1800",
        "AXIOM_IDLE_LEASE_SECONDS": "120",
        "MARKETING_LIFECYCLE_SERVICE_NAME": p["lifecycle_service"],
        "MARKETING_LIFECYCLE_SCHEDULER_NAME": p["scheduler_job"],
        "MARKETING_SCHEDULER_ACCOUNT_ID": "axiom-proof-preprod-scheduler",
        **{
            "MARKETING_" + c.upper() + "_SERVICE_NAME": "axiom-proof-preprod-" + c
            for c in components
        },
    }
    target = {
        key: p[key]
        for key in ("environment", "project", "instance", "bucket", "object")
    }
    target_hash = helper.digest(target)
    release = {
        "release_sha": p["release_sha"],
        "lifecycle_target_manifest_sha256": target_hash,
        "auxiliary_images": {
            "lifecycle": p["lifecycle_image"],
            "migrations": p["migration_image"],
        },
        "images": {
            c: "asia-south1-docker.pkg.dev/test-project/images/"
            + c
            + "@sha256:"
            + "e" * 64
            for c in components
        },
    }
    services = {
        "project": p["project"],
        "release_sha": p["release_sha"],
        "idle_automation_enabled": False,
        "lifecycle_controller_uri": p["controllerUrl"],
        "cloud_run_uris": {c: "https://" + c + ".run.app" for c in components},
    }
    seed = {
        "project": p["project"],
        "release_sha": p["release_sha"],
        "seed_target_sha256": target_hash,
        "state_initialized": True,
        "admission_reopened": True,
        "bucket": p["bucket"],
        "object": p["object"],
        "seed_generation": "10",
    }
    browser = {
        "status": "browser-and-api-green-storage-and-lifecycle-pending",
        "run": "synthetic-original",
        "config": {
            "environment": "preprod",
            "project": p["project"],
            "releaseSha": p["release_sha"],
            "servicesReceiptSha256": p["hashes"]["services"],
        },
        "health": {"releaseSha": p["release_sha"], "status": "healthy"},
        "contacts": [
            {"response": {"id": "contact-1"}},
            {"response": {"id": "contact-2"}},
        ],
        "gapScans": [{"id": "gap-1"}],
    }
    baseline = {
        "schema_version": 1,
        "phase": "acceptance-readback",
        "project": p["project"],
        "release_sha": p["release_sha"],
        "job": p["readback_job"],
        "sql_proof": {
            "project": p["project"],
            "releaseSha": p["release_sha"],
            "run": browser["run"],
            "observations": {
                "database": "axiom_proof_preprod",
                "contacts": [{"id": "contact-1"}, {"id": "contact-2"}],
                "gap": [{"id": "gap-1"}],
            },
        },
    }
    return env, release, services, seed, browser, baseline, p["hashes"]


def test_prepare_pins_actual_policy_all_five_services_and_original_browser_rows():
    plan = helper.prepare_scope(*plan_inputs())
    assert plan["idle_seconds"] == 1800 and len(plan["service_bindings"]) == 5
    assert plan["database_connection_name"].endswith(":axiom-proof-preprod-sql")
    assert plan["browser_semantic_sha256"] == helper.readback.digest(plan_inputs()[4])


@pytest.mark.parametrize(
    "index,key,value",
    [
        (0, "ENVIRONMENT", "prod"),
        (0, "GCP_REGION", "us-central1"),
        (1, "release_sha", "b" * 40),
        (1, "lifecycle_target_manifest_sha256", "0" * 64),
        (2, "idle_automation_enabled", True),
        (3, "admission_reopened", False),
        (3, "seed_generation", "not-generation"),
        (4, "status", "fabricated"),
        (5, "phase", "unverified"),
    ],
)
def test_prepare_refuses_source_target_and_prior_gate_mutants(index, key, value):
    values = list(plan_inputs())
    values[index][key] = value
    with pytest.raises(ValueError):
        helper.prepare_scope(*values)


def test_prepare_refuses_retained_rows_from_another_browser_run():
    values = list(plan_inputs())
    values[5]["sql_proof"]["observations"]["gap"][0]["id"] = "another-session"
    with pytest.raises(ValueError, match="identities"):
        helper.prepare_scope(*values)


@pytest.mark.parametrize(
    "field,value",
    [("command", ["sh"]), ("args", ["arbitrary-script"]), ("image", "mutable:latest")],
)
def test_completion_refuses_non_readonly_job_even_with_pinned_approval(
    field, value, monkeypatch
):
    runner, _provider, clock, _saved = cycle()
    pending = runner.cycle()
    p = runner.plan
    prepared = postwake_descriptor(p)
    prepared["job"]["template"]["template"]["containers"][0][field] = value
    approval = approve(
        p,
        "complete",
        clock,
        cycle_sha256=helper.digest(pending),
        postwake_plan_sha256=helper.digest(prepared),
    )
    called = []
    monkeypatch.setattr(
        helper.readback, "verify_execution", lambda *args: called.append(args)
    )
    with pytest.raises(ValueError, match="read-only"):
        helper.complete(p, pending, approval, prepared, {}, {}, [], now=clock.wall())
    assert not called


def test_atomic_recovery_file_has_private_permissions_and_refuses_broad_directory(
    tmp_path,
):
    import os

    os.chmod(tmp_path, 0o700)
    output = tmp_path / "proof.json"
    helper.save_private(output, {"outcome": "unknown", "recovery": "test-only-lease"})
    helper.save_private(output, {"outcome": "observed", "recovery": "test-only-lease"})
    assert output.stat().st_mode & 0o777 == 0o600
    assert __import__("json").loads(output.read_text())["outcome"] == "observed"
    os.chmod(tmp_path, 0o755)
    with pytest.raises(ValueError):
        helper.save_private(output, {"outcome": "unsafe"})


def test_uncertain_scheduler_resume_is_attempted_once_and_retains_unknown_intent():
    runner, provider, clock, saved = cycle()
    p = runner.plan
    completed = {
        "status": "actual-lifecycle-and-postwake-readback-green-scheduler-paused",
        "plan_sha256": helper.digest(p),
    }
    approval = approve(p, "resume", clock, completed_sha256=helper.digest(completed))

    def transport(url, token, body=None):
        result = provider(url, token, body)
        if url.endswith(":resume"):
            raise OSError("receipt lost")
        return result

    with pytest.raises(OSError):
        helper.resume(
            p,
            completed,
            approval,
            runner.tokens,
            lambda value: saved.append(copy.deepcopy(value)),
            transport=transport,
            now=clock.wall(),
            wall=clock.wall,
        )
    assert sum(url.endswith(":resume") for url, _ in provider.calls) == 1
    assert saved[-1]["actions"][-1]["outcome"] == "unknown"


@pytest.mark.parametrize(
    "field,value",
    [
        ("environment", "prod"),
        ("region", "us-central1"),
        ("controllerUrl", "https://credentials.example.invalid"),
        ("targetHash", "f" * 64),
        ("service_bindings", {}),
    ],
)
def test_handcrafted_runtime_plan_cannot_bypass_preprod_prepare(field, value):
    runner, provider, _clock, _saved = cycle()
    runner.plan[field] = value
    runner.approval["plan_sha256"] = helper.digest(runner.plan)
    with pytest.raises(ValueError):
        runner.cycle()
    assert provider.calls == []


@pytest.mark.parametrize("fault", [None, "absent-log", "foreign-log", "changed-row"])
def test_complete_consumes_real_readback_verifier_causally_without_mocking(fault):
    fixture_module = load(
        "postwake_verifier_fixture", "tests/deployment/test_marketing_acceptance_job.py"
    )
    _source, prepared, _actual, execution, entry = fixture_module.fixture.__wrapped__()
    runner, _provider, clock, _saved = cycle()
    p = runner.plan
    p["migration_image"] = prepared["job"]["template"]["template"]["containers"][0][
        "image"
    ]
    p["browser_semantic_sha256"] = prepared["browser_sha256"]
    p["baseline_sql_proof"] = copy.deepcopy(
        entry["jsonPayload"]["axiom_marketing_readback"]["proof"]
    )
    runner.approval["plan_sha256"] = helper.digest(p)
    runner.proof["plan_sha256"] = helper.digest(p)
    pending = runner.cycle()
    prepared["database_connection_name"] = p["database_connection_name"]
    prepared["job"]["name"] = (
        p["readback_job"].removesuffix("-readback") + "-readback-postwake"
    )
    prepared["job_sha256"] = helper.readback.digest(prepared["job"])
    execution["name"] = prepared["job"]["name"] + "/executions/acceptance-123"
    execution["startTime"] = datetime.fromtimestamp(
        clock.wall() + 1, timezone.utc
    ).isoformat()
    execution["completionTime"] = datetime.fromtimestamp(
        clock.wall() + 30, timezone.utc
    ).isoformat()
    entry["timestamp"] = datetime.fromtimestamp(
        clock.wall() + 15, timezone.utc
    ).isoformat()
    entry["resource"]["labels"]["job_name"] = prepared["job"]["name"].rsplit("/", 1)[1]
    actual_job = copy.deepcopy(prepared["job"])
    entries = [entry]
    if fault == "absent-log":
        entries = []
    if fault == "foreign-log":
        entry["resource"]["labels"]["project_id"] = "another-project"
    if fault == "changed-row":
        entry["jsonPayload"]["axiom_marketing_readback"]["proof"]["observations"][
            "contacts"
        ][0]["name"] = "changed synthetic row"
    approval = approve(
        p,
        "complete",
        clock,
        cycle_sha256=helper.digest(pending),
        postwake_plan_sha256=helper.digest(prepared),
    )
    if fault:
        with pytest.raises(ValueError):
            helper.complete(
                p,
                pending,
                approval,
                prepared,
                actual_job,
                execution,
                entries,
                now=clock.wall() + 31,
            )
    else:
        result = helper.complete(
            p,
            pending,
            approval,
            prepared,
            actual_job,
            execution,
            entries,
            now=clock.wall() + 31,
        )
        assert (
            result["status"]
            == "actual-lifecycle-and-postwake-readback-green-scheduler-paused"
        )
