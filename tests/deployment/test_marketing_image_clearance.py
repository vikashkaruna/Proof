"""Synthetic classification fixtures test bindings, not live Auth acceptance."""

from __future__ import annotations

import gzip
import importlib.util
import io
import json
import tarfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "image_clearance", ROOT / "scripts/marketing-image-clearance.py"
)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
REAL_UPSTREAM_ARCHIVE = MODULE.UPSTREAM_ARCHIVE
REAL_FORK_TREE = MODULE.FORK_TREE
PREFIX = f"auth-{MODULE.COMMIT}/"
FORK_FILES = {
    "go.mod": b"module github.com/joho/godotenv\n\ngo 1.12\n",
    "godotenv.go": b"package godotenv // synthetic reviewed fork\n",
    "parser.go": b"package godotenv // synthetic parser\n",
    "fixtures/plain.env": b"OPTION_A=1\n",
}
ROOT_GO_MOD = (
    b"module github.com/supabase/auth\n\nrequire github.com/joho/godotenv v1.5.1\n\n"
    b"replace github.com/joho/godotenv => ./internal/forks/godotenv\n"
)
FORK_MODULES = (
    b"\tdep\tgithub.com/joho/godotenv\tv1.5.1\n"
    b"\t=>\t./internal/forks/godotenv\t(devel)\t\n"
)


def synthetic_archive(fork=None, go_mod=ROOT_GO_MOD, extra=()):
    """Deterministic stand-in for the official archive; never the real pin."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as bundle:
        for name, data, kind in [
            (PREFIX[:-1], b"", tarfile.DIRTYPE),
            (PREFIX + "go.mod", go_mod, tarfile.REGTYPE),
            (PREFIX + "internal/forks/godotenv", b"", tarfile.DIRTYPE),
            *[
                (PREFIX + "internal/forks/godotenv/" + key, value, tarfile.REGTYPE)
                for key, value in (FORK_FILES if fork is None else fork).items()
            ],
            *extra,
        ]:
            info = tarfile.TarInfo(name)
            info.type = kind
            if kind == tarfile.SYMTYPE:
                info.linkname = data.decode()
                bundle.addfile(info)
            elif kind == tarfile.REGTYPE:
                info.size = len(data)
                bundle.addfile(info, io.BytesIO(data))
            else:
                bundle.addfile(info)
    return gzip.compress(buffer.getvalue(), mtime=0)


def tree(files):
    return MODULE.digest(
        "".join(
            f"{name}\0{MODULE.digest(files[name])}\n" for name in sorted(files)
        ).encode()
    )


@pytest.fixture(autouse=True)
def synthetic_source_pins(monkeypatch):
    """Tests bind to synthetic pins; the real pins are checked separately."""
    monkeypatch.setattr(MODULE, "UPSTREAM_ARCHIVE", MODULE.digest(synthetic_archive()))
    monkeypatch.setattr(MODULE, "FORK_TREE", tree(FORK_FILES))


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


def snapshot_for(archive_hash, commit=None):
    return json.dumps(
        {
            "upstream_commit": commit or MODULE.COMMIT,
            "upstream_archive_sha256": archive_hash,
        }
    ).encode()


def review_fixture(root, manifest, archive=None, snapshot=None):
    archive = synthetic_archive() if archive is None else archive
    snapshot = snapshot_for(MODULE.UPSTREAM_ARCHIVE) if snapshot is None else snapshot
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
        "compiled_modules": b"/out/auth: go1.27.2\n\tdep google.golang.org/grpc v1.83.2\n\tdep github.com/jackc/pgproto3/v2 v2.3.3\n"
        + FORK_MODULES
        + b"\tdep golang.org/x/net v0.60.0\n",
        "source_snapshot": snapshot,
        "upstream_archive": archive,
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
                "source_snapshot_sha256": MODULE.digest(snapshot),
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


@pytest.mark.parametrize(
    "change",
    [
        "old-go",
        "future-go",
        "missing-go",
        "old-net",
        "missing-net",
        "duplicate-net",
        "replacement",
        "embedded-version",
    ],
)
def test_auth_module_metadata_requires_reviewed_fixed_toolchain_and_net(
    tmp_path, change
):
    manifest = fixture(tmp_path, auth=True)
    review = review_fixture(tmp_path, manifest)
    data = (tmp_path / "compiled_modules.proof").read_bytes()
    changed = {
        "old-go": data.replace(b"go1.27.2", b"go1.27.1"),
        "future-go": data.replace(b"go1.27.2", b"go1.27.3"),
        "missing-go": data.replace(b"/out/auth: go1.27.2\n", b""),
        "old-net": data.replace(b"v0.60.0", b"v0.58.0"),
        "missing-net": data.replace(b"\tdep golang.org/x/net v0.60.0\n", b""),
        "duplicate-net": data + b"\tdep golang.org/x/net v0.58.0\n",
        "replacement": data + b"\t=> example.invalid/net v0.1.0\n",
        "embedded-version": data.replace(b"v0.60.0", b"v0.60.0-unsafe"),
    }[change]
    review["proofs"]["compiled_modules"] = stored(
        tmp_path, "compiled_modules.proof", changed
    )
    stored(tmp_path, "review.json", json.dumps(review).encode())
    with pytest.raises(ValueError, match="toolchain|metadata|replacement"):
        MODULE.classify(tmp_path / "manifest.json", tmp_path / "review.json", tmp_path)


def test_auth_build_locks_match_reviewed_descriptor_and_template_builder():
    source = json.loads((ROOT / "infra/docker/auth-security/source.json").read_text())
    dockerfile = (ROOT / "infra/docker/Dockerfile.auth").read_text()
    assert source["go_version"] == "1.27.2"
    assert source["x_net_version"] == "v0.60.0"
    assert "-require=golang.org/x/net@" + source["x_net_version"] in dockerfile
    assert "-require=google.golang.org/grpc@" + source["grpc_version"] in dockerfile
    for environment in ("local", "preprod", "staging", "production", "onprem"):
        template = (
            ROOT / f"infra/docker/environments/.env.{environment}.example"
        ).read_text()
        assert "MARKETING_AUTH_GO_BUILD_IMAGE=" + source["go_builder_index"] in template


def test_reviewed_upstream_fork_is_admitted_and_recorded(tmp_path):
    manifest = fixture(tmp_path, auth=True)
    review_fixture(tmp_path, manifest)
    result = MODULE.classify(
        tmp_path / "manifest.json", tmp_path / "review.json", tmp_path
    )
    fork = result["auth_fixed_disposition"]["reviewed_fork"]
    assert fork == {
        "module": "github.com/joho/godotenv",
        "version": "v1.5.1",
        "replacement": "./internal/forks/godotenv",
        "upstream_archive_sha256": MODULE.UPSTREAM_ARCHIVE,
        "fork_tree_sha256": MODULE.FORK_TREE,
    }


def changed_modules(data, kind):
    return {
        "different-module": data.replace(
            b"dep\tgithub.com/joho/godotenv", b"dep\tgithub.com/other/godotenv"
        ),
        "different-version": data.replace(b"\tv1.5.1\n\t=>", b"\tv1.5.2\n\t=>"),
        "different-path": data.replace(
            b"./internal/forks/godotenv", b"./internal/forks/godotenv-evil"
        ),
        "versioned-target": data.replace(
            b"./internal/forks/godotenv\t(devel)",
            b"github.com/evil/godotenv\tv1.5.1\th1:" + b"A" * 44,
        ),
        "extra-replacement": data
        + b"\tdep\tgolang.org/x/crypto\tv0.57.0\n\t=>\t./internal/forks/crypto\t(devel)\t\n",
        "second-godotenv-replacement": data + FORK_MODULES,
        "detached-replacement": data.replace(FORK_MODULES, b"")
        + b"\tdep\tgithub.com/joho/godotenv\tv1.5.1\n\tdep\tgolang.org/x/text\tv0.42.0\n"
        + b"\t=>\t./internal/forks/godotenv\t(devel)\t\n",
        "missing-replacement": data.replace(
            FORK_MODULES, b"\tdep\tgithub.com/joho/godotenv\tv1.5.1\n"
        ),
    }[kind]


@pytest.mark.parametrize(
    "kind",
    [
        "different-module",
        "different-version",
        "different-path",
        "versioned-target",
        "extra-replacement",
        "second-godotenv-replacement",
        "detached-replacement",
        "missing-replacement",
    ],
)
def test_only_the_exact_upstream_fork_replacement_is_admitted(tmp_path, kind):
    manifest = fixture(tmp_path, auth=True)
    review = review_fixture(tmp_path, manifest)
    data = (tmp_path / "compiled_modules.proof").read_bytes()
    review["proofs"]["compiled_modules"] = stored(
        tmp_path, "compiled_modules.proof", changed_modules(data, kind)
    )
    stored(tmp_path, "review.json", json.dumps(review).encode())
    with pytest.raises(ValueError, match="replacement is not reviewed"):
        MODULE.classify(tmp_path / "manifest.json", tmp_path / "review.json", tmp_path)


def rebound(tmp_path, monkeypatch, archive):
    """Re-pin the archive itself so only the fork-tree/go.mod checks can refuse."""
    monkeypatch.setattr(MODULE, "UPSTREAM_ARCHIVE", MODULE.digest(archive))
    manifest = fixture(tmp_path, auth=True)
    review_fixture(tmp_path, manifest, archive=archive)


@pytest.mark.parametrize(
    "kind",
    [
        "modified-file",
        "added-file",
        "removed-file",
        "symlink",
        "extra-go-mod-replace",
        "missing-go-mod-replace",
    ],
)
def test_changed_fork_source_is_refused_even_with_a_consistent_archive_pin(
    tmp_path, monkeypatch, kind
):
    fork = dict(FORK_FILES)
    go_mod = ROOT_GO_MOD
    extra = ()
    if kind == "modified-file":
        fork["parser.go"] = b"package godotenv // attacker controlled\n"
    elif kind == "added-file":
        fork["init.go"] = b"package godotenv\nfunc init() {}\n"
    elif kind == "removed-file":
        del fork["parser.go"]
    elif kind == "symlink":
        extra = (
            (
                PREFIX + "internal/forks/godotenv/link.go",
                b"/etc/passwd",
                tarfile.SYMTYPE,
            ),
        )
    elif kind == "extra-go-mod-replace":
        go_mod += b"replace golang.org/x/net => ./internal/forks/net\n"
    else:
        go_mod = ROOT_GO_MOD.replace(
            b"replace github.com/joho/godotenv => ./internal/forks/godotenv\n", b""
        )
    rebound(tmp_path, monkeypatch, synthetic_archive(fork, go_mod, extra))
    with pytest.raises(
        ValueError, match="content differs|links or special|replacement directives"
    ):
        MODULE.classify(tmp_path / "manifest.json", tmp_path / "review.json", tmp_path)


@pytest.mark.parametrize(
    ("kind", "reason"),
    [
        ("unpinned-archive", "bound to the reviewed upstream archive"),
        ("snapshot-other-archive", "not the extracted provenance|bound to the"),
        ("snapshot-other-commit", "bound to the reviewed upstream archive"),
        ("snapshot-not-extracted", "not the extracted provenance"),
        ("foreign-layout", "archive layout is not reviewed"),
        ("duplicate-member", "archive layout is not reviewed"),
        ("missing-source-proofs", "review is incomplete"),
    ],
)
def test_fork_must_be_bound_to_extracted_snapshot_and_pinned_archive(
    tmp_path, monkeypatch, kind, reason
):
    manifest = fixture(tmp_path, auth=True)
    if kind == "unpinned-archive":
        review = review_fixture(
            tmp_path, manifest, archive=synthetic_archive(go_mod=ROOT_GO_MOD + b"\n")
        )
    elif kind == "snapshot-other-archive":
        review = review_fixture(tmp_path, manifest, snapshot=snapshot_for("e" * 64))
    elif kind == "snapshot-other-commit":
        review = review_fixture(
            tmp_path,
            manifest,
            snapshot=snapshot_for(MODULE.UPSTREAM_ARCHIVE, commit="0" * 40),
        )
    elif kind == "snapshot-not-extracted":
        review = review_fixture(tmp_path, manifest)
        review["proofs"]["source_snapshot"] = stored(
            tmp_path,
            "source_snapshot.proof",
            snapshot_for(MODULE.UPSTREAM_ARCHIVE) + b" ",
        )
    elif kind in {"foreign-layout", "duplicate-member"}:
        extra = (
            (("other-root/internal/forks/godotenv/x.go", b"x", tarfile.REGTYPE),)
            if kind == "foreign-layout"
            else ((PREFIX + "go.mod", ROOT_GO_MOD, tarfile.REGTYPE),)
        )
        archive = synthetic_archive(extra=extra)
        monkeypatch.setattr(MODULE, "UPSTREAM_ARCHIVE", MODULE.digest(archive))
        review = review_fixture(tmp_path, manifest, archive=archive)
    else:
        review = review_fixture(tmp_path, manifest)
        del review["proofs"]["source_snapshot"]
        del review["proofs"]["upstream_archive"]
    stored(tmp_path, "review.json", json.dumps(review).encode())
    with pytest.raises(ValueError, match=reason):
        MODULE.classify(tmp_path / "manifest.json", tmp_path / "review.json", tmp_path)


def test_real_archive_pin_matches_committed_auth_source_descriptor():
    source = json.loads((ROOT / "infra/docker/auth-security/source.json").read_text())
    assert REAL_UPSTREAM_ARCHIVE == source["upstream_archive_sha256"]
    assert source["upstream_commit"] == MODULE.COMMIT
    assert len(REAL_FORK_TREE) == 64 and REAL_FORK_TREE != tree(FORK_FILES)
