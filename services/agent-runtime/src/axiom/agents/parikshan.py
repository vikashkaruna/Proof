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

from ..assessment_scoring import AssessmentInput, score_assessment
from ..control_library_loader import ControlLibrary, load_default_library
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
        return ParikshanOutput.model_validate(
            score_assessment(
                lib,
                AssessmentInput(
                    library_version=input.library_version,
                    answers=input.answers,
                    sdf_self_attested=input.sdf_self_attested,
                    processes_children=input.processes_children,
                    processes_health=input.processes_health,
                ),
            )
        )
