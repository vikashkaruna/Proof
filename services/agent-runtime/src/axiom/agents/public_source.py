"""Bounded public HTML contracts, never private inventory or database authority.

The dedicated BFF composition must load the actual tenant-owned check and
engagement. These models check transport consistency only. projection_sha256
is an opaque database integrity digest; it is not a Python canonical JSON digest.
"""

# ruff: noqa: N815 -- Preserve the existing shared public form metadata wire names.

from __future__ import annotations

from typing import Annotated, Any, Literal, TypeAlias
from uuid import UUID

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    model_serializer,
    model_validator,
)

MAX_FORMS = 3
MAX_CONTROLS = 12
MAX_COUNT = 512 * 1024
MAX_PAGES = 4


def _uuid(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("Public source identifiers must be UUID strings")
    return str(UUID(value))


def _one(value: Any) -> int:
    if type(value) is not int or value != 1:
        raise ValueError("Unsupported public source version")
    return value


def _true(value: Any) -> bool:
    if value is not True:
        raise ValueError("Public observations require human review")
    return value


Identifier: TypeAlias = Annotated[str, BeforeValidator(_uuid)]
Digest: TypeAlias = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
Version: TypeAlias = Annotated[Literal[1], BeforeValidator(_one)]
TrueOnly: TypeAlias = Annotated[Literal[True], BeforeValidator(_true)]
Count: TypeAlias = Annotated[int, Field(ge=0, le=MAX_COUNT)]
Ordinal: TypeAlias = Annotated[int, Field(ge=1, le=MAX_COUNT)]
PageKind: TypeAlias = Literal["root", "privacy", "contact", "terms"]
InputType: TypeAlias = Literal[
    "text",
    "email",
    "tel",
    "url",
    "search",
    "number",
    "date",
    "datetime-local",
    "time",
    "month",
    "week",
    "color",
    "range",
    "checkbox",
    "radio",
]


class PublicContract(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    @model_serializer(mode="wrap")
    def omit_absent_attributes(self, handler: Any) -> dict[str, Any]:
        # Absent optional metadata/types retain the existing shared wire shape.
        return {key: value for key, value in handler(self).items() if value is not None}


class PublicSourceBinding(PublicContract):
    tenant_id: Identifier
    engagement_id: Identifier
    check_id: Identifier
    root_content_sha256: Digest
    projection_sha256: Digest
    projection_version: Version


class PublicControl(PublicContract):
    ordinal: Ordinal
    element: Literal["input", "select", "textarea"]
    inputType: InputType | None = None
    requiredAttribute: bool
    disabledAttribute: bool

    @model_validator(mode="before")
    @classmethod
    def absent_input_type_is_not_null(cls, value: Any) -> Any:
        if isinstance(value, dict) and "inputType" in value and value["inputType"] is None:
            raise ValueError("Absent input types must be omitted")
        return value

    @model_validator(mode="after")
    def input_type_matches_element(self) -> PublicControl:
        if (self.element == "input") != (self.inputType is not None):
            raise ValueError("Input type must match the observed element")
        return self


class PublicForm(PublicContract):
    ordinal: Annotated[int, Field(ge=1, le=MAX_FORMS)]
    method: Literal["get", "post", "dialog"]
    observedControlCount: Count
    excludedControlCount: Count
    controlsTruncated: bool
    controls: Annotated[list[PublicControl], Field(max_length=MAX_CONTROLS)]

    @model_validator(mode="after")
    def controls_match_counts(self) -> PublicForm:
        eligible = self.observedControlCount - self.excludedControlCount
        if (
            eligible < 0
            or len(self.controls) != min(eligible, MAX_CONTROLS)
            or self.controlsTruncated != (eligible > MAX_CONTROLS)
        ):
            raise ValueError("Observed control counts are inconsistent")
        previous = 0
        for control in self.controls:
            if control.ordinal <= previous or control.ordinal > self.observedControlCount:
                raise ValueError("Observed control ordinals are inconsistent")
            previous = control.ordinal
        return self


class PublicFormMetadata(PublicContract):
    version: Version
    scope: Literal["static_html_form_descendants"]
    sourceSha256: Digest
    observedFormCount: Count
    formsTruncated: bool
    forms: Annotated[list[PublicForm], Field(max_length=MAX_FORMS)]

    @model_validator(mode="after")
    def forms_match_counts(self) -> PublicFormMetadata:
        if (
            len(self.forms) != min(self.observedFormCount, MAX_FORMS)
            or self.formsTruncated != (self.observedFormCount > MAX_FORMS)
            or any(form.ordinal != index + 1 for index, form in enumerate(self.forms))
        ):
            raise ValueError("Observed form counts and ordinals are inconsistent")
        return self


class CheckedPublicPage(PublicContract):
    page: PageKind
    status: Literal["checked"]
    content_sha256: Digest
    form_metadata: PublicFormMetadata | None = None

    @model_validator(mode="before")
    @classmethod
    def absent_metadata_is_not_null(cls, value: Any) -> Any:
        if isinstance(value, dict) and "form_metadata" in value and value["form_metadata"] is None:
            raise ValueError("Unexamined form metadata must be omitted")
        return value

    @model_validator(mode="after")
    def metadata_matches_content(self) -> CheckedPublicPage:
        if self.form_metadata and self.form_metadata.sourceSha256 != self.content_sha256:
            raise ValueError("Form metadata does not match its page content")
        return self


class UnavailablePublicPage(PublicContract):
    page: PageKind
    status: Literal["unavailable"]


PublicPage: TypeAlias = Annotated[
    CheckedPublicPage | UnavailablePublicPage, Field(discriminator="status")
]


def _validate_pages(binding: PublicSourceBinding, pages: list[Any]) -> None:
    if len({page.page for page in pages}) != len(pages):
        raise ValueError("Public source pages must be unique")
    root = pages[0]
    if (
        root.page != "root"
        or root.status != "checked"
        or root.content_sha256 != binding.root_content_sha256
    ):
        raise ValueError("Public source root does not match its binding")


class PublicWebsiteSource(PublicContract):
    version: Version
    binding: PublicSourceBinding
    pages: Annotated[list[PublicPage], Field(min_length=1, max_length=MAX_PAGES)]

    @model_validator(mode="after")
    def pages_match_binding(self) -> PublicWebsiteSource:
        _validate_pages(self.binding, self.pages)
        return self


class UnknownPrivateFacts(PublicContract):
    hosting_region: Literal["unknown"] = "unknown"
    backend_personal_data: Literal["unknown"] = "unknown"
    cross_border_processing: Literal["unknown"] = "unknown"


class CheckedPublicObservationPage(CheckedPublicPage):
    form_state: Literal["observed", "unexamined"]

    @model_validator(mode="after")
    def form_state_matches_metadata(self) -> CheckedPublicObservationPage:
        expected = "observed" if self.form_metadata is not None else "unexamined"
        if self.form_state != expected:
            raise ValueError("Form observation state does not match its metadata")
        return self


class UnavailablePublicObservationPage(UnavailablePublicPage):
    form_state: Literal["unavailable"]


PublicObservationPage: TypeAlias = Annotated[
    CheckedPublicObservationPage | UnavailablePublicObservationPage,
    Field(discriminator="status"),
]


class PublicWebsiteObservation(PublicContract):
    version: Version
    binding: PublicSourceBinding
    pages: Annotated[list[PublicObservationPage], Field(min_length=1, max_length=MAX_PAGES)]
    private_facts: UnknownPrivateFacts
    requires_human_review: TrueOnly

    @model_validator(mode="after")
    def pages_match_binding(self) -> PublicWebsiteObservation:
        _validate_pages(self.binding, self.pages)
        return self


class DrishtiPublicInput(PublicContract):
    mode: Literal["public_website"]
    tenant_id: Identifier
    engagement_id: Identifier
    source: PublicWebsiteSource

    @model_validator(mode="after")
    def envelope_matches_binding(self) -> DrishtiPublicInput:
        _validate_envelope(self.tenant_id, self.engagement_id, self.source.binding)
        return self


def _validate_envelope(tenant_id: str, engagement_id: str, binding: PublicSourceBinding) -> None:
    if tenant_id != binding.tenant_id or engagement_id != binding.engagement_id:
        raise ValueError("Public source does not match the agent envelope")


class DrishtiPublicOutput(PublicContract):
    mode: Literal["public_website"]
    observation: PublicWebsiteObservation


class VibhaagPublicInput(PublicContract):
    mode: Literal["public_website"]
    tenant_id: Identifier
    engagement_id: Identifier
    source_binding: PublicSourceBinding
    observation: PublicWebsiteObservation

    @model_validator(mode="after")
    def observation_matches_binding(self) -> VibhaagPublicInput:
        _validate_envelope(self.tenant_id, self.engagement_id, self.source_binding)
        if self.observation.binding != self.source_binding:
            raise ValueError("Discovery observation does not match the expected source")
        return self


class PublicCollectionIndicator(PublicContract):
    page: PageKind
    content_sha256: Digest
    form_ordinal: Annotated[int, Field(ge=1, le=MAX_FORMS)]
    control_ordinal: Ordinal
    input_type: Literal["email", "tel"]
    indicator: Literal["potential_contact_collection"]
    requires_human_review: TrueOnly


class VibhaagPublicOutput(PublicContract):
    mode: Literal["public_website"]
    source_binding: PublicSourceBinding
    indicators: Annotated[
        list[PublicCollectionIndicator], Field(max_length=MAX_PAGES * MAX_FORMS * MAX_CONTROLS)
    ]
    private_facts: UnknownPrivateFacts
    unexamined_pages: Annotated[list[PageKind], Field(max_length=MAX_PAGES)]
    unavailable_pages: Annotated[list[PageKind], Field(max_length=MAX_PAGES)]
    scope_limited: TrueOnly

    @model_validator(mode="after")
    def observations_are_unique(self) -> VibhaagPublicOutput:
        locators = [
            (item.page, item.form_ordinal, item.control_ordinal) for item in self.indicators
        ]
        if len(set(locators)) != len(locators):
            raise ValueError("Public collection indicators must be unique")
        if (
            len(set(self.unexamined_pages)) != len(self.unexamined_pages)
            or len(set(self.unavailable_pages)) != len(self.unavailable_pages)
            or set(self.unexamined_pages) & set(self.unavailable_pages)
            or any(
                item.page in self.unexamined_pages + self.unavailable_pages
                for item in self.indicators
            )
        ):
            raise ValueError("Public page coverage is inconsistent")
        return self


def invocation_mode(value: Any) -> str:
    """Discriminate new contracts without adding fields to legacy wire output."""
    mode = (
        value.get("mode", "legacy_inventory")
        if isinstance(value, dict)
        else getattr(value, "mode", "legacy_inventory")
    )
    return mode if isinstance(mode, str) else "invalid"


def reject_public_fields_in_legacy(value: Any, reserved: set[str]) -> Any:
    if isinstance(value, dict) and reserved.intersection(value):
        raise ValueError("Public source facts require the public website mode")
    return value
