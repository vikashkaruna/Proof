"""Pure assessment calculation shared by the legacy agent and isolated worker.

No settings, clients, model calls, credentials, persistence or default library.
The caller supplies the exact pinned library. Existing scoring is preserved.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

from .control_library_loader import ControlLibrary


@dataclass(frozen=True)
class AssessmentInput:
    library_version: str
    answers: dict = field(default_factory=dict)
    sdf_self_attested: bool | None = None
    processes_children: bool | None = None
    processes_health: bool | None = None


def score_assessment(lib: ControlLibrary, input: AssessmentInput) -> dict:
    if not lib.version or lib.version != input.library_version or len(lib) == 0:
        raise ValueError("Assessment library mismatch")
    declarations = {
        "sdf_self_attested": input.sdf_self_attested,
        "processes_children": input.processes_children,
        "processes_health": input.processes_health,
    }
    if any(value is not None and type(value) is not bool for value in declarations.values()):
        raise ValueError("Invalid input flags")
    findings: list[dict] = []
    provenance_controls: list[dict] = []
    if not 1 <= len(lib) <= 500:
        raise ValueError("Invalid provenance library size")
    total_weight = 0.0
    weighted_score = 0.0
    total_exposure_inr = 0

    for control in lib:
        answers = input.answers.get(control.id, {})
        provenance_controls.append(control_provenance(control, answers, input))
        # Only boolean questions participate in the deterministic score.
        # Evidence/text answers are recorded by the caller but must not be
        # mistaken for compliant answers, and unknown question IDs must
        # not inflate the score.
        total_q, yes, no = boolean_answer_counts(control, answers)
        if total_q == 0:
            score = 50.0  # untestable; neutral
        elif yes == total_q:
            score = 100.0
        elif yes > 0:
            score = round(100.0 * yes / total_q, 2)
        elif no == total_q:
            score = 0.0
        else:
            score = 30.0  # unknown

        risk_points = round((100 - score) / 100 * control.scoring.penalty_points, 2)
        rationale = build_rationale(control, score, answers, input)
        findings.append(
            {
                "control_id": control.id,
                "title": control.title,
                "domain": control.domain.value,
                "severity": control.severity.value,
                "score": score,
                "risk_points": risk_points,
                "rationale": rationale,
                "evidence_required": [
                    {
                        "type": e.type.value,
                        "description": e.description,
                        "retention": e.retention,
                    }
                    for e in control.evidence_required
                ],
            }
        )
        total_weight += control.scoring.weight
        weighted_score += score * control.scoring.weight
        # Preserve the existing penalty-point estimate; this is not a statutory cap calculation.
        total_exposure_inr += int(min(risk_points, control.scoring.penalty_points) * 10_00_000)

    posture = round(weighted_score / max(0.0001, total_weight), 2)

    sdf_assessment = {
        "is_sdf_attested": input.sdf_self_attested,
        "processes_children": input.processes_children,
        "processes_health": input.processes_health,
        "applicable_sdf_controls": None
        if input.sdf_self_attested is None
        else [c.id for c in lib.filter(sdf_only=True) if input.sdf_self_attested],
        "applicable_children_controls": None
        if input.processes_children is None
        else [c.id for c in lib.filter(children_only=True) if input.processes_children],
        "declaration_provenance": {
            key: "unknown" if value is None else "caller_declared_unverified"
            for key, value in declarations.items()
        },
        "applicability_review_required": True,
        "computation_scope": "All library controls are scored; applicability is not determined.",
    }
    provenance = {
        "version": 1,
        "source_library_version": lib.version,
        "source_library_digest": None,
        "estimates": "provisional",
        "review_required": True,
        "controls": provenance_controls,
        "applicability": {
            key: {
                "value": value,
                "provenance": "unknown" if value is None else "caller_declared_unverified",
            }
            for key, value in declarations.items()
        },
    }
    if len(json.dumps(provenance, ensure_ascii=False).encode("utf-8")) > 262144:
        raise ValueError("Provenance size limit exceeded")

    return {
        "library_version": lib.version,
        "posture_score": posture,
        "estimated_exposure_inr": total_exposure_inr,
        "findings": sorted(findings, key=lambda f: f["risk_points"], reverse=True),
        "sdf_self_assessment": sdf_assessment,
        "questionnaire_provenance": provenance,
        "notes": (
            f"Scored against library v{lib.version} using {len(findings)} controls. "
            "Scores, risk points and exposure are computation estimates based on unverified "
            "questionnaire answers; evidence and human/legal review remain required."
        ),
    }


def boolean_answer_counts(control, answers: dict) -> tuple[int, int, int]:
    boolean_ids = {
        str(q.get("id"))
        for q in control.assessment_questions
        if q.get("type") == "boolean" and q.get("id")
    }
    return (
        len(boolean_ids),
        sum(answers.get(qid) is True for qid in boolean_ids),
        sum(answers.get(qid) is False for qid in boolean_ids),
    )


def control_provenance(control, answers: dict, input: AssessmentInput) -> dict:
    """Bounded known-question declarations, never free text, evidence or PII."""
    if (
        not isinstance(answers, dict)
        or not isinstance(control.id, str)
        or not 1 <= len(control.id) <= 200
        or control.library_version != input.library_version
        or type(control.sdf_only) is not bool
        or type(control.children_only) is not bool
    ):
        raise ValueError("Invalid provenance control")
    ids = [q.get("id") for q in control.assessment_questions if q.get("type") == "boolean"]
    if len(ids) > 1000 or any(not isinstance(q, str) or not 1 <= len(q) <= 200 for q in ids):
        raise ValueError("Invalid provenance questions")
    if len(set(ids)) != len(ids):
        raise ValueError("Duplicate provenance questions")
    questions = [
        {
            "question_id": qid,
            "declaration": "caller_affirmed"
            if answers.get(qid) is True
            else "caller_denied"
            if answers.get(qid) is False
            else "unknown",
        }
        for qid in sorted(ids)
    ]
    total = len(questions)
    affirmed = sum(q["declaration"] == "caller_affirmed" for q in questions)
    denied = sum(q["declaration"] == "caller_denied" for q in questions)
    unknown = total - affirmed - denied
    state = (
        "not_boolean_assessable"
        if total == 0
        else "unknown"
        if unknown == total
        else "partially_answered"
        if unknown
        else "caller_declared_unverified"
    )
    required = []
    if control.sdf_only:
        required.append(input.sdf_self_attested)
    if control.children_only:
        required.append(input.processes_children)
    applicability = (
        "unconditional"
        if not required
        else "caller_declared_not_applicable_unverified"
        if any(v is False for v in required)
        else "unknown"
        if any(v is None for v in required)
        else "caller_declared_applicable_unverified"
    )
    return {
        "control_id": control.id,
        "questions": questions,
        "known_boolean_question_count": total,
        "caller_affirmed_count": affirmed,
        "caller_denied_count": denied,
        "unknown_count": unknown,
        "answer_state": state,
        "applicability_state": applicability,
    }


def build_rationale(
    control, score: float, answers: dict, input: AssessmentInput | None = None
) -> str:
    citations = "; ".join(f"{c.instrument} {c.reference}" for c in control.citations)
    total, yes, no = boolean_answer_counts(control, answers)
    if total:
        assessment = (
            f"Boolean questionnaire: {yes} caller-affirmed, {no} caller-denied, "
            f"{total - yes - no} unknown of {total}; declared answers remain unverified. "
        )
        if total > yes + no:
            assessment += "Unknown answers require evidence and human review. "
    else:
        assessment = "No boolean assessment questions; a neutral computation estimate is used. "

    def declaration(value: bool | None) -> str:
        return "unknown" if value is None else f"caller-declared {str(value).lower()} (unverified)"

    # The isolated worker persists rationale, not sdf_self_assessment. Keep
    # applicability provenance here too, without storing raw questionnaire values.
    applicability = "; ".join(
        f"{label}={declaration(getattr(input, key, None))}"
        for label, key in (
            ("SDF", "sdf_self_attested"),
            ("children", "processes_children"),
            ("health", "processes_health"),
        )
    )
    return (
        f"{assessment}Questionnaire score estimate: {score:g}%. "
        f"Applicability inputs: {applicability}. All library controls remain in this computation. "
        "Scores, risk points and exposure are estimates; compliance, applicability and statutory "
        f"liability require evidence and human/legal review. {citations}."
    )
