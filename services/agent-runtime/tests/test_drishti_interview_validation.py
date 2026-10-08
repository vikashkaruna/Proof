"""Interview declarations must be validated before discovery and audit."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from axiom.agents.base import AgentName
from axiom.agents.drishti import DrishtiAgent, DrishtiInput, DrishtiOutput
from axiom.app import app


def interview_input(**declarations):
    return {
        "tenant_id": "synthetic-tenant",
        "engagement_id": "synthetic-engagement",
        "interview": {"crm": {"name": "CRM", "type": "crm", **declarations}},
    }


@pytest.mark.parametrize("field", ["hosts_personal_data", "cross_border"])
@pytest.mark.parametrize("value", ["false", "true", "private-sentinel", 0, 1, None, [], {}])
def test_non_boolean_interview_declarations_are_invalid(field, value):
    with pytest.raises(ValidationError):
        DrishtiInput.model_validate(interview_input(**{field: value}))


def test_unrelated_interview_answers_and_explicit_inventory_remain_compatible():
    input = interview_input(hosts_personal_data=False, cross_border=False, customer_count=12)
    input["interview"]["operator_notes"] = "Private inventory reviewed separately"
    input["systems"] = [{"name": "Confirmed CRM", "type": "crm", "hosts_personal_data": True}]
    parsed = DrishtiInput.model_validate(input)
    assert parsed.interview["crm"]["customer_count"] == 12
    assert parsed.interview["operator_notes"] == "Private inventory reviewed separately"
    assert parsed.systems[0].hosts_personal_data is True


@pytest.mark.asyncio
@pytest.mark.parametrize("personal_data", [False, True])
@pytest.mark.parametrize("cross_border", [False, True])
async def test_json_boolean_interview_declarations_preserve_meaning(personal_data, cross_border):
    agent = DrishtiAgent(
        ledger=SimpleNamespace(append=AsyncMock(return_value=SimpleNamespace(id="1"))),
        evidence=SimpleNamespace(),
        model_gateway=SimpleNamespace(),
    )
    result = await agent.invoke(
        interview_input(hosts_personal_data=personal_data, cross_border=cross_border)
    )
    assert result.status == "succeeded"
    output = DrishtiOutput.model_validate(result.output)
    assert output.inventory[0].hosts_personal_data is personal_data
    assert output.inventory[0].cross_border is cross_border
    assert output.personal_data_systems == int(personal_data)
    assert output.cross_border_systems == int(cross_border)


@pytest.mark.asyncio
async def test_absent_interview_transfer_and_region_declarations_remain_unknown():
    agent = DrishtiAgent(
        ledger=SimpleNamespace(append=AsyncMock(return_value=SimpleNamespace(id="1"))),
        evidence=SimpleNamespace(),
        model_gateway=SimpleNamespace(),
    )
    result = await agent.invoke(interview_input())
    assert result.status == "succeeded"
    output = DrishtiOutput.model_validate(result.output)
    assert output.inventory[0].hosts_personal_data is False
    assert output.inventory[0].cross_border is None
    assert output.inventory[0].region == "Unknown — residency evidence required"
    assert output.unknown_cross_border_systems == 1


@pytest.mark.parametrize("declaration", [False, True])
def test_http_accepts_actual_json_booleans_and_records_work(monkeypatch, declaration):
    append = AsyncMock(side_effect=[SimpleNamespace(id="1"), SimpleNamespace(id="2")])
    agent = DrishtiAgent(
        ledger=SimpleNamespace(append=append),
        evidence=SimpleNamespace(),
        model_gateway=SimpleNamespace(),
    )
    monkeypatch.setattr(
        app.state, "settings", SimpleNamespace(internal_token="interview-fixture"), raising=False
    )
    monkeypatch.setattr(app.state, "agents", {AgentName.DRISHTI: agent}, raising=False)
    response = TestClient(app).post(
        "/agents/drishti/invoke",
        json={"input": interview_input(hosts_personal_data=declaration, cross_border=declaration)},
        headers={"X-Internal-Token": "interview-fixture"},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "succeeded"
    inventory = response.json()["output"]["inventory"][0]
    assert inventory["hosts_personal_data"] is declaration
    assert inventory["cross_border"] is declaration
    assert response.json()["ledger_entry_ids"] == ["1", "2"]
    assert append.await_count == 2


@pytest.mark.parametrize("field", ["hosts_personal_data", "cross_border"])
@pytest.mark.parametrize("value", ["false", "private-sentinel", 0, 1, None, [], {}])
def test_invalid_interview_preserves_sanitized_http_failure_contract(monkeypatch, field, value):
    append = AsyncMock(return_value=SimpleNamespace(id="1"))
    agent = DrishtiAgent(
        ledger=SimpleNamespace(append=append),
        evidence=SimpleNamespace(),
        model_gateway=SimpleNamespace(),
    )
    work = AsyncMock()
    monkeypatch.setattr(agent, "_run", work)
    monkeypatch.setattr(
        app.state, "settings", SimpleNamespace(internal_token="interview-fixture"), raising=False
    )
    monkeypatch.setattr(app.state, "agents", {AgentName.DRISHTI: agent}, raising=False)
    response = TestClient(app).post(
        "/agents/drishti/invoke",
        json={"input": interview_input(**{field: value})},
        headers={"X-Internal-Token": "interview-fixture"},
    )
    # The BFF consumes this authenticated failure result as a known refusal.
    # Changing it to a non-2xx transport error would make settlement ambiguous.
    assert response.status_code == 200
    result = response.json()
    assert result["agent"] == "drishti"
    assert result["status"] == "failed"
    assert result["error"] == "validation_failed"
    assert result["output"] is None
    assert result["ledger_entry_ids"] == []
    assert result["input_tokens"] == result["output_tokens"] == 0
    assert "private-sentinel" not in response.text
    append.assert_not_called()
    work.assert_not_called()
