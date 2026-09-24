"""Pure assessment calculation shared by the legacy agent and isolated worker.

No settings, clients, model calls, credentials, persistence or default library.
The caller supplies the exact pinned library. Existing scoring is preserved.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .control_library_loader import ControlLibrary


@dataclass(frozen=True)
class AssessmentInput:
    library_version: str
    answers: dict = field(default_factory=dict)
    sdf_self_attested: bool = False
    processes_children: bool = False
    processes_health: bool = False


def score_assessment(lib: ControlLibrary, input: AssessmentInput) -> dict:
    if not lib.version or lib.version != input.library_version or len(lib) == 0:
        raise ValueError("Assessment library mismatch")
    findings: list[dict] = []
    total_weight = 0.0
    weighted_score = 0.0
    total_exposure_inr = 0

    for control in lib:
        answers = input.answers.get(control.id, {})
        # Only boolean questions participate in the deterministic score.
        # Evidence/text answers are recorded by the caller but must not be
        # mistaken for compliant answers, and unknown question IDs must
        # not inflate the score.
        boolean_ids = {
            str(q.get("id"))
            for q in control.assessment_questions
            if q.get("type") == "boolean" and q.get("id")
        }
        boolean_answers = {qid: answers[qid] for qid in boolean_ids if qid in answers}
        yes = sum(1 for a in boolean_answers.values() if a is True)
        no = sum(1 for a in boolean_answers.values() if a is False)
        total_q = len(boolean_ids)
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
        rationale = build_rationale(control, score, answers)
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
        "applicable_sdf_controls": [
            c.id for c in lib.filter(sdf_only=True) if input.sdf_self_attested
        ],
        "applicable_children_controls": [
            c.id for c in lib.filter(children_only=True) if input.processes_children
        ],
    }

    return {
        "library_version": lib.version,
        "posture_score": posture,
        "estimated_exposure_inr": total_exposure_inr,
        "findings": sorted(findings, key=lambda f: f["risk_points"], reverse=True),
        "sdf_self_assessment": sdf_assessment,
        "notes": f"Scored against library v{lib.version} using {len(findings)} controls.",
    }


def build_rationale(control, score: float, answers: dict) -> str:
    citations = "; ".join(f"{c.instrument} {c.reference}" for c in control.citations)
    if score >= 100:
        return f"All assessment questions answered compliantly. {citations}."
    if score == 0:
        return f"No compliant answers; full risk exposure. {citations}."
    if score < 50:
        return f"Partial compliance ({score:.0f}%). {citations}."
    return f"Mostly compliant ({score:.0f}%). {citations}."
