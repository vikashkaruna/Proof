"""Tests for the sector-pack section of the control library mirror (W7.3/W7.4)."""

from axiom.control_library_loader import (
    MappingProvenance,
    MappingStrength,
    load_default_library,
    load_default_sector_packs,
    load_sector_packs_from_file,
)


def test_bundled_pack_loads_with_reference_provenance():
    bundle = load_default_sector_packs()
    assert len(bundle.frameworks) > 0
    assert len(bundle.framework_controls) > 0
    assert len(bundle.control_mappings) > 0
    assert len(bundle.packs) == 3

    bfsi = bundle.pack_for_sector("BFSI")
    assert bfsi is not None
    assert bfsi.code == "BFSI-1"
    assert bfsi.sector == "BFSI"
    assert len(bfsi.control_ids) > 0

    healthcare = bundle.pack_for_sector("Healthcare")
    assert healthcare is not None
    assert healthcare.code == "IN-HEALTHCARE-2024"
    assert healthcare.sector == "Healthcare"
    assert len(healthcare.control_ids) > 0

    tech = bundle.pack_for_sector("Tech/E-commerce")
    assert tech is not None
    assert tech.code == "IN-TECH-2024"
    assert tech.sector == "Tech/E-commerce"
    assert len(tech.control_ids) > 0

    # Every mapping is honestly labelled: reference provenance, and no
    # mapping claims equivalence — none has been verified against the
    # regulators' printed text.
    for mapping in bundle.control_mappings:
        assert mapping.provenance == MappingProvenance.REFERENCE
        assert mapping.mapping_strength in (MappingStrength.PARTIAL, MappingStrength.INDICATIVE)
        assert mapping.note

    # Every mapping resolves to a published control in the same library.
    library = load_default_library()
    known = {c.id for c in library}
    for mapping in bundle.control_mappings:
        assert mapping.control_id in known
    for pack in bundle.packs:
        for control_id in pack.control_ids:
            assert control_id in known


def test_legacy_compatibility_pack_framework_union():
    bundle = load_default_sector_packs()
    for pack in bundle.packs:
        pack_mappings = [
            m for m in bundle.control_mappings if m.framework_code in pack.framework_codes
        ]
        assert sorted(pack.control_ids) == sorted({m.control_id for m in pack_mappings})


def test_legacy_for_control_returns_unqualified_compatibility_coverage():
    bundle = load_default_sector_packs()
    # SEC-001 is deliberately mapped from more than one regulator.
    coverage = bundle.for_control("DPDPA-SEC-001")
    assert len(coverage) >= 2
    assert {m.framework_code for m in coverage} >= {
        "RBI-MD-ITG",
        "SEBI-CYBER-RESILIENCE",
        "MOHFW-EHR-STANDARDS",
        "MEITY-SPDI-2011",
    }
    assert bundle.for_control("DPDPA-GOV-001")


def test_pack_for_sector_lookup():
    bundle = load_default_sector_packs()
    assert bundle.pack_for_sector("BFSI") is not None
    assert bundle.pack_for_sector("Healthcare") is not None
    assert bundle.pack_for_sector("Tech/E-commerce") is not None
    assert bundle.pack_for_sector("UnknownSector") is None


def test_missing_section_degrades_to_empty_bundle(tmp_path):
    legacy = tmp_path / "legacy.json"
    legacy.write_text('{"version": "0.1.0", "controls": []}', encoding="utf-8")
    bundle = load_sector_packs_from_file(legacy)
    assert bundle.frameworks == ()
    assert bundle.control_mappings == ()
    assert bundle.packs == ()
    assert bundle.pack_for_sector("BFSI") is None


def test_authoritative_sector_source_notes_never_use_global_legacy_fallback():
    bundle = load_default_sector_packs()
    assert len(bundle.mapping_contexts) == 44
    assert all(m.scope == "legacy_global_unqualified" for m in bundle.control_mappings)
    pack_codes = ["BFSI-1", "IN-HEALTHCARE-2024", "IN-TECH-2024"]
    notes = []
    for code in pack_codes:
        mappings = bundle.for_sector_control("mapping-contexts-2026-10-13.v1", code, "DPDPA-BRCH-001")
        selected = [m for m in mappings if m.ref == "six-hour-incident-report"]
        assert len(selected) == 1
        assert selected[0].sector_pack_code == code
        assert selected[0].library_version == "0.1.1"
        assert selected[0].origin == "reviewed_source_reference"  # Not actual publication/receipt proof.
        notes.append(selected[0].note)
    assert len(set(notes)) == 3
    assert bundle.for_sector_control("unknown-version", pack_codes[0], "DPDPA-BRCH-001") == ()
    assert bundle.for_sector_control("mapping-contexts-2026-10-13.v1", "unknown-sector", "DPDPA-BRCH-001") == ()


def test_context_pack_coverage_uses_exact_sector_not_framework_only():
    bundle = load_default_sector_packs()
    for pack in bundle.packs:
        covered = {m.control_id for m in bundle.mapping_contexts if m.sector_pack_code == pack.code}
        assert covered == set(pack.control_ids)


def test_old_mirror_keeps_legacy_data_but_invents_no_contexts(tmp_path):
    import json
    from pathlib import Path
    path = Path(__file__).parents[1] / "src/axiom/data/controls.json"
    data = json.loads(path.read_text())
    del data["sector_packs"]["mapping_context_publication"]
    fixture = tmp_path / "legacy-context.json"
    fixture.write_text(json.dumps(data))
    bundle = load_sector_packs_from_file(fixture)
    assert len(bundle.control_mappings) == 44
    assert bundle.mapping_contexts == ()
    assert bundle.for_sector_control("mapping-contexts-2026-10-13.v1", "BFSI-1", "DPDPA-BRCH-001") == ()


def test_malformed_context_source_is_refused_without_using_legacy_notes(tmp_path):
    import json
    from pathlib import Path

    import pytest
    path = Path(__file__).parents[1] / "src/axiom/data/controls.json"
    pristine = json.loads(path.read_text())
    mutations = [
        lambda p: p.update(origin="database_published"),
        lambda p: p.update(libraryVersion="foreign-version"),
        lambda p: p.update(contexts=p["contexts"] + [p["contexts"][0]]),
        lambda p: p["contexts"][0].update(sectorPackCode="FOREIGN"),
        lambda p: p["contexts"][0].update(controlId="FOREIGN"),
        lambda p: p["contexts"][0].update(ref="foreign-ref"),
        lambda p: p["contexts"][0].update(frameworkCode="FOREIGN"),
        lambda p: p["contexts"][0].update(mappingStrength="equivalent"),
        lambda p: p["contexts"][0].update(provenance="vendor-verified"),
        lambda p: p["contexts"][0].update(note=False),
        lambda p: p["contexts"][0].update(extra="unknown"),
        lambda p: p.update(contexts=[]),
        lambda p: p.update(publicationVersion="BAD VERSION"),
    ]
    for mutate in mutations:
        data = json.loads(json.dumps(pristine))
        mutate(data["sector_packs"]["mapping_context_publication"])
        fixture = tmp_path / "refused-context.json"
        fixture.write_text(json.dumps(data))
        with pytest.raises(ValueError, match=r"(Mapping context|MappingProvenance)"):
            load_sector_packs_from_file(fixture)
