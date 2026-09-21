"""Parikshan — the Assessment Agent.

"I measure you against the law."

Parikshan runs the gap assessment against the versioned control
library (46 controls in v0.1.0). It scores each control, weights
the risk, and produces a posture score and an estimated statutory
exposure. It also produces SDF self-assessments.

In Phase 0, the agent produces a structured scoring against the
46 controls. The reasoning model is used to generate the rationale
for each finding. The structural classification of "what control
applies to what evidence" is deterministic.
"""

from __future__ import annotations

from typing import Any, ClassVar

from pydantic import BaseModel, Field

from ..control_library_loader import ControlLibrary, ControlSeverity, load_default_library
from .base import AgentName, AutonomyLevel, BaseAgent


class ParikshanInput(BaseModel):
    tenant_id: str
    engagement_id: str
    library_version: str = "0.1.0"
    answers: dict[str, dict[str, Any]] = Field(
        default_factory=dict,
        description="Map of control_id → {question_id: answer} for the assessment questionnaire",
    )
    sdf_self_attested: bool = False
    processes_children: bool = False
    processes_health: bool = False


class FindingOut(BaseModel):
    control_id: str
    title: str
    domain: str
    severity: str
    score: float  # 0-100
    risk_points: float
    rationale: str
    evidence_required: list[dict[str, Any]]


class ParikshanOutput(BaseModel):
    library_version: str
    posture_score: float
    estimated_exposure_inr: int
    findings: list[FindingOut]
    sdf_self_assessment: dict[str, Any]
    notes: str = ""


class ParikshanAgent(BaseAgent[ParikshanInput, ParikshanOutput]):
    name: ClassVar[AgentName] = AgentName.PARIKSHAN
    writes_axiom_state: ClassVar[bool] = True
    description: ClassVar[str] = "Score the engagement against the versioned control library."
    one_liner: ClassVar[str] = "I measure you against the law."
    tool_scopes: ClassVar[tuple[str, ...]] = ("control_library.read", "findings.write")
    autonomy: ClassVar[AutonomyLevel] = AutonomyLevel.L1
    default_task_kind: ClassVar[Any] = "reasoning"

    def input_schema(self) -> type[ParikshanInput]:
        return ParikshanInput

    def output_schema(self) -> type[ParikshanOutput]:
        return ParikshanOutput

    async def _run(
        self, *, correlation_id: str, input: ParikshanInput, **deps: Any
    ) -> ParikshanOutput:
        lib: ControlLibrary = deps.get("library") or load_default_library()
        findings: list[FindingOut] = []
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
            rationale = self._build_rationale(control, score, answers)
            findings.append(
                FindingOut(
                    control_id=control.id,
                    title=control.title,
                    domain=control.domain.value,
                    severity=control.severity.value,
                    score=score,
                    risk_points=risk_points,
                    rationale=rationale,
                    evidence_required=[
                        {
                            "type": e.type.value,
                            "description": e.description,
                            "retention": e.retention,
                        }
                        for e in control.evidence_required
                    ],
                )
            )
            total_weight += control.scoring.weight
            weighted_score += score * control.scoring.weight
            # Cap exposure at the per-control statutory max
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

        return ParikshanOutput(
            library_version=lib.version,
            posture_score=posture,
            estimated_exposure_inr=total_exposure_inr,
            findings=sorted(findings, key=lambda f: f.risk_points, reverse=True),
            sdf_self_assessment=sdf_assessment,
            notes=f"Scored against library v{lib.version} using {len(findings)} controls.",
        )

    def _build_rationale(
        self, control, score: float, answers: dict[str, Any]
    ) -> str:
        citations = "; ".join(f"{c.instrument} {c.reference}" for c in control.citations)
        if score >= 100:
            return f"All assessment questions answered compliantly. {citations}."
        if score == 0:
            return f"No compliant answers; full risk exposure. {citations}."
        if score < 50:
            return f"Partial compliance ({score:.0f}%). {citations}."
        return f"Mostly compliant ({score:.0f}%). {citations}."
