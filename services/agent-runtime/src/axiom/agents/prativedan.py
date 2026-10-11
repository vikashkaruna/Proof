"""Prativedan — the Reporting Agent.

"I turn findings into documents."

Prativedan generates Board reports, auditor packs, and DPB-ready
submissions. Every claim in a report is traceable to a specific
evidence artifact. The founder reviews and signs off before any
report reaches a client.

In Phase 0, Prativedan produces structured JSON + an HTML/PDF
rendering. The agent references the control library + findings
data and uses the model gateway to draft the prose.
"""

from __future__ import annotations

from html import escape
from typing import Annotated, Any, ClassVar, Literal
from uuid import UUID

from pydantic import BaseModel, Field, model_validator

from ..enum_types import QualifiedStringEnum
from .base import AgentName, AutonomyLevel, BaseAgent


class ReportKind(QualifiedStringEnum):
    BOARD = "board"
    AUDITOR = "auditor"
    DPB = "dpb"
    TECHNICAL = "technical"
    GAP_SCAN = "gap_scan"
    EVIDENCE_PACK = "evidence_pack"
    CUSTOM = "custom"


class PrativedanInput(BaseModel):
    tenant_id: str = "00000000-0000-0000-0000-000000000001"
    engagement_id: str | None = None
    kind: ReportKind = ReportKind.BOARD
    title: str = "Executive Board Compliance Report"
    findings: list[dict[str, Any]] = Field(default_factory=list)
    posture_score: float | None = Field(
        default=None, ge=0, le=100, allow_inf_nan=False, strict=True
    )
    estimated_exposure_inr: int | None = Field(default=None, ge=0, le=9007199254740991, strict=True)
    library_version: str = "0.1.0"
    # Draft input only. A future dedicated composer must verify these against
    # the exact frozen library; their presence is not source authority.
    library_control_ids: (
        list[Annotated[str, Field(strict=True, min_length=1, max_length=100)]] | None
    ) = Field(default=None, min_length=1, max_length=500)
    reviewer_id: str | None = None

    @model_validator(mode="after")
    def validate_declared_control_set(self) -> PrativedanInput:
        if self.library_control_ids is not None:
            identifiers = self.library_control_ids
            if any(value != value.strip() for value in identifiers) or len(set(identifiers)) != len(
                identifiers
            ):
                raise ValueError("Declared control identifiers must be meaningful and unique")
            if any(finding.get("control_id") not in identifiers for finding in self.findings):
                raise ValueError("Finding differs from the declared control set")
        return self


class PrativedanOutput(BaseModel):
    title: str
    kind: str
    sections: list[dict[str, Any]]
    cited_evidence_ids: list[str] = Field(default_factory=list)
    generated_by_agent: str = "prativedan"
    rendered_html: str = ""
    review_required: Literal[True] = True
    citation_verification: Literal["unverified_references"] = "unverified_references"


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

    def input_schema(self) -> type[PrativedanInput]:
        return PrativedanInput

    def output_schema(self) -> type[PrativedanOutput]:
        return PrativedanOutput

    async def _run(
        self, *, correlation_id: str, input: PrativedanInput, **deps: Any
    ) -> PrativedanOutput:
        # Section: executive summary
        posture = input.posture_score
        verdict = (
            "Unknown"
            if posture is None
            else "Strong"
            if posture >= 85
            else "Acceptable"
            if posture >= 65
            else "At Risk"
            if posture >= 40
            else "Critical"
        )
        posture_text = (
            "Posture score: Unknown (not supplied)."
            if posture is None
            else f"Declared posture score: {posture:.0f}/100 ({verdict}; provisional)."
        )
        exposure_text = (
            "Estimated statutory exposure: Unknown (not supplied)."
            if input.estimated_exposure_inr is None
            else f"Estimated statutory exposure (provisional): ₹{input.estimated_exposure_inr / 1e7:.2f} Cr."
        )
        executive_summary = {
            "type": "executive_summary",
            "title": "Executive summary",
            "body": (
                f"{posture_text} {exposure_text} "
                f"{len(input.findings)} findings included for review. "
                f"Library version: {input.library_version}."
            ),
        }

        # Section: top findings (top 10 by risk_points)
        top = sorted(input.findings, key=lambda f: f.get("risk_points", 0), reverse=True)[:10]
        top_section = {
            "type": "findings_table",
            "title": "Top findings (by risk-weighted exposure)",
            "items": [
                {
                    "control_id": f.get("control_id"),
                    "title": f.get("title"),
                    "severity": f.get("severity"),
                    "score": f.get("score"),
                    "risk_points": f.get("risk_points"),
                    "rationale": f.get("rationale"),
                }
                for f in top
            ],
        }

        # Section: control library reference
        library_section = {
            "type": "library",
            "title": "Control library",
            "body": (
                f"Referenced library version: {input.library_version}. "
                + (
                    "Control count unavailable; frozen library source not provided."
                    if input.library_control_ids is None
                    else f"Draft input declares {len(input.library_control_ids)} controls; frozen source verification remains required."
                )
            ),
        }

        # Section: agent attribution + human reviewer
        attribution = {
            "type": "attribution",
            "title": "Draft attribution and review status",
            "body": (
                f"Generated by Prativedan (v{self.version}). "
                + "Pending recorded human review. Evidence references are unverified."
            ),
        }

        sections: list[dict[str, Any]] = [
            executive_summary,
            top_section,
            library_section,
            attribution,
        ]

        # Render HTML
        rendered = self._render_html(input.title, sections, posture, verdict)

        return PrativedanOutput(
            title=input.title,
            kind=input.kind.value if isinstance(input.kind, ReportKind) else str(input.kind),
            sections=sections,
            cited_evidence_ids=self._evidence_ids(input.findings),
            rendered_html=rendered,
        )

    @staticmethod
    def _evidence_ids(findings: list[dict[str, Any]]) -> list[str]:
        """Extract canonical UUID references, not verified artifact claims.

        Dedicated source composition must separately validate existence, content
        and retention. Neither a valid UUID nor a caller flag proves evidence.
        """
        ids: list[str] = []

        def add(value: object) -> None:
            if not isinstance(value, str):
                return
            try:
                identifier = UUID(value)
            except ValueError:
                return
            if identifier.int != 0 and str(identifier) == value:
                ids.append(value)

        for finding in findings:
            explicit = finding.get("evidence_ids", [])
            for item in explicit if isinstance(explicit, list) else []:
                add(item)
            required = finding.get("evidence_required", [])
            for item in required if isinstance(required, list) else []:
                if isinstance(item, dict):
                    value = item.get("evidence_id")
                    add(value)
        return list(dict.fromkeys(ids))

    def _render_html(
        self, title: str, sections: list[dict[str, Any]], posture: float | None, verdict: str
    ) -> str:
        def safe(value: object) -> str:
            return escape(str(value if value is not None else ""), quote=True)

        out = [f"<h1>{safe(title)}</h1>"]
        posture_label = (
            "Unknown (not supplied)"
            if posture is None
            else f"{posture:.0f}/100 ({verdict}; provisional)"
        )
        out.append(
            f'<div class="axiom-cover"><p>Posture: <strong>{safe(posture_label)}</strong></p></div>'
        )
        for s in sections:
            out.append(f"<h2>{safe(s.get('title', ''))}</h2>")
            if s.get("body"):
                out.append(f"<p>{safe(s['body'])}</p>")
            if s.get("type") == "findings_table" and s.get("items"):
                rows = "".join(
                    f"<tr><td>{safe(i.get('control_id'))}</td><td>{safe(i.get('title'))}</td>"
                    f"<td>{safe(i.get('severity'))}</td><td>{safe(i.get('score'))}</td>"
                    f"<td>{safe(i.get('risk_points'))}</td></tr>"
                    for i in s["items"]
                )
                out.append(
                    "<table><thead><tr><th>Control</th><th>Title</th><th>Severity</th>"
                    "<th>Score</th><th>Risk pts</th></tr></thead>"
                    f"<tbody>{rows}</tbody></table>"
                )
        return "\n".join(out)
