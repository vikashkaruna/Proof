"""Assessment computations retain unknown facts and declaration provenance."""

from dataclasses import replace

import pytest

from axiom.assessment_scoring import AssessmentInput, score_assessment
from axiom.control_library_loader import ControlLibrary, load_default_library


def library(questions=None):
    control = replace(
        next(iter(load_default_library())),
        library_version="scoring-test",
        assessment_questions=tuple(
            questions
            if questions is not None
            else [{"id": "Q1", "type": "boolean"}, {"id": "Q2", "type": "boolean"}]
        ),
        sdf_only=True,
        children_only=True,
    )
    return ControlLibrary("scoring-test", [control]), control


@pytest.mark.parametrize(
    ("answers", "score", "counts"),
    [
        ({}, 30, "0 caller-affirmed, 0 caller-denied, 2 unknown of 2"),
        ({"Q1": None, "Q2": None}, 30, "0 caller-affirmed, 0 caller-denied, 2 unknown of 2"),
        ({"Q1": "true", "Q2": 1}, 30, "0 caller-affirmed, 0 caller-denied, 2 unknown of 2"),
        ({"Q1": False}, 30, "0 caller-affirmed, 1 caller-denied, 1 unknown of 2"),
        ({"Q1": True}, 50, "1 caller-affirmed, 0 caller-denied, 1 unknown of 2"),
        ({"Q1": True, "Q2": False}, 50, "1 caller-affirmed, 1 caller-denied, 0 unknown of 2"),
        ({"Q1": True, "Q2": True}, 100, "2 caller-affirmed, 0 caller-denied, 0 unknown of 2"),
        ({"Q1": False, "Q2": False}, 0, "0 caller-affirmed, 2 caller-denied, 0 unknown of 2"),
        ({"invented": True}, 30, "0 caller-affirmed, 0 caller-denied, 2 unknown of 2"),
    ],
)
def test_answer_truth_is_separate_from_preserved_score_estimate(answers, score, counts):
    lib, control = library()
    result = score_assessment(lib, AssessmentInput(lib.version, {control.id: answers}))
    finding = result["findings"][0]
    assert result["posture_score"] == finding["score"] == score
    risk = round((100 - score) / 100 * control.scoring.penalty_points, 2)
    assert finding["risk_points"] == risk
    assert result["estimated_exposure_inr"] == int(risk * 1_000_000)
    assert counts in finding["rationale"]
    assert f"Questionnaire score estimate: {score}%" in finding["rationale"]
    assert "declared answers remain unverified" in finding["rationale"]
    assert "statutory liability require evidence and human/legal review" in finding["rationale"]
    assert "Partial compliance" not in finding["rationale"]
    assert "answered compliantly" not in finding["rationale"]
    assert "full risk exposure" not in finding["rationale"]
    assert "computation estimates" in result["notes"]


def test_non_boolean_questions_have_neutral_unverified_computation():
    lib, control = library([{"id": "TEXT", "type": "text"}])
    result = score_assessment(lib, AssessmentInput(lib.version, {control.id: {"TEXT": True}}))
    assert result["posture_score"] == 50
    assert "No boolean assessment questions" in result["findings"][0]["rationale"]
    assert "Mostly compliant" not in result["findings"][0]["rationale"]


@pytest.mark.parametrize("explicit", [False, True])
def test_omitted_and_null_declarations_remain_unknown(explicit):
    lib, _ = library()
    kwargs = (
        {"sdf_self_attested": None, "processes_children": None, "processes_health": None}
        if explicit
        else {}
    )
    result = score_assessment(lib, AssessmentInput(lib.version, **kwargs))
    assessment = result["sdf_self_assessment"]
    assert assessment["is_sdf_attested"] is None
    assert assessment["processes_children"] is None
    assert assessment["processes_health"] is None
    assert assessment["applicable_sdf_controls"] is None
    assert assessment["applicable_children_controls"] is None
    assert set(assessment["declaration_provenance"].values()) == {"unknown"}
    assert assessment["applicability_review_required"] is True
    for label in ("SDF", "children", "health"):
        assert f"{label}=unknown" in result["findings"][0]["rationale"]


@pytest.mark.parametrize("value", [False, True])
def test_caller_flags_are_unverified_and_never_filter_numeric_computation(value):
    lib, control = library()
    result = score_assessment(
        lib,
        AssessmentInput(
            lib.version,
            sdf_self_attested=value,
            processes_children=value,
            processes_health=value,
        ),
    )
    assessment = result["sdf_self_assessment"]
    assert assessment["is_sdf_attested"] is value
    assert assessment["processes_children"] is value
    assert assessment["processes_health"] is value
    assert assessment["applicable_sdf_controls"] == ([control.id] if value else [])
    assert assessment["applicable_children_controls"] == ([control.id] if value else [])
    assert set(assessment["declaration_provenance"].values()) == {"caller_declared_unverified"}
    assert assessment["applicability_review_required"] is True
    assert result["posture_score"] == 30
    assert len(result["findings"]) == 1
    for label in ("SDF", "children", "health"):
        assert (
            f"{label}=caller-declared {str(value).lower()} (unverified)"
            in result["findings"][0]["rationale"]
        )


@pytest.mark.parametrize("value", ["false", 0, 1, [], {}])
def test_pure_scorer_refuses_non_boolean_declarations(value):
    lib, _ = library()
    with pytest.raises(ValueError, match="Invalid input flags"):
        score_assessment(lib, AssessmentInput(lib.version, sdf_self_attested=value))
