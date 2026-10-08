"""Credentialless Vibhaag role for protected, reviewed workflow source transport."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, ClassVar

import structlog

from ..ledger_client import LedgerClient
from .base import AgentName, AutonomyLevel, BaseAgent
from .reviewed_workflows import (
    ReviewedWorkflowInput,
    ReviewedWorkflowOutput,
    build_reviewed_workflow_drafts,
)

if TYPE_CHECKING:
    from ..config import Settings
    from ..evidence_client import EvidenceVault
    from ..model_gateway import ModelGateway


class VibhaagReviewDraftAgent(BaseAgent[ReviewedWorkflowInput, ReviewedWorkflowOutput]):
    name: ClassVar[AgentName] = AgentName.VIBHAAG
    description: ClassVar[str] = (
        "Propose unpublished drafts from recorded declarations and reported task time."
    )
    one_liner: ClassVar[str] = "I prepare drafts. You review and adopt."
    tool_scopes: ClassVar[tuple[str, ...]] = ()
    autonomy: ClassVar[AutonomyLevel] = AutonomyLevel.L1
    can_mutate: ClassVar[bool] = False
    writes_axiom_state: ClassVar[bool] = False

    def __init__(
        self,
        *,
        settings: Settings | None = None,
        ledger: LedgerClient | None = None,
        evidence: EvidenceVault | None = None,
        model_gateway: ModelGateway | None = None,
    ) -> None:
        # Compatibility with runtime dependency construction does not retain
        # any vault, gateway, settings or read/domain-writing credential.
        self.ledger = (ledger or LedgerClient.from_settings(settings)).append_only_view()
        self.log = structlog.get_logger(agent=self.name.value, version=self.version)

    def input_schema(self) -> type[ReviewedWorkflowInput]:
        return ReviewedWorkflowInput

    def output_schema(self) -> type[ReviewedWorkflowOutput]:
        return ReviewedWorkflowOutput

    async def _run(
        self, *, correlation_id: str, input: ReviewedWorkflowInput, **deps: Any
    ) -> ReviewedWorkflowOutput:
        return build_reviewed_workflow_drafts(input)
