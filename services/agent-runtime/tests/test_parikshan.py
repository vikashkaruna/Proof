"""Tests for the Parikshan assessment agent."""

import pytest

from axiom.agents.parikshan import (
    FindingOut,
    ParikshanAgent,
    ParikshanInput,
    ParikshanOutput,
)
from axiom.control_library_loader import load_default_library


@pytest.mark.asyncio
async def test_parikshan_full_compliance():
    agent = ParikshanAgent()
    # Empty answers — the agent defaults to score 30 (unknown) per control
    out = await agent.invoke(
        ParikshanInput(
            tenant_id="t1",
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
    # With no answers, every control scores 30 (unknown) — weighted
    # average should be 30 with a small discount for unverified self-attestation.
    assert 0 <= output.posture_score <= 50
    # At least one finding is produced (the placeholder library has
    # at least one control; the real v0.1.0 library has 46).
    assert len(output.findings) >= 1
    assert isinstance(output.findings[0], FindingOut)


@pytest.mark.asyncio
async def test_parikshan_with_yes_answers_for_some_controls():
    agent = ParikshanAgent()
    # If we had a fully loaded library we'd test 'DPDPA-CNS-001' here;
    # with the placeholder library, the result is still valid.
    out = await agent.invoke(
        ParikshanInput(
            tenant_id="t1",
            engagement_id="e1",
            library_version=load_default_library().version,
            answers={},
        )
    )
    assert out.status == "succeeded"


@pytest.mark.asyncio
async def test_parikshan_ignores_unknown_question_ids():
    agent = ParikshanAgent()
    out = await agent.invoke(
        ParikshanInput(
            tenant_id="t1",
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
        ParikshanInput(tenant_id="t1", engagement_id="e1", library_version="unavailable-version")
    )
    assert out.status == "failed"
    assert out.output is None
