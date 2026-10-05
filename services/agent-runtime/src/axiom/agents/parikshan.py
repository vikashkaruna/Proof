"""Parikshan — the Assessment Agent.

"I measure you against the law."

Parikshan runs the gap assessment against the versioned control
library (46 controls in v0.1.0). It scores each control, weights
the risk, and produces computation estimates of posture and exposure.
Questionnaire declarations and SDF applicability remain unverified.

In Phase 0, the agent produces a structured scoring against the
46 controls. Rationale describes the deterministic computation and
unknown inputs. Evidence and human/legal review remain required.
"""

from __future__ import annotations

from typing import Any, ClassVar, Literal

from pydantic import BaseModel, ConfigDict, Field

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
    sdf_self_attested: bool | None = Field(default=None, strict=True)
    processes_children: bool | None = Field(default=None, strict=True)
    processes_health: bool | None = Field(default=None, strict=True)


class FindingOut(BaseModel):
    control_id: str
    title: str
    domain: str
    severity: str
    score: float  # 0-100
    risk_points: float
    rationale: str
    evidence_required: list[dict[str, Any]]


class QuestionDeclaration(BaseModel):
    model_config = ConfigDict(extra="forbid")
    question_id: str = Field(min_length=1, max_length=200)
    declaration: Literal["unknown", "caller_affirmed", "caller_denied"]


class ControlProvenance(BaseModel):
    model_config = ConfigDict(extra="forbid")
    control_id: str = Field(min_length=1, max_length=200)
    questions: list[QuestionDeclaration] = Field(max_length=1000)
    known_boolean_question_count: int = Field(strict=True, ge=0, le=1000)
    caller_affirmed_count: int = Field(strict=True, ge=0, le=1000)
    caller_denied_count: int = Field(strict=True, ge=0, le=1000)
    unknown_count: int = Field(strict=True, ge=0, le=1000)
    answer_state: Literal[
        "unknown", "partially_answered", "caller_declared_unverified", "not_boolean_assessable"
    ]
    applicability_state: Literal[
        "unconditional",
        "unknown",
        "caller_declared_applicable_unverified",
        "caller_declared_not_applicable_unverified",
    ]


class ApplicabilityDeclaration(BaseModel):
    model_config = ConfigDict(extra="forbid")
    value: bool | None = Field(strict=True)
    provenance: Literal["unknown", "caller_declared_unverified"]


class ApplicabilityProvenance(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sdf_self_attested: ApplicabilityDeclaration
    processes_children: ApplicabilityDeclaration
    processes_health: ApplicabilityDeclaration


class QuestionnaireProvenance(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Literal[1]
    source_library_version: str = Field(min_length=1, max_length=200)
    source_library_digest: str | None = Field(pattern=r"^[a-f0-9]{64}$")
    estimates: Literal["provisional"]
    review_required: Literal[True]
    controls: list[ControlProvenance] = Field(min_length=1, max_length=500)
    applicability: ApplicabilityProvenance


class ParikshanOutput(BaseModel):
    library_version: str
    posture_score: float
    estimated_exposure_inr: int
    findings: list[FindingOut]
    sdf_self_assessment: dict[str, Any]
    notes: str = ""
    questionnaire_provenance: QuestionnaireProvenance | None = None


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
