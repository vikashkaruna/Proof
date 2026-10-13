"""Sanket — the Public Market Observation Agent.

"I surface public observations for your review."

Reviews authenticated, captured public sources for bounded heading markers.
Those observations do not establish purchase intent or authorize outreach.
Current runtime invocation requires trusted source transport to be composed.
"""

from __future__ import annotations

import re
from typing import Any, ClassVar
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field

from ..public_signal_sources import VerifiedPublicSourceBatch, capture_time, require_public_sources
from .base import AgentName, AutonomyLevel, BaseAgent


class BuyingSignal(BaseModel):
    source: str
    company: str
    signal: str  # e.g. "DPO role posted", "Privacy RFP issued"
    detected_at: str
    score: int  # 0-100
    context: str = ""
    url: str | None = None


class SanketInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    correlation_id: str | None = None  # Accepted legacy BFF wire field; transport binds authority.
    engagement_id: str | None = None
    tenant_id: str
    sectors: list[str] = Field(default_factory=lambda: ["BFSI", "Healthcare", "SaaS / Tech"])
    geo: str = Field(default="India", max_length=100)
    since: str | None = Field(default=None, max_length=64)  # ISO datetime; default last 14 days


class PublicMarketObservation(BaseModel):
    requested_url: str
    final_url: str
    checked_at: str
    content_sha256: str
    projection_sha256: str
    capture_reference: str
    observed_notice_kinds: list[str]
    requires_human_review: bool = True


class SanketOutput(BaseModel):
    signals: list[BuyingSignal]
    high_intent: list[BuyingSignal]
    source_observations: list[PublicMarketObservation] = Field(default_factory=list)
    processing_mode: str = "verified_public_capture_review"
    notes: str = ""


class SanketAgent(BaseAgent[SanketInput, SanketOutput]):
    name: ClassVar[AgentName] = AgentName.SANKET
    description: ClassVar[str] = "Review source-bound public market observations with human oversight."
    one_liner: ClassVar[str] = "I surface public observations for your review."
    tool_scopes: ClassVar[tuple[str, ...]] = ("http.read.public_sources",)
    autonomy: ClassVar[AutonomyLevel] = AutonomyLevel.L1
    default_task_kind: ClassVar[Any] = "structural"
    default_pii_redact: ClassVar[bool] = False

    def input_schema(self) -> type[SanketInput]:
        return SanketInput

    def output_schema(self) -> type[SanketOutput]:
        return SanketOutput

    def __init__(
        self, *, public_source_batch: VerifiedPublicSourceBatch | None = None, **kwargs: Any
    ):
        super().__init__(**kwargs)
        self._public_source_batch = public_source_batch

    async def _run(self, *, correlation_id: str, input: SanketInput, **deps: Any) -> SanketOutput:
        batch = require_public_sources(
            deps.get("public_source_batch", self._public_source_batch),
            agent="sanket",
            tenant_id=input.tenant_id,
            correlation_id=correlation_id,
        )
        since = capture_time(input.since) if input.since else None
        documents = [
            document
            for document in batch.documents
            if since is None or capture_time(document.checked_at) >= since
        ]
        if not documents:
            raise ValueError("no_current_guarded_public_capture")
        # Explicit title/heading markers are observations, never intent scores.
        markers = (
            ("public_rfp_heading", re.compile(r"\b(?:request for proposals?|rfp)\b", re.I)),
            ("public_dpo_heading", re.compile(r"\b(?:data protection officer|dpo)\b", re.I)),
            ("public_hiring_heading", re.compile(r"\b(?:hiring|job openings?|vacancies)\b", re.I)),
        )
        observations, signals = [], []
        for document in documents:
            sections = (document.title, *document.headings)
            kinds = [
                kind
                for kind, pattern in markers
                if any(pattern.search(section) for section in sections)
            ]
            observations.append(
                PublicMarketObservation(
                    requested_url=document.requested_url,
                    final_url=document.final_url,
                    checked_at=document.checked_at,
                    content_sha256=document.content_sha256,
                    projection_sha256=document.projection_sha256,
                    capture_reference=document.capture_reference,
                    observed_notice_kinds=kinds,
                )
            )
            for kind in kinds:
                signals.append(
                    BuyingSignal(
                        source=document.capture_reference,
                        company=urlsplit(document.final_url).hostname or "",
                        signal=kind,
                        detected_at=document.checked_at,
                        score=0,
                        url=document.final_url,
                        context="Marker observed in a bounded public title/heading. The host is a source identifier, not a verified legal company identity. Hiring, procurement, applicability, recency and buying intent are unverified; human review is required.",
                    )
                )
        return SanketOutput(
            signals=signals,
            high_intent=[],
            source_observations=observations,
            notes="Processed only supplied approved public captures and explicit title/heading markers. Zero score and empty high-intent list preserve unknown buying intent. Capture time is not notice publication time. Sector/geography preferences do not establish source-company classification. No contact records, outreach, login or message delivery is performed.",
        )
