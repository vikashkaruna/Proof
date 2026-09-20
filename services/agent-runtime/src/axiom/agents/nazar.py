"""Nazar — the Regulatory Watch Agent.

"I watch the law so you don't have to."

Nazar monitors MeitY notifications, the Data Protection Board's
orders, and the gazette. When a regulatory change is detected, Nazar
maps it to affected controls in the library and raises a
re-assessment prompt.

In Phase 2, Nazar reads the gazette and MeitY feeds. In Phase 0/1,
Nazar is a stub that produces a baseline 'no new changes' report.
"""

from __future__ import annotations

from typing import Any, ClassVar

from pydantic import BaseModel, Field

from .base import AgentName, AutonomyLevel, BaseAgent


class RegulatoryChange(BaseModel):
    source: str
    reference: str
    title: str
    summary: str
    detected_at: str
    affected_control_ids: list[str] = Field(default_factory=list)
    severity: str = "info"  # 'info' | 'low' | 'medium' | 'high' | 'critical'
    url: str | None = None


class NazarInput(BaseModel):
    tenant_id: str | None = None  # optional; Nazar is mostly tenant-agnostic
    sources: list[str] = Field(
        default_factory=lambda: [
            "meity.gov.in",
            "dpb.gov.in",
            "egazette.gov.in",
        ]
    )
    since: str | None = None  # ISO datetime; defaults to last 7 days


class NazarOutput(BaseModel):
    sources_checked: list[str]
    changes: list[RegulatoryChange]
    escalate: bool = False
    notes: str = ""


class NazarAgent(BaseAgent[NazarInput, NazarOutput]):
    name: ClassVar[AgentName] = AgentName.NAZAR
    description: ClassVar[str] = "Monitor MeitY/DPB/gazette for regulatory changes."
    one_liner: ClassVar[str] = "I watch the law so you don't have to."
    # SEC-15: was ("http.read.government_sources", "control_library.write").
    # The control library is the definition of what compliance MEANS, and Nazar
    # is an L1 agent that ingests untrusted government web pages. Write access
    # there turns a misread gazette page into a silent change to every client's
    # posture. Nazar PROPOSES a baseline delta; a human accepts it.
    tool_scopes: ClassVar[tuple[str, ...]] = (
        "http.read.government_sources",
        "regulatory_signal.write",
    )
    autonomy: ClassVar[AutonomyLevel] = AutonomyLevel.L1
    default_task_kind: ClassVar[Any] = "structural"
    default_pii_redact: ClassVar[bool] = False

    def input_schema(self) -> type[NazarInput]:
        return NazarInput

    def output_schema(self) -> type[NazarOutput]:
        return NazarOutput

    async def _run(
        self, *, correlation_id: str, input: NazarInput, **deps: Any
    ) -> NazarOutput:
        # Phase 0/1: stub that returns an empty change list.
        # Phase 2+: a real implementation polls the sources, diffs
        # against a cached prior state, and emits detected changes.
        # The shape of the change is preserved so downstream code can
        # rely on the schema.
        return NazarOutput(
            sources_checked=input.sources,
            changes=[],
            notes=(
                "Nazar is in stub mode (Phase 0/1). Real regulatory feed "
                "polling is scheduled for Phase 2."
            ),
        )
