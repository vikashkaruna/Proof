"""Versioned deterministic renderer configuration, independent of input/output bytes.

The immutable canonical manifest is the configuration actually consumed by the
renderer. Changing behavior or its implementation identifier requires a new
manifest version; this commitment is not a source or human-approval assertion.
"""

import json
from typing import Any, Final

from .canonicalise import canonical_json, sha256_hex

RENDERER_CONFIG_VERSION: Final = "prativedan-draft-v1"
_MANIFEST_TEXT: Final = canonical_json(
    {
        "schema_version": 1,
        "renderer_config_version": RENDERER_CONFIG_VERSION,
        "agent": "prativedan",
        "agent_version": "0.1.0",
        "implementation": "deterministic-prativedan-sections-html-v1",
        "model_inference": False,
        "model_identity": None,
        "section_order": ["executive_summary", "findings_table", "library", "attribution"],
        "finding_limit": 10,
        "finding_order": "numeric-finite-nonnegative-risk-desc-otherwise-source-order",
        "ranked_findings_title": "Top findings (by risk-weighted exposure)",
        "source_findings_title": "Findings for review (source order)",
        "posture_bands": [[85, "Strong"], [65, "Acceptable"], [40, "At Risk"], [0, "Critical"]],
        "posture_format": ".0f",
        "exposure_divisor": 10000000,
        "exposure_format": ".2f",
        "html_escape": "python-html-escape-quote-true",
        "html_findings_columns": ["control_id", "title", "severity", "score", "risk_points"],
        "review_required": True,
        "citation_verification": "unverified_references",
        "citation_policy": "explicit-canonical-nonzero-uuid-references-unverified",
        "source_rationale_suffix": " [Draft assessment declaration: answer={answer_state}; applicability={applicability_state}; evidence unverified.]",
    }
)


def renderer_config() -> dict[str, Any]:
    """Return a fresh copy; callers cannot mutate the retained manifest."""
    value: dict[str, Any] = json.loads(_MANIFEST_TEXT)
    return value


def renderer_commitment() -> tuple[str, str, str]:
    """Compute the real canonical manifest digest, never accept a caller digest."""
    text = canonical_json(renderer_config())
    return RENDERER_CONFIG_VERSION, text, sha256_hex(text)
