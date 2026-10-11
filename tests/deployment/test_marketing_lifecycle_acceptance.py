"""Mock provider contract tests. No live controller/cloud or stop/wake proof."""

import importlib.util
import time
from copy import deepcopy
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "acceptance", ROOT / "scripts/marketing-lifecycle-acceptance.py"
)
acceptance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acceptance)


def fixture(change=None):
    source = {
        "project": "test-project",
        "instance": "test-project-preprod-postgres",
        "bucket": "test-project-preprod-state-123",
        "object": "marketing-preprod/lifecycle/state.json",
        "targetHash": "a" * 64,
        "controllerUrl": "https://selected.run.app",
        "expiresUnix": time.time() + 180,
    }
    state = {"phase": "running", "targetHash": source["targetHash"], "leases": {}}
    sql = {
        "name": source["instance"],
        "project": source["project"],
        "state": "RUNNABLE",
        "settings": {"activationPolicy": "ALWAYS", "settingsVersion": "1"},
    }
    calls = []
    saved = []

    def transport(url, token, body=None):
        calls.append((url, deepcopy(body)))
        if url.endswith("/gate/acquire"):
            if change == "lost-acquire":
                raise OSError("Mock lost reply after unspecified server outcome")
            if change == "not-admitted":
                return 503, {"status": "starting"}
            state["leases"][body["requestId"]] = {
                "tokenHash": acceptance.sha(body["leaseToken"].encode()),
                "expiresAt": time.time() + 120,
            }
            if change == "lease-hash":
                state["leases"][body["requestId"]]["tokenHash"] = "b" * 64
            return 200, {"status": "admitted"}
        if url.endswith("/idle/check"):
            if change == "idle-accepted":
                return 200, {"status": "stopping"}
            if change == "policy-drift":
                sql["settings"]["activationPolicy"] = "NEVER"
            return 503, {"status": "in_flight_or_completion_unknown"}
        if url.endswith("/gate/release"):
            if change == "lost-release":
                raise OSError("Mock lost release reply")
            state["leases"].pop(body["requestId"])
            return 200, {"status": "released"}
        if url.startswith("https://sqladmin.googleapis.com/"):
            result = deepcopy(sql)
            if change == "foreign-sql":
                result["name"] = "foreign"
            if change == "stopped":
                result["settings"]["activationPolicy"] = "NEVER"
            return 200, result
        if "alt=media" in url:
            if change == "foreign-target":
                return 200, {**state, "targetHash": "b" * 64}
            return 200, deepcopy(state)
        metadata = {
            "bucket": source["bucket"],
            "name": source["object"],
            "generation": "123",
        }
        if change == "foreign-object":
            metadata["name"] = "customer/private.json"
        return 200, metadata

    return source, transport, calls, saved


def test_mock_observations_preserve_generation_and_exact_durable_lease():
    source, transport, calls, saved = fixture()
    proof = acceptance.hold_and_refuse(
        source,
        "mock-access",
        "mock-identity",
        lambda p: saved.append(deepcopy(p)),
        transport,
    )
    assert proof["status"] == "actual-in-flight-refusal-observed-cold-cycle-pending"
    assert len(proof["observations"]) == 4
    assert all(p["generation"] == "123" for p in proof["observations"])
    assert [a["path"] for a in proof["actions"]] == [
        "/gate/acquire",
        "/idle/check",
        "/gate/release",
    ]
    assert saved[0]["actions"][0]["outcome"] == "unknown"
    assert any("alt=media&generation=123" in url for url, _ in calls)
    assert not any("sql" in url and body is not None for url, body in calls)


@pytest.mark.parametrize(
    "change",
    [
        "foreign-sql",
        "foreign-object",
        "foreign-target",
        "stopped",
        "lease-hash",
        "idle-accepted",
        "policy-drift",
        "not-admitted",
    ],
)
def test_concrete_provider_mismatch_refuses_without_implicit_wake(change):
    source, transport, calls, saved = fixture(change)
    with pytest.raises(ValueError):
        acceptance.hold_and_refuse(
            source,
            "mock-access",
            "mock-identity",
            lambda p: saved.append(deepcopy(p)),
            transport,
        )
    actions = [url.rsplit("/", 1)[-1] for url, body in calls if body is not None]
    if change in ("foreign-sql", "foreign-object", "foreign-target", "stopped"):
        assert actions == []
    if change in ("lease-hash", "idle-accepted", "policy-drift"):
        assert actions[-1] == "release"


@pytest.mark.parametrize("change", ["lost-acquire", "lost-release"])
def test_lost_mutation_reply_retains_original_intent_and_never_retries(change):
    source, transport, calls, saved = fixture(change)
    with pytest.raises(OSError):
        acceptance.hold_and_refuse(
            source,
            "mock-access",
            "mock-identity",
            lambda p: saved.append(deepcopy(p)),
            transport,
        )
    assert len([u for u, _ in calls if u.endswith("/gate/acquire")]) == 1
    if change == "lost-acquire":
        assert not any(u.endswith("/gate/release") for u, _ in calls)
    assert saved[-1]["actions"][-1]["outcome"] == "unknown"
    assert len(saved[-1]["leaseToken"]) == 64


def test_expired_scope_never_transmits_mutation():
    source, transport, calls, saved = fixture()
    source["expiresUnix"] = time.time() - 1
    with pytest.raises(ValueError):
        acceptance.hold_and_refuse(
            source,
            "mock-access",
            "mock-identity",
            lambda p: saved.append(deepcopy(p)),
            transport,
        )
    assert not any(body is not None for _, body in calls)


@pytest.mark.parametrize(
    "change",
    [
        None,
        "manifest",
        "hash",
        "services",
        "approval-hash",
        "actions",
        "expiry",
        "environment",
    ],
)
def test_protected_preparation_binds_exact_target_release_actions_and_scope(
    tmp_path, change
):
    import json
    import os

    manifest = {
        "environment": "preprod",
        "project": "test-project",
        "instance": "test-project-preprod-postgres",
        "bucket": "test-project-preprod-state-123",
        "object": "marketing-preprod/lifecycle/state.json",
    }

    def private(name, value):
        p = tmp_path / name
        p.write_text(json.dumps(value))
        os.chmod(p, 0o600)
        return p, acceptance.sha(p.read_bytes())

    target, target_hash = private("target.json", manifest)
    services, service_hash = private(
        "services.json",
        {
            "project": "test-project",
            "release_sha": "a" * 40,
            "lifecycle_controller_uri": "https://selected.run.app",
        },
    )
    approval_data = {
        "kind": "marketing-preprod-lifecycle-acceptance",
        "project": "test-project",
        "release_sha": "a" * 40,
        "services_receipt_sha256": service_hash,
        "target_manifest_sha256": target_hash,
        "approved_by": "test operator",
        "actions": ["observe", "gate/acquire", "idle/check", "gate/release"],
        "expires_unix": int(time.time()) + 180,
    }
    if change == "manifest":
        target, _ = private("target.json", {**manifest, "instance": "foreign"})
    elif change == "services":
        services, _ = private(
            "services.json",
            {
                "project": "foreign-project",
                "release_sha": "a" * 40,
                "lifecycle_controller_uri": "https://foreign.run.app",
            },
        )
    elif change == "approval-hash":
        approval_data["services_receipt_sha256"] = "f" * 64
    elif change == "actions":
        approval_data["actions"] = ["observe", "stop"]
    elif change == "expiry":
        approval_data["expires_unix"] = int(time.time()) - 1
    approval, _ = private("approval.json", approval_data)
    env = tmp_path / "selected.env"
    variables = {
        "ENVIRONMENT": "production" if change == "environment" else "preprod",
        "GCP_REGION": "asia-south1",
        "GCP_PROJECT_ID": "test-project",
        "CLOUD_SQL_INSTANCE_NAME": manifest["instance"],
        "AXIOM_IDLE_STATE_BUCKET": manifest["bucket"],
        "AXIOM_IDLE_STATE_OBJECT": manifest["object"],
        "AXIOM_IDLE_TARGET_MANIFEST_SHA256": "f" * 64
        if change == "hash"
        else target_hash,
    }
    env.write_text("\n".join(k + "=" + v for k, v in variables.items()) + "\n")
    os.chmod(env, 0o600)
    if change is None:
        result = acceptance.prepare(env, services, target, approval, "hold")
        assert result["controllerUrl"] == "https://selected.run.app"
        assert result["targetHash"] == target_hash
    else:
        with pytest.raises(ValueError):
            acceptance.prepare(env, services, target, approval, "hold")
