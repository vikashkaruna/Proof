"""Synthetic tenant refusal and same-instance concurrency; no live ledger proof."""

import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi.testclient import TestClient
from pydantic import BaseModel, RootModel, field_validator

from axiom.agents.base import AgentName, BaseAgent
from axiom.app import AGENTS, app
from axiom.canonicalise import canonical_json, sha256_hex
from axiom.config import Settings
from axiom.ledger_client import AppendResult

TENANT_A = "47480000-0000-4000-8000-00000000000a"
TENANT_B = "47480000-0000-4000-8000-00000000000b"


class LegacyDefaultInput(BaseModel):
    tenant_id: str = "00000000-0000-0000-0000-000000000001"
    fail: bool = False


class TenantOutput(BaseModel):
    tenant_id: str
    correlation_id: str


class TenantAgent(BaseAgent[LegacyDefaultInput, TenantOutput]):
    name = AgentName.LEKHA

    def input_schema(self):
        return LegacyDefaultInput

    def output_schema(self):
        return TenantOutput

    async def _run(self, *, correlation_id, input, **deps):
        self.work(input.tenant_id, correlation_id)
        if self.gates is not None:
            self.arrived[input.tenant_id].set()
            await self.gates[input.tenant_id].wait()
        if input.fail:
            raise ValueError("synthetic failure")
        return TenantOutput(tenant_id=input.tenant_id, correlation_id=correlation_id)


def agent_fixture(agent_type=TenantAgent):
    append = AsyncMock(return_value=AppendResult(id="1", occurred_at=datetime.now(UTC)))
    agent = agent_type(
        settings=Settings(_env_file=None),
        ledger=SimpleNamespace(append=append),
        evidence=Mock(),
        model_gateway=Mock(),
    )
    agent.work = Mock()
    agent.gates = None
    agent.arrived = {}
    return agent, append


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"tenant_id": None},
        {"tenant_id": ""},
        {"tenant_id": "tenant-private-value"},
        {"tenant_id": "00000000-0000-0000-0000-000000000000"},
        {"tenant_id": TENANT_A.upper()},
        {"tenant_id": TENANT_A.replace("-", "")},
        {"tenant_id": 1},
        LegacyDefaultInput(),
        RootModel[LegacyDefaultInput](LegacyDefaultInput()),
    ],
)
async def test_invalid_or_implicit_tenant_refuses_before_any_side_effect(payload):
    agent, append = agent_fixture()
    result = await agent.invoke(payload)
    assert result.status == "failed"
    assert result.error == "validation_failed"
    assert result.ledger_entry_ids == []
    append.assert_not_called()
    agent.work.assert_not_called()
    assert agent.model_gateway.mock_calls == []
    assert agent.evidence.mock_calls == []


@pytest.mark.parametrize("tenant", [TENANT_A, TENANT_B])
async def test_explicit_canonical_tenant_is_preserved(tenant):
    agent, append = agent_fixture()
    result = await agent.invoke({"tenant_id": tenant}, correlation_id="synthetic-correlation")
    assert result.status == "succeeded"
    assert result.output["tenant_id"] == tenant
    assert [call.args[0].tenant_id for call in append.call_args_list] == [tenant, tenant]


async def test_same_instance_reverse_completion_and_failure_keep_tenant_receipts_isolated():
    agent, append = agent_fixture()
    agent.gates = {tenant: asyncio.Event() for tenant in [TENANT_A, TENANT_B]}
    agent.arrived = {tenant: asyncio.Event() for tenant in [TENANT_A, TENANT_B]}

    async def record(entry):
        return AppendResult(id=str(append.call_count), occurred_at=datetime.now(UTC))

    append.side_effect = record
    payload_a = {"tenant_id": TENANT_A, "fail": True}
    payload_b = {"tenant_id": TENANT_B, "fail": False}
    task_a = asyncio.create_task(agent.invoke(payload_a, correlation_id="correlation-a"))
    task_b = asyncio.create_task(agent.invoke(payload_b, correlation_id="correlation-b"))
    try:
        await asyncio.wait_for(
            asyncio.gather(*(event.wait() for event in agent.arrived.values())), timeout=2
        )
        agent.gates[TENANT_B].set()
        result_b = await asyncio.wait_for(task_b, timeout=2)
        agent.gates[TENANT_A].set()
        result_a = await asyncio.wait_for(task_a, timeout=2)
    finally:
        for task in (task_a, task_b):
            if not task.done():
                task.cancel()
        await asyncio.gather(task_a, task_b, return_exceptions=True)
    entries = [call.args[0] for call in append.call_args_list]
    assert [entry.tenant_id for entry in entries] == [TENANT_A, TENANT_B, TENANT_B, TENANT_A]
    assert result_b.status == "succeeded"
    assert result_b.output == {"tenant_id": TENANT_B, "correlation_id": "correlation-b"}
    assert result_a.status == "failed"
    assert result_a.output is None
    assert result_a.ledger_entry_ids == ["1", "4"]
    assert result_b.ledger_entry_ids == ["2", "3"]
    for start, finish, payload, correlation in [
        (entries[0], entries[3], payload_a, "correlation-a"),
        (entries[1], entries[2], payload_b, "correlation-b"),
    ]:
        assert start.correlation_id == finish.correlation_id == correlation
        assert start.input_hash == finish.input_hash == sha256_hex(canonical_json(payload))
    assert entries[2].detail["started_entry"] == "2"
    assert entries[3].detail["started_entry"] == "1"
    assert entries[2].output_hash == sha256_hex(canonical_json(result_b.output))
    assert entries[3].output_hash is None


class ReboundTenantInput(LegacyDefaultInput):
    @field_validator("tenant_id")
    @classmethod
    def rebound_tenant(cls, tenant: str) -> str:
        return TENANT_B


class ReboundTenantAgent(TenantAgent):
    def input_schema(self):
        return ReboundTenantInput


async def test_schema_cannot_replace_explicit_tenant_before_ledger_append():
    agent, append = agent_fixture(ReboundTenantAgent)
    result = await agent.invoke({"tenant_id": TENANT_A})
    assert result.status == "failed"
    assert result.error == "validation_failed"
    append.assert_not_called()
    agent.work.assert_not_called()


@pytest.mark.parametrize(
    "name", [AgentName.SANKET, AgentName.KARYA, AgentName.LEKHA, AgentName.NAZAR]
)
def test_authenticated_generic_http_refuses_missing_tenant_before_work(monkeypatch, name):
    append = AsyncMock()
    evidence = Mock()
    gateway = Mock()
    agent = AGENTS[name](
        settings=Settings(_env_file=None),
        ledger=SimpleNamespace(append=append),
        evidence=evidence,
        model_gateway=gateway,
    )
    work = AsyncMock()
    monkeypatch.setattr(agent, "_run", work)
    monkeypatch.setattr(app.state, "agents", {name: agent}, raising=False)
    monkeypatch.setattr(
        app.state, "settings", SimpleNamespace(internal_token="synthetic-peer-token"), raising=False
    )
    response = TestClient(app).post(
        f"/agents/{name.value}/invoke",
        json={"input": {}, "correlation_id": "synthetic-http-correlation"},
        headers={"X-Internal-Token": "synthetic-peer-token"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "failed"
    assert body["error"] == "validation_failed"
    assert body["ledger_entry_ids"] == []
    assert body["output"] is None
    append.assert_not_called()
    work.assert_not_called()
    assert evidence.mock_calls == gateway.mock_calls == []


@pytest.mark.parametrize(
    ("name", "status", "detail"),
    [
        ("prativedan", 403, "board_report_workflow_required"),
        ("pramaan", 404, "Agent not initialised: pramaan"),
    ],
)
def test_generic_unmounted_workflows_remain_unavailable(monkeypatch, name, status, detail):
    monkeypatch.setattr(app.state, "agents", {}, raising=False)
    monkeypatch.setattr(
        app.state, "settings", SimpleNamespace(internal_token="synthetic-peer-token"), raising=False
    )
    response = TestClient(app).post(
        f"/agents/{name}/invoke",
        json={"input": {"tenant_id": TENANT_A}},
        headers={"X-Internal-Token": "synthetic-peer-token"},
    )
    assert response.status_code == status
    assert response.json() == {"detail": detail}
