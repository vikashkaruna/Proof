"""Sudhaar — the Remediation Planning Agent.

"I propose the fix. You decide."

Sudhaar converts each finding into a typed, parameterised remediation
action with a risk score, blast radius, dependency order, and a
mandatory generated rollback plan.

Per ADR-3 (mirror): Sudhaar holds NO write credentials. It proposes,
never executes. This is the separation of duties.
"""

from __future__ import annotations

from enum import Enum
from typing import Any, ClassVar

from pydantic import BaseModel, Field


class ActionType(str, Enum):
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


from .base import AgentName, AutonomyLevel, BaseAgent


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
    pairs: dict[ActionType, ActionType] = {
        ActionType.DATA_DELETE: ActionType.POLICY_PUBLISH,  # data can't be un-deleted; rollback = log+notify
        ActionType.DATA_MASK: ActionType.CUSTOM,  # masked data cannot be unmasked by design
        ActionType.CONFIG_RBAC_UPDATE: ActionType.CONFIG_RBAC_UPDATE,
        ActionType.CONFIG_MFA_ENFORCE: ActionType.CONFIG_MFA_ENFORCE,
        ActionType.CONSENT_UPDATE: ActionType.NOTICE_UPDATE,
        ActionType.POLICY_PUBLISH: ActionType.POLICY_UPDATE,
    }
    return pairs.get(action)


class SudhaarAction(BaseModel):
    sequence: int
    action_type: str
    description: str
    parameters: dict[str, Any] = Field(default_factory=dict)
    closes_finding_id: str
    risk_class: str  # 'low' | 'medium' | 'high' | 'critical'
    risk_score: float  # 0-100
    records_affected: int
    systems_affected: list[str] = Field(default_factory=list)
    environment: str = "production"  # 'production' | 'staging' | 'development' | 'n/a'
    rollback: dict[str, Any]
    depends_on: list[int] = Field(default_factory=list)


class SudhaarInput(BaseModel):
    tenant_id: str
    engagement_id: str
    title: str = "Remediation plan"
    findings: list[dict[str, Any]] = Field(default_factory=list)
    blast_radius_cap_records: int = 50_000  # tenant-set cap


class SudhaarOutput(BaseModel):
    title: str
    actions: list[SudhaarAction]
    aggregate_records_affected: int
    aggregate_systems: list[str]
    escalate: bool = False
    escalation_reason: str | None = None


class SudhaarAgent(BaseAgent[SudhaarInput, SudhaarOutput]):
    name: ClassVar[AgentName] = AgentName.SUDHAAR
    writes_axiom_state: ClassVar[bool] = True
    description: ClassVar[str] = "Generate a typed remediation plan with rollback definitions."
    one_liner: ClassVar[str] = "I propose the fix. You decide."
    # A plan proposal is returned to the caller; Sudhaar has no persistence
    # scope and cannot mutate a tenant's plan or any external system.
    tool_scopes: ClassVar[tuple[str, ...]] = ("findings.read", "control_library.read", "plan.propose")
    autonomy: ClassVar[AutonomyLevel] = AutonomyLevel.L1
    # Per ADR-3, Sudhaar holds NO write credentials
    can_mutate: ClassVar[bool] = False
    default_task_kind: ClassVar[Any] = "reasoning"

    def input_schema(self) -> type[SudhaarInput]:
        return SudhaarInput

    def output_schema(self) -> type[SudhaarOutput]:
        return SudhaarOutput

    async def _run(
        self, *, correlation_id: str, input: SudhaarInput, **deps: Any
    ) -> SudhaarOutput:
        actions: list[SudhaarAction] = []
        aggregate_records = 0
        aggregate_systems: set[str] = set()
        escalate = False
        escalation_reason: str | None = None

        # Sort findings by risk (descending) so the highest-priority
        # actions come first in the plan
        sorted_findings = sorted(
            input.findings, key=lambda f: f.get("risk_points", 0), reverse=True
        )

        for i, finding in enumerate(sorted_findings, start=1):
            patterns = finding.get("remediation_patterns") or ["policy"]
            primary_pattern = patterns[0] if patterns else "policy"
            action_type = PATTERN_TO_ACTION.get(primary_pattern, ActionType.CUSTOM)
            control_id = finding.get("control_id", "")
            severity = finding.get("severity", "medium")
            risk_score = float(finding.get("risk_points", 0))
            risk_class = severity if severity in {"low", "medium", "high", "critical"} else "medium"

            records_affected = int(risk_score * 100)  # heuristic
            systems_affected = ["crm-prod"] if records_affected > 0 else []

            # Build the rollback plan
            inv = inverse_action(action_type)
            rollback = {
                "type": "typed",
                "inverseActionType": inv.value if inv else None,
                "steps": [
                    {
                        "description": (
                            f"Restore {action_type.value} to pre-execution state"
                            if inv
                            else f"Manual recovery: revert {action_type.value} via documented procedure"
                        ),
                        "action": "rollback.execute",
                        "parameters": {"originalActionId": "{{action.id}}"},
                    }
                ],
                "estimatedRollbackTimeSeconds": 300,
                "preconditions": [
                    f"pre_state snapshot exists for action {{action.id}}",
                    "no concurrent mutations on the same target",
                ],
                "validatedExecutable": False,  # set true after dry-run
            }

            actions.append(
                SudhaarAction(
                    sequence=i,
                    action_type=action_type.value,
                    description=f"Address {control_id}: {finding.get('title', '')}",
                    parameters={
                        "control_id": control_id,
                        "finding_id": finding.get("id", ""),
                    },
                    closes_finding_id=finding.get("id", ""),
                    risk_class=risk_class,
                    risk_score=min(100.0, risk_score),
                    records_affected=records_affected,
                    systems_affected=systems_affected,
                    environment="production" if records_affected > 0 else "n/a",
                    rollback=rollback,
                )
            )

            aggregate_records += records_affected
            aggregate_systems.update(systems_affected)

            # Per-action escalation: high-risk actions get a flag
            if risk_class in {"high", "critical"} and records_affected > 10_000:
                escalate = True
                escalation_reason = (
                    escalation_reason
                    or f"high_blast_radius: action #{i} ({action_type.value}) affects {records_affected} records"
                )

        # Tenant-level blast-radius cap check
        if aggregate_records > input.blast_radius_cap_records:
            escalate = True
            escalation_reason = (
                escalation_reason
                or f"blast_radius_exceeded: plan affects {aggregate_records} records > cap {input.blast_radius_cap_records}"
            )

        return SudhaarOutput(
            title=input.title,
            actions=actions,
            aggregate_records_affected=aggregate_records,
            aggregate_systems=sorted(aggregate_systems),
            escalate=escalate,
            escalation_reason=escalation_reason,
        )
