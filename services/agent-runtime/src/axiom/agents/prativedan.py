"""Prativedan — the Reporting Agent.

"I turn findings into documents."

Prativedan produces deterministic draft sections and escaped HTML from supplied
findings. It performs no model inference. Evidence references remain unverified,
and each draft requires recorded human review before client release.
"""

from __future__ import annotations

from typing import Any, ClassVar

from ..prativedan_contracts import PrativedanInput as PrativedanInput
from ..prativedan_contracts import PrativedanOutput as PrativedanOutput
from ..prativedan_contracts import ReportKind as ReportKind
from ..prativedan_pure_renderer import evidence_ids, render_html, render_prativedan
from ..prativedan_renderer_config import renderer_commitment
from .base import AgentName, AutonomyLevel, BaseAgent


class PrativedanAgent(BaseAgent[PrativedanInput, PrativedanOutput]):
    name: ClassVar[AgentName] = AgentName.PRATIVEDAN
    writes_axiom_state: ClassVar[bool] = True
    description: ClassVar[str] = "Generate a structured compliance report from findings."
    one_liner: ClassVar[str] = "I turn findings into documents."
    tool_scopes: ClassVar[tuple[str, ...]] = (
        "findings.read",
        "evidence.read",
        "control_library.read",
        "report.write",
        "pdf.render",
    )
    autonomy: ClassVar[AutonomyLevel] = AutonomyLevel.L1
    default_task_kind: ClassVar[Any] = "report"
    default_pii_redact: ClassVar[bool] = True

    def renderer_configuration(self) -> tuple[str, str, str]:
        return renderer_commitment()

    def input_schema(self) -> type[PrativedanInput]:
        return PrativedanInput

    def output_schema(self) -> type[PrativedanOutput]:
        return PrativedanOutput

    async def _run(
        self, *, correlation_id: str, input: PrativedanInput, **deps: Any
    ) -> PrativedanOutput:
        return render_prativedan(input, version=self.version)

    _evidence_ids = staticmethod(evidence_ids)

    def _render_html(
        self, title: str, sections: list[dict[str, Any]], posture: float | None, verdict: str
    ) -> str:
        return render_html(title, sections, posture, verdict)
