"""Reviewable policy and notice drafts derived from RoPA records."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from .ropa_generator import RopaRecord


class PolicyDraft(BaseModel):
    kind: Literal["privacy_notice", "consent_notice", "retention_policy", "dpa_template"]
    title: str
    sections: list[dict[str, str]] = Field(default_factory=list)
    source_activity_ids: list[str] = Field(default_factory=list)
    review_required: bool = True
    legal_review_required: bool = True


def _recorded_list(values: list[str] | None) -> str:
    if values is None:
        return "To be confirmed"
    return ", ".join(values) if values else "Human recorded none (review required)"


def _activity_sections(records: list[RopaRecord]) -> list[dict[str, str]]:
    """Carry unresolved facts through every draft instead of hiding them."""
    return [
        {
            "heading": record.system,
            "body": (
                f"Activity: {record.activity_id}. Purpose: {record.purpose}. "
                f"Lawful basis: {record.lawful_basis}. Retention: {record.retention_period}. "
                f"Stated processors: {_recorded_list(record.processors)}. "
                f"Stated region: {record.region}. "
                f"Cross-border processing: {record.cross_border if record.cross_border is not None else 'Unknown'}. "
                f"Transfer review: {record.transfer_safeguards or 'To be confirmed'}. "
                f"Evidence references: {', '.join(record.evidence_refs) or 'None supplied'}. "
                "The source activity requires human and legal review."
            ),
        }
        for record in records
    ] or [
        {
            "heading": "Processing inventory",
            "body": "No processing activities recorded; inventory and legal review required before use.",
        }
    ]


def _review_section() -> dict[str, str]:
    return {
        "heading": "Review before use",
        "body": "Unpublished draft. Confirm the processing inventory, purposes, lawful basis, retention, residency and transfers with the Data Fiduciary and legal reviewer before publication or execution.",
    }


def build_privacy_notice(organisation_name: str, records: list[RopaRecord]) -> PolicyDraft:
    activities = (
        "; ".join(record.system for record in records) or "No processing activities recorded"
    )
    categories = sorted(
        {category for record in records for category in record.data_categories or []}
    )
    return PolicyDraft(
        kind="privacy_notice",
        title=f"Draft Privacy Notice — {organisation_name}",
        sections=[
            {"heading": "Processing activities", "body": activities},
            {
                "heading": "Data categories",
                "body": (
                    (", ".join(categories) or "Human recorded none (review required)")
                    if records and all(record.data_categories is not None for record in records)
                    else (
                        ", ".join(categories) + "; some activities require category confirmation"
                        if categories
                        else "To be confirmed"
                    )
                ),
            },
            {
                "heading": "Rights and contact details",
                "body": "To be completed by the Data Fiduciary before publication.",
            },
            *_activity_sections(records),
            _review_section(),
        ],
        source_activity_ids=[record.activity_id for record in records],
    )


def build_retention_policy(organisation_name: str, records: list[RopaRecord]) -> PolicyDraft:
    return PolicyDraft(
        kind="retention_policy",
        title=f"Draft Retention Policy — {organisation_name}",
        sections=[
            *_activity_sections(records),
            {
                "heading": "Deletion and exceptions",
                "body": "Confirm retention triggers, deletion methods, legal holds, exceptions, owner and review schedule. No deletion is authorized by this draft.",
            },
            _review_section(),
        ],
        source_activity_ids=[record.activity_id for record in records],
    )


def build_consent_notice(organisation_name: str, records: list[RopaRecord]) -> PolicyDraft:
    """Prepare completion prompts; discovery does not prove valid consent."""
    return PolicyDraft(
        kind="consent_notice",
        title=f"Draft Consent Notice — {organisation_name}",
        sections=[
            *_activity_sections(records),
            {
                "heading": "Consent collection and withdrawal",
                "body": "Confirm each specific purpose, data items, applicable lawful basis, clear affirmative action, notice language, consent records, withdrawal route and contact details. A draft is not proof that consent was obtained.",
            },
            _review_section(),
        ],
        source_activity_ids=[record.activity_id for record in records],
    )


def build_dpa_template(organisation_name: str, records: list[RopaRecord]) -> PolicyDraft:
    """Prepare a reviewable template; no contract or processor facts invented."""
    return PolicyDraft(
        kind="dpa_template",
        title=f"Draft Data Processing Agreement — {organisation_name}",
        sections=[
            *_activity_sections(records),
            {
                "heading": "Parties and processing instructions",
                "body": "Identify and verify the parties, roles, subject matter, duration, purpose, data types, instructions and subprocessors. An observed system name is not proof of a processor agreement.",
            },
            {
                "heading": "Contract review",
                "body": "Confirm confidentiality, security measures, incident notification, rights assistance, audit terms, transfers, return or deletion and signatures with legal counsel. This unsigned template creates no agreement or authorization.",
            },
            _review_section(),
        ],
        source_activity_ids=[record.activity_id for record in records],
    )
