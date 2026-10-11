"""Discovery must not turn location hints into processing declarations."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from axiom.agents.base import AgentName
from axiom.agents.drishti import DrishtiAgent
from axiom.app import app
from axiom.policy_generator import (
    build_consent_notice,
    build_dpa_template,
    build_privacy_notice,
    build_retention_policy,
)
from axiom.ropa_generator import build_ropa_records


def agent_fixture():
    return DrishtiAgent(
        ledger=SimpleNamespace(append=AsyncMock(return_value=SimpleNamespace(id="receipt"))),
        evidence=SimpleNamespace(),
        model_gateway=SimpleNamespace(),
    )


def payload(system, *, interview=False):
    return {
        "tenant_id": "synthetic-tenant",
        "engagement_id": "synthetic-engagement",
        **({"interview": {"crm": system}} if interview else {"systems": [system]}),
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("interview", [False, True])
@pytest.mark.parametrize("declaration", [None, False, True])
@pytest.mark.parametrize("region", [None, "Unknown", "us-east-1", "ap-south-1"])
async def test_discovery_ropa_and_policy_preserve_transfer_declaration(
    interview, declaration, region
):
    system = {"name": "CRM", "type": "crm"}
    if declaration is not None:
        system["cross_border"] = declaration
    if region is not None:
        system["region"] = region
    result = await agent_fixture().invoke(payload(system, interview=interview))
    assert result.status == "succeeded"
    discovered = result.output["inventory"][0]
    assert discovered["cross_border"] is declaration
    assert discovered["region"] == (region or "Unknown — residency evidence required")
    assert result.output["cross_border_systems"] == int(declaration is True)
    assert result.output["unknown_cross_border_systems"] == int(declaration is None)
    assert "declared cross-border" in result.output["summary"]
    records = build_ropa_records([discovered]).records
    assert records[0].cross_border is declaration
    assert records[0].review_required is True
    if declaration is not True:
        assert records[0].transfer_safeguards is None
    for builder in (
        build_privacy_notice,
        build_consent_notice,
        build_retention_policy,
        build_dpa_template,
    ):
        draft = builder("Synthetic organisation", records)
        text = " ".join(section["body"] for section in draft.sections)
        expected = "Unknown" if declaration is None else str(declaration)
        assert f"Cross-border processing: {expected}." in text
        assert "Unpublished draft" in text
        assert draft.review_required is draft.legal_review_required is True


@pytest.mark.asyncio
@pytest.mark.parametrize("interview", [False, True])
async def test_region_in_name_is_only_a_review_indicator(interview):
    result = await agent_fixture().invoke(
        payload(
            {
                "name": "US analytics us-east-1",
                "type": "s3",
                "description": "Operator description, not verified hosting evidence",
                "region": "ap-south-1",
                "cross_border": False,
            },
            interview=interview,
        )
    )
    assert result.status == "succeeded"
    discovered = result.output["inventory"][0]
    assert discovered["region"] == "ap-south-1"
    assert discovered["cross_border"] is False
    assert result.output["escalate"] is True
    assert result.output["escalation_reason"] == "residency_declaration_review_required"
    warnings = " ".join(result.output["warnings"])
    assert "us-east-1" in warnings
    assert "does not establish" in warnings
    assert "Statutory Warning" not in warnings


@pytest.mark.parametrize("field", ["hosts_personal_data", "cross_border"])
@pytest.mark.parametrize("value", ["false", "true", 0, 1])
def test_explicit_inventory_rejects_coerced_declarations_before_work(monkeypatch, field, value):
    agent = agent_fixture()
    work = AsyncMock()
    monkeypatch.setattr(agent, "_run", work)
    monkeypatch.setattr(
        app.state, "settings", SimpleNamespace(internal_token="inventory-fixture"), raising=False
    )
    monkeypatch.setattr(app.state, "agents", {AgentName.DRISHTI: agent}, raising=False)
    response = TestClient(app).post(
        "/agents/drishti/invoke",
        json={"input": payload({"name": "CRM", "type": "crm", field: value})},
        headers={"X-Internal-Token": "inventory-fixture"},
    )
    assert response.status_code == 200
    result = response.json()
    assert result["status"] == "failed"
    assert result["error"] == "validation_failed"
    assert result["output"] is None
    assert result["ledger_entry_ids"] == []
    agent.ledger.append.assert_not_called()
    work.assert_not_called()
