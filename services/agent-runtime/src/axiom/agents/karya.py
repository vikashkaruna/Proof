"""Karya — the Execution Agent.

"I only act on your approval."

Karya is the only mutating agent. It executes ONLY actions covered
by a signed, scope-bound approval token validated per action (not
per batch). Every step logs pre- and post-state to the evidence
vault; the post-execution verification agent confirms the gap
actually closed.

Phase 0/1: stub. Phase 3 turns this on with a typed action catalogue
and connector-driven execution. The agent refuses to run without a
valid approval token; the validation logic is in the BFF.

Per ADR-2 (mirror): Karya is the gate. Approval is architectural.
"""

from __future__ import annotations

from typing import Any, ClassVar

from pydantic import BaseModel, Field

from ..kill_switch import KillSwitchEngaged, KillSwitchReader
from .base import AgentName, AutonomyLevel, BaseAgent


class KaryaInput(BaseModel):
    tenant_id: str = "00000000-0000-0000-0000-000000000001"
    plan_id: str = "00000000-0000-0000-0000-000000000001"
    action_id: str = "00000000-0000-0000-0000-000000000001"
    approval_token: dict[str, Any] | None = Field(
        default=None,
        description="The signed approval token, including spec and signature",
    )
    parameters: dict[str, Any] = Field(default_factory=dict)


class KaryaOutput(BaseModel):
    action_id: str
    status: str  # 'succeeded' | 'failed' | 'rolled_back' | 'skipped' | 'denied'
    pre_state_uri: str | None = None
    post_state_uri: str | None = None
    error: str | None = None
    notes: str = ""


class KaryaAgent(BaseAgent[KaryaInput, KaryaOutput]):
    name: ClassVar[AgentName] = AgentName.KARYA
    description: ClassVar[str] = "Execute an approved action (Phase 3, stub in Phase 0/1)."
    one_liner: ClassVar[str] = "I only act on your approval."
    tool_scopes: ClassVar[tuple[str, ...]] = (
        "connector.write",
        "evidence.write",
        "rollback.execute",
    )
    autonomy: ClassVar[AutonomyLevel] = AutonomyLevel.L2
    # Karya is the ONLY mutating agent. It requires an approval token.
    can_mutate: ClassVar[bool] = True
    default_task_kind: ClassVar[Any] = "structural"
    default_pii_redact: ClassVar[bool] = True

    def input_schema(self) -> type[KaryaInput]:
        return KaryaInput

    def output_schema(self) -> type[KaryaOutput]:
        return KaryaOutput

    async def _run(
        self, *, correlation_id: str, input: KaryaInput, **deps: Any
    ) -> KaryaOutput:
        # SEC-4 / R-09 / FR-8.6 — the stop is checked HERE, inside the only
        # agent that mutates a client estate, not merely where the BFF admits
        # a request. Admission is not execution: a batch already dispatched
        # would otherwise run to completion however many times an operator
        # engages the switch.
        #
        # First of two checks. This one refuses to start; the second runs
        # immediately before the mutating step, so the window between "clear"
        # and "acting" is as small as the code allows.
        kill_switch: KillSwitchReader = deps.get("kill_switch") or KillSwitchReader.from_settings(
            self.settings
        )
        try:
            kill_switch.raise_if_engaged(input.tenant_id)
        except KillSwitchEngaged as halt:
            return KaryaOutput(
                action_id=input.action_id,
                status="denied",
                error=f"kill_switch_engaged: {halt.reason}",
                notes=(
                    "Execution is halted. This is a refusal to act, not a failure: "
                    "nothing was mutated and the action remains approved and retryable."
                ),
            )

        # ADR-1 / ADR-3 Gate: unapproved mutating execution is architecturally refused
        if not input.approval_token:
            return KaryaOutput(
                action_id=input.action_id,
                status="denied",
                error="approval_token_required: Karya refuses mutating execution without a signed, scope-bound approval token (ADR-1, ADR-3).",
                notes="Review and approve actions via the Approval Console (/approval) before execution.",
            )

        # Phase 0/1 stub: refuse to execute without explicit phase
        # activation. The BFF gates all real execution in Phase 3+.
        if not self.settings.feature_execution_engine:
            return KaryaOutput(
                action_id=input.action_id,
                status="denied",
                error="Karya is disabled in current phase (feature_execution_engine=false)",
                notes="Karya refuses to run in Phase 0/1. Enable when moving to Phase 3.",
            )

        # Validate the approval token signature via the approval engine
        from ..approval_engine import ApprovalEngine  # type: ignore[attr-defined]

        engine = ApprovalEngine(
            signing_key=self.settings.approval_signing_key,
        )
        verification = await engine.verify(input.tenant_id, input.approval_token)
        if not verification.valid:
            return KaryaOutput(
                action_id=input.action_id,
                status="denied",
                error=f"Token invalid: {verification.reason}",
            )

        spec = input.approval_token.get("spec", {})
        if spec.get("planId") != input.plan_id:
            return KaryaOutput(
                action_id=input.action_id,
                status="denied",
                error="Token was not issued for this plan",
            )
        if input.action_id not in spec.get("actionIds", []):
            return KaryaOutput(
                action_id=input.action_id,
                status="denied",
                error="Action is not covered by the approval token",
            )

        # Second checkpoint, immediately before the mutating step.
        #
        # Token verification above reaches the network, so time has passed
        # since the first check — and this is the point of no return. Anything
        # engaged in that window must still stop the action. When Phase 3
        # replaces the stub below with a real connector call, this check and
        # the chunk boundary inside it are what bound the stop latency to one
        # action rather than one batch.
        try:
            kill_switch.raise_if_engaged(input.tenant_id)
        except KillSwitchEngaged as halt:
            return KaryaOutput(
                action_id=input.action_id,
                status="denied",
                error=f"kill_switch_engaged: {halt.reason}",
                notes="Halted after token validation and before any mutation.",
            )

        # Token valid. Phase 3+ would now dispatch to the typed action
        # catalogue (connector-driven for data actions, file system
        # for policy publishing, etc.). For Phase 0/1 we record the
        # intent and return a dry-run-equivalent.
        return KaryaOutput(
            action_id=input.action_id,
            status="skipped",
            notes=(
                "Phase 0/1 stub: token validated; execution deferred until "
                "Phase 3 connector framework is online. The intent is "
                "recorded in the audit ledger."
            ),
        )
