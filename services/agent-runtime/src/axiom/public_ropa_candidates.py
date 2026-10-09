"""Unpublished RoPA review candidates from bounded public form observations.

This pure builder checks transport consistency, not database ownership or genuine
agent receipts. A server integration must supply the binding from its retained
source and verify the ordered Drishti/Vibhaag receipts before persisting or
adopting anything. Candidates are neither saved RoPA facts nor legal decisions.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict

from .agents.public_source import (
    Digest,
    Ordinal,
    PageKind,
    PublicCollectionIndicator,
    PublicControl,
    PublicSourceBinding,
    TrueOnly,
    VibhaagPublicInput,
    VibhaagPublicOutput,
)


class CandidateContract(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)


class PublicRopaCandidate(CandidateContract):
    page: PageKind
    content_sha256: Digest
    form_ordinal: Ordinal
    form_method: Literal["get", "post", "dialog"]
    observed_controls: list[PublicControl]
    observed_control_count: int
    excluded_control_count: int
    controls_truncated: bool
    forms_truncated: bool
    suggestion: Literal["Review potential contact collection"] = (
        "Review potential contact collection"
    )
    status: Literal["unpublished_review_candidate"] = "unpublished_review_candidate"
    # Public form attributes cannot establish any of these private facts.
    personal_data_processing: None = None
    purpose: None = None
    data_categories: None = None
    data_principals: None = None
    processors: None = None
    recipients: None = None
    lawful_basis: None = None
    retention_period: None = None
    hosting_region: None = None
    cross_border: None = None
    destination_countries: None = None
    transfer_safeguards: None = None
    requires_human_review: TrueOnly = True


class PublicRopaCandidates(CandidateContract):
    source_binding: PublicSourceBinding
    candidates: list[PublicRopaCandidate]
    unexamined_pages: list[PageKind]
    unavailable_pages: list[PageKind]
    empty_result_means: Literal["No supported candidate in the bounded observation"] = (
        "No supported candidate in the bounded observation"
    )
    limitations: Literal[
        "Static public HTML only; no submission, backend access, private processing verification "
        "or legal approval. Missing candidates do not establish absence of processing."
    ] = (
        "Static public HTML only; no submission, backend access, private processing verification "
        "or legal approval. Missing candidates do not establish absence of processing."
    )


def build_public_ropa_candidates(
    source: VibhaagPublicInput,
    classification: VibhaagPublicOutput,
    *,
    expected_binding: PublicSourceBinding,
) -> PublicRopaCandidates:
    """Require exact source-derived classification; preserve unknown facts as JSON null."""
    if (
        source.source_binding != expected_binding
        or classification.source_binding != expected_binding
    ):
        raise ValueError("Public RoPA source binding mismatch")
    expected_indicators = [
        PublicCollectionIndicator(
            page=page.page,
            content_sha256=page.content_sha256,
            form_ordinal=form.ordinal,
            control_ordinal=control.ordinal,
            input_type=control.inputType,
            indicator="potential_contact_collection",
            requires_human_review=True,
        )
        for page in source.observation.pages
        if page.status == "checked" and page.form_metadata is not None
        for form in page.form_metadata.forms
        for control in form.controls
        if control.element == "input" and control.inputType in ("email", "tel")
    ]
    unexamined = [page.page for page in source.observation.pages if page.form_state == "unexamined"]
    unavailable = [
        page.page for page in source.observation.pages if page.form_state == "unavailable"
    ]
    if (
        classification.indicators != expected_indicators
        or classification.unexamined_pages != unexamined
        or classification.unavailable_pages != unavailable
    ):
        raise ValueError("Public RoPA classification does not match the bounded observation")
    candidates = [
        PublicRopaCandidate(
            page=page.page,
            content_sha256=page.content_sha256,
            form_ordinal=form.ordinal,
            form_method=form.method,
            observed_controls=[
                control
                for control in form.controls
                if control.element == "input" and control.inputType in ("email", "tel")
            ],
            observed_control_count=form.observedControlCount,
            excluded_control_count=form.excludedControlCount,
            controls_truncated=form.controlsTruncated,
            forms_truncated=page.form_metadata.formsTruncated,
        )
        for page in source.observation.pages
        if page.status == "checked" and page.form_metadata is not None
        for form in page.form_metadata.forms
        if any(
            control.element == "input" and control.inputType in ("email", "tel")
            for control in form.controls
        )
    ]
    return PublicRopaCandidates(
        source_binding=expected_binding,
        candidates=candidates,
        unexamined_pages=unexamined,
        unavailable_pages=unavailable,
    )
