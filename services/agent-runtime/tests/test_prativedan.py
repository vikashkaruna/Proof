from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from pydantic import ValidationError

from axiom.agents.base import DispatchContext
from axiom.agents.prativedan import PrativedanAgent, PrativedanInput
from axiom.canonicalise import canonical_json, sha256_hex
from axiom.config import Settings
from axiom.ledger_client import AppendResult

EV1 = "47470000-0000-4000-8000-000000000011"
EV2 = "47470000-0000-4000-8000-000000000012"
REQUIREMENT = "47470000-0000-4000-8000-000000000013"


def test_prativedan_extracts_only_explicit_evidence_ids():
    ids = PrativedanAgent._evidence_ids(
        [
            {"evidence_required": [{"type": "document", "description": "Policy"}]},
            {"evidence_ids": [EV1], "evidence_required": [{"evidence_id": EV2}]},
        ]
    )
    assert ids == [EV1, EV2]


def test_requirements_and_malformed_references_do_not_become_citations():
    assert PrativedanAgent._evidence_ids(
        [
            {
                "evidence_ids": [EV1, EV1, None, "policy needed", "0" * 32, EV1.replace("-", "")],
                "evidence_required": [EV2, "Policy document required", {"type": "policy"}],
            },
            {"evidence_ids": EV2, "evidence_required": None},
            {"evidence_required": [{"id": REQUIREMENT}, {"evidence_id": EV2}]},
        ]
    ) == [EV1, EV2]


@pytest.fixture
def agent():
    return object.__new__(PrativedanAgent)


@pytest.mark.asyncio
async def test_missing_metrics_remain_unknown_in_sections_and_html(agent):
    output = await agent._run(correlation_id="synthetic", input=PrativedanInput())
    assert "Posture score: Unknown (not supplied)." in output.sections[0]["body"]
    assert "Estimated statutory exposure: Unknown (not supplied)." in output.sections[0]["body"]
    assert "0/100" not in output.rendered_html
    assert "Critical" not in output.rendered_html
    assert "0.00 Cr" not in output.rendered_html
    assert "findings included for review" in output.rendered_html
    assert output.review_required is True
    assert output.citation_verification == "unverified_references"


@pytest.mark.parametrize(
    ("posture", "exposure", "expected_posture", "expected_exposure"),
    [
        (0, 0, "0/100 (Critical; provisional)", "₹0.00 Cr"),
        (85, 123000000, "85/100 (Strong; provisional)", "₹12.30 Cr"),
        (65, None, "65/100 (Acceptable; provisional)", "Unknown (not supplied)"),
        (40, 0, "40/100 (At Risk; provisional)", "₹0.00 Cr"),
        (None, 50000000, "Posture score: Unknown (not supplied)", "₹5.00 Cr"),
    ],
)
@pytest.mark.asyncio
async def test_supplied_zero_and_each_independent_metric_are_preserved_as_provisional(
    agent, posture, exposure, expected_posture, expected_exposure
):
    output = await agent._run(
        correlation_id="synthetic",
        input=PrativedanInput(posture_score=posture, estimated_exposure_inr=exposure),
    )
    assert expected_posture in output.sections[0]["body"]
    assert expected_exposure in output.sections[0]["body"]


@pytest.mark.parametrize("control_ids", [None, ["C1"], ["C1", "C2", "C3"]])
@pytest.mark.asyncio
async def test_library_count_uses_declared_source_set_or_is_unavailable(agent, control_ids):
    output = await agent._run(
        correlation_id="synthetic",
        input=PrativedanInput(library_version="synthetic-1", library_control_ids=control_ids),
    )
    text = output.sections[2]["body"]
    assert "synthetic-1" in text
    assert "46 controls" not in text
    if control_ids is None:
        assert "Control count unavailable" in text
    else:
        assert f"Draft input declares {len(control_ids)} controls" in text
        assert "frozen source verification remains required" in text


@pytest.mark.parametrize("ids", [[], ["C1", "C1"], [" C1"], [""], [str(i) for i in range(501)]])
def test_declared_library_set_rejects_ambiguous_or_unbounded_ids(ids):
    with pytest.raises(ValidationError):
        PrativedanInput(library_control_ids=ids)


def test_finding_outside_declared_control_set_is_refused():
    with pytest.raises(ValidationError):
        PrativedanInput(library_control_ids=["C1"], findings=[{"control_id": "C2"}])


@pytest.mark.parametrize("reviewer", [None, "synthetic reviewer", "<script>reviewed</script>"])
@pytest.mark.asyncio
async def test_caller_reviewer_never_establishes_recorded_human_review(agent, reviewer):
    output = await agent._run(
        correlation_id="synthetic", input=PrativedanInput(reviewer_id=reviewer)
    )
    assert "Pending recorded human review" in output.sections[3]["body"]
    assert "Reviewed by" not in output.rendered_html
    assert "findings reviewed" not in output.rendered_html
    if reviewer:
        assert reviewer not in output.rendered_html


@pytest.mark.parametrize(
    "payload",
    [
        {"posture_score": -1},
        {"posture_score": 101},
        {"posture_score": float("nan")},
        {"posture_score": True},
        {"estimated_exposure_inr": -1},
        {"estimated_exposure_inr": True},
        {"estimated_exposure_inr": 9007199254740992},
    ],
)
def test_invalid_metrics_are_refused_instead_of_fabricated(payload):
    with pytest.raises(ValidationError):
        PrativedanInput(**payload)


@pytest.mark.asyncio
async def test_invoke_commits_unknown_draft_and_unverified_citation_status_in_both_receipts():
    ledger = SimpleNamespace(
        append=AsyncMock(
            side_effect=[
                AppendResult(id="71", occurred_at=datetime.now(UTC)),
                AppendResult(id="72", occurred_at=datetime.now(UTC)),
            ]
        )
    )
    instance = PrativedanAgent(
        settings=Settings(_env_file=None), ledger=ledger, evidence=Mock(), model_gateway=Mock()
    )
    payload = PrativedanInput(
        tenant_id="47470000-0000-4000-8000-000000000001",
        engagement_id="47470000-0000-4000-8000-000000000002",
        library_control_ids=["C1"],
        findings=[{"control_id": "C1", "evidence_ids": [EV1]}],
    )
    context = DispatchContext(run_id="47470000-0000-4000-8000-000000000004", request_hash="a" * 64)
    result = await instance.invoke(payload, dispatch_context=context)
    assert result.status == "succeeded"
    assert result.output["review_required"] is True
    assert result.output["citation_verification"] == "unverified_references"
    assert result.output["cited_evidence_ids"] == [EV1]
    assert "Unknown" in result.output["rendered_html"]
    started, completed = [call.args[0] for call in ledger.append.await_args_list]
    for receipt in (started, completed):
        assert receipt.actor_id == "prativedan"
        assert receipt.target_ref == payload.engagement_id
        assert receipt.input_hash == sha256_hex(canonical_json(payload.model_dump(mode="json")))
        assert receipt.detail["run_id"] == str(context.run_id)
    assert completed.output_hash == sha256_hex(canonical_json(result.output))
    instance.evidence.assert_not_called()
    instance.model_gateway.assert_not_called()


def test_prativedan_html_escapes_untrusted_report_values():
    html = PrativedanAgent._render_html(
        object.__new__(PrativedanAgent),
        "<script>alert(1)</script>",
        [
            {
                "type": "findings_table",
                "title": "<img src=x>",
                "items": [{"control_id": "<x>", "title": "<b>bad</b>"}],
            }
        ],
        10,
        "Critical",
    )
    assert "<script>" not in html
    assert "&lt;script&gt;" in html
    assert "&lt;img" in html


@pytest.mark.asyncio
@pytest.mark.parametrize("unknown", [None, True, "9"])
async def test_unknown_risk_preserves_source_order_without_claiming_ranking(agent, unknown):
    findings = [
        {"control_id": "FIRST", "risk_points": unknown},
        {"control_id": "SECOND", "risk_points": 100},
    ]
    output = await agent._run(correlation_id="synthetic", input=PrativedanInput(findings=findings))
    section = output.sections[1]
    assert section["title"] == "Findings for review (source order)"
    assert [item["control_id"] for item in section["items"]] == ["FIRST", "SECOND"]
    assert section["items"][0]["risk_points"] == unknown
    assert "by risk-weighted exposure" not in output.rendered_html


@pytest.mark.asyncio
async def test_present_numeric_risks_can_rank_findings(agent):
    output = await agent._run(
        correlation_id="synthetic",
        input=PrativedanInput(
            findings=[
                {"control_id": "FIRST", "risk_points": 1},
                {"control_id": "SECOND", "risk_points": 100},
            ]
        ),
    )
    section = output.sections[1]
    assert section["title"] == "Top findings (by risk-weighted exposure)"
    assert [item["control_id"] for item in section["items"]] == ["SECOND", "FIRST"]
