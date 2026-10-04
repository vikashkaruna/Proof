"""Tests for the Sudhaar planning agent — critical separation of duties checks."""

import pytest

from axiom.agents.base import AutonomyLevel
from axiom.agents.sudhaar import SudhaarAgent, SudhaarInput


@pytest.mark.asyncio
async def test_sudhaar_has_no_mutate_capability():
    agent = SudhaarAgent()
    # ADR-3: the planning agent holds NO write credentials
    assert agent.can_mutate is False
    # And it's at L1 (proposes only)
    assert agent.autonomy == AutonomyLevel.L1


@pytest.mark.asyncio
async def test_sudhaar_generates_actions_with_rollback_for_each():
    agent = SudhaarAgent()
    findings = [
        {
            "id": "f1",
            "control_id": "DPDPA-CNS-001",
            "title": "Obtain specific, informed, unambiguous consent",
            "severity": "critical",
            "risk_points": 30.0,
            "remediation_patterns": ["consent"],
        },
        {
            "id": "f2",
            "control_id": "DPDPA-SEC-001",
            "title": "Implement reasonable security safeguards",
            "severity": "critical",
            "risk_points": 50.0,
            "remediation_patterns": ["config"],
        },
    ]
    out = await agent.invoke(
        SudhaarInput(
            tenant_id="t1",
            engagement_id="e1",
            title="Test plan",
            findings=findings,
        )
    )
    assert out.status == "succeeded"
    actions = out.output["actions"]
    assert len(actions) == 2
    # Every action MUST have a rollback plan
    for action in actions:
        assert "rollback" in action
        assert action["rollback"]["type"] == "typed"
        assert len(action["rollback"]["steps"]) >= 1
        # Rollback is NOT yet validated as executable (this happens at dry-run time)
        assert action["rollback"]["validatedExecutable"] is False


@pytest.mark.asyncio
async def test_sudhaar_escalates_on_high_blast_radius():
    agent = SudhaarAgent()
    findings = [
        {
            "id": "f1",
            "control_id": "DPDPA-SEC-001",
            "title": "Reasonable security",
            "severity": "critical",
            "risk_points": 100.0,  # extreme
            "remediation_patterns": ["config"],
        }
    ]
    out = await agent.invoke(
        SudhaarInput(
            tenant_id="t1",
            engagement_id="e1",
            title="Large plan",
            findings=findings,
            scope_hints={
                "f1": {
                    "records_affected": 1000,
                    "systems_affected": ["website-content"],
                    "environment": "development",
                }
            },
            blast_radius_cap_records=10,
        )
    )
    assert out.status == "succeeded"
    # The agent should escalate because the aggregate blast radius exceeds the cap
    assert out.output["escalate"] is True
    assert "blast_radius" in (out.output.get("escalation_reason") or "")


def finding(finding_id="f1", risk_points=50.0):
    return {
        "id": finding_id,
        "control_id": "DPDPA-SEC-001",
        "title": "Reasonable security",
        "severity": "critical",
        "risk_points": risk_points,
        "remediation_patterns": ["config"],
    }


@pytest.mark.asyncio
async def test_unknown_scope_never_invents_a_count_target_or_environment():
    out = await SudhaarAgent().invoke(
        {"tenant_id": "t1", "engagement_id": "e1", "findings": [finding()]}
    )
    assert out.status == "succeeded"
    action = out.output["actions"][0]
    assert action["records_affected"] is None
    assert action["systems_affected"] == []
    assert action["environment"] is None
    assert action["scope_status"] == "incomplete"
    assert out.output["aggregate_records_affected"] is None
    assert out.output["aggregate_systems"] == []
    assert out.output["escalate"] is True
    assert "blast_radius_unconfirmed" in out.output["escalation_reason"]
    assert action["rollback"]["validatedExecutable"] is False


@pytest.mark.asyncio
@pytest.mark.parametrize("risk_points", [0.0, 100.0])
async def test_actual_declared_scope_is_preserved_independently_of_risk(risk_points):
    out = await SudhaarAgent().invoke(
        {
            "tenant_id": "t1",
            "engagement_id": "e1",
            "findings": [finding(risk_points=risk_points)],
            "scope_hints": {
                "f1": {
                    "records_affected": 12,
                    "systems_affected": ["website-content"],
                    "environment": "development",
                }
            },
        }
    )
    assert out.status == "succeeded"
    action = out.output["actions"][0]
    assert action["records_affected"] == 12
    assert action["systems_affected"] == ["website-content"]
    assert action["environment"] == "development"
    assert action["scope_status"] == "declared"
    assert out.output["aggregate_records_affected"] == 12
    assert out.output["aggregate_systems"] == ["website-content"]
    assert out.output["escalate"] is False
    assert action["rollback"]["validatedExecutable"] is False


@pytest.mark.asyncio
async def test_declared_zero_stays_zero_while_missing_target_requires_review():
    out = await SudhaarAgent().invoke(
        {
            "tenant_id": "t1",
            "engagement_id": "e1",
            "findings": [finding()],
            "scope_hints": {"f1": {"records_affected": 0, "environment": "n/a"}},
        }
    )
    assert out.status == "succeeded"
    action = out.output["actions"][0]
    assert action["records_affected"] == 0
    assert action["systems_affected"] == []
    assert action["environment"] == "n/a"
    assert action["scope_status"] == "incomplete"
    assert out.output["aggregate_records_affected"] == 0
    assert out.output["escalate"] is True


@pytest.mark.asyncio
async def test_partial_scope_has_unknown_total_and_enforces_known_count_cap():
    out = await SudhaarAgent().invoke(
        {
            "tenant_id": "t1",
            "engagement_id": "e1",
            "findings": [finding("f1", 100.0), finding("f2", 10.0)],
            "scope_hints": {
                "f1": {
                    "records_affected": 120,
                    "systems_affected": ["website-content"],
                    "environment": "development",
                }
            },
            "blast_radius_cap_records": 100,
        }
    )
    assert out.status == "succeeded"
    assert out.output["aggregate_records_affected"] is None
    assert out.output["actions"][1]["records_affected"] is None
    assert out.output["escalate"] is True
    assert "blast_radius_exceeded" in out.output["escalation_reason"]


@pytest.mark.asyncio
@pytest.mark.parametrize("count", [-1, True, 1.5, "12", 10**12 + 1])
async def test_invalid_declared_counts_refuse_before_computing_a_proposal(count):
    out = await SudhaarAgent().invoke(
        {
            "tenant_id": "t1",
            "engagement_id": "e1",
            "findings": [finding()],
            "scope_hints": {"f1": {"records_affected": count}},
        }
    )
    assert out.status == "failed"
    assert out.error == "validation_failed"
    assert out.output is None
    assert out.ledger_entry_ids == []


@pytest.mark.asyncio
async def test_scope_hints_bind_to_finding_id_after_priority_sort():
    out = await SudhaarAgent().invoke(
        {
            "tenant_id": "t1",
            "engagement_id": "e1",
            "findings": [finding("low", 1.0), finding("high", 100.0)],
            "scope_hints": {
                "low": {
                    "records_affected": 2,
                    "systems_affected": ["public-site"],
                    "environment": "staging",
                },
                "high": {
                    "records_affected": 15_000,
                    "systems_affected": ["archive", "archive"],
                    "environment": "production",
                },
            },
        }
    )
    assert out.status == "succeeded"
    actions = out.output["actions"]
    assert actions[0]["closes_finding_id"] == "high"
    assert actions[0]["records_affected"] == 15_000
    assert actions[0]["systems_affected"] == ["archive"]
    assert actions[1]["closes_finding_id"] == "low"
    assert actions[1]["records_affected"] == 2
    assert actions[1]["systems_affected"] == ["public-site"]
    assert out.output["aggregate_records_affected"] == 15_002
    assert out.output["aggregate_systems"] == ["archive", "public-site"]
    assert out.output["escalate"] is True
    assert "high_blast_radius" in out.output["escalation_reason"]
