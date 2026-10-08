"""Deterministic RoPA generation from discovery and classification output.

This is the local Phase 2 core. It deliberately leaves lawful basis,
retention, and transfer safeguards as review fields: inventing legal facts
from a system name would create an unsafe compliance record.
"""

from __future__ import annotations

import re
from typing import Any

from pydantic import BaseModel, Field

from .agents.drishti import INDIAN_REGIONS


class RopaRecord(BaseModel):
    activity_id: str
    system: str
    purpose: str
    data_items: list[str]
    data_categories: list[str] | None
    lawful_basis: str
    retention_period: str
    processors: list[str] | None = None
    region: str = "Unknown — residency evidence required"
    cross_border: bool | None = None
    transfer_safeguards: str | None = None
    evidence_refs: list[str] = Field(default_factory=list)
    review_required: bool = True


class RopaOutput(BaseModel):
    records: list[RopaRecord]
    generated_by: str = "vibhaag"
    review_required: bool = True


def build_ropa_records(
    inventory: list[dict[str, Any]],
    classifications: list[dict[str, Any]] | None = None,
) -> RopaOutput:
    """Build one reviewable RoPA activity per discovered system."""
    classifications = classifications or []
    by_system: dict[str, list[str]] = {}
    categories_by_system: dict[str, set[str]] = {}
    for item in classifications:
        system = str(item.get("system", "unknown"))
        field_path = str(item.get("field_path", ""))
        field_name = field_path.rsplit(".", 1)[-1] if field_path else "*"
        by_system.setdefault(system, []).append(field_name)
        category = item.get("category")
        if isinstance(category, str) and category.strip():
            categories_by_system.setdefault(system, set()).add(category.strip())

    records: list[RopaRecord] = []
    for index, system in enumerate(inventory, start=1):
        name = str(system.get("name") or f"system-{index}")
        slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or f"system-{index}"
        fields = list(dict.fromkeys(by_system.get(name, [])))
        supplied_categories = system.get("data_categories")
        categories_valid = isinstance(supplied_categories, list) and all(
            isinstance(value, str) and value.strip() for value in supplied_categories
        )
        categories_invalid = supplied_categories is not None and not categories_valid
        categories = (
            {value.strip().lower() for value in supplied_categories} if categories_valid else set()
        )
        categories.update(value.lower() for value in categories_by_system.get(name, set()))
        supplied_processors = system.get("processors", system.get("processor"))
        if isinstance(supplied_processors, str):
            supplied_processors = [supplied_processors]
        # Only a genuinely empty declaration establishes a recorded none.
        # Invalid or mixed nonempty lists cannot be sanitised into that claim.
        processors = (
            list(dict.fromkeys(value.strip() for value in supplied_processors))
            if isinstance(supplied_processors, list)
            and all(isinstance(value, str) and value.strip() for value in supplied_processors)
            else None
        )
        # A discovered system description is an observation, not an attested
        # processing purpose. Even a complete field inventory requires review.
        purpose = "Purpose to be confirmed by the Data Fiduciary"
        public_source = any(
            isinstance(system.get(key), str)
            and system.get(key) in {"public_website", "public_html"}
            for key in ("mode", "source_type", "source_scope")
        )
        cross_border = (
            system.get("cross_border") if isinstance(system.get("cross_border"), bool) else None
        )
        region = str(system.get("region") or "").strip()
        if public_source:
            # Public HTML cannot establish a private processor or hosting region.
            processors = None
            fields = []
            categories = set()
            region = ""
            cross_border = None
        # A stated hosting region does not establish a transfer or its absence.
        # Preserve only an explicit Boolean declaration, including a stated no;
        # contradictions and unknown processing facts remain for human review.

        safeguards = None
        if cross_border:
            if region and region.lower() not in INDIAN_REGIONS:
                safeguards = f"Transfer restrictions and safeguards to be reviewed (Stated destination: {region})"
            else:
                safeguards = "To be documented"

        records.append(
            RopaRecord(
                activity_id=f"ropa-{slug}-{index}",
                system=name,
                purpose=purpose,
                data_items=fields or ["Unspecified — field inventory required"],
                data_categories=(
                    sorted(categories)
                    if not categories_invalid
                    and (categories or (not public_source and supplied_categories == []))
                    else None
                ),
                lawful_basis="To be confirmed by the Data Fiduciary",
                retention_period="To be confirmed by the retention schedule",
                processors=processors,
                region=region or "Unknown — residency evidence required",
                cross_border=cross_border,
                transfer_safeguards=safeguards,
                evidence_refs=[str(ref) for ref in system.get("evidence_refs", []) or []],
                review_required=True,
            )
        )
    return RopaOutput(records=records, review_required=True)
