"""Pure renderer input/output contracts; no agent credentials or controller ports."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, model_validator

from .enum_types import QualifiedStringEnum


class ReportKind(QualifiedStringEnum):
    BOARD = "board"
    AUDITOR = "auditor"
    DPB = "dpb"
    TECHNICAL = "technical"
    GAP_SCAN = "gap_scan"
    EVIDENCE_PACK = "evidence_pack"
    CUSTOM = "custom"


class PrativedanInput(BaseModel):
    tenant_id: str
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
