"""Service-only capabilities for bounded public-source proposal processing.

This module performs no HTTP, DNS, storage or authority lookup. The trusted
composition must use the existing pinned public-website fetcher, retain its
actual capture, and call ``from_guarded_capture`` with the same body bytes.
A SHA validates bytes/projection consistency, never the origin's truth or a
legal conclusion. Neither this capability nor source documents are accepted
from agent business-input JSON. Generic runtime dispatch has no capability
and therefore remains unavailable until a trusted composition is installed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import urlsplit
from uuid import UUID

from .canonicalise import canonical_json, sha256_hex

MAX_SOURCE_BYTES = 512 * 1024
MAX_DOCUMENTS = 4
GOVERNMENT_HOSTS = frozenset(
    {
        "meity.gov.in",
        "www.meity.gov.in",
        "dpb.gov.in",
        "www.dpb.gov.in",
        "egazette.gov.in",
        "www.egazette.gov.in",
    }
)


def public_source_url(value: str) -> str:
    """Transport consistency only; upstream must still validate/pin every DNS hop."""
    if not isinstance(value, str) or len(value) > 2048:
        raise ValueError("public_source_url_refused")
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.port
        or parsed.query
        or parsed.fragment
        or not re.fullmatch(
            r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}", parsed.hostname
        )
        or re.search(
            r"(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$", parsed.hostname
        )
        or any(ord(character) < 32 or character.isspace() for character in value)
    ):
        raise ValueError("public_source_url_refused")
    return value


def capture_time(value: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError("public_capture_time_refused")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("public_capture_time_refused")
    return parsed.astimezone(UTC)


def public_origin(value: str) -> str:
    parsed = urlsplit(public_source_url(value))
    return f"https://{parsed.hostname}"


def _bounded_heading(value: str, limit: int) -> str:
    if (
        not isinstance(value, str)
        or len(value) > limit
        or any(ord(character) < 32 and character not in "\t\n\r" for character in value)
    ):
        raise ValueError("public_projection_text_refused")
    # These are already bounded DOM title/headings from the guarded producer;
    # no paragraphs, form values, attributes, script text or contact records.
    return " ".join(value.split())


@dataclass(frozen=True, slots=True)
class GuardedPublicDocument:
    requested_url: str
    final_url: str
    checked_at: str
    content_sha256: str
    byte_size: int
    title: str
    headings: tuple[str, ...]
    capture_reference: str

    def __post_init__(self):
        public_source_url(self.requested_url)
        public_source_url(self.final_url)
        capture_time(self.checked_at)
        if not isinstance(self.content_sha256, str) or not re.fullmatch(
            r"[a-f0-9]{64}", self.content_sha256
        ):
            raise ValueError("public_content_digest_refused")
        if type(self.byte_size) is not int or not 1 <= self.byte_size <= MAX_SOURCE_BYTES:
            raise ValueError("public_content_budget_refused")
        if (
            type(self.headings) is not tuple
            or len(self.headings) > 12
            or _bounded_heading(self.title, 500) != self.title
            or any(_bounded_heading(value, 500) != value for value in self.headings)
        ):
            raise ValueError("public_projection_bounds_refused")
        UUID(self.capture_reference)

    @classmethod
    def from_guarded_capture(
        cls,
        *,
        requested_url: str,
        final_url: str,
        checked_at: str,
        content_sha256: str,
        body: bytes,
        title: str,
        headings: tuple[str, ...],
        capture_reference: str,
    ):
        """Called by trusted fetch composition, never on caller-supplied prose.

        The title/headings must come from the guarded producer's DOM projection.
        They are not asserted to be independently verified legal/public notices.
        Raw body is checked then discarded; it never becomes model input/output.
        """
        if (
            type(body) is not bytes
            or type(headings) is not tuple
            or not 1 <= len(body) <= MAX_SOURCE_BYTES
            or sha256_hex(body) != content_sha256
        ):
            raise ValueError("guarded_capture_content_mismatch")
        return cls(
            requested_url=requested_url,
            final_url=final_url,
            checked_at=checked_at,
            content_sha256=content_sha256,
            byte_size=len(body),
            title=_bounded_heading(title, 500),
            headings=tuple(_bounded_heading(value, 500) for value in headings),
            capture_reference=capture_reference,
        )

    @property
    def projection_sha256(self) -> str:
        return sha256_hex(
            canonical_json(
                {
                    "requested_url": self.requested_url,
                    "final_url": self.final_url,
                    "checked_at": self.checked_at,
                    "content_sha256": self.content_sha256,
                    "byte_size": self.byte_size,
                    "title": self.title,
                    "headings": list(self.headings),
                    "capture_reference": self.capture_reference,
                }
            )
        )


@dataclass(frozen=True, slots=True)
class VerifiedPublicSourceBatch:
    """Per-dispatch service capability; no reusable, cross-tenant agent state."""

    tenant_id: str
    correlation_id: str
    agent: str
    approved_origins: tuple[str, ...]
    documents: tuple[GuardedPublicDocument, ...]
    previous_documents: tuple[GuardedPublicDocument, ...] = ()

    def __post_init__(self):
        UUID(self.tenant_id)
        UUID(self.correlation_id)
        if self.agent not in {"nazar", "sanket"}:
            raise ValueError("public_signal_agent_refused")
        if (
            type(self.approved_origins) is not tuple
            or not self.approved_origins
            or len(self.approved_origins) > MAX_DOCUMENTS
            or len(set(self.approved_origins)) != len(self.approved_origins)
            or any(public_origin(value) != value for value in self.approved_origins)
        ):
            raise ValueError("approved_public_origins_required")
        for collection, allow_empty in ((self.documents, False), (self.previous_documents, True)):
            if (
                type(collection) is not tuple
                or not 1 <= len(collection) <= MAX_DOCUMENTS
                or any(type(document) is not GuardedPublicDocument for document in collection)
            ):
                if collection == () and allow_empty:
                    continue
                raise ValueError("bounded_guarded_documents_required")
            if len({document.requested_url for document in collection}) != len(collection):
                raise ValueError("duplicate_guarded_source_refused")
            for document in collection:
                if (
                    public_origin(document.requested_url) not in self.approved_origins
                    or public_origin(document.final_url) not in self.approved_origins
                ):
                    raise ValueError("unapproved_public_source_refused")
                if self.agent == "nazar" and (
                    urlsplit(document.requested_url).hostname not in GOVERNMENT_HOSTS
                    or urlsplit(document.final_url).hostname not in GOVERNMENT_HOSTS
                ):
                    raise ValueError("government_source_required")
        current = {document.requested_url: document for document in self.documents}
        for previous in self.previous_documents:
            if (
                previous.requested_url not in current
                or previous.capture_reference == current[previous.requested_url].capture_reference
                or capture_time(previous.checked_at)
                >= capture_time(current[previous.requested_url].checked_at)
            ):
                raise ValueError("earlier_source_baseline_required")

    def for_dispatch(self, *, agent: str, tenant_id: str | None, correlation_id: str):
        if (
            agent != self.agent
            or tenant_id is None
            or str(UUID(tenant_id)) != str(UUID(self.tenant_id))
            or str(UUID(correlation_id)) != str(UUID(self.correlation_id))
        ):
            raise ValueError("public_source_dispatch_binding_refused")
        return self


def require_public_sources(value, *, agent: str, tenant_id: str | None, correlation_id: str):
    if type(value) is not VerifiedPublicSourceBatch:
        raise ValueError("trusted_public_source_capability_required")
    return value.for_dispatch(agent=agent, tenant_id=tenant_id, correlation_id=correlation_id)
