"""PII redactor — runs on the Model Gateway before any data egress.

The Model Gateway redacts personal data values before they leave
the agent runtime to a third-party model provider. Per Doc 05 §6,
no major LLM vendor today guarantees India-only inference, so the
redaction is load-bearing — not aspirational.

This module is the canonical redaction logic. It runs:
  - At the agent runtime boundary, before any model call that has
    `pii_redact=True`
  - On values from anywhere in the request payload, not just the
    prompt text
"""

from __future__ import annotations

import re
from dataclasses import dataclass


# Patterns covering the common DPDPA-relevant PII types
PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("PAN", re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b")),
    ("AADHAAR", re.compile(r"\b\d{4}\s?\d{4}\s?\d{4}\b")),
    ("PASSPORT", re.compile(r"\b[A-PR-WY][0-9]{7}\b")),
    ("IFSC", re.compile(r"\b[A-Z]{4}0[A-Z0-9]{6}\b")),
    ("UPI", re.compile(r"\b[\w.-]+@[\w.-]+\b")),
    ("EMAIL", re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")),
    ("PHONE_IN", re.compile(r"(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b")),
    ("CARD", re.compile(r"\b(?:\d[ -]?){13,19}\b")),
]


@dataclass(frozen=True)
class RedactionResult:
    redacted_text: str
    redactions: list[dict[str, str]]


def redact_text(text: str, *, replacement: str = "[REDACTED:{}]") -> RedactionResult:
    """Redact known PII patterns in a string. Returns the redacted
    text and a list of {type, count} for the redaction summary.
    """
    redactions: list[dict[str, str]] = []
    out = text
    for name, pattern in PATTERNS:
        matches = pattern.findall(out)
        if matches:
            count = len(matches)
            out = pattern.sub(replacement.format(name), out)
            redactions.append({"type": name, "count": str(count)})
    return RedactionResult(redacted_text=out, redactions=redactions)


def redact_dict(data: dict[str, object], *, depth: int = 0) -> tuple[dict[str, object], list[dict[str, str]]]:
    """Recursively redact string values in a dict. Non-string values
    are passed through. Lists are recursed into.
    """
    if depth > 8:
        return data, []
    all_redactions: list[dict[str, str]] = []
    out: dict[str, object] = {}
    for k, v in data.items():
        if isinstance(v, str):
            r = redact_text(v)
            if r.redactions:
                all_redactions.extend(r.redactions)
                out[k] = r.redacted_text
            else:
                out[k] = v
        elif isinstance(v, dict):
            sub, sub_red = redact_dict(v, depth=depth + 1)
            out[k] = sub
            all_redactions.extend(sub_red)
        elif isinstance(v, list):
            new_list: list[object] = []
            for item in v:
                if isinstance(item, str):
                    r = redact_text(item)
                    if r.redactions:
                        all_redactions.extend(r.redactions)
                        new_list.append(r.redacted_text)
                    else:
                        new_list.append(item)
                elif isinstance(item, dict):
                    sub, sub_red = redact_dict(item, depth=depth + 1)
                    new_list.append(sub)
                    all_redactions.extend(sub_red)
                else:
                    new_list.append(item)
            out[k] = new_list
        else:
            out[k] = v
    return out, all_redactions
