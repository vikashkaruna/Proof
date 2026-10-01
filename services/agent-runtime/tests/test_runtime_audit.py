"""Runtime audit must remain durable, redacted and fail closed."""

import base64
import json
import time
from dataclasses import asdict
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from pydantic import BaseModel

from axiom.agents.base import AgentName, BaseAgent
from axiom.config import Settings
from axiom.ledger_client import AppendInput, AppendResult, LedgerClient

PRIVATE = "synthetic-private-approval-and-personal-data"
TENANT = "47470000-0000-4000-8000-000000000001"
RECEIPT = "17"


class AuditInput(BaseModel):
    tenant_id: str
    count: int
    private_value: str


class AuditOutput(BaseModel):
    count: int
    private_value: str


class AuditAgent(BaseAgent[AuditInput, AuditOutput]):
    name = AgentName.PRATIVEDAN

    def input_schema(self):
        return AuditInput

    def output_schema(self):
        return AuditOutput

    async def _run(self, *, correlation_id, input, **deps):
        self.invocations += 1
        if self.fail:
            raise RuntimeError(PRIVATE)
        return AuditOutput(count=input.count, private_value=input.private_value)


@pytest.fixture
def fixture():
    append = AsyncMock(
        return_value=AppendResult(id=RECEIPT, occurred_at=datetime.now(timezone.utc))
    )
    agent = AuditAgent(
        settings=Settings(_env_file=None),
        ledger=SimpleNamespace(append=append),
        evidence=Mock(),
        model_gateway=Mock(),
    )
    agent.log = Mock()
    agent.invocations = 0
    agent.fail = False
    payload = {"tenant_id": TENANT, "count": 2, "private_value": PRIVATE}
    return agent, append, payload


@pytest.mark.asyncio
async def test_success_hashes_data_without_persisting_or_logging_raw_values(fixture):
    agent, append, payload = fixture
    result = await agent.invoke(payload)
    assert result.status == "succeeded"
    # The authorized business result remains available; only audit is redacted.
    assert result.output["private_value"] == PRIVATE
    entries = [asdict(call.args[0]) for call in append.call_args_list]
    assert PRIVATE not in json.dumps(entries)
    assert PRIVATE not in str(agent.log.mock_calls)
    assert len(entries[0]["input_hash"]) == 64
    assert entries[0]["input_hash"] == entries[1]["input_hash"]
    assert len(entries[1]["output_hash"]) == 64
    assert entries[0]["detail"] == {"phase": "started"}
    assert entries[1]["detail"] == {"phase": "completed", "started_entry": RECEIPT}


@pytest.mark.asyncio
async def test_input_validation_refuses_before_audit_and_never_echoes_pydantic_values(fixture):
    agent, append, payload = fixture
    payload["count"] = PRIVATE
    result = await agent.invoke(payload)
    assert result.status == "failed" and result.error == "validation_failed"
    assert agent.invocations == 0
    append.assert_not_called()
    assert PRIVATE not in str(agent.log.mock_calls)
    assert PRIVATE not in str(asdict(result))


@pytest.mark.asyncio
async def test_unrelated_base_model_cannot_bypass_declared_schema(fixture):
    agent, append, _ = fixture

    class ForeignModel(BaseModel):
        private_value: str

    result = await agent.invoke(ForeignModel(private_value=PRIVATE))
    assert result.error == "validation_failed"
    assert agent.invocations == 0
    append.assert_not_called()


@pytest.mark.asyncio
async def test_started_audit_failure_prevents_execution_and_sanitizes_error(fixture):
    agent, append, payload = fixture
    append.side_effect = RuntimeError(PRIVATE)
    result = await agent.invoke(payload)
    assert result.status == "failed" and result.error == "ledger_append_failed"
    assert agent.invocations == 0 and result.output is None
    assert PRIVATE not in str(agent.log.mock_calls)
    assert PRIVATE not in str(asdict(result))


@pytest.mark.asyncio
async def test_completion_audit_failure_never_returns_success_or_output(fixture):
    agent, append, payload = fixture
    receipt = AppendResult(id=RECEIPT, occurred_at=datetime.now(timezone.utc))
    append.side_effect = [receipt, RuntimeError(PRIVATE), receipt]
    result = await agent.invoke(payload)
    assert result.status == "failed" and result.error == "audit_completion_failed"
    assert result.output is None and agent.invocations == 1
    assert append.call_args_list[-1].args[0].result == "failure"
    assert PRIVATE not in json.dumps([asdict(call.args[0]) for call in append.call_args_list])
    assert PRIVATE not in str(agent.log.mock_calls)


@pytest.mark.asyncio
async def test_agent_failure_and_failed_error_audit_do_not_leak_exception_detail(fixture):
    agent, append, payload = fixture
    agent.fail = True
    append.side_effect = [
        AppendResult(id=RECEIPT, occurred_at=datetime.now(timezone.utc)),
        RuntimeError(PRIVATE),
    ]
    result = await agent.invoke(payload)
    assert result.status == "failed" and result.error == "agent_failed"
    assert result.output is None
    assert PRIVATE not in json.dumps([asdict(call.args[0]) for call in append.call_args_list])
    assert PRIVATE not in str(agent.log.mock_calls)
    assert PRIVATE not in str(asdict(result))


@pytest.mark.asyncio
async def test_invalid_output_fails_without_disclosing_or_recording_raw_values(fixture):
    agent, append, payload = fixture
    agent._run = AsyncMock(return_value={"count": PRIVATE, "private_value": PRIVATE})
    result = await agent.invoke(payload)
    assert result.status == "failed" and result.error == "agent_failed"
    assert result.output is None
    assert append.call_args_list[-1].args[0].result == "failure"
    assert PRIVATE not in json.dumps([asdict(call.args[0]) for call in append.call_args_list])
    assert PRIVATE not in str(agent.log.mock_calls)
    assert PRIVATE not in str(asdict(result))


def _jwt(role: str, exp: int | None = None) -> str:
    def part(value: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b"=").decode()

    return f"{part({'alg': 'HS256'})}.{part({'role': role, 'exp': exp or int(time.time()) + 600})}.sig"


def _strict_settings(environment: str, **overrides):
    values = dict(
        environment=environment,
        supabase_url="http://127.0.0.1:56321",
        supabase_service_key="synthetic-service",
        supabase_anon_key="synthetic-anon",
        supabase_agent_ledger_writer_key=_jwt("agent_ledger_writer"),
    )
    values.update(overrides)
    return SimpleNamespace(**values)


@pytest.mark.parametrize("environment", ["staging", "preprod", "production"])
def test_strict_environment_never_selects_memory_for_loopback_or_client_failure(
    monkeypatch, environment
):
    settings = _strict_settings(environment)
    client = Mock()
    create = Mock(return_value=client)
    monkeypatch.setattr("axiom.ledger_client.create_client", create)
    assert LedgerClient.from_settings(settings).in_memory_mode is False
    writer_call, read_call = create.call_args_list
    # Appends: public apikey, with the scoped writer as the Bearer identity; the
    # shared service-role key is never presented on the append client.
    assert writer_call.args == (settings.supabase_url, "synthetic-anon")
    options = writer_call.kwargs["options"]
    assert options.headers == {
        "Authorization": f"Bearer {settings.supabase_agent_ledger_writer_key}"
    }
    assert settings.supabase_service_key not in str(writer_call)
    # Reads (verify_ledger, audit_ledger queries) are a separate client; the
    # writer role cannot execute them and the writer JWT is not sent with them.
    assert read_call.args == (settings.supabase_url, settings.supabase_service_key)
    assert settings.supabase_agent_ledger_writer_key not in str(read_call)
    create.side_effect = RuntimeError(PRIVATE)
    with pytest.raises(RuntimeError, match="^Audit ledger configuration was refused$"):
        LedgerClient.from_settings(settings)


@pytest.mark.parametrize("environment", ["staging", "preprod", "production", "development"])
@pytest.mark.parametrize(
    "overrides",
    [
        {"supabase_agent_ledger_writer_key": None},
        {"supabase_agent_ledger_writer_key": ""},
        {"supabase_agent_ledger_writer_key": "synthetic-service"},
        {"supabase_agent_ledger_writer_key": "not-a-jwt"},
        {"supabase_agent_ledger_writer_key": _jwt("service_role")},
        {"supabase_agent_ledger_writer_key": _jwt("human_action_writer")},
        {"supabase_agent_ledger_writer_key": _jwt("agent_ledger_writer", exp=1)},
        {"supabase_anon_key": None},
    ],
)
def test_missing_or_wrong_writer_credential_fails_closed_without_fallback(
    monkeypatch, environment, overrides
):
    # development only reaches the remote path for a non-loopback target.
    url = "https://remote.test.invalid" if environment == "development" else "http://127.0.0.1:1"
    settings = _strict_settings(environment, supabase_url=url, **overrides)
    create = Mock()
    monkeypatch.setattr("axiom.ledger_client.create_client", create)
    with pytest.raises(RuntimeError, match="^Audit ledger configuration was refused$"):
        LedgerClient.from_settings(settings)
    create.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("in_memory", [True, False])
async def test_human_labelled_events_are_refused_by_the_agent_ledger(in_memory):
    db = Mock()
    ledger = LedgerClient.in_memory() if in_memory else LedgerClient(db)
    with pytest.raises(RuntimeError, match="^Audit ledger append refused for actor type$"):
        await ledger.append(
            AppendInput(
                tenant_id=TENANT,
                correlation_id=TENANT,
                actor_type="human",
                actor_id=TENANT,
                action_type="approval.granted",
            )
        )
    db.rpc.assert_not_called()


@pytest.mark.parametrize(
    "url",
    ["https://remote.test.invalid", "http://localhost.evil.invalid", "http://127.evil.invalid"],
)
def test_remote_development_configuration_also_cannot_silently_fall_back(monkeypatch, url):
    settings = _strict_settings("development", supabase_url=url)
    monkeypatch.setattr(
        "axiom.ledger_client.create_client", Mock(side_effect=RuntimeError(PRIVATE))
    )
    with pytest.raises(RuntimeError, match="^Audit ledger configuration was refused$"):
        LedgerClient.from_settings(settings)


@pytest.mark.parametrize("environment", ["development", "test"])
def test_explicit_loopback_development_and_tests_retain_memory_ledger(environment):
    settings = SimpleNamespace(environment=environment, supabase_url="http://localhost:54321")
    assert LedgerClient.from_settings(settings).in_memory_mode is True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "data",
    [None, "", "0", 0, -1, True, 1.5, 9223372036854775808, "01", "invalid", {}, {"id": RECEIPT}],
)
async def test_missing_or_malformed_remote_receipt_is_not_success(data):
    db = Mock()
    db.rpc.return_value.execute.return_value = SimpleNamespace(data=data)
    ledger = LedgerClient(db)
    with pytest.raises(RuntimeError, match="^Audit ledger append was not confirmed$"):
        await ledger.append(
            AppendInput(
                tenant_id=TENANT,
                correlation_id=TENANT,
                actor_type="agent",
                actor_id="drishti",
                action_type="discovery.started",
            )
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("receipt", [17, "17", 9223372036854775807])
async def test_confirmed_remote_receipt_uses_append_function_only(receipt):
    db = Mock()
    db.rpc.return_value.execute.return_value = SimpleNamespace(data=receipt)
    ledger = LedgerClient(db)
    result = await ledger.append(
        AppendInput(
            tenant_id=TENANT,
            correlation_id=TENANT,
            actor_type="agent",
            actor_id="drishti",
            action_type="discovery.started",
        )
    )
    assert result.id == str(receipt)
    assert db.rpc.call_args.args[0] == "append_agent_ledger"
    db.table.assert_not_called()


def _append_input() -> AppendInput:
    return AppendInput(
        tenant_id="11111111-1111-4111-8111-111111111111",
        correlation_id="22222222-2222-4222-8222-222222222222",
        actor_type="system",
        actor_id="lekha",
        action_type="discovery.started",
        result="success",
    )


@pytest.mark.asyncio
async def test_verify_and_query_use_the_read_client_and_appends_use_only_the_writer():
    writer, reader = Mock(), Mock()
    reader.rpc.return_value.execute.return_value.data = []
    reader.table.return_value.select.return_value.eq.return_value.order.return_value.limit.return_value.execute.return_value.data = [  # noqa: E501
        {"sequence_no": 1}
    ]
    writer.rpc.return_value.execute.return_value.data = 7
    ledger = LedgerClient(writer, read_client=reader)

    assert (await ledger.verify("t1")) == {"intact": True}
    reader.rpc.assert_called_once_with(
        "verify_ledger", {"p_tenant_id": "t1", "p_from_sequence": 1}
    )
    assert await ledger.query(tenant_id="t1") == [{"sequence_no": 1}]
    reader.table.assert_called_once_with("audit_ledger")
    # The writer credential cannot verify or read; it must never be asked to.
    writer.rpc.assert_not_called()
    writer.table.assert_not_called()

    await ledger.append(_append_input())
    assert writer.rpc.call_args.args[0] == "append_agent_ledger"
    # ...and the read client (service key) must never append.
    assert [call.args[0] for call in reader.rpc.call_args_list] == ["verify_ledger"]


@pytest.mark.asyncio
async def test_without_a_read_client_reads_fall_back_to_the_only_client():
    only = Mock()
    only.rpc.return_value.execute.return_value.data = []
    assert (await LedgerClient(only).verify("t1")) == {"intact": True}
    only.rpc.assert_called_once()


@pytest.mark.parametrize("environment", ["staging", "preprod", "production"])
def test_strict_environment_without_a_service_key_for_reads_fails_closed(monkeypatch, environment):
    settings = _strict_settings(environment, supabase_service_key=None)
    create = Mock()
    monkeypatch.setattr("axiom.ledger_client.create_client", create)
    with pytest.raises(RuntimeError, match="^Audit ledger configuration was refused$"):
        LedgerClient.from_settings(settings)
