"""Sudhaar — the Remediation Planning Agent.

"I propose the fix. You decide."

Sudhaar converts exact source-bound assessment findings into mandatory review
work. Scores and caller declarations never establish verified failures, safe
scope, reversible operations, executable actions or closed findings.

Per ADR-3 (mirror): Sudhaar holds NO write credentials. It proposes,
never executes. This is the separation of duties.
"""

from __future__ import annotations

from enum import StrEnum
from typing import TYPE_CHECKING, Any, ClassVar, Literal, Self

import structlog
from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..canonicalise import canonical_json
from ..ledger_client import LedgerClient

if TYPE_CHECKING:
    from ..config import Settings
    from ..evidence_client import EvidenceVault
    from ..model_gateway import ModelGateway

from .base import AgentName, AutonomyLevel, BaseAgent


class ActionType(StrEnum):
    POLICY_PUBLISH = "policy.publish"
    POLICY_UPDATE = "policy.update"
    NOTICE_UPDATE = "notice.update"
    CONSENT_UPDATE = "consent.update"
    DATA_MASK = "data.mask"
    DATA_DELETE = "data.delete"
    DATA_PORTABILITY_EXPORT = "data.portability_export"
    DATA_RETENTION_PURGE = "data.retention_purge"
    CONFIG_RBAC_UPDATE = "config.rbac_update"
    CONFIG_MFA_ENFORCE = "config.mfa_enforce"
    CONFIG_BACKUP_ENCRYPT = "config.backup_encrypt"
    CONFIG_AUDIT_LOG_ENABLE = "config.audit_log_enable"
    CONFIG_CONSENT_UI_UPDATE = "config.consent_ui_update"
    DPO_APPOINT = "dpo.appoint"
    DPA_EXECUTE = "dpa.execute"
    DPO_CONTACT_PUBLISH = "dpo.contact_publish"
    BREACH_PLAYBOOK_PUBLISH = "breach.playbook_publish"
    TRAINING_RUN = "training.run"
    REVIEW_ACCEPT_RISK = "review.accept_risk"
    CONNECTOR_SCAN = "connector.scan"
    CONNECTOR_CLASSIFY = "connector.classify"
    CUSTOM = "custom"


# Map control remediation patterns to default action types
PATTERN_TO_ACTION: dict[str, ActionType] = {
    "policy": ActionType.POLICY_PUBLISH,
    "consent": ActionType.CONSENT_UPDATE,
    "config": ActionType.CONFIG_AUDIT_LOG_ENABLE,
    "data-deletion": ActionType.DATA_DELETE,
    "data-masking": ActionType.DATA_MASK,
    "data-portability": ActionType.DATA_PORTABILITY_EXPORT,
    "dpo-appointment": ActionType.DPO_APPOINT,
    "dpa-execution": ActionType.DPA_EXECUTE,
    "breach-process": ActionType.BREACH_PLAYBOOK_PUBLISH,
    "training": ActionType.TRAINING_RUN,
    "discovery": ActionType.CONNECTOR_SCAN,
    "vendor-risk": ActionType.DPA_EXECUTE,
    "review": ActionType.REVIEW_ACCEPT_RISK,
    "reporting": ActionType.POLICY_PUBLISH,
}


def inverse_action(action: ActionType) -> ActionType | None:
    """For each mutating action, return its typed inverse for rollback."""
    pairs: dict[ActionType, ActionType | None] = {
        ActionType.DATA_DELETE: None,  # Irreversible deletion has no typed inverse.
        ActionType.DATA_MASK: None,  # Irreversible masking cannot claim a custom undo.
        ActionType.CONFIG_RBAC_UPDATE: ActionType.CONFIG_RBAC_UPDATE,
        ActionType.CONFIG_MFA_ENFORCE: ActionType.CONFIG_MFA_ENFORCE,
        ActionType.CONSENT_UPDATE: ActionType.NOTICE_UPDATE,
        ActionType.POLICY_PUBLISH: ActionType.POLICY_UPDATE,
    }
    return pairs.get(action)


class PlanningSource(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, serialize_by_alias=True)
    assessment_run_id: str = Field(
        alias="assessmentRunId", pattern=r"^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$"
    )
    library_version: str = Field(alias="libraryVersion", min_length=1, max_length=200)
    library_digest: str = Field(alias="libraryDigest", pattern=r"^[a-f0-9]{64}$")
    result_digest: str = Field(alias="resultDigest", pattern=r"^[a-f0-9]{64}$")
    finalized_receipt: str = Field(alias="finalizedReceipt", pattern=r"^[1-9][0-9]{0,18}$")

    @model_validator(mode="after")
    def validate_receipt(self) -> Self:
        if int(self.finalized_receipt) > 9223372036854775807:
            raise ValueError("Planning receipt refused")
        return self


class AnswerCounts(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    known: int = Field(ge=0, le=1000)
    affirmed: int = Field(ge=0, le=1000)
    denied: int = Field(ge=0, le=1000)
    unknown: int = Field(ge=0, le=1000)


class PlanningFinding(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    finding_id: str = Field(pattern=r"^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$")
    control_id: str = Field(min_length=1, max_length=100)
    title: str = Field(min_length=1, max_length=300)
    severity: Literal["critical", "high", "medium", "low", "info"]
    score_decimal: str = Field(pattern=r"^(?:100(?:\.0+)?|(?:[0-9]|[1-9][0-9])(?:\.[0-9]{1,6})?)$")
    risk_points_decimal: str = Field(pattern=r"^(?:0|[1-9][0-9]{0,4})(?:\.[0-9]{1,6})?$")
    answer_state: Literal[
        "unknown",
        "partially_answered",
        "caller_declared_unverified",
        "not_boolean_assessable",
        "unavailable",
    ]
    applicability_state: Literal[
        "unconditional",
        "unknown",
        "caller_declared_applicable_unverified",
        "caller_declared_not_applicable_unverified",
        "unavailable",
    ]
    answer_counts: AnswerCounts | None

    @model_validator(mode="after")
    def validate_declarations(self) -> Self:
        n = self.answer_counts
        expected = (
            "unavailable"
            if n is None
            else "not_boolean_assessable"
            if n.known == 0
            else "unknown"
            if n.unknown == n.known
            else "partially_answered"
            if n.unknown
            else "caller_declared_unverified"
        )
        if (
            self.answer_state != expected
            or (n and n.known != n.affirmed + n.denied + n.unknown)
            or ((n is None) != (self.applicability_state == "unavailable"))
        ):
            raise ValueError("Unbound planning declarations")
        return self


class SudhaarInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    tenant_id: str = Field(pattern=r"^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$")
    engagement_id: str = Field(pattern=r"^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$")
    title: str = Field(min_length=1, max_length=300)
    source: PlanningSource
    findings: list[PlanningFinding] = Field(min_length=1, max_length=500)

    @model_validator(mode="after")
    def validate_register(self) -> Self:
        if (
            len({f.finding_id for f in self.findings}) != len(self.findings)
            or len({f.control_id for f in self.findings}) != len(self.findings)
            or sum(f.answer_counts.known for f in self.findings if f.answer_counts) > 5000
            or len(canonical_json(self.model_dump(mode="json")).encode()) > 524_288
        ):
            raise ValueError("Planning register refused")
        return self


ReviewReason = Literal[
    "provenance_unavailable",
    "applicability_unverified",
    "questionnaire_incomplete",
    "evidence_required",
    "declarations_unverified",
]


class ReviewTask(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    sequence: int = Field(ge=1, le=500)
    finding_id: str
    control_id: str
    title: str
    reason: ReviewReason
    instruction: Literal[
        "Review the recorded questionnaire, applicability and supporting evidence before proposing corrective work. No finding is closed by this proposal."
    ]


class SudhaarOutput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    schema_version: Literal[1]
    kind: Literal["remediation_proposal"]
    title: str
    source: PlanningSource
    persistence: Literal["not_saved"]
    review_required: Literal[True]
    escalate: Literal[True]
    execution_allowed: Literal[False]
    review_tasks: list[ReviewTask] = Field(min_length=1, max_length=500)
    provisional_actions: list[Any] = Field(max_length=0)
    aggregate_records_affected: None
    aggregate_systems: list[str] = Field(max_length=0)


def review_reason(finding: PlanningFinding) -> ReviewReason:
    if finding.answer_state == "unavailable":
        return "provenance_unavailable"
    if finding.applicability_state != "unconditional":
        return "applicability_unverified"
    if finding.answer_state in {"unknown", "partially_answered"}:
        return "questionnaire_incomplete"
    if finding.answer_state == "not_boolean_assessable":
        return "evidence_required"
    return "declarations_unverified"


class SudhaarAgent(BaseAgent[SudhaarInput, SudhaarOutput]):
    name: ClassVar[AgentName] = AgentName.SUDHAAR
    writes_axiom_state: ClassVar[bool] = False
    description: ClassVar[str] = (
        "Propose source-bound assessment review work; never execute or close findings."
    )
    one_liner: ClassVar[str] = "I propose the review. You decide."
    tool_scopes: ClassVar[tuple[str, ...]] = (
        "findings.read",
        "control_library.read",
        "plan.propose",
    )
    autonomy: ClassVar[AutonomyLevel] = AutonomyLevel.L1
    can_mutate: ClassVar[bool] = False
    default_task_kind: ClassVar[Any] = "reasoning"

    def __init__(
        self,
        *,
        settings: Settings | None = None,
        ledger: LedgerClient | None = None,
        evidence: EvidenceVault | None = None,
        model_gateway: ModelGateway | None = None,
    ) -> None:
        # Keep constructor compatibility with the shared runtime registry while
        # retaining none of the shared settings/vault/gateway/read credentials.
        # The only credential-bearing capability is the scoped audit writer.
        self.ledger = (ledger or LedgerClient.from_settings(settings)).append_only_view()
        self.log = structlog.get_logger(agent=self.name.value, version=self.version)

    def input_schema(self) -> type[SudhaarInput]:
        return SudhaarInput

    def output_schema(self) -> type[SudhaarOutput]:
        return SudhaarOutput

    async def _run(self, *, correlation_id: str, input: SudhaarInput, **deps: Any) -> SudhaarOutput:
        tasks = [
            ReviewTask(
                sequence=i,
                finding_id=f.finding_id,
                control_id=f.control_id,
                title=f.title,
                reason=review_reason(f),
                instruction="Review the recorded questionnaire, applicability and supporting evidence before proposing corrective work. No finding is closed by this proposal.",
            )
            for i, f in enumerate(input.findings, 1)
        ]
        return SudhaarOutput(
            schema_version=1,
            kind="remediation_proposal",
            title=input.title,
            source=input.source,
            persistence="not_saved",
            review_required=True,
            escalate=True,
            execution_allowed=False,
            review_tasks=tasks,
            provisional_actions=[],
            aggregate_records_affected=None,
            aggregate_systems=[],
        )
