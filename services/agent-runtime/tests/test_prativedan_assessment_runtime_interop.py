"""Source harness refusal tests; no Docker/DB/network resources are executed."""

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from prativedan_assessment_runtime_interop import (
    NoExternalCalls,
    PgRpcBridge,
    owned_container,
    rpc_sql,
)


def test_rpc_scope_forbids_arbitrary_functions_and_keys():
    with pytest.raises(ValueError, match="Unscoped"):
        rpc_sql("append_ledger", {})
    with pytest.raises(ValueError, match="Unscoped"):
        rpc_sql(
            "load_prativedan_assessment_dispatch",
            {"t": "t", "k": "k", "r": "r", "rh": "h", "admin": True},
        )


def test_rpc_role_and_literal_escaping_preserve_original_text():
    body = "single'quote\\newline\n<&> नमस्ते;reset role;"
    sql = rpc_sql(
        "claim_prativedan_assessment_draft",
        {"t": "t", "k": "k", "r": "r", "rh": "h", "input_text": body},
    )
    assert "set role axiom_prativedan_controller" in sql
    assert "set standard_conforming_strings=on" in sql
    assert "single''quote" in sql
    assert "public.claim_prativedan_assessment_draft" in sql
    assert "input_text=>((a.v->>" in sql


@pytest.mark.parametrize(
    ("name", "args"),
    [
        ("load_prativedan_assessment_dispatch", {"t": "t", "k": "k", "r": "r", "rh": float("nan")}),
        (
            "load_prativedan_assessment_dispatch",
            {"t": "t", "k": "k", "r": "r", "rh": "x" * 4_194_304},
        ),
    ],
)
def test_rpc_nonfinite_or_oversized_args_refuse(name, args):
    with pytest.raises(ValueError, match=r"Out of range|RPC argument"):
        rpc_sql(name, args)


def test_hosted_fence_refuses_before_any_docker(monkeypatch):
    import prativedan_assessment_runtime_interop as harness

    call = Mock()
    monkeypatch.setattr(harness.subprocess, "run", call)
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    with pytest.raises(ValueError, match="hosted"):
        owned_container("a" * 64, Path.cwd().resolve())
    call.assert_not_called()


@pytest.mark.parametrize(
    "change",
    [
        {"Id": "b" * 64},
        {"Name": "/retained-database"},
        {"Config": {"Labels": {}}},
        {"HostConfig": {"PortBindings": {"5432/tcp": [{"HostPort": "5432"}]}}},
        {"State": {"Running": False}},
        {"HostConfig": {"PublishAllPorts": True}},
        {"NetworkSettings": {"Ports": {"5432/tcp": [{"HostPort": "5432"}]}}},
    ],
)
def test_inspection_refuses_foreign_or_exposed_container(monkeypatch, change):
    import json

    import prativedan_assessment_runtime_interop as harness

    item = {
        "Id": "a" * 64,
        "Name": "/axiom-prativedan-controller-" + "c" * 12,
        "Config": {
            "Labels": {
                "com.axiom.fixture": "database-policy-test",
                "com.axiom.fixture.project": "axiom-db-tests",
                "com.axiom.owner-worktree": str(Path.cwd().resolve()),
            }
        },
        "State": {"Running": True},
        "HostConfig": {"PortBindings": {}},
    }
    item.update(change)
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    monkeypatch.setenv("RUNNER_ENVIRONMENT", "github-hosted")
    call = Mock(return_value=SimpleNamespace(stdout=json.dumps([item])))
    monkeypatch.setattr(harness.subprocess, "run", call)
    with pytest.raises(ValueError, match="Foreign"):
        owned_container("a" * 64, Path.cwd().resolve())
    assert call.call_count == 1
    assert call.call_args.kwargs["env"]["DOCKER_HOST"] == "unix:///var/run/docker.sock"


def test_bridge_only_immutable_id_and_scoped_sql(monkeypatch):
    import prativedan_assessment_runtime_interop as harness

    bridge = object.__new__(PgRpcBridge)
    bridge.container_id = "a" * 64
    bridge.responses = {}
    call = Mock(return_value=SimpleNamespace(stdout='"9007199254740993"'))
    monkeypatch.setattr(harness.subprocess, "run", call)
    result = bridge.execute(
        "load_prativedan_assessment_dispatch", {"t": "t", "k": "k", "r": "r", "rh": "h"}
    )
    assert result == "9007199254740993"
    assert call.call_args.args[0][3] == "a" * 64
    assert "set role axiom_prativedan_controller" in call.call_args.kwargs["input"]
    assert call.call_args.kwargs["timeout"] == 10


def test_external_dependency_is_hard_refused():
    dependency = NoExternalCalls()
    with pytest.raises(RuntimeError, match="External"):
        dependency.complete()
    assert dependency.accesses == 1


@pytest.mark.asyncio
async def test_wrong_fixture_zero_rpc_and_no_output(tmp_path):
    from prativedan_assessment_runtime_interop import run_fixture

    bridge = Mock()
    with pytest.raises(ValueError, match="fixture shape"):
        await run_fixture({"fixture_kind": "fabricated"}, bridge, tmp_path)
    assert bridge.mock_calls == []
    assert list(tmp_path.iterdir()) == []


def test_foreign_worktree_zero_docker(monkeypatch, tmp_path):
    import prativedan_assessment_runtime_interop as harness

    call = Mock()
    monkeypatch.setattr(harness.subprocess, "run", call)
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    monkeypatch.setenv("RUNNER_ENVIRONMENT", "github-hosted")
    with pytest.raises(ValueError, match="hosted"):
        owned_container("a" * 64, tmp_path)
    call.assert_not_called()


def test_wrong_owner_label_refuses(monkeypatch):
    import json

    import prativedan_assessment_runtime_interop as harness

    item = {
        "Id": "a" * 64,
        "Name": "/axiom-prativedan-controller-" + "c" * 12,
        "Config": {
            "Labels": {
                "com.axiom.fixture": "database-policy-test",
                "com.axiom.fixture.project": "axiom-db-tests",
                "com.axiom.owner-worktree": "/foreign",
            }
        },
        "State": {"Running": True},
        "HostConfig": {"PortBindings": {}},
    }
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    monkeypatch.setenv("RUNNER_ENVIRONMENT", "github-hosted")
    monkeypatch.setattr(
        harness.subprocess, "run", Mock(return_value=SimpleNamespace(stdout=json.dumps([item])))
    )
    with pytest.raises(ValueError, match="Foreign"):
        owned_container("a" * 64, Path.cwd().resolve())
