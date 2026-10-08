"""Saakshi staging role: no retained bytes, vault, read or domain write credentials."""

from __future__ import annotations

from typing import Any, ClassVar

import structlog

from ..ledger_client import LedgerClient
from ..saakshi_staging import (
    EvidenceStageInput,
    EvidenceStagePort,
    StagedEvidenceOutput,
    stage_owned_evidence,
)
from .base import AgentName, AutonomyLevel, BaseAgent


class SaakshiStageAgent(BaseAgent[EvidenceStageInput, StagedEvidenceOutput]):
    name: ClassVar[AgentName] = AgentName.SAAKSHI
    description: ClassVar[str] = (
        "Stage explicitly approved retained human evidence for verification."
    )
    one_liner: ClassVar[str] = "I stage your approved evidence. Acceptance requires verification."
    tool_scopes: ClassVar[tuple[str, ...]] = ()
    autonomy: ClassVar[AutonomyLevel] = AutonomyLevel.L2
    can_mutate: ClassVar[bool] = True
    writes_axiom_state: ClassVar[bool] = False

    def __init__(self, *, ledger: LedgerClient, port: EvidenceStagePort) -> None:
        self.ledger = ledger.append_only_view()
        self.port = port
        self.log = structlog.get_logger(agent=self.name.value, version=self.version)

    def input_schema(self) -> type[EvidenceStageInput]:
        return EvidenceStageInput

    def output_schema(self) -> type[StagedEvidenceOutput]:
        return StagedEvidenceOutput

    async def _run(
        self, *, correlation_id: str, input: EvidenceStageInput, **deps: Any
    ) -> StagedEvidenceOutput:
        return await stage_owned_evidence(input, correlation_id, self.port)
