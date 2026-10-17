"""Control library loader.

Loads control libraries from generated JSON mirrors (built by
`pnpm tsx scripts/build-controls-json.mjs` from the TypeScript source
of truth in packages/control-library/src).

Mirrors are per version: the default version keeps its historical
`data/controls.json`; other versions are `data/controls-<version>.json`.
`load_library(version)` resolves an explicit version and refuses an unknown
one; it never substitutes the latest. `load_default_library()` is unchanged.
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import NotRequired, TypedDict

from .enum_types import QualifiedStringEnum


class ControlDomain(QualifiedStringEnum):
    GOV = "GOV"
    CNS = "CNS"
    DAT = "DAT"
    RCD = "RCD"
    BRCH = "BRCH"
    XBR = "XBR"
    CHD = "CHD"
    SDF = "SDF"
    SEC = "SEC"
    RTN = "RTN"
    DPF = "DPF"
    AUD = "AUD"
    DPIA = "DPIA"


class ControlSeverity(QualifiedStringEnum):
    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class EvidenceType(QualifiedStringEnum):
    DOCUMENT = "document"
    CONFIG = "config"
    SCREENSHOT = "screenshot"
    LOG = "log"
    ATTESTATION = "attestation"
    INTERVIEW = "interview"
    INVENTORY = "inventory"
    REPORT = "report"


class RawCitation(TypedDict):
    instrument: str
    reference: str
    url: NotRequired[str | None]


class RawEvidenceRequirement(TypedDict):
    type: str
    description: str
    retention: NotRequired[str | None]


class RawScoring(TypedDict):
    baseline: float
    weight: float
    penaltyPoints: float
    maxPenaltyINR: int


class RawControl(TypedDict):
    id: str
    title: str
    obligation: str
    domain: str
    severity: str
    scoring: RawScoring
    library_version: NotRequired[str]
    introduced_in_version: NotRequired[str]
    revised_in_version: NotRequired[str | None]
    notes: NotRequired[str | None]
    citations: NotRequired[list[RawCitation]]
    evidence_required: NotRequired[list[RawEvidenceRequirement]]
    assessment_questions: NotRequired[list[dict[str, object]]]
    remediation_patterns: NotRequired[list[str]]
    tags: NotRequired[list[str]]
    sdf_only: NotRequired[bool]
    children_only: NotRequired[bool]


@dataclass(frozen=True)
class ControlScoring:
    baseline: float
    weight: float
    penalty_points: float
    max_penalty_inr: int


@dataclass(frozen=True)
class ControlCitation:
    instrument: str
    reference: str
    url: str | None = None


@dataclass(frozen=True)
class ControlEvidenceRequirement:
    type: EvidenceType
    description: str
    retention: str | None = None


@dataclass(frozen=True)
class Control:
    id: str
    library_version: str
    title: str
    obligation: str
    domain: ControlDomain
    severity: ControlSeverity
    citations: tuple[ControlCitation, ...]
    evidence_required: tuple[ControlEvidenceRequirement, ...]
    assessment_questions: tuple[dict[str, object], ...]
    scoring: ControlScoring
    remediation_patterns: tuple[str, ...]
    tags: tuple[str, ...]
    sdf_only: bool
    children_only: bool
    introduced_in_version: str
    revised_in_version: str | None = None
    notes: str | None = None


def _parse_control(raw: RawControl) -> Control:
    citations = tuple(
        ControlCitation(
            instrument=c["instrument"],
            reference=c["reference"],
            url=c.get("url"),
        )
        for c in raw.get("citations", [])
    )
    evidence = tuple(
        ControlEvidenceRequirement(
            type=EvidenceType(e["type"]),
            description=e["description"],
            retention=e.get("retention"),
        )
        for e in raw.get("evidence_required", [])
    )
    scoring_raw = raw["scoring"]
    return Control(
        id=raw["id"],
        library_version=raw.get("library_version") or raw.get("introduced_in_version", "0.1.0"),
        title=raw["title"],
        obligation=raw["obligation"],
        domain=ControlDomain(raw["domain"]),
        severity=ControlSeverity(raw["severity"]),
        citations=citations,
        evidence_required=evidence,
        assessment_questions=tuple(raw.get("assessment_questions", [])),
        scoring=ControlScoring(
            baseline=scoring_raw["baseline"],
            weight=scoring_raw["weight"],
            penalty_points=scoring_raw["penaltyPoints"],
            max_penalty_inr=scoring_raw["maxPenaltyINR"],
        ),
        remediation_patterns=tuple(raw.get("remediation_patterns", [])),
        tags=tuple(raw.get("tags", [])),
        sdf_only=bool(raw.get("sdf_only", False)),
        children_only=bool(raw.get("children_only", False)),
        introduced_in_version=raw.get("introduced_in_version", "0.1.0"),
        revised_in_version=raw.get("revised_in_version"),
        notes=raw.get("notes"),
    )


class ControlLibrary:
    def __init__(
        self, version: str, controls: list[Control], legal: dict[str, object] | None = None,
    ):
        self.version = version
        # Version legal metadata (commencement, classification); None for 0.1.1.
        self.legal = legal
        self._controls: tuple[Control, ...] = tuple(controls)
        self._by_id: dict[str, Control] = {c.id: c for c in controls}

    def __len__(self) -> int:
        return len(self._controls)

    def __iter__(self) -> Iterator[Control]:
        return iter(self._controls)

    def get(self, control_id: str) -> Control | None:
        return self._by_id.get(control_id)

    def effective_from(self, control_id: str) -> str | None:
        """Phased commencement date for a control, if this version records it."""
        if not self.legal:
            return None
        entries = self.legal.get("commencement")
        if not isinstance(entries, list):
            return None
        for entry in entries:
            if isinstance(entry, dict) and entry.get("control_id") == control_id:
                value = entry.get("effective_from")
                return value if isinstance(value, str) else None
        return None

    def filter(
        self,
        *,
        domain: ControlDomain | None = None,
        severity: ControlSeverity | None = None,
        sdf_only: bool | None = None,
        children_only: bool | None = None,
    ) -> list[Control]:
        out: list[Control] = []
        for c in self._controls:
            if domain is not None and c.domain != domain:
                continue
            if severity is not None and c.severity != severity:
                continue
            if sdf_only is not None and c.sdf_only != sdf_only:
                continue
            if children_only is not None and c.children_only != children_only:
                continue
            out.append(c)
        return out


def load_library_from_file(path: str | os.PathLike[str]) -> ControlLibrary:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    version = data.get("version") or data.get("library_version")
    if not version:
        raise ValueError(f"Library file {path} missing version")
    parsed = [_parse_control(c) for c in data.get("controls", [])]
    legal = data.get("legal")
    if legal is not None and not isinstance(legal, dict):
        raise ValueError(f"Library file {path} has malformed legal metadata")
    return ControlLibrary(version=version, controls=parsed, legal=legal)


_DEFAULT_LIB_PATH = (
    Path(__file__).parent / "data" / "controls.json"
)


_DATA_DIR = Path(__file__).parent / "data"
_VERSION_RE = re.compile(r"\d{1,4}\.\d{1,4}\.\d{1,4}")


class UnknownLibraryVersionError(LookupError):
    """Raised when no bundled mirror exists for the requested version."""


def bundled_library_versions() -> tuple[str, ...]:
    """Versions with a bundled mirror, sorted by semver."""
    found: set[str] = set()
    if _DEFAULT_LIB_PATH.exists():
        with open(_DEFAULT_LIB_PATH, encoding="utf-8") as f:
            found.add(str(json.load(f).get("version")))
    for p in _DATA_DIR.glob("controls-*.json"):
        v = p.name[len("controls-"):-len(".json")]
        if _VERSION_RE.fullmatch(v):
            found.add(v)
    return tuple(sorted(found, key=lambda v: tuple(int(x) for x in v.split("."))))


def load_library(version: str) -> ControlLibrary:
    """Load exactly `version` from the bundled mirrors, or refuse.

    Historical assessments and reports must verify against the version they
    recorded; this never falls back to the default or to the latest.
    """
    if not isinstance(version, str) or not _VERSION_RE.fullmatch(version):
        raise UnknownLibraryVersionError("control library version refused")
    candidates = [_DATA_DIR / f"controls-{version}.json", _DEFAULT_LIB_PATH]
    for path in candidates:
        if not path.exists():
            continue
        lib = load_library_from_file(path)
        if lib.version == version:
            if any(c.library_version != version for c in lib):
                raise ValueError("control library row version mismatch")
            return lib
    raise UnknownLibraryVersionError(f"no bundled control library {version}")


def load_default_library() -> ControlLibrary:
    """Load the bundled v0.1.0 library.

    If services/agent-runtime/src/axiom/data/controls.json is missing,
    the agent runtime can still operate by loading the library from
    Supabase at startup. This function returns a minimal in-code
    library with one representative control so the agents have
    something to score against in test environments.
    """
    if _DEFAULT_LIB_PATH.exists():
        return load_library_from_file(_DEFAULT_LIB_PATH)
    # Minimal in-code fallback. Production loads from Supabase.
    fallback = [
        Control(
            id="DPDPA-GOV-001",
            library_version="0.1.0",
            title="Designate a data fiduciary accountable for DPDPA compliance",
            obligation=(
                "Every entity that determines the purpose and means of "
                "processing digital personal data is a Data Fiduciary and "
                "bears primary statutory accountability under Section 8."
            ),
            domain=ControlDomain.GOV,
            severity=ControlSeverity.CRITICAL,
            citations=(ControlCitation("DPDPA-2023", "Section 2(i), 2(k), 8(1)"),),
            evidence_required=(
                ControlEvidenceRequirement(
                    type=EvidenceType.DOCUMENT,
                    description="Board resolution or partnership deed naming the Data Fiduciary entity",
                ),
            ),
            assessment_questions=(
                {
                    "id": "Q1",
                    "prompt": "Is there a single legal entity formally identified as the Data Fiduciary?",
                    "type": "boolean",
                    "evidenceTypes": ["document", "config"],
                },
            ),
            scoring=ControlScoring(0, 1, 30, 25_00_00_000),
            remediation_patterns=("dpo-appointment", "review"),
            tags=("foundation", "always-applies"),
            sdf_only=False,
            children_only=False,
            introduced_in_version="0.1.0",
        ),
    ]
    return ControlLibrary(version="0.1.0", controls=fallback)


# ─── W7.3/W7.4 · Multi-regulator overlay and sector packs ────────────
# The generated JSON carries a `sector_packs` section (frameworks,
# framework_controls, control_mappings, packs) built from the TypeScript
# source of truth. The runtime scores DPDPA controls; this section lets it
# report cross-framework coverage and pack membership. Parsing is additive:
# a file without the section yields an empty bundle, so older JSON stays
# loadable.


class MappingStrength(QualifiedStringEnum):
    """M4.2 mapping strength. 'equivalent' requires regulator-side verification."""

    EQUIVALENT = "equivalent"
    PARTIAL = "partial"
    INDICATIVE = "indicative"


class MappingProvenance(QualifiedStringEnum):
    """Honest provenance vocabulary; 'vendor-verified' is deliberately absent
    until client tenants exist."""

    REFERENCE = "reference"
    MAPPED = "mapped"


@dataclass(frozen=True)
class Framework:
    code: str
    regulator: str
    title: str
    description: str
    source_url: str
    verified_on: str
    verified_by: str
    notes: str | None = None


@dataclass(frozen=True)
class FrameworkControl:
    framework_code: str
    ref: str
    heading: str


@dataclass(frozen=True)
class ControlMapping:
    framework_code: str
    ref: str
    control_id: str
    mapping_strength: MappingStrength
    provenance: MappingProvenance
    note: str
    scope: str = "legacy_global_unqualified"


@dataclass(frozen=True)
class MappingContext:
    publication_version: str
    library_version: str
    sector_pack_code: str
    framework_code: str
    ref: str
    control_id: str
    mapping_strength: MappingStrength
    provenance: MappingProvenance
    note: str
    origin: str = "reviewed_source_reference"


@dataclass(frozen=True)
class SectorPack:
    code: str
    name: str
    sector: str
    description: str
    framework_codes: tuple[str, ...]
    control_ids: tuple[str, ...]
    evidence_requirements: tuple[dict[str, str], ...]
    remediation_patterns: tuple[str, ...]
    provenance: MappingProvenance
    basis: str


@dataclass(frozen=True)
class SectorPackBundle:
    frameworks: tuple[Framework, ...]
    framework_controls: tuple[FrameworkControl, ...]
    control_mappings: tuple[ControlMapping, ...]
    packs: tuple[SectorPack, ...]
    mapping_contexts: tuple[MappingContext, ...] = ()

    def for_sector_control(
        self, publication_version: str, sector_pack_code: str, control_id: str,
    ) -> tuple[MappingContext, ...]:
        """Sector-qualified source references; never fall back to global legacy notes.

        Bundled source metadata does not attest database publication or client verification.
        """
        return tuple(m for m in self.mapping_contexts if
                     m.publication_version == publication_version and
                     m.sector_pack_code == sector_pack_code and m.control_id == control_id)

    def for_control(self, control_id: str) -> tuple[ControlMapping, ...]:
        """Legacy unqualified compatibility data; not authoritative sector notes."""
        return tuple(m for m in self.control_mappings if m.control_id == control_id)

    def pack_for_sector(self, sector: str) -> SectorPack | None:
        for p in self.packs:
            if p.sector == sector:
                return p
        return None


def _context_strings(value: object, fields: dict[str, int]) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) != set(fields):
        raise ValueError("Mapping context shape refused")
    result: dict[str, str] = {}
    for key, maximum in fields.items():
        item = value[key]
        if not isinstance(item, str) or not 1 <= len(item) <= maximum:
            raise ValueError("Mapping context value refused")
        result[key] = item
    return result


def _parse_mapping_contexts(
    value: object, version: object, packs: tuple[SectorPack, ...],
    framework_controls: tuple[FrameworkControl, ...],
) -> tuple[MappingContext, ...]:
    if value is None:
        return ()  # Legacy mirror compatibility, with no invented sector authority.
    if not isinstance(value, dict) or set(value) != {"origin", "publicationVersion", "libraryVersion", "contexts"}:
        raise ValueError("Mapping context publication shape refused")
    publication_version = value["publicationVersion"]
    if (value["origin"] != "reviewed_source_reference" or not isinstance(publication_version, str)
            or not re.fullmatch(r"[a-z0-9][a-z0-9.-]{2,79}", publication_version)
            or not isinstance(version, str) or value["libraryVersion"] != version):
        raise ValueError("Mapping context publication binding refused")
    raw_contexts = value["contexts"]
    if not isinstance(raw_contexts, list) or not 1 <= len(raw_contexts) <= 1000:
        raise ValueError("Mapping context count refused")
    by_pack = {p.code: p for p in packs}
    refs = {(f.framework_code, f.ref) for f in framework_controls}
    seen: set[tuple[str, str, str, str]] = set()
    contexts: list[MappingContext] = []
    for raw_context in raw_contexts:
        m = _context_strings(raw_context, {"sectorPackCode": 64, "frameworkCode": 64, "ref": 300,
                                          "controlId": 100, "mappingStrength": 20, "provenance": 20, "note": 2000})
        pack = by_pack.get(m["sectorPackCode"])
        key = (m["sectorPackCode"], m["frameworkCode"], m["ref"], m["controlId"])
        strength = MappingStrength(m["mappingStrength"])
        provenance = MappingProvenance(m["provenance"])
        if (key in seen or pack is None or m["controlId"] not in pack.control_ids
                or m["frameworkCode"] not in pack.framework_codes or (m["frameworkCode"], m["ref"]) not in refs
                or (strength == MappingStrength.EQUIVALENT and provenance == MappingProvenance.REFERENCE)):
            raise ValueError("Mapping context reference refused")
        seen.add(key)
        contexts.append(MappingContext(publication_version, version, m["sectorPackCode"], m["frameworkCode"],
                                       m["ref"], m["controlId"], strength, provenance, m["note"]))
    for pack in packs:
        if {m.control_id for m in contexts if m.sector_pack_code == pack.code} != set(pack.control_ids):
            raise ValueError("Mapping context pack coverage refused")
    return tuple(contexts)


def load_sector_packs_from_file(path: str | os.PathLike[str]) -> SectorPackBundle:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    raw = data.get("sector_packs") or {}
    frameworks = tuple(
        Framework(
            code=f["code"],
            regulator=f["regulator"],
            title=f["title"],
            description=f.get("description", ""),
            source_url=f["source_url"],
            verified_on=f["verified_on"],
            verified_by=f["verified_by"],
            notes=f.get("notes"),
        )
        for f in raw.get("frameworks", [])
    )
    framework_controls = tuple(
        FrameworkControl(
            framework_code=fc["framework_code"],
            ref=fc["ref"],
            heading=fc["heading"],
        )
        for fc in raw.get("framework_controls", [])
    )
    control_mappings = tuple(
        ControlMapping(
            framework_code=m["framework_code"],
            ref=m["ref"],
            control_id=m["control_id"],
            mapping_strength=MappingStrength(m["mapping_strength"]),
            provenance=MappingProvenance(m["provenance"]),
            note=m["note"],
        )
        for m in raw.get("control_mappings", [])
    )
    packs = tuple(
        SectorPack(
            code=p["code"],
            name=p["name"],
            sector=p["sector"],
            description=p.get("description", ""),
            framework_codes=tuple(p.get("framework_codes", [])),
            control_ids=tuple(p.get("control_ids", [])),
            evidence_requirements=tuple(p.get("evidence_requirements", [])),
            remediation_patterns=tuple(p.get("remediation_patterns", [])),
            provenance=MappingProvenance(p.get("provenance", "reference")),
            basis=p.get("basis", ""),
        )
        for p in raw.get("packs", [])
    )
    return SectorPackBundle(
        frameworks=frameworks,
        framework_controls=framework_controls,
        control_mappings=control_mappings,
        packs=packs,
        mapping_contexts=_parse_mapping_contexts(raw.get("mapping_context_publication"), data.get("version"), packs, framework_controls),
    )


def load_default_sector_packs() -> SectorPackBundle:
    """Load the bundled sector-pack section of the generated library JSON.

    Returns an empty bundle when the file is missing or predates the
    section — callers degrade to DPDPA-only behaviour, never to an error.
    """
    if not _DEFAULT_LIB_PATH.exists():
        return SectorPackBundle(frameworks=(), framework_controls=(), control_mappings=(), packs=())
    return load_sector_packs_from_file(_DEFAULT_LIB_PATH)
