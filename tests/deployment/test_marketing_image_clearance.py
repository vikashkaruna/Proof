"""Synthetic classification fixtures test bindings, not live Auth acceptance."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "image_clearance", ROOT / "scripts/marketing-image-clearance.py"
)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def stored(root, name, data):
    path = root / name
    path.write_bytes(data)
    path.chmod(0o600)
    return {"path": name, "sha256": MODULE.digest(data)}


def fixture(root, auth=False):
    images = {}
    for index, name in enumerate(sorted(MODULE.COMPONENTS), 1):
        identity = "sha256:" + str(index) * 64
        findings = []
        if name == "auth" and auth:
            findings = [
                {
                    "Severity": "HIGH",
                    "VulnerabilityID": "CVE-2026-32286",
                    "PkgName": "github.com/jackc/pgproto3/v2",
                    "InstalledVersion": "v2.3.3",
                }
            ]
        report = {
            "SchemaVersion": 2,
            "ArtifactType": "container_image",
            "ArtifactID": "sha256:" + "b" * 64,
            "ArtifactName": name + ":candidate",
            "Metadata": {"ImageID": identity},
            "Results": [{"Vulnerabilities": findings}],
        }
        ref = stored(root, name + ".json", json.dumps(report).encode())
        images[name] = {
            "image_id": identity,
            "report_path": ref["path"],
            "report_sha256": ref["sha256"],
        }
    manifest = {
        "scanner_image": MODULE.SCANNER,
        "release_sha": "c" * 40,
        "images": images,
    }
    stored(root, "manifest.json", json.dumps(manifest).encode())
    return manifest


def save_manifest(root, manifest):
    stored(root, "manifest.json", json.dumps(manifest).encode())


def amend_report(root, manifest, component, change):
    item = manifest["images"][component]
    report = json.loads((root / item["report_path"]).read_bytes())
    change(report)
    ref = stored(root, item["report_path"], json.dumps(report).encode())
    item["report_sha256"] = ref["sha256"]
    save_manifest(root, manifest)


def review_fixture(root, manifest):
    original = (
        ROOT / "tests/fixtures/security/pgproto3-v2.3.3-data-row.go.txt"
    ).read_bytes()
    patched = original.replace(
        b"if len(src[rp:]) < msgSize {",
        b"if msgSize < 0 || len(src[rp:]) < msgSize {",
        1,
    )
    binary = b"synthetic classifier fixture; never a live binary acceptance claim"
    image = manifest["images"]["auth"]["image_id"]
    payloads = {
        "fixture": b"retained synthetic fixture proof",
        "binary": binary,
        "original_source": original,
        "patched_source": patched,
        "patch": (
            ROOT / "infra/docker/auth-security/pgproto3-data-row.patch"
        ).read_bytes(),
        "compiled_modules": b"dep google.golang.org/grpc v1.83.2\ndep github.com/jackc/pgproto3/v2 v2.3.3\n",
        "original_regression": b"panic: runtime error: slice bounds out of range\n(*DataRow).Decode\nTestAxiomNegativeLengthsReturnError",
        "fixed_tests": b"ok github.com/jackc/pgproto3/v2 0.1s\nPASS\n",
        "runtime_acceptance": json.dumps(
            {
                "image_id": image,
                "binary_sha256": MODULE.digest(binary),
                "fixture_proof_sha256": MODULE.digest(
                    b"retained synthetic fixture proof"
                ),
                "checks": dict.fromkeys(
                    [
                        "actual_named_runtime",
                        "normal_auth_signup_and_token",
                        "schema_compatible",
                        "no_database_bypass",
                    ],
                    True,
                ),
            }
        ).encode(),
        "provenance": json.dumps(
            {
                "image_id": image,
                "binary_sha256": MODULE.digest(binary),
                "upstream_commit": MODULE.COMMIT,
                "patch_sha256": MODULE.PATCH,
                "patched_source_sha256": MODULE.digest(patched),
                "source_snapshot_sha256": "a" * 64,
            }
        ).encode(),
    }
    refs = {
        name: stored(root, name + ".proof", data) for name, data in payloads.items()
    }
    review = {
        "format": 1,
        "decision": "verified_fixed",
        "release_sha": manifest["release_sha"],
        "image_id": image,
        "artifact_id": "sha256:" + "b" * 64,
        "reviewer": "independent test reviewer",
        "builder": "test builder",
        "proofs": refs,
    }
    stored(root, "review.json", json.dumps(review).encode())
    return review


def test_all_seven_exact_clean_scans_are_required(tmp_path):
    manifest = fixture(tmp_path)
    result = MODULE.classify(tmp_path / "manifest.json", None, tmp_path)
    assert result["decision"] == "cleared"
    assert len(result["images"]) == 7
    assert result["auth_fixed_disposition"] is None
    del manifest["images"]["rest"]
    save_manifest(tmp_path, manifest)
    with pytest.raises(ValueError, match="seven"):
        MODULE.classify(tmp_path / "manifest.json", None, tmp_path)


@pytest.mark.parametrize(
    "kind",
    [
        "identity",
        "hash",
        "world-readable",
        "scanner",
        "secret",
        "other-high",
        "critical",
        "malformed",
    ],
)
def test_report_and_security_gates_refuse(tmp_path, kind):
    manifest = fixture(tmp_path)
    if kind == "identity":
        amend_report(
            tmp_path,
            manifest,
            "bff",
            lambda r: r["Metadata"].update(ImageID="sha256:" + "0" * 64),
        )
    elif kind == "hash":
        (tmp_path / "bff.json").write_text("changed")
    elif kind == "world-readable":
        (tmp_path / "bff.json").chmod(0o644)
    elif kind == "scanner":
        manifest["scanner_image"] = "aquasec/trivy:latest"
        save_manifest(tmp_path, manifest)
    elif kind == "secret":
        amend_report(
            tmp_path,
            manifest,
            "bff",
            lambda r: r["Results"][0].update(Secrets=[{"Severity": "HIGH"}]),
        )
    elif kind in {"other-high", "critical"}:
        amend_report(
            tmp_path,
            manifest,
            "bff",
            lambda r: r["Results"][0].update(
                Vulnerabilities=[
                    {
                        "Severity": "CRITICAL" if kind == "critical" else "HIGH",
                        "VulnerabilityID": "CVE-unrelated",
                    }
                ]
            ),
        )
    else:
        amend_report(tmp_path, manifest, "bff", lambda r: r.update(Results="unparsed"))
    with pytest.raises((ValueError, TypeError)):
        MODULE.classify(tmp_path / "manifest.json", None, tmp_path)


def test_auth_advisory_never_ignored_without_exact_review(tmp_path):
    fixture(tmp_path, auth=True)
    with pytest.raises(ValueError, match="review is missing"):
        MODULE.classify(tmp_path / "manifest.json", None, tmp_path)


def test_fixed_artifact_keeps_raw_count_and_module_version(tmp_path):
    manifest = fixture(tmp_path, auth=True)
    review_fixture(tmp_path, manifest)
    result = MODULE.classify(
        tmp_path / "manifest.json", tmp_path / "review.json", tmp_path
    )
    assert result["images"]["auth"]["raw_high"] == 1
    assert result["images"]["auth"]["effective_high"] == 0
    assert result["auth_fixed_disposition"]["status"] == "fixed"
    assert b"v2.3.3" in (tmp_path / "compiled_modules.proof").read_bytes()


@pytest.mark.parametrize(
    "kind",
    [
        "different-image",
        "self-review",
        "changed-binary",
        "missing-runtime",
        "unchanged-parser",
        "missing-causal",
        "old-grpc",
        "changed-provenance",
        "wrong-package",
        "changed-fixture",
    ],
)
def test_auth_fixed_disposition_refuses_incomplete_or_different_artifacts(
    tmp_path, kind
):
    manifest = fixture(tmp_path, auth=True)
    review = review_fixture(tmp_path, manifest)
    if kind == "different-image":
        review["image_id"] = "sha256:" + "9" * 64
    elif kind == "self-review":
        review["reviewer"] = review["builder"]
    elif kind == "wrong-package":
        amend_report(
            tmp_path,
            manifest,
            "auth",
            lambda r: r["Results"][0]["Vulnerabilities"][0].update(PkgName="unrelated"),
        )
    else:
        field, data = {
            "changed-binary": ("binary", b"different"),
            "missing-runtime": ("runtime_acceptance", b"{}"),
            "unchanged-parser": (
                "patched_source",
                (tmp_path / "original_source.proof").read_bytes(),
            ),
            "missing-causal": (
                "original_regression",
                b"test harness compilation failure",
            ),
            "old-grpc": ("compiled_modules", b"dep google.golang.org/grpc v1.82.1\n"),
            "changed-provenance": ("provenance", b"{}"),
            "changed-fixture": ("fixture", b"different fixture"),
        }[kind]
        review["proofs"][field] = stored(tmp_path, field + ".proof", data)
    stored(tmp_path, "review.json", json.dumps(review).encode())
    with pytest.raises(ValueError):
        MODULE.classify(tmp_path / "manifest.json", tmp_path / "review.json", tmp_path)


@pytest.mark.parametrize("directory_link", [False, True])
def test_internal_symlinks_are_never_protected_proof_files(tmp_path, directory_link):
    manifest = fixture(tmp_path)
    if directory_link:
        target = tmp_path / "real"
        target.mkdir()
        report = tmp_path / "bff.json"
        report.rename(target / "bff.json")
        (tmp_path / "linked").symlink_to(target, target_is_directory=True)
        manifest["images"]["bff"]["report_path"] = "linked/bff.json"
    else:
        (tmp_path / "bff.json").rename(tmp_path / "real-bff.json")
        (tmp_path / "bff.json").symlink_to(tmp_path / "real-bff.json")
    save_manifest(tmp_path, manifest)
    with pytest.raises((OSError, ValueError)):
        MODULE.classify(tmp_path / "manifest.json", None, tmp_path)
