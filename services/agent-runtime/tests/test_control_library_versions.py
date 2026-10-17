"""Version-aware control library loading (0.1.1 published, 0.2.0 candidate)."""

import hashlib
import json
from pathlib import Path

import pytest

from axiom.agents.parikshan import _bundled_library
from axiom.control_library_loader import (
    UnknownLibraryVersionError,
    bundled_library_versions,
    load_default_library,
    load_library,
)

DATA = Path(__file__).parents[1] / "src/axiom/data"
# Pinned before 0.2.0 was authored; the TS suite pins the same digest.
PINNED_0_1_1_MIRROR = "948627fb1b60a59918d2196b81babbf26251ad76842db82f465f829731e9b648"
CORRECTED = {
    "DPDPA-BRCH-002", "DPDPA-CNS-003", "DPDPA-DAT-003",
    "DPDPA-DAT-006", "DPDPA-RCD-001", "DPDPA-RCD-003",
}


def test_published_0_1_1_mirror_bytes_and_default_unchanged():
    raw = (DATA / "controls.json").read_bytes()
    assert hashlib.sha256(raw).hexdigest() == PINNED_0_1_1_MIRROR
    default = load_default_library()
    assert default.version == "0.1.1"
    assert default.legal is None
    assert "within 30 days" in default.get("DPDPA-DAT-003").obligation


def test_bundled_versions_and_exact_resolution():
    assert bundled_library_versions() == ("0.1.1", "0.2.0")
    for version in ("0.1.1", "0.2.0"):
        lib = load_library(version)
        assert lib.version == version
        assert len(lib) == 46
        assert all(c.library_version == version for c in lib)


@pytest.mark.parametrize("version", ["0.1.0", "9.9.9", "latest", "", "0.2", "0.2.0 ", "../controls"])
def test_unknown_version_is_refused_not_substituted(version):
    with pytest.raises(UnknownLibraryVersionError):
        load_library(version)


def test_mismatched_row_version_is_refused(tmp_path, monkeypatch):
    import axiom.control_library_loader as loader

    data = json.loads((DATA / "controls-0.2.0.json").read_text())
    data["controls"][0]["library_version"] = "0.1.1"
    (tmp_path / "controls-0.2.0.json").write_text(json.dumps(data))
    monkeypatch.setattr(loader, "_DATA_DIR", tmp_path)
    monkeypatch.setattr(loader, "_DEFAULT_LIB_PATH", tmp_path / "controls.json")
    with pytest.raises(ValueError, match="row version mismatch"):
        loader.load_library("0.2.0")


def test_0_2_0_corrected_text_parity():
    old, new = load_library("0.1.1"), load_library("0.2.0")
    changed = {c.id for c in new if c.obligation != old.get(c.id).obligation}
    assert changed == CORRECTED
    for c in new:
        if c.id in CORRECTED:
            assert c.revised_in_version == "0.2.0"
        else:
            assert c == old.get(c.id).__class__(**{**old.get(c.id).__dict__, "library_version": "0.2.0"})

    cns = new.get("DPDPA-CNS-003")
    assert any(cit.reference == "Section 6(10)" for cit in cns.citations)
    assert "only to a registered Consent Manager" in cns.obligation
    assert "not exceeding ninety days" in new.get("DPDPA-DAT-003").obligation
    assert "entitled" not in new.get("DPDPA-DAT-006").obligation
    assert "does not create a general data portability entitlement" in new.get("DPDPA-DAT-006").obligation
    assert "any personal data breach" in new.get("DPDPA-BRCH-002").obligation
    assert "likely to cause harm" not in new.get("DPDPA-BRCH-002").obligation
    for cid in ("DPDPA-RCD-001", "DPDPA-RCD-003"):
        assert [c.reference for c in new.get(cid).citations] == ["Section 8(1)"]


def test_0_2_0_legal_metadata():
    lib = load_library("0.2.0")
    assert lib.legal is not None
    assert lib.legal["status"] == "candidate"
    assert lib.legal["review"]["legalSignOff"] == "pending"
    assert lib.effective_from("DPDPA-BRCH-002") == "2027-05-13"
    assert lib.effective_from("DPDPA-UNKNOWN-999") is None
    records = {r["control_id"]: r for r in lib.legal["records"]}
    assert set(records) == CORRECTED
    assert records["DPDPA-DAT-006"]["legal_basis"] == "organisation_policy"
    assert records["DPDPA-CNS-003"]["conditional_questions"] == [
        {"question_id": "Q3", "condition": "registered_consent_manager"}
    ]
    cns = next(c for c in lib.legal["commencement"] if c["control_id"] == "DPDPA-CNS-003")
    groups = {p["reference"]: p["group"] for p in cns["provisions"]}
    assert groups == {
        "Section 6(10)": "eighteen_months", "Rule 4": "one_year", "First Schedule": "one_year",
    }


def test_parikshan_resolves_the_requested_version():
    assert _bundled_library("0.2.0").version == "0.2.0"
    assert _bundled_library("0.1.1").version == "0.1.1"
    # Unknown keeps the pre-existing path: default library, whose version then
    # mismatches and is refused by score_assessment.
    assert _bundled_library("0.1.0").version == "0.1.1"
