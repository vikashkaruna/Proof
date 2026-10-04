"""Drishti — the Discovery Agent.

"I find what you didn't know you had."

Drishti runs discovery across your systems. In Phase 1, this is
interview-driven: the founder or operator answers a structured
questionnaire and Drishti normalises the answers into a system
inventory. In Phase 2, this connects to live read-only data sources.

Per ADR-3 (mirror): Drishti is read-only. It can write evidence and
inventory rows but cannot mutate client systems.
"""

from __future__ import annotations

import re
from typing import Annotated, Any, ClassVar, Literal

from pydantic import (
    BaseModel,
    Discriminator,
    Field,
    RootModel,
    Tag,
    field_validator,
    model_validator,
)

from .base import AgentName, AutonomyLevel, BaseAgent
from .public_source import (
    CheckedPublicObservationPage,
    DrishtiPublicInput,
    DrishtiPublicOutput,
    PublicWebsiteObservation,
    UnavailablePublicObservationPage,
    UnknownPrivateFacts,
    invocation_mode,
    reject_public_fields_in_legacy,
)

INDIAN_REGIONS: set[str] = {
    # AWS India
    "ap-south-1",
    "ap-south-2",
    # GCP India
    "asia-south1",
    "asia-south2",
    # Azure India
    "centralindia",
    "southindia",
    "westindia",
    # Oracle Cloud India
    "ap-mumbai-1",
    "ap-hyderabad-1",
    # Generic / Local aliases
    "in",
    "india",
    "mumbai",
    "hyderabad",
    "delhi",
    "pune",
    "chennai",
    "local",
    "localhost",
    "internal",
    "on-prem",
    "on-premises",
}

NON_INDIAN_REGION_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"\b(us-(?:east|west)-\d+)\b", re.IGNORECASE),
    re.compile(r"\b(eu-(?:west|central|north|south)-\d+)\b", re.IGNORECASE),
    re.compile(r"\b(ap-(?:southeast|northeast|east)-\d+)\b", re.IGNORECASE),
    re.compile(
        r"\b(ca-central-\d+|sa-east-\d+|me-south-\d+|me-central-\d+|af-south-\d+|il-central-\d+)\b",
        re.IGNORECASE,
    ),
    re.compile(r"\b(us-(?:central|east|west)\d+)\b", re.IGNORECASE),
    re.compile(r"\b(europe-(?:west|north|central|south)\d+)\b", re.IGNORECASE),
    re.compile(r"\b(asia-(?:east|northeast|southeast)\d+)\b", re.IGNORECASE),
    re.compile(
        r"\b(eastus\d*|westus\d*|centralus|northeurope|westeurope|eastasia|southeastasia)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(united states|usa|virginia|ohio|oregon|california|frankfurt|germany|ireland|dublin|london|tokyo|japan|singapore|sydney|australia)\b",
        re.IGNORECASE,
    ),
]


def evaluate_residency_and_cross_border(system: SystemRecord) -> None:
    """Evaluate system region and data residency under India DPDPA §16.

    Defaults to ap-south-1 (Mumbai, India). Automatically detects non-Indian
    regions (e.g. us-east-1) in region, name, or description. If a non-Indian
    region is detected or configured, cross_border is strictly enforced (True)
    even if the caller passed False, and statutory warnings are issued.
    """
    explicit_region = (system.region or "").strip()
    detected_region: str | None = None

    if explicit_region and explicit_region.lower() not in INDIAN_REGIONS:
        detected_region = explicit_region
    else:
        text_to_scan = f"{system.name} {system.description}"
        for pattern in NON_INDIAN_REGION_PATTERNS:
            match = pattern.search(text_to_scan)
            if match:
                detected_region = match.group(0).lower()
                break

    if detected_region:
        system.region = detected_region
        system.cross_border = True
        system.warnings.append(
            f"Statutory Warning [DPDPA-XBD-01]: System '{system.name}' (type: '{system.type}') "
            f"is hosted in non-Indian region '{system.region}'. Under India DPDPA 2023 §16 & Rule 16, "
            f"storing personal data, telemetry, or system logs in non-Indian jurisdictions constitutes "
            f"a cross-border transfer subject to statutory restrictions and transfer safeguards. "
            f"Default system destination must be India (ap-south-1 / Mumbai). Ensure statutory transfer "
            f"safeguards, contractual clauses, and RoPA documentation are in place."
        )
    elif system.cross_border:
        system.warnings.append(
            f"Statutory Warning [DPDPA-XBD-01]: System '{system.name}' is flagged for cross-border data "
            f"transfer under India DPDPA 2023 §16. Ensure statutory transfer safeguards and RoPA "
            f"documentation are in place."
        )
    else:
        if not system.region or system.region.lower() in INDIAN_REGIONS:
            system.region = system.region or "ap-south-1"


class SystemRecord(BaseModel):
    name: str
    type: str  # postgres, mysql, s3, gdrive, m365, salesforce, etc.
    description: str = ""
    hosts_personal_data: bool = False
    data_categories: list[str] = Field(default_factory=list)
    cross_border: bool = False
    processor: str | None = None
    evidence_refs: list[str] = Field(default_factory=list)
    region: str = "ap-south-1"
    warnings: list[str] = Field(default_factory=list)


class DrishtiInput(BaseModel):
    mode: Literal["legacy_inventory"] = Field(default="legacy_inventory", exclude=True)
    tenant_id: str
    engagement_id: str
    interview: dict[str, Any] = Field(
        default_factory=dict,
        description="Structured answers from the discovery interview",
    )
    systems: list[SystemRecord] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def public_facts_require_explicit_mode(cls, value: Any) -> Any:
        return reject_public_fields_in_legacy(value, {"source", "source_binding", "observation"})

    @field_validator("interview")
    @classmethod
    def validate_interview_booleans(cls, interview: dict[str, Any]) -> dict[str, Any]:
        # The interview remains extensible, but declarations used for discovery
        # must be actual JSON booleans. Python truthiness turns "false" into True.
        for answer in interview.values():
            if not isinstance(answer, dict):
                continue
            for field in ("hosts_personal_data", "cross_border"):
                if field in answer and not isinstance(answer[field], bool):
                    raise ValueError("Interview data declarations must be booleans")
        return interview


class DrishtiOutput(BaseModel):
    system_count: int
    personal_data_systems: int
    cross_border_systems: int
    inventory: list[SystemRecord]
    summary: str
    needs_live_connector: bool
    escalate: bool = False
    escalation_reason: str | None = None
    warnings: list[str] = Field(default_factory=list)


class DrishtiInvocationInput(
    RootModel[
        Annotated[
            Annotated[DrishtiInput, Tag("legacy_inventory")]
            | Annotated[DrishtiPublicInput, Tag("public_website")],
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


class DrishtiInvocationOutput(
    RootModel[
        Annotated[
            Annotated[DrishtiOutput, Tag("legacy_inventory")]
            | Annotated[DrishtiPublicOutput, Tag("public_website")],
            Discriminator(invocation_mode),
        ]
    ]
):
    pass


class DrishtiAgent(BaseAgent[DrishtiInvocationInput, DrishtiInvocationOutput]):
    name: ClassVar[AgentName] = AgentName.DRISHTI
    writes_axiom_state: ClassVar[bool] = True
    description: ClassVar[str] = "Build a system inventory from interview data or live connectors."
    one_liner: ClassVar[str] = "I find what you didn't know you had."
    tool_scopes: ClassVar[tuple[str, ...]] = ("connector.read", "inventory.write", "evidence.write")
    autonomy: ClassVar[AutonomyLevel] = AutonomyLevel.L1
    default_task_kind: ClassVar[Any] = "structural"
    default_pii_redact: ClassVar[bool] = False  # structural only — no values

    def input_schema(self) -> type[DrishtiInvocationInput]:
        return DrishtiInvocationInput

    def output_schema(self) -> type[DrishtiInvocationOutput]:
        return DrishtiInvocationOutput

    async def _run(
        self, *, correlation_id: str, input: DrishtiInvocationInput, **deps: Any
    ) -> DrishtiInvocationOutput:
        source_input = input.root
        if isinstance(source_input, DrishtiPublicInput):
            # Public attributes cannot establish private hosting or processing.
            pages = [
                UnavailablePublicObservationPage(
                    page=page.page, status="unavailable", form_state="unavailable"
                )
                if page.status == "unavailable"
                else CheckedPublicObservationPage(
                    **page.model_dump(),
                    form_state="observed" if page.form_metadata is not None else "unexamined",
                )
                for page in source_input.source.pages
            ]
            return DrishtiInvocationOutput(
                root=DrishtiPublicOutput(
                    mode="public_website",
                    observation=PublicWebsiteObservation(
                        version=1,
                        binding=source_input.source.binding,
                        pages=pages,
                        private_facts=UnknownPrivateFacts(),
                        requires_human_review=True,
                    ),
                )
            )
        legacy_input = source_input
        # If interview is provided, normalise it; otherwise use the explicit systems
        inventory = legacy_input.systems or self._from_interview(legacy_input.interview)

        # Normalize and evaluate residency and cross-border indicators
        for s in inventory:
            evaluate_residency_and_cross_border(s)

        personal_data = [s for s in inventory if s.hosts_personal_data]
        cross_border = [s for s in inventory if s.cross_border]

        escalate = False
        escalation_reason: str | None = None
        # Escalate if children data was discovered
        for s in inventory:
            categories = {category.lower() for category in s.data_categories}
            if "children" in categories:
                escalate = True
                escalation_reason = f"discovers_children_data: system '{s.name}' flagged"
                break
        # Escalate if health data was discovered
        for s in inventory:
            categories = {category.lower() for category in s.data_categories}
            if "health" in categories:
                escalate = True
                escalation_reason = (
                    escalation_reason or f"discovers_health_data: system '{s.name}' flagged"
                )
                break
        # Escalate if any cross-border transfer was discovered
        if any(s.cross_border for s in inventory):
            escalate = True
            escalation_reason = escalation_reason or "cross_border_transfer_detected"

        all_warnings: list[str] = []
        for s in inventory:
            all_warnings.extend(s.warnings)

        summary = (
            f"Discovered {len(inventory)} system(s); "
            f"{len(personal_data)} hold personal data; "
            f"{len(cross_border)} involve cross-border transfer."
        )
        if all_warnings:
            summary += f" ({len(all_warnings)} statutory residency warning(s) flagged)"

        return DrishtiInvocationOutput(
            root=DrishtiOutput(
                system_count=len(inventory),
                personal_data_systems=len(personal_data),
                cross_border_systems=len(cross_border),
                inventory=inventory,
                summary=summary,
                needs_live_connector=len(inventory) >= 3,
                escalate=escalate,
                escalation_reason=escalation_reason,
                warnings=all_warnings,
            )
        )

    def _from_interview(self, interview: dict[str, Any]) -> list[SystemRecord]:
        # Very minimal Phase 1 normaliser. Phase 2 swaps in live
        # connector-driven discovery.
        systems: list[SystemRecord] = []
        for key, val in interview.items():
            if not isinstance(val, dict):
                continue
            systems.append(
                SystemRecord(
                    name=val.get("name", key),
                    type=val.get("type", "unknown"),
                    description=val.get("description", ""),
                    hosts_personal_data=val.get("hosts_personal_data", False),
                    data_categories=val.get("data_categories", []) or [],
                    cross_border=val.get("cross_border", False),
                    processor=val.get("processor"),
                    evidence_refs=val.get("evidence_refs", []) or [],
                    region=val.get("region", "ap-south-1"),
                    warnings=val.get("warnings", []) or [],
                )
            )
        return systems
