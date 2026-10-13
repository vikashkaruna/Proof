"""Tests for the Parikshan assessment agent."""

import pytest
from pydantic import ValidationError

from axiom.agents.parikshan import (
    FindingOut,
    ParikshanAgent,
    ParikshanInput,
    ParikshanOutput,
)
from axiom.control_library_loader import load_default_library

# Explicit independent synthetic tenant; no default production identity.
SYNTHETIC_TENANT_ID = "47480000-0000-4000-8000-000000000004"


@pytest.mark.asyncio
async def test_parikshan_unanswered_questionnaire_is_unverified():
    agent = ParikshanAgent()
    # Empty answers — the agent defaults to score 30 (unknown) per control
    out = await agent.invoke(
        ParikshanInput(
            tenant_id=SYNTHETIC_TENANT_ID,
            engagement_id="e1",
            library_version=load_default_library().version,
            answers={},
            sdf_self_attested=False,
            processes_children=False,
            processes_health=False,
        )
    )
    assert out.status == "succeeded"
    output = ParikshanOutput.model_validate(out.output)
    # Empty answers retain unknown/neutral estimates; caller flags never verify facts.
    assert 0 <= output.posture_score <= 50
    # At least one finding is produced (the placeholder library has
    # at least one control; the real v0.1.0 library has 46).
    assert len(output.findings) >= 1
    assert isinstance(output.findings[0], FindingOut)
    assert output.sdf_self_assessment["is_sdf_attested"] is False
    assert output.sdf_self_assessment["declaration_provenance"]["sdf_self_attested"] == (
        "caller_declared_unverified"
    )
    assert "SDF=caller-declared false (unverified)" in output.findings[0].rationale


@pytest.mark.asyncio
async def test_parikshan_omitted_flags_are_unknown():
    agent = ParikshanAgent()
    # If we had a fully loaded library we'd test 'DPDPA-CNS-001' here;
    # with the placeholder library, the result is still valid.
    out = await agent.invoke(
        ParikshanInput(
            tenant_id=SYNTHETIC_TENANT_ID,
            engagement_id="e1",
            library_version=load_default_library().version,
            answers={},
        )
    )
    assert out.status == "succeeded"
    output = ParikshanOutput.model_validate(out.output)
    assert output.sdf_self_assessment["is_sdf_attested"] is None
    assert output.sdf_self_assessment["applicable_sdf_controls"] is None
    assert "SDF=unknown" in output.findings[0].rationale


@pytest.mark.asyncio
async def test_parikshan_ignores_unknown_question_ids():
    agent = ParikshanAgent()
    out = await agent.invoke(
        ParikshanInput(
            tenant_id=SYNTHETIC_TENANT_ID,
            engagement_id="e1",
            library_version=load_default_library().version,
            answers={"DPDPA-GOV-001": {"not-a-question": True}},
        )
    )
    assert out.status == "succeeded"
    output = ParikshanOutput.model_validate(out.output)
    finding = next(item for item in output.findings if item.control_id == "DPDPA-GOV-001")
    assert finding.score <= 50


@pytest.mark.asyncio
async def test_parikshan_refuses_a_different_library_version():
    out = await ParikshanAgent().invoke(
        ParikshanInput(
            tenant_id=SYNTHETIC_TENANT_ID, engagement_id="e1", library_version="unavailable-version"
        )
    )
    assert out.status == "failed"
    assert out.output is None


@pytest.mark.parametrize("flag", ["sdf_self_attested", "processes_children", "processes_health"])
@pytest.mark.parametrize("value", [None, False, True])
def test_parikshan_preserves_nullable_boolean_declarations(flag, value):
    data = ParikshanInput(tenant_id=SYNTHETIC_TENANT_ID, engagement_id="e1", **{flag: value})
    assert getattr(data, flag) is value


@pytest.mark.parametrize("flag", ["sdf_self_attested", "processes_children", "processes_health"])
@pytest.mark.parametrize("value", ["false", "true", 0, 1])
def test_parikshan_never_coerces_unknown_declarations(flag, value):
    with pytest.raises(ValidationError):
        ParikshanInput(tenant_id=SYNTHETIC_TENANT_ID, engagement_id="e1", **{flag: value})
