"""Vibhaag — the Classification Agent.

"I tell you what kind of data it is."

Vibhaag takes Drishti's output and classifies each field/record by
DPDPA category. Confidence scores are produced; low-confidence
classifications are routed to a human review queue.

In Phase 1, classification is rule-based + LLM-assisted. The agent
emits classifications with confidence; below a threshold, the field
goes to a human queue.
"""

from __future__ import annotations

from typing import Annotated, Any, ClassVar, Literal

from pydantic import BaseModel, Discriminator, Field, RootModel, Tag, model_validator

from .base import AgentName, AutonomyLevel, BaseAgent
from .public_source import (
    PublicCollectionIndicator,
    UnknownPrivateFacts,
    VibhaagPublicInput,
    VibhaagPublicOutput,
    invocation_mode,
    reject_public_fields_in_legacy,
)


class FieldClassification(BaseModel):
    field_path: str
    system: str
    category: str  # 'identity' | 'contact' | 'government_id' | 'financial' | 'health' | 'children' | 'behavioural' | 'biometric' | 'other'
    sensitivity: str  # 'low' | 'medium' | 'high'
    confidence: float  # 0-1
    needs_review: bool
    rationale: str = ""


class VibhaagInput(BaseModel):
    mode: Literal["legacy_inventory"] = Field(default="legacy_inventory", exclude=True)
    tenant_id: str
    engagement_id: str
    inventory: list[dict[str, Any]] = Field(default_factory=list)
    field_hints: dict[str, dict[str, Any]] = Field(
        default_factory=dict,
        description="Per-system hints: {system_name: {field_name: {category?, sensitivity?}}}",
    )

    @model_validator(mode="before")
    @classmethod
    def public_facts_require_explicit_mode(cls, value: Any) -> Any:
        return reject_public_fields_in_legacy(
            value, {"source", "source_binding", "observation", "records", "source_records_sha256"}
        )


class VibhaagOutput(BaseModel):
    total_fields: int
    classified: int
    needs_review_count: int
    classifications: list[FieldClassification]
    escalate: bool = False
    escalation_reason: str | None = None


class VibhaagInvocationInput(
    RootModel[
        Annotated[
            Annotated[VibhaagInput, Tag("legacy_inventory")]
            | Annotated[VibhaagPublicInput, Tag("public_website")],
            Discriminator(invocation_mode),
        ]
    ]
):
    @property
    def tenant_id(self) -> str:
        return self.root.tenant_id

    @property
    def engagement_id(self) -> str:
        return self.root.engagement_id


class VibhaagInvocationOutput(
    RootModel[
        Annotated[
            Annotated[VibhaagOutput, Tag("legacy_inventory")]
            | Annotated[VibhaagPublicOutput, Tag("public_website")],
            Discriminator(invocation_mode),
        ]
    ]
):
    pass


# Pattern-based classifier used as the structural backbone
NAME_PATTERNS = {
    "government_id": ["aadhaar", "pan", "passport", "voter", "license", "ssn", "national_id"],
    "contact": ["email", "phone", "mobile", "address", "zip", "postal"],
    "identity": ["name", "first_name", "last_name", "full_name", "dob", "date_of_birth", "gender"],
    "financial": ["bank", "account", "ifsc", "credit", "debit", "card", "upi", "salary"],
    "health": ["diagnosis", "icd", "medication", "blood", "weight", "height", "allergy"],
    "children": ["parent", "guardian", "minor", "child", "school_grade"],
    "behavioural": ["browsing", "search", "click", "view", "page", "session", "device_id", "ip"],
    "biometric": ["fingerprint", "face", "iris", "voice", "biometric"],
}


def pattern_classify(field_name: str) -> tuple[str, float]:
    """Quick structural classification by name pattern. Returns (category, confidence)."""
    n = field_name.lower()
    for category, patterns in NAME_PATTERNS.items():
        for p in patterns:
            if p in n:
                return category, 0.95
    return "other", 0.4


class VibhaagAgent(BaseAgent[VibhaagInvocationInput, VibhaagInvocationOutput]):
    name: ClassVar[AgentName] = AgentName.VIBHAAG
    description: ClassVar[str] = "Classify discovered data fields by DPDPA category."
    one_liner: ClassVar[str] = "I tell you what kind of data it is."
    tool_scopes: ClassVar[tuple[str, ...]] = ()  # operates on discovery output only
    autonomy: ClassVar[AutonomyLevel] = AutonomyLevel.L1
    default_task_kind: ClassVar[Any] = "classification"
    default_pii_redact: ClassVar[bool] = True

    def input_schema(self) -> type[VibhaagInvocationInput]:
        return VibhaagInvocationInput

    def output_schema(self) -> type[VibhaagInvocationOutput]:
        return VibhaagInvocationOutput

    async def _run(
        self, *, correlation_id: str, input: VibhaagInvocationInput, **deps: Any
    ) -> VibhaagInvocationOutput:
        source_input = input.root
        if isinstance(source_input, VibhaagPublicInput):
            indicators = [
                PublicCollectionIndicator(
                    page=page.page,
                    content_sha256=page.content_sha256,
                    form_ordinal=form.ordinal,
                    control_ordinal=control.ordinal,
                    input_type=control.inputType,
                    indicator="potential_contact_collection",
                    requires_human_review=True,
                )
                for page in source_input.observation.pages
                if page.status == "checked" and page.form_metadata is not None
                for form in page.form_metadata.forms
                for control in form.controls
                if control.element == "input" and control.inputType in ("email", "tel")
            ]
            return VibhaagInvocationOutput(
                root=VibhaagPublicOutput(
                    mode="public_website",
                    source_binding=source_input.source_binding,
                    indicators=indicators,
                    private_facts=UnknownPrivateFacts(),
                    unexamined_pages=[
                        page.page
                        for page in source_input.observation.pages
                        if page.form_state == "unexamined"
                    ],
                    unavailable_pages=[
                        page.page
                        for page in source_input.observation.pages
                        if page.form_state == "unavailable"
                    ],
                    scope_limited=True,
                )
            )
        legacy_input = source_input
        classifications: list[FieldClassification] = []
        for system in legacy_input.inventory:
            sys_name = system.get("name", "unknown")
            hint = legacy_input.field_hints.get(sys_name, {})
            fields: list[Any]
            if isinstance(hint.get("fields"), list):
                fields = hint["fields"]
            else:
                # Accept the documented shape {field_name: {category, ...}}
                # as well as the historical {fields: [...]} shape.
                fields = [
                    {"name": field_name, **(field_hint if isinstance(field_hint, dict) else {})}
                    for field_name, field_hint in hint.items()
                    if field_name != "fields"
                ]

            for field in fields:
                field_name = field if isinstance(field, str) else field.get("name", "")
                # Prefer caller hint if present
                if isinstance(field, dict):
                    cat = field.get("category")
                    sens = field.get("sensitivity", "medium")
                else:
                    cat, sens = None, "medium"
                if not cat:
                    cat, conf = pattern_classify(field_name)
                else:
                    conf = 0.99
                classifications.append(
                    FieldClassification(
                        field_path=f"{sys_name}.{field_name}",
                        system=sys_name,
                        category=cat,
                        sensitivity=sens,
                        confidence=conf,
                        needs_review=conf < 0.7 or cat == "other",
                        rationale=(
                            f"Pattern match (conf {conf:.2f})"
                            if conf < 0.99
                            else f"Caller-provided hint (conf {conf:.2f})"
                        ),
                    )
                )

        # If there are no fields, synthesise a coarse classification
        # from data_categories on the system (e.g. Drishti said this
        # system handles "children" — flag children for review)
        if not classifications:
            for system in legacy_input.inventory:
                sys_name = system.get("name", "unknown")
                for cat in system.get("data_categories", []) or []:
                    if cat in NAME_PATTERNS:
                        classifications.append(
                            FieldClassification(
                                field_path=f"{sys_name}.*",
                                system=sys_name,
                                category=cat,
                                sensitivity="high"
                                if cat in {"children", "health", "biometric", "government_id"}
                                else "medium",
                                confidence=0.6,
                                needs_review=True,
                                rationale="Inferred from system-level data_categories; field-level classification required.",
                            )
                        )

        needs_review = [c for c in classifications if c.needs_review]

        escalate = any(c.category == "children" and c.confidence >= 0.9 for c in classifications)
        escalation_reason = "ambiguous_field: children-data fields detected" if escalate else None

        return VibhaagInvocationOutput(
            root=VibhaagOutput(
                total_fields=len(classifications),
                classified=len([c for c in classifications if c.confidence >= 0.7]),
                needs_review_count=len(needs_review),
                classifications=classifications,
                escalate=escalate,
                escalation_reason=escalation_reason,
            )
        )
