from __future__ import annotations

import copy
import hashlib
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

import pytest
from lifecycle import Conflict, Controller, Target, Unavailable, bootstrap_state


class Store:
    def __init__(self, state):
        self.state, self.generation = state, 1
        self.lock = threading.Lock()
        self.barrier = None
        self.reads = 0
        self.before_write = None
        self.fail = False

    def read(self):
        if self.fail:
            raise Unavailable
        with self.lock:
            result = str(self.generation), copy.deepcopy(self.state)
            self.reads += 1
            barrier = self.barrier if self.reads <= 2 else None
        if barrier:
            barrier.wait(timeout=3)
        return result

    def write(self, generation, state):
        hook, self.before_write = self.before_write, None
        if hook:
            hook(state)
        with self.lock:
            if generation != str(self.generation):
                raise Conflict
            self.state = copy.deepcopy(state)
            self.generation += 1


class Cloud:
    def __init__(self):
        self.policy = "ALWAYS"
        self.state = "RUNNABLE"
        self.done = False
        self.calls = []
        self.fail = False
        self.fail_read = False

    def instance(self):
        if self.fail_read:
            raise Unavailable
        return {"state": self.state, "activationPolicy": self.policy}

    def activate(self, policy):
        self.calls.append(policy)
        self.policy = policy
        if self.fail:
            raise TimeoutError
        return "operation-1"

    def operation_done(self, operation):
        assert operation == "operation-1"
        return self.done


@pytest.fixture
def system():
    target = Target(
        "synthetic-project",
        "synthetic-project-preprod-db",
        "synthetic-project-preprod-state-123",
        "marketing-preprod/lifecycle/state.json",
        "a" * 64,
        idle_seconds=120,
    )
    store = Store(bootstrap_state(target, now=1000, phase="running"))
    cloud = Cloud()
    clock = [1121]
    controller = Controller(target, store, cloud, lambda: clock[0])
    return target, store, cloud, clock, controller


def body():
    return {"requestId": str(uuid4()), "leaseToken": "a" * 64}


def test_admission_release_and_idle_stop_preserve_request(system):
    _, store, cloud, clock, controller = system
    request = body()
    admitted = controller.handle("/gate/acquire", request)
    assert admitted.status == 200
    assert admitted.body["expiresAt"] == 1241
    assert controller.handle("/idle/check", {}).status == 503
    assert cloud.calls == []
    assert controller.handle("/gate/release", request).status == 200
    assert controller.handle("/idle/check", {}).body["status"] == "active"
    clock[0] += 121
    assert controller.handle("/idle/check", {}).body["status"] == "stopping"
    assert cloud.calls == ["NEVER"]
    assert store.state["phase"] == "stopping"
    assert controller.handle("/gate/acquire", body()).status == 503


def test_two_true_concurrent_admissions_have_two_durable_leases(system):
    _, store, cloud, _, controller = system
    store.barrier = threading.Barrier(2)
    first, second = body(), body()
    with ThreadPoolExecutor(max_workers=2) as pool:
        replies = list(
            pool.map(
                lambda value: controller.handle("/gate/acquire", value), [first, second]
            )
        )
    assert [reply.status for reply in replies] == [200, 200]
    assert set(store.state["leases"]) == {first["requestId"], second["requestId"]}
    assert cloud.calls == []


def test_admission_wins_cas_before_shutdown_no_stop(system):
    _, store, cloud, _, controller = system
    request = body()

    def hook(state):
        assert state["phase"] == "draining"
        assert controller.handle("/gate/acquire", request).status == 200

    store.before_write = hook
    assert controller.handle("/idle/check", {}).status == 503
    assert cloud.calls == []
    assert request["requestId"] in store.state["leases"]


def test_shutdown_wins_cas_before_admission_no_lease(system):
    _, store, cloud, _, controller = system

    def hook(state):
        assert state["phase"] == "running"
        assert controller.handle("/idle/check", {}).status == 503

    store.before_write = hook
    assert controller.handle("/gate/acquire", body()).status == 503
    assert cloud.calls == ["NEVER"]
    assert store.state["leases"] == {}


def test_expired_lease_missing_completion_never_stops(system):
    _, store, cloud, clock, controller = system
    request = body()
    assert controller.handle("/gate/acquire", request).status == 200
    clock[0] += 1000
    result = controller.handle("/idle/check", {})
    assert result.status == 503
    assert result.body["status"] == "in_flight_or_completion_unknown"
    assert cloud.calls == []
    assert request["requestId"] in store.state["leases"]
    assert controller.handle("/gate/acquire", request).status == 503
    assert controller.handle("/gate/release", request).status == 200


def test_retry_recovers_exact_lease_without_extending(system):
    _, store, _, clock, controller = system
    request = body()
    original = controller.handle("/gate/acquire", request)
    clock[0] += 10
    assert controller.handle("/gate/acquire", request) == original
    changed = {**request, "leaseToken": "b" * 64}
    assert controller.handle("/gate/acquire", changed).status == 409
    assert controller.handle("/gate/release", changed).status == 409
    assert len(store.state["leases"]) == 1


def test_wake_nonblocking_until_operation_done_and_live_runnable(system):
    _, store, cloud, _, controller = system
    store.state["phase"] = "stopped"
    cloud.policy = "NEVER"
    request = body()
    assert controller.handle("/gate/acquire", request).body["status"] == "starting"
    assert cloud.calls == ["ALWAYS"]
    assert controller.handle("/gate/acquire", request).status == 503
    cloud.done = True
    cloud.state = "MAINTENANCE"
    assert controller.handle("/gate/acquire", request).status == 503
    cloud.state = "RUNNABLE"
    assert controller.handle("/gate/acquire", request).status == 200
    assert cloud.calls == ["ALWAYS"]


def test_stop_done_then_wake_requires_distinct_operation(system):
    _, store, cloud, _, controller = system
    assert controller.handle("/idle/check", {}).status == 503
    cloud.done = True
    # Reconcile records stopped before initiating the separately scoped wake.
    cloud.done = False
    assert store.state["phase"] == "stopping"
    assert controller.handle("/gate/acquire", body()).status == 503
    cloud.done = True
    assert controller.handle("/idle/check", {}).body["status"] == "stopped"
    assert store.state["phase"] == "stopped"
    assert cloud.calls == ["NEVER"]


@pytest.mark.parametrize(
    "phase,path", [("running", "/idle/check"), ("stopped", "/gate/acquire")]
)
def test_uncertain_cloud_patch_does_not_repeat_or_admit(system, phase, path):
    _, store, cloud, _, controller = system
    store.state["phase"] = phase
    cloud.fail = True
    request = body() if path == "/gate/acquire" else {}
    assert controller.handle(path, request).status == 503
    assert len(cloud.calls) == 1
    assert store.state["operation"] is None
    for _ in range(2):
        assert controller.handle(path, request).status == 503
    assert len(cloud.calls) == 1
    assert store.state["leases"] == {}


@pytest.mark.parametrize(
    "damage", ["missing", "target", "clock", "lease", "version", "operation", "phase"]
)
def test_missing_or_corrupt_telemetry_refuses_stopping(system, damage):
    _, store, cloud, _, controller = system
    if damage == "missing":
        store.fail = True
    elif damage == "target":
        store.state["targetHash"] = "b" * 64
    elif damage == "clock":
        store.state["lastActivity"] = 999999
    elif damage == "lease":
        store.state["leases"] = {"bad-id": {"tokenHash": "a" * 64, "expiresAt": 10}}
    elif damage == "version":
        store.state["version"] = True
    elif damage == "operation":
        store.state["operation"] = "../other"
    else:
        store.state["phase"] = "unknown"
    assert controller.handle("/idle/check", {}).status == 503
    assert cloud.calls == []


@pytest.mark.parametrize(
    "payload",
    [
        {"project": "production"},
        {"requestId": "x", "leaseToken": "a" * 64},
        {**body(), "instance": "other"},
    ],
)
def test_body_cannot_select_resources(system, payload):
    _, store, cloud, _, controller = system
    assert controller.handle("/gate/acquire", payload).status == 400
    assert store.generation == 1
    assert cloud.calls == []


def test_live_runnable_required_even_for_recovered_lease(system):
    _, _, cloud, _, controller = system
    request = body()
    assert controller.handle("/gate/acquire", request).status == 200
    cloud.policy = "NEVER"
    assert controller.handle("/gate/acquire", request).status == 503
    cloud.fail_read = True
    assert controller.handle("/idle/check", {}).status == 503


def environment(tmp_path: Path):
    approved = {
        "environment": "preprod",
        "project": "synthetic-project",
        "instance": "synthetic-project-preprod-db",
        "bucket": "synthetic-project-preprod-state-123",
        "object": "marketing-preprod/lifecycle/state.json",
    }
    path = tmp_path / "approved.json"
    path.write_text(json.dumps(approved))
    return {
        "AXIOM_IDLE_TARGET_MANIFEST": str(path),
        "AXIOM_IDLE_TARGET_MANIFEST_SHA256": hashlib.sha256(
            path.read_bytes()
        ).hexdigest(),
        "ENVIRONMENT": approved["environment"],
        "GCP_PROJECT_ID": approved["project"],
        "CLOUD_SQL_INSTANCE_NAME": approved["instance"],
        "AXIOM_IDLE_STATE_BUCKET": approved["bucket"],
        "AXIOM_IDLE_STATE_OBJECT": approved["object"],
    }


def test_packaged_target_matches_selected_env(tmp_path):
    target = Target.from_environment(environment(tmp_path))
    assert target.project == "synthetic-project"
    assert target.lease_seconds >= target.request_seconds + 30


@pytest.mark.parametrize(
    "key,value",
    [
        ("ENVIRONMENT", "production"),
        ("GCP_PROJECT_ID", "arbitrary-project"),
        ("CLOUD_SQL_INSTANCE_NAME", "other-db"),
        ("AXIOM_IDLE_STATE_BUCKET", "other-bucket"),
        ("AXIOM_IDLE_STATE_OBJECT", "other/path"),
        ("AXIOM_IDLE_TARGET_MANIFEST_SHA256", "b" * 64),
        ("AXIOM_IDLE_REQUEST_MAX_SECONDS", "26"),
        ("AXIOM_IDLE_LEASE_SECONDS", "20"),
        ("AXIOM_IDLE_INTERVAL_SECONDS", "10"),
    ],
)
def test_config_drift_or_unsafe_bounds_refused(tmp_path, key, value):
    config = environment(tmp_path)
    config[key] = value
    with pytest.raises(Unavailable):
        Target.from_environment(config)


def test_lost_admission_reply_recovers_original_durable_lease(system):
    _, store, _, clock, controller = system
    original_write = store.write
    first = [True]

    def lost_write(generation, state):
        original_write(generation, state)
        if first[0]:
            first[0] = False
            raise Unavailable("reply_lost_after_commit")

    store.write = lost_write
    request = body()
    assert controller.handle("/gate/acquire", request).status == 503
    expires = store.state["leases"][request["requestId"]]["expiresAt"]
    clock[0] += 10
    recovered = controller.handle("/gate/acquire", request)
    assert recovered.status == 200
    assert recovered.body["expiresAt"] == expires
    assert len(store.state["leases"]) == 1


def test_elapsed_acquisition_cannot_admit_an_expired_lease(system):
    _, store, cloud, clock, controller = system
    original_instance = cloud.instance

    def slow_instance():
        clock[0] += 130
        return original_instance()

    cloud.instance = slow_instance
    request = body()
    reply = controller.handle("/gate/acquire", request)
    assert reply.status == 503
    assert reply.body["status"] == "lease_expired"
    assert request["requestId"] in store.state["leases"]
    assert cloud.calls == []


def test_near_expiry_recovery_cannot_start_a_new_full_request(system):
    _, store, _, clock, controller = system
    request = body()
    assert controller.handle("/gate/acquire", request).status == 200
    original = copy.deepcopy(store.state["leases"])
    clock[0] += 110
    assert controller.handle("/gate/acquire", request).status == 503
    assert store.state["leases"] == original


@pytest.mark.parametrize(
    "key,value",
    [
        ("ENVIRONMENT", "production"),
        ("CLOUD_SQL_INSTANCE_NAME", "synthetic-project-production-db"),
        ("AXIOM_IDLE_STATE_BUCKET", "synthetic-project-production-state-123"),
        ("AXIOM_IDLE_STATE_OBJECT", "production/lifecycle/state.json"),
    ],
)
def test_even_matching_packaged_manifest_cannot_enable_production(tmp_path, key, value):
    config = environment(tmp_path)
    config[key] = value
    path = Path(config["AXIOM_IDLE_TARGET_MANIFEST"])
    approved = {
        "environment": config["ENVIRONMENT"],
        "project": config["GCP_PROJECT_ID"],
        "instance": config["CLOUD_SQL_INSTANCE_NAME"],
        "bucket": config["AXIOM_IDLE_STATE_BUCKET"],
        "object": config["AXIOM_IDLE_STATE_OBJECT"],
    }
    path.write_text(json.dumps(approved))
    config["AXIOM_IDLE_TARGET_MANIFEST_SHA256"] = hashlib.sha256(
        path.read_bytes()
    ).hexdigest()
    with pytest.raises(Unavailable):
        Target.from_environment(config)
