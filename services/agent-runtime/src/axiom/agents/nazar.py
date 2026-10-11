"""Nazar — the Regulatory Watch Agent.

"I watch the law so you don't have to."

Nazar monitors MeitY notifications, the Data Protection Board's
orders, and the gazette. When a regulatory change is detected, Nazar
maps it to affected controls in the library and raises a
re-assessment prompt.

A trusted service must provide actual guarded government-source captures.
Nazar proposes content-change review; it never infers legal changes or writes
controls. First captures are baselines, not evidence of no regulatory change.
"""

from __future__ import annotations

from typing import Any, ClassVar
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field

from ..public_signal_sources import VerifiedPublicSourceBatch, capture_time, require_public_sources
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
    model_config = ConfigDict(extra="forbid")
    correlation_id: str | None = None  # Accepted legacy BFF wire field; transport binds authority.
    engagement_id: str | None = None
    tenant_id: str | None = None  # optional; Nazar is mostly tenant-agnostic
    sources: list[str] = Field(
        default_factory=lambda: [
            "meity.gov.in",
            "dpb.gov.in",
            "egazette.gov.in",
        ]
    )
    since: str | None = Field(default=None, max_length=64)  # ISO datetime; defaults to last 7 days


class RegulatorySourceObservation(BaseModel):
    requested_url: str
    final_url: str
    checked_at: str
    content_sha256: str
    projection_sha256: str
    capture_reference: str
    baseline_status: str
    previous_content_sha256: str | None = None
    requires_human_review: bool = True


class NazarOutput(BaseModel):
    sources_checked: list[str]
    changes: list[RegulatoryChange]
    source_observations: list[RegulatorySourceObservation] = Field(default_factory=list)
    sources_unchecked: list[str] = Field(default_factory=list)
    processing_mode: str = "verified_public_capture_review"
    escalate: bool = False
    notes: str = ""


class NazarAgent(BaseAgent[NazarInput, NazarOutput]):
    name: ClassVar[AgentName] = AgentName.NAZAR
    writes_axiom_state: ClassVar[bool] = True
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

    def __init__(
        self, *, public_source_batch: VerifiedPublicSourceBatch | None = None, **kwargs: Any
    ):
        super().__init__(**kwargs)
        self._public_source_batch = public_source_batch

    async def _run(self, *, correlation_id: str, input: NazarInput, **deps: Any) -> NazarOutput:
        batch = require_public_sources(
            deps.get("public_source_batch", self._public_source_batch),
            agent="nazar",
            tenant_id=input.tenant_id,
            correlation_id=correlation_id,
        )
        requested_hosts = {host.removeprefix("www.") for host in input.sources}
        if not requested_hosts or not requested_hosts <= {
            "meity.gov.in",
            "dpb.gov.in",
            "egazette.gov.in",
        }:
            raise ValueError("requested_government_source_not_composed")
        since = capture_time(input.since) if input.since else None
        documents = [
            document
            for document in batch.documents
            if (urlsplit(document.requested_url).hostname or "").removeprefix("www.")
            in requested_hosts
            and (since is None or capture_time(document.checked_at) >= since)
        ]
        if not documents:
            raise ValueError("no_current_guarded_government_capture")
        previous = {document.requested_url: document for document in batch.previous_documents}
        observations, changes = [], []
        for document in documents:
            before = previous.get(document.requested_url)
            status = (
                "first_capture_baseline"
                if before is None
                else (
                    "content_unchanged"
                    if before.content_sha256 == document.content_sha256
                    else "content_changed"
                )
            )
            observations.append(
                RegulatorySourceObservation(
                    requested_url=document.requested_url,
                    final_url=document.final_url,
                    checked_at=document.checked_at,
                    content_sha256=document.content_sha256,
                    projection_sha256=document.projection_sha256,
                    capture_reference=document.capture_reference,
                    baseline_status=status,
                    previous_content_sha256=before.content_sha256 if before else None,
                )
            )
            if status == "content_changed":
                changes.append(
                    RegulatoryChange(
                        source=urlsplit(document.final_url).hostname or "",
                        reference=document.capture_reference,
                        title="Public government source content changed",
                        summary="The retained content digest differs from the earlier capture. Review the exact source versions; this is not a verified legal change or an interpretation of obligations.",
                        detected_at=document.checked_at,
                        affected_control_ids=[],
                        severity="info",
                        url=document.final_url,
                    )
                )
        return NazarOutput(
            sources_checked=list(
                dict.fromkeys(urlsplit(document.final_url).hostname or "" for document in documents)
            ),
            changes=changes,
            sources_unchecked=sorted(
                requested_hosts
                - {
                    (urlsplit(document.requested_url).hostname or "").removeprefix("www.")
                    for document in documents
                }
            ),
            source_observations=observations,
            escalate=bool(changes),
            notes="Processed only the supplied guarded government captures. First capture establishes a baseline; unchanged HTML does not prove absence of legal change. Capture time is not publication/effective date. A human must verify applicability before any control or reassessment change.",
        )
