"""Real client lookup plus fixed singleton adapter and credentialless IPC contracts."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
from supabase import ClientOptions, create_client

from axiom import owned_execution_worker as worker
from axiom.executor import ExecutorDb
from axiom.owned_execution_adapter import OwnedExecutionAdapter
from axiom.write_adapters import WriteRefused


def uid(n):
    return f"89110000-0000-4000-8000-{n:012d}"


def fixture():
    rollback = {"enabled": False, "snapshot_sha256": "a" * 64}
    row = {
        "id": uid(3),
        "plan_id": uid(2),
        "action_type": "config.audit_log_enable",
        "parameters": {"enabled": True},
        "rollback_definition": rollback,
    }
    token = {
        "spec": {
            "planId": uid(2),
            "actionIds": [uid(3)],
            "contentDigest": "b" * 64,
            "concurrency": 1,
        },
        "signature": "c" * 64,
    }
    payload = SimpleNamespace(
        tenant_id=uid(1),
        plan_id=uid(2),
        action_ids=[uid(3)],
        approval_token=token,
        content_digest="b" * 64,
        concurrency=1,
        request_key="synthetic-request",
    )
    port = SimpleNamespace(
        call=AsyncMock(
            return_value={
                "rows_affected": 1,
                "pre_state_ref": "owned-synthetic/snapshot/" + "a" * 64,
                "post_state_ref": "owned-synthetic/snapshot/" + "b" * 64,
            }
        )
    )
    return payload, row, port


def test_real_installed_supabase_builder_reads_action_with_python_method():
    calls = []

    def respond(request):
        calls.append(request)
        return httpx.Response(
            200,
            json=[
                {
                    "id": uid(3),
                    "plan_id": uid(2),
                    "action_type": "config.audit_log_enable",
                    "parameters": {"enabled": True},
                    "blast_radius": {"records": 1},
                    "rollback_definition": {"enabled": False, "snapshot_sha256": "a" * 64},
                }
            ],
        )

    client = create_client(
        "http://fixture.invalid",
        "synthetic-key",
        options=ClientOptions(
            auto_refresh_token=False,
            persist_session=False,
            httpx_client=httpx.Client(transport=httpx.MockTransport(respond)),
        ),
    )
    row = ExecutorDb(client).action_row(uid(1), uid(3))
    assert row["id"] == uid(3)
    assert len(calls) == 1
    assert calls[0].url.path == "/rest/v1/remediation_actions"
    assert calls[0].url.params["tenant_id"] == "eq." + uid(1)
    assert calls[0].url.params["id"] == "eq." + uid(3)
    assert "rollback_definition" in calls[0].url.params["select"]


@pytest.mark.asyncio
async def test_adapter_fixed_scope_and_rollbacks_use_same_bound_approval():
    payload, row, port = fixture()
    adapter = OwnedExecutionAdapter(payload, row, port)
    payload.approval_token["signature"] = "changed after constructor"
    await adapter.execute("config.audit_log_enable", {"enabled": True})
    await adapter.simulate_rollback("config.audit_log_enable", row["rollback_definition"])
    await adapter.execute_rollback("config.audit_log_enable", row["rollback_definition"])
    assert [c.args[0]["operation"] for c in port.call.call_args_list] == [
        "forward",
        "simulate_rollback",
        "rollback",
    ]
    assert all(c.args[0]["token"]["signature"] == "c" * 64 for c in port.call.call_args_list)
    assert all(
        set(c.args[0]) == {"tenantId", "planId", "actionId", "requestKey", "token", "operation"}
        for c in port.call.call_args_list
    )


@pytest.mark.parametrize(
    "change",
    [
        lambda p, r: setattr(p, "action_ids", [uid(3), uid(4)]),
        lambda p, r: r.update(id=uid(4)),
        lambda p, r: r.update(action_type="custom"),
        lambda p, r: r.update(parameters={"enabled": 1}),
        lambda p, r: r.update(rollback_definition={"enabled": False, "sql": "not allowed"}),
        lambda p, r: p.approval_token["spec"].update(actionIds=[uid(4)]),
    ],
)
def test_unregistered_or_mixed_or_modified_scope_refused_before_port(change):
    payload, row, port = fixture()
    change(payload, row)
    with pytest.raises(WriteRefused):
        OwnedExecutionAdapter(payload, row, port)
    port.call.assert_not_called()


@pytest.mark.asyncio
async def test_modified_action_or_rollback_never_reaches_controller():
    payload, row, port = fixture()
    adapter = OwnedExecutionAdapter(payload, row, port)
    for params in ({"enabled": 1}, {"enabled": True, "system": "caller-controlled"}):
        with pytest.raises(WriteRefused):
            await adapter.execute("config.audit_log_enable", params)
    with pytest.raises(WriteRefused):
        await adapter.execute_rollback(
            "config.audit_log_enable", {"enabled": False, "snapshot_sha256": "d" * 64}
        )
    port.call.assert_not_called()


@pytest.mark.asyncio
async def test_refused_controller_error_is_sanitized():
    payload, row, port = fixture()
    port.call.side_effect = ValueError("private synthetic diagnostic")
    with pytest.raises(WriteRefused, match="owned_execution_unconfirmed") as error:
        await OwnedExecutionAdapter(payload, row, port).execute(
            "config.audit_log_enable", {"enabled": True}
        )
    assert "private" not in str(error.value)


def test_worker_svid_only_leaves_in_private_tool_frame(monkeypatch):
    payload, _, _ = fixture()
    frames = []
    request = {
        "tenantId": payload.tenant_id,
        "planId": payload.plan_id,
        "actionId": uid(3),
        "requestKey": payload.request_key,
        "token": payload.approval_token,
        "operation": "forward",
    }
    metadata = {
        "rows_affected": 1,
        "pre_state_ref": "owned-synthetic/snapshot/" + "a" * 64,
        "post_state_ref": "owned-synthetic/snapshot/" + "b" * 64,
    }
    monkeypatch.setattr(worker, "write_frame", frames.append)
    monkeypatch.setattr(worker, "read_frame", lambda: {"ok": True, "value": metadata})
    worker.execute(request, lambda: "private-synthetic-proof")
    assert frames == [
        {
            "tool": "owned.execute",
            "request": {**request, "workloadProof": "private-synthetic-proof"},
        },
        {"result": metadata},
    ]
    assert "private-synthetic-proof" not in json.dumps(frames[1])


def test_worker_cannot_accept_caller_credentials_or_identity():
    payload, _, _ = fixture()
    identity = Mock()
    for extra in ("endpoint", "password", "sql", "workloadProof", "spiffeId"):
        with pytest.raises(ValueError, match="Owned assignment refused"):
            worker.execute({"tenantId": payload.tenant_id, extra: "caller-controlled"}, identity)
    identity.assert_not_called()


def test_real_installed_supabase_maybe_single_empty_result_is_absent():
    client = create_client(
        "http://fixture.invalid",
        "synthetic-key",
        options=ClientOptions(
            auto_refresh_token=False,
            persist_session=False,
            httpx_client=httpx.Client(
                transport=httpx.MockTransport(lambda _: httpx.Response(200, json=[]))
            ),
        ),
    )
    assert ExecutorDb(client).action_row(uid(1), uid(3)) is None


def test_owned_execution_requires_explicit_local_deployment():
    from axiom.config import Settings

    assert not Settings(_env_file=None, AXIOM_OWNED_EXECUTION_ENABLED="1").owned_execution_enabled
    with pytest.raises(ValueError, match="reviewed local socket"):
        Settings(
            _env_file=None,
            AXIOM_OWNED_EXECUTION_ENABLED=True,
            environment="production",
            AXIOM_OWNED_EXECUTION_SOCKET="/protected/socket",
        )


@pytest.mark.asyncio
async def test_existing_executor_keeps_signed_gate_settlement_verification_and_reconciliation():
    from datetime import UTC, datetime, timedelta

    from test_executor import FakeDb, FakeKillSwitch

    from axiom.approval_engine import ApprovalEngine, ApprovalTokenSpec
    from axiom.executor import execute_batch

    payload, row, port = fixture()
    payload.correlation_id = uid(5)
    payload.mode = "batch"
    payload.stop_on_failure = True
    spec = ApprovalTokenSpec(
        plan_id=payload.plan_id,
        action_ids=payload.action_ids,
        approver_id=uid(6),
        mode="batch",
        concurrency=1,
        stop_on_failure=True,
        expires_at=(datetime.now(UTC) + timedelta(minutes=5)).isoformat(),
        nonce="synthetic-executor-nonce",
        content_digest=payload.content_digest,
    )
    engine = ApprovalEngine("synthetic-executor-key")
    payload.approval_token = {
        "spec": spec.to_canonical(),
        "signature": await engine.sign(payload.tenant_id, spec),
    }
    write_result = port.call.return_value

    async def invoke(request):
        if request["operation"] == "verify":
            return {
                "checks": [
                    {
                        "check_id": "owned.synthetic.audit_log_boolean",
                        "outcome": "passed",
                        "detail": "Dedicated synthetic boolean only.",
                    }
                ]
            }
        return write_result

    port.call.side_effect = invoke
    db = FakeDb()
    db.rows[row["id"]] = row

    async def verify(tenant, token):
        result = await engine.verify(tenant, token)
        return result.valid, result.reason

    result = await execute_batch(
        payload,
        db=db,
        kill_switch=FakeKillSwitch(),
        adapter=OwnedExecutionAdapter(payload, row, port),
        verify_token=verify,
        signing_key="synthetic-executor-key",
    )
    assert result.status == "completed"
    assert [c.args[0]["operation"] for c in port.call.call_args_list] == ["forward", "verify"]
    calls = [name for name, _ in db.rpc_calls]
    for required in (
        "start_claimed_execution_batch",
        "mark_execution_action_started",
        "settle_execution_action",
        "record_verification_result",
        "prepare_plan_reconciliation",
        "record_plan_reconciliation",
    ):
        assert required in calls
    assert (
        calls.index("start_claimed_execution_batch")
        < calls.index("settle_execution_action")
        < calls.index("record_verification_result")
        < calls.index("record_plan_reconciliation")
    )


@pytest.mark.asyncio
async def test_existing_executor_refuses_invalid_signature_before_owned_target_call():
    from test_executor import FakeDb, FakeKillSwitch

    from axiom.executor import ExecutorRefused, execute_batch

    payload, row, port = fixture()
    db = FakeDb()

    async def refused(_tenant, _token):
        return False, "signature_mismatch"

    with pytest.raises(ExecutorRefused, match="approval_token_invalid"):
        await execute_batch(
            payload,
            db=db,
            kill_switch=FakeKillSwitch(),
            adapter=OwnedExecutionAdapter(payload, row, port),
            verify_token=refused,
        )
    port.call.assert_not_called()
    assert db.rpc_calls == []
