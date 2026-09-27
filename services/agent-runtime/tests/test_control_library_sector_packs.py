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
    assert len(bundle.packs) == 1

    pack = bundle.packs[0]
    assert pack.code == "BFSI-1"
    assert pack.sector == "BFSI"
    assert len(pack.control_ids) > 0

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
    for control_id in pack.control_ids:
        assert control_id in known


def test_pack_subset_is_the_mapped_control_union():
    bundle = load_default_sector_packs()
    pack = bundle.packs[0]
    assert sorted(pack.control_ids) == sorted({m.control_id for m in bundle.control_mappings})


def test_for_control_returns_cross_framework_coverage():
    bundle = load_default_sector_packs()
    # SEC-001 is deliberately mapped from more than one regulator.
    coverage = bundle.for_control("DPDPA-SEC-001")
    assert len(coverage) >= 2
    assert {m.framework_code for m in coverage} >= {"RBI-MD-ITG", "SEBI-CYBER-RESILIENCE"}
    assert bundle.for_control("DPDPA-GOV-001")


def test_pack_for_sector_lookup():
    bundle = load_default_sector_packs()
    assert bundle.pack_for_sector("BFSI") is not None
    assert bundle.pack_for_sector("Healthcare") is None


def test_missing_section_degrades_to_empty_bundle(tmp_path):
    legacy = tmp_path / "legacy.json"
    legacy.write_text('{"version": "0.1.0", "controls": []}', encoding="utf-8")
    bundle = load_sector_packs_from_file(legacy)
    assert bundle.frameworks == ()
    assert bundle.control_mappings == ()
    assert bundle.packs == ()
    assert bundle.pack_for_sector("BFSI") is None
