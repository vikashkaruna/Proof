"""Unpublished drafts from exact human-recorded processing and reported task declarations.

These models validate transport consistency, never source authority. Only the
protected retained-source workflow may invoke this mode. Public HTML provenance
is not evidence that a declaration is true. Agents receive no domain credentials.
"""

# ruff: noqa: N815 -- Preserve exact human workflow payload wire names.

from __future__ import annotations

import hashlib
from datetime import datetime
from typing import Annotated, Any, Literal, Self

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    SerializerFunctionWrapHandler,
    model_serializer,
    model_validator,
)

from ..canonicalise import canonical_json
from ..playbook import PlaybookEntry, rank_playbook_backlog
from .public_source import Digest, Identifier, TrueOnly, Version


def _text(value: str) -> str:
    if value != value.strip() or not value or "\x00" in value:
        raise ValueError("Expected exact meaningful recorded text")
    if any(0xD800 <= ord(character) <= 0xDFFF for character in value):
        raise ValueError("Invalid recorded Unicode")
    return value


def _false(value: bool) -> bool:
    if value is not False:
        raise ValueError("Execution and publication are prohibited")
    return value


FalseOnly = Annotated[Literal[False], BeforeValidator(_false)]
Text = Annotated[str, AfterValidator(_text)]
Name = Annotated[Text, Field(max_length=200)]
Note = Annotated[Text, Field(max_length=2000)]
RecordedList = Annotated[list[Name], Field(max_length=50)] | None


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)


class PublicProvenance(Contract):
    observationId: Identifier
    outputSha256: Digest


class ProcessingDeclarations(Contract):
    engagementId: Identifier | None
    sourceNote: Note
    source: PublicProvenance | None = None
    system: Name
    purpose: Note | None
    legalBasis: Name | None
    retentionMonths: int | None = Field(ge=1, le=1200)
    dataCategories: RecordedList
    dataPrincipals: RecordedList
    processors: RecordedList
    recipients: RecordedList
    destinationCountries: RecordedList
    transferSafeguards: Note | None
    dpiaRequired: bool | None
    region: Annotated[Text, Field(max_length=100)] | None
    crossBorder: bool | None
    securityMeasures: Note | None

    @model_validator(mode="before")
    @classmethod
    def absent_public_provenance(cls, value: object) -> object:
        if isinstance(value, dict) and "source" in value and value["source"] is None:
            raise ValueError("Optional public provenance must be absent or exact")
        return value

    @model_serializer(mode="wrap")
    def exact_optional_source(self, handler: SerializerFunctionWrapHandler) -> dict[str, Any]:
        value: dict[str, Any] = handler(self)
        if self.source is None:
            del value["source"]
        return value


class ReportedTask(Contract):
    engagementId: Identifier | None
    taskName: Name
    source: Name
    durationMinutes: int = Field(ge=0, le=1_000_000)
    repetitions: int = Field(ge=1, le=1_000_000)
    notes: str = Field(max_length=2000)

    @model_validator(mode="after")
    def exact_notes(self) -> Self:
        if self.notes and _text(self.notes) != self.notes:
            raise ValueError("Invalid recorded notes")
        return self


class HumanRecord(Contract):
    id: Identifier
    tenant_id: Identifier
    operation_key: Identifier
    created_by: Identifier
    created_at: str = Field(
        max_length=40,
        pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$",
    )
    content_sha256: None
    receipt_id: str = Field(pattern=r"^[1-9][0-9]{0,18}$")

    @model_validator(mode="after")
    def exact_metadata(self) -> Self:
        date = datetime.fromisoformat(self.created_at.replace("Z", "+00:00"))
        if date.tzinfo is None or int(self.receipt_id) > 9223372036854775807:
            raise ValueError("Invalid recorded metadata")
        return self


class ProcessingRecord(HumanRecord):
    kind: Literal["ropa"]
    payload: ProcessingDeclarations


class DeliveryRecord(HumanRecord):
    kind: Literal["delivery_task"]
    payload: ReportedTask


SourceRecord = Annotated[ProcessingRecord | DeliveryRecord, Field(discriminator="kind")]


def source_text(records: list[ProcessingRecord | DeliveryRecord]) -> str:
    # Optional public provenance is omitted only when absent. All nullable
    # declarations remain present so null, false and [] stay distinct.
    values = [record.model_dump(mode="json") for record in records]
    for record in values:
        if record["kind"] == "ropa" and record["payload"].get("source") is None:
            record["payload"].pop("source", None)
    return canonical_json(values)


class ReviewedWorkflowInput(Contract):
    schema_version: Version
    mode: Literal["reviewed_workflow"]
    tenant_id: Identifier
    engagement_id: Identifier
    source_records_sha256: Digest
    records: list[SourceRecord] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def exact_sources(self) -> Self:
        records = self.records
        if (
            any(
                record.tenant_id != self.tenant_id
                or record.payload.engagementId != self.engagement_id
                for record in records
            )
            or len({record.id for record in records}) != len(records)
            or len({record.receipt_id for record in records}) != len(records)
            or len({record.operation_key for record in records}) != len(records)
            or hashlib.sha256(source_text(records).encode()).hexdigest()
            != self.source_records_sha256
            or len(canonical_json(self.model_dump(mode="json")).encode()) > 524_288
        ):
            raise ValueError("Reviewed source register refused")
        return self


class SourceReference(Contract):
    record_id: Identifier
    human_receipt_id: str
    created_by: Identifier
    record_kind: Literal["ropa", "delivery_task"]


class ProcessingReview(Contract):
    source: SourceReference
    declarations: ProcessingDeclarations
    unresolved_fields: list[str]
    declaration_status: Literal["human_recorded_unverified"]
    review_required: TrueOnly


PolicyCategory = Literal["privacy_notice", "consent_notice", "retention", "dpa_template"]


class PolicyReviewDraft(Contract):
    source: SourceReference
    source_ropa_id: Identifier
    category: PolicyCategory
    title: Annotated[Text, Field(max_length=300)]
    content: Annotated[Text, Field(max_length=100_000)]
    review_required: TrueOnly
    legal_review_required: TrueOnly
    publication_status: Literal["unpublished"]

    @model_validator(mode="after")
    def bounded_content(self) -> Self:
        if len(self.content.encode()) > 100_000:
            raise ValueError("Draft content refused")
        return self


class PlaybookReview(Contract):
    source: SourceReference
    reported_task: ReportedTask
    reported_total_minutes: int = Field(ge=0, le=1_000_000_000_000)
    measurement_status: Literal["not_verified"]
    ranking_basis: Literal["human_reported_time_only"]
    time_horizon: Literal["not_recorded"]
    automation_candidate: FalseOnly
    review_required: TrueOnly


class ReviewedWorkflowOutput(Contract):
    schema_version: Version
    mode: Literal["reviewed_workflow"]
    source_records_sha256: Digest
    processing_reviews: list[ProcessingReview] = Field(max_length=20)
    policy_drafts: list[PolicyReviewDraft] = Field(max_length=80)
    playbook_reviews: list[PlaybookReview] = Field(max_length=20)
    persistence: Literal["not_saved"]
    review_required: TrueOnly
    execution_allowed: FalseOnly
    publication_allowed: FalseOnly

    @model_validator(mode="after")
    def bounded_output(self) -> Self:
        if len(canonical_json(self.model_dump(mode="json")).encode()) > 524_288:
            raise ValueError("Reviewed draft output refused")
        return self


def reference(record: ProcessingRecord | DeliveryRecord) -> SourceReference:
    return SourceReference(
        record_id=record.id,
        human_receipt_id=record.receipt_id,
        created_by=record.created_by,
        record_kind=record.kind,
    )


def _declaration(value: str | int | bool | list[str] | None) -> str:
    if value is None:
        return "Unknown — authorised human confirmation required"
    if isinstance(value, list):
        return ", ".join(value) if value else "Human recorded none (review required)"
    if type(value) is bool:
        return (
            "Human recorded yes (review required)"
            if value
            else "Human recorded no (review required)"
        )
    return str(value)


_DECLARATION_LABELS = {
    "engagementId": "engagement",
    "sourceNote": "source and reason",
    "system": "system",
    "purpose": "purpose",
    "legalBasis": "legal basis",
    "retentionMonths": "retention in months",
    "dataCategories": "data categories",
    "dataPrincipals": "data principal groups",
    "processors": "processors",
    "recipients": "recipients",
    "destinationCountries": "destination countries",
    "transferSafeguards": "transfer safeguards",
    "dpiaRequired": "impact assessment required",
    "region": "processing location",
    "crossBorder": "cross-border processing",
    "securityMeasures": "security measures",
}

_POLICY_PROMPTS: dict[PolicyCategory, tuple[str, str]] = {
    "privacy_notice": (
        "Privacy Notice",
        "Confirm organisation identity, contacts, rights routes, notice languages and applicable obligations before publication.",
    ),
    "consent_notice": (
        "Consent Notice",
        "Confirm specific purposes, lawful basis, clear affirmative action, notice language, consent records and withdrawal routes. No consent is proven by this draft.",
    ),
    "retention": (
        "Retention Policy",
        "Confirm retention triggers, deletion methods, legal holds, exceptions, owners and review schedule. No deletion is authorised by this draft.",
    ),
    "dpa_template": (
        "Data Processing Agreement Template",
        "Verify parties, roles, instructions, subprocessors, security, incidents, audit terms, transfers and signatures with legal counsel. This unsigned draft creates no agreement.",
    ),
}


def policy_drafts(record: ProcessingRecord) -> list[PolicyReviewDraft]:
    payload = record.payload
    declarations = payload.model_dump(mode="json")
    content = [
        "Human and legal review required. Recorded declarations are not independently verified processing or legal facts.",
        f"Human source record: {record.id}",
        f"Human audit receipt: {record.receipt_id}",
        f"Original recorded actor: {record.created_by}",
        *[
            f"Recorded {_DECLARATION_LABELS[field]}: {_declaration(value)}"
            for field, value in declarations.items()
            if field != "source"
        ],
        *(
            [
                f"Retained public observation: {payload.source.observationId}",
                f"Public observation output SHA-256: {payload.source.outputSha256}",
            ]
            if payload.source
            else []
        ),
        "Public HTML provenance does not establish private processing facts, residency, contracts, lawful basis or compliance.",
        "Approval, publication and execution remain separate human decisions.",
    ]
    return [
        PolicyReviewDraft(
            source=reference(record),
            source_ropa_id=record.id,
            category=category,
            title=f"Draft {label} — {payload.system}"[:300],
            content="\n\n".join([f"DRAFT {label.upper()} — UNPUBLISHED", *content, prompt]),
            review_required=True,
            legal_review_required=True,
            publication_status="unpublished",
        )
        for category, (label, prompt) in _POLICY_PROMPTS.items()
    ]


def build_reviewed_workflow_drafts(input: ReviewedWorkflowInput) -> ReviewedWorkflowOutput:
    processing = [record for record in input.records if isinstance(record, ProcessingRecord)]
    deliveries = [record for record in input.records if isinstance(record, DeliveryRecord)]
    entries = [
        PlaybookEntry(
            task_name=record.payload.taskName,
            source=record.id,
            duration_minutes=record.payload.durationMinutes,
            repetitions=record.payload.repetitions,
            notes=record.payload.notes,
            automation_candidate=False,
        )
        for record in deliveries
    ]
    by_id = {record.id: record for record in deliveries}
    return ReviewedWorkflowOutput(
        schema_version=1,
        mode="reviewed_workflow",
        source_records_sha256=input.source_records_sha256,
        processing_reviews=[
            ProcessingReview(
                source=reference(record),
                declarations=record.payload,
                unresolved_fields=[
                    field
                    for field, value in record.payload.model_dump().items()
                    if value is None and field not in ("engagementId", "source")
                ],
                declaration_status="human_recorded_unverified",
                review_required=True,
            )
            for record in processing
        ],
        policy_drafts=[draft for record in processing for draft in policy_drafts(record)],
        playbook_reviews=[
            PlaybookReview(
                source=reference(by_id[entry.source]),
                reported_task=by_id[entry.source].payload,
                reported_total_minutes=entry.total_minutes,
                measurement_status="not_verified",
                ranking_basis="human_reported_time_only",
                time_horizon="not_recorded",
                automation_candidate=False,
                review_required=True,
            )
            for entry in rank_playbook_backlog(entries)
        ],
        persistence="not_saved",
        review_required=True,
        execution_allowed=False,
        publication_allowed=False,
    )
