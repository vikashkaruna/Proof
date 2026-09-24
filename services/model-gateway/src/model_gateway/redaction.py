"""PII redaction for the Model Gateway.

The redaction runs on every prompt before it leaves the agent runtime
to a third-party model provider. It uses Presidio (Microsoft) for
robust named-entity recognition, with a regex pre-pass for
DPDPA-specific patterns (Aadhaar, PAN, IFSC, etc.) that Presidio
doesn't always catch.

Redaction is irreversible for the model — the redacted text is what
the model sees. The original is hashed (SHA-256) and the hash is
recorded in the audit ledger for reproducibility, but the value
itself never leaves the runtime.
"""

from __future__ import annotations

import hashlib
import logging
import re
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

# DPDPA-specific patterns (high-precision, low-false-positive)
DPDPA_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("PAN", re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b")),
    ("AADHAAR", re.compile(r"\b\d{4}\s?\d{4}\s?\d{4}\b")),
    ("PASSPORT", re.compile(r"\b[A-PR-WY][0-9]{7}\b")),
    ("IFSC", re.compile(r"\b[A-Z]{4}0[A-Z0-9]{6}\b")),
    ("UPI", re.compile(r"\b[\w.-]{2,}@(ybl|okaxis|oksbi|paytm|upi)\b", re.IGNORECASE)),
    ("EMAIL", re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")),
    ("PHONE_IN", re.compile(r"(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b")),
    ("CARD", re.compile(r"\b(?:\d[ -]?){13,19}\b")),
    ("IP", re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")),
]


@lru_cache(maxsize=1)
def _presidio_analyzer() -> Any | None:
    """Load Presidio once when its language model is available.

    Regexes remain the deterministic baseline. A missing Presidio model must
    not make the gateway crash or stall downloading hundreds of MBs during
    local development.
    """
    try:
        import spacy

        if not (spacy.util.is_package("en_core_web_lg") or spacy.util.is_package("en_core_web_sm")):
            return None

        from presidio_analyzer import AnalyzerEngine

        return AnalyzerEngine()
    except Exception:  # noqa: BLE001 - optional dependency/model failure
        return None


@dataclass(frozen=True)
class RedactionSummary:
    redacted_text: str
    redactions: dict[str, int]
    original_hash: str  # SHA-256 of the original (for ledger)
    redacted_hash: str  # SHA-256 of the redacted output


def redact(text: str) -> RedactionSummary:
    """Apply DPDPA-specific regex patterns to redact PII.

    For broader NER (names, addresses), the gateway also runs Presidio
    when available. This function is the always-on, no-deps fallback.
    """
    if not text:
        return RedactionSummary(
            redacted_text=text,
            redactions={},
            original_hash=hashlib.sha256(b"").hexdigest(),
            redacted_hash=hashlib.sha256(b"").hexdigest(),
        )

    original_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
    redactions: dict[str, int] = {}
    out = text

    for name, pattern in DPDPA_PATTERNS:
        matches = pattern.findall(out)
        if matches:
            count = len(matches)
            redactions[name] = count
            out = pattern.sub(f"[REDACTED:{name}]", out)

    # Presidio covers the PII classes that cannot be safely identified with a
    # portable regex alone, especially PERSON and LOCATION/ADDRESS.
    analyzer = _presidio_analyzer()
    if analyzer is not None and out:
        try:
            results = analyzer.analyze(
                text=out,
                language="en",
                entities=[
                    "PERSON",
                    "LOCATION",
                    "ADDRESS",
                    "PHONE_NUMBER",
                    "EMAIL_ADDRESS",
                    "CREDIT_CARD",
                    "IP_ADDRESS",
                    "DATE_TIME",
                ],
                score_threshold=0.6,
            )
            labels = {
                "PERSON": "PERSON",
                "LOCATION": "LOCATION",
                "ADDRESS": "ADDRESS",
                "PHONE_NUMBER": "PHONE",
                "EMAIL_ADDRESS": "EMAIL",
                "CREDIT_CARD": "CARD",
                "IP_ADDRESS": "IP",
                "DATE_TIME": "DATE_TIME",
            }
            for result in sorted(results, key=lambda item: item.start, reverse=True):
                label = labels.get(result.entity_type)
                if not label:
                    continue
                out = out[: result.start] + f"[REDACTED:{label}]" + out[result.end :]
                redactions[label] = redactions.get(label, 0) + 1
        except Exception:  # noqa: BLE001 - fail back to deterministic regexes
            # The regex pass above already ran; never log the text itself.
            logging.getLogger(__name__).warning("redaction.ner_unavailable")

    return RedactionSummary(
        redacted_text=out,
        redactions=redactions,
        original_hash=original_hash,
        redacted_hash=hashlib.sha256(out.encode("utf-8")).hexdigest(),
    )


def redact_variables(variables: dict[str, Any]) -> tuple[dict[str, Any], dict[str, int]]:
    """Redact string values in a variables dict, recursively."""
    all_redactions: dict[str, int] = {}
    out = _walk(variables, all_redactions)
    return out, all_redactions


def _walk(value: Any, accum: dict[str, int]) -> Any:
    if isinstance(value, str):
        r = redact(value)
        for k, v in r.redactions.items():
            accum[k] = accum.get(k, 0) + v
        return r.redacted_text
    if isinstance(value, dict):
        return {k: _walk(v, accum) for k, v in value.items()}
    if isinstance(value, list):
        return [_walk(v, accum) for v in value]
    return value
