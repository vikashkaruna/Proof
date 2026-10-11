#!/usr/bin/env python3
"""Classify preserved image scans; a source-fixed Auth advisory needs exact review."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import stat
import tarfile
from pathlib import Path

SCANNER = "aquasec/trivy@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa"
COMPONENTS = {"marketing", "bff", "auth", "rest", "gateway", "lifecycle", "migrations"}
ORIGINAL = "6cf3e036a8ac399d981060253720d5fbb0cd026d1fb1808540cd6dfc9771aa4c"
PATCH = "3607dfa9731f02c2cadcb91a57a74603f141ff9a9727d5155a98b49c77e29885"
COMMIT = "4eee58f296d9698a1c2c0ae14d7a0b379c7622d3"
# The pinned upstream Auth source carries exactly one local fork. It is only
# admissible when the compiled metadata names it exactly and the official
# archive (bound through the extracted source snapshot) contains the reviewed
# fork tree byte for byte. No other module replacement is ever accepted.
UPSTREAM_ARCHIVE = "dd5168b9f0bb294fa1e1d343c23b6bb5f68376f271d97dea897339b28fbd4b8d"
FORK_MODULE = "github.com/joho/godotenv"
FORK_VERSION = "v1.5.1"
FORK_PATH = "./internal/forks/godotenv"
FORK_TREE = "14e220e0d5bdea5d823944c1bc81a5a81bc98c79aa260234e71f6421040b736e"


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def hexadecimal(value: object, prefixed: bool = False) -> bool:
    return isinstance(value, str) and bool(
        re.fullmatch(("sha256:" if prefixed else "") + "[0-9a-f]{64}", value)
    )


def protected(path: Path, root: Path, maximum: int = 128 * 1024 * 1024) -> bytes:
    canonical_root = root.resolve(strict=True)
    candidate = path.absolute()
    if ".." in candidate.parts:
        raise ValueError("Proof file traversal refused")
    try:
        parts = candidate.relative_to(canonical_root).parts
    except ValueError:
        raise ValueError("Proof file outside checkout") from None
    if not parts:
        raise ValueError("Proof file path is missing")
    # Walk anchored directory descriptors; each component refuses symlinks,
    # including a link swapped between validation and the eventual file open.
    descriptors = []
    try:
        directory = os.open(
            canonical_root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        )
        descriptors.append(directory)
        for component in parts[:-1]:
            directory = os.open(
                component,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=directory,
            )
            descriptors.append(directory)
        file = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
        descriptors.append(file)
        info = os.fstat(file)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid()
            or info.st_mode & 0o077
            or info.st_size > maximum
        ):
            raise ValueError("Proof file must be protected, owned and bounded")
        chunks = []
        total = 0
        while True:
            chunk = os.read(file, min(1024 * 1024, maximum + 1 - total))
            if not chunk:
                break
            total += len(chunk)
            if total > maximum:
                raise ValueError("Proof grew beyond bounded read")
            chunks.append(chunk)
        final = os.fstat(file)
        if (info.st_size, info.st_mtime_ns, info.st_ctime_ns) != (
            final.st_size,
            final.st_mtime_ns,
            final.st_ctime_ns,
        ):
            raise ValueError("Proof changed while being read")
        return b"".join(chunks)
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def proof(reference: object, root: Path) -> bytes:
    if (
        not isinstance(reference, dict)
        or set(reference) != {"path", "sha256"}
        or not hexadecimal(reference["sha256"])
    ):
        raise ValueError("Invalid proof reference")
    if not isinstance(reference["path"], str):
        raise TypeError("Invalid proof path")
    data = protected(root / reference["path"], root)
    if digest(data) != reference["sha256"]:
        raise ValueError("Proof hash mismatch")
    return data


def reviewed_fork(modules: str, snapshot: bytes, archive: bytes, bound: str) -> str:
    """Admit only the pinned upstream godotenv fork, bound to official source."""
    replacements = re.findall(r"^[ \t]*=>.*$", modules, re.MULTILINE)
    exact = re.findall(
        r"^\tdep\t"
        + re.escape(FORK_MODULE)
        + "\t"
        + re.escape(FORK_VERSION)
        + r"\n\t=>\t"
        + re.escape(FORK_PATH)
        + r"\t\(devel\)\t?$",
        modules,
        re.MULTILINE,
    )
    named = re.findall(
        r"^\s*dep\s+" + re.escape(FORK_MODULE) + r"\s", modules, re.MULTILINE
    )
    if len(replacements) != 1 or len(exact) != 1 or len(named) != 1:
        raise ValueError("Auth actual module replacement is not reviewed")
    if digest(snapshot) != bound:
        raise ValueError("Auth source snapshot is not the extracted provenance")
    descriptor = json.loads(snapshot)
    if (
        not isinstance(descriptor, dict)
        or descriptor.get("upstream_commit") != COMMIT
        or descriptor.get("upstream_archive_sha256") != UPSTREAM_ARCHIVE
        or digest(archive) != UPSTREAM_ARCHIVE
    ):
        raise ValueError("Auth fork is not bound to the reviewed upstream archive")
    prefix = f"auth-{COMMIT}/"
    fork = prefix + FORK_PATH[2:] + "/"
    files: dict[str, str] = {}
    seen: set[str] = set()
    root_go_mod = None
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as bundle:
        for item in bundle.getmembers():
            if item.name in seen or not (item.name + "/").startswith(prefix):
                raise ValueError("Auth upstream archive layout is not reviewed")
            seen.add(item.name)
            if item.name == prefix + "go.mod" and item.isfile():
                handle = bundle.extractfile(item)
                root_go_mod = handle.read() if handle else None
            if not (item.name + "/").startswith(fork) or item.isdir():
                continue
            if not item.isfile():
                raise ValueError("Auth fork contains links or special files")
            handle = bundle.extractfile(item)
            if handle is None:
                raise ValueError("Auth fork member is unreadable")
            files[item.name[len(fork) :]] = digest(handle.read())
    tree = digest(
        "".join(f"{name}\0{files[name]}\n" for name in sorted(files)).encode()
    )
    if not files or tree != FORK_TREE:
        raise ValueError("Auth fork content differs from the reviewed upstream fork")
    directives = re.findall(
        r"^[ \t]*replace\b.*$", (root_go_mod or b"").decode(), re.MULTILINE
    )
    if directives != [f"replace {FORK_MODULE} => {FORK_PATH}"]:
        raise ValueError("Auth upstream replacement directives are not reviewed")
    return tree


def reviewed_auth(
    review_path: Path | None,
    root: Path,
    release: str,
    image: dict[str, object],
    report: dict[str, object],
) -> dict[str, object]:
    if review_path is None or not review_path.exists():
        raise ValueError("Exact Auth fixed-source independent review is missing")
    raw = protected(review_path, root)
    review = json.loads(raw)
    if (
        not isinstance(review, dict)
        or review.get("format") != 1
        or review.get("decision") != "verified_fixed"
    ):
        raise ValueError("Auth review is not a fixed-artifact clearance")
    if (
        review.get("release_sha") != release
        or review.get("image_id") != image["image_id"]
        or review.get("artifact_id") != report["ArtifactID"]
    ):
        raise ValueError("Auth review subject mismatch")
    if (
        not isinstance(review.get("reviewer"), str)
        or not review["reviewer"].strip()
        or not isinstance(review.get("builder"), str)
        or not review["builder"].strip()
        or review["reviewer"] == review["builder"]
    ):
        raise ValueError("Independent reviewer is required")
    refs = review.get("proofs")
    names = {
        "binary",
        "original_source",
        "patched_source",
        "patch",
        "compiled_modules",
        "original_regression",
        "fixed_tests",
        "runtime_acceptance",
        "provenance",
        "fixture",
        "source_snapshot",
        "upstream_archive",
    }
    if not isinstance(refs, dict) or set(refs) != names:
        raise ValueError("Auth review is incomplete")
    data = {name: proof(refs[name], root) for name in names}
    original = data["original_source"]
    old = b"if len(src[rp:]) < msgSize {"
    if (
        digest(original) != ORIGINAL
        or original.count(old) != 1
        or digest(data["patch"]) != PATCH
        or data["patched_source"]
        != original.replace(old, b"if msgSize < 0 || len(src[rp:]) < msgSize {", 1)
    ):
        raise ValueError("Auth parser fix does not match reviewed source")
    modules = data["compiled_modules"].decode()
    if not re.search(r"^[^\n]+: go1\.27\.2$", modules, re.MULTILINE):
        raise ValueError(
            "Auth actual Go toolchain differs from the reviewed fixed version"
        )
    for module, version in (
        ("google.golang.org/grpc", "v1.83.2"),
        ("github.com/jackc/pgproto3/v2", "v2.3.3"),
        ("golang.org/x/net", "v0.60.0"),
    ):
        entries = re.findall(
            r"^\s*dep[ \t]+" + re.escape(module) + r"[ \t]+([^\s]+)(?:[ \t]+[^\n]*)?$",
            modules,
            re.MULTILINE,
        )
        if entries != [version]:
            raise ValueError("Auth actual module metadata differs")
    causal = data["original_regression"].decode()
    fixed = data["fixed_tests"].decode()
    if (
        "panic: runtime error: slice bounds out of range" not in causal
        or "(*DataRow).Decode" not in causal
        or "TestAxiomNegativeLengthsReturnError" not in causal
        or not re.search(r"ok\s+github.com/jackc/pgproto3/v2\s", fixed)
        or "PASS" not in fixed
    ):
        raise ValueError("Auth causal and fixed test proofs are incomplete")
    provenance = json.loads(data["provenance"])
    runtime = json.loads(data["runtime_acceptance"])
    binary_hash = digest(data["binary"])
    if (
        not isinstance(provenance, dict)
        or provenance.get("image_id") != image["image_id"]
        or provenance.get("binary_sha256") != binary_hash
        or provenance.get("upstream_commit") != COMMIT
        or provenance.get("patch_sha256") != PATCH
        or provenance.get("patched_source_sha256") != digest(data["patched_source"])
        or not hexadecimal(provenance.get("source_snapshot_sha256"))
    ):
        raise ValueError("Auth extracted provenance mismatch")
    fork_tree = reviewed_fork(
        modules,
        data["source_snapshot"],
        data["upstream_archive"],
        provenance["source_snapshot_sha256"],
    )
    checks = {
        "actual_named_runtime",
        "normal_auth_signup_and_token",
        "schema_compatible",
        "no_database_bypass",
    }
    if (
        not isinstance(runtime, dict)
        or runtime.get("image_id") != image["image_id"]
        or runtime.get("binary_sha256") != binary_hash
        or not isinstance(runtime.get("checks"), dict)
        or any(runtime["checks"].get(name) is not True for name in checks)
        or runtime.get("fixture_proof_sha256") != digest(data["fixture"])
        or not data["fixture"]
    ):
        raise ValueError("Auth actual runtime acceptance is missing")
    return {
        "review_sha256": digest(raw),
        "reviewer": review["reviewer"],
        "binary_sha256": binary_hash,
        "source_snapshot_sha256": provenance["source_snapshot_sha256"],
        "patch_sha256": PATCH,
        "patched_source_sha256": digest(data["patched_source"]),
        "reviewed_fork": {
            "module": FORK_MODULE,
            "version": FORK_VERSION,
            "replacement": FORK_PATH,
            "upstream_archive_sha256": UPSTREAM_ARCHIVE,
            "fork_tree_sha256": fork_tree,
        },
        "proofs": refs,
    }


def classify(
    manifest_path: Path, auth_review: Path | None, root: Path
) -> dict[str, object]:
    manifest_bytes = protected(manifest_path, root)
    manifest = json.loads(manifest_bytes)
    if (
        not isinstance(manifest, dict)
        or manifest.get("scanner_image") != SCANNER
        or not isinstance(manifest.get("release_sha"), str)
        or not re.fullmatch("[0-9a-f]{40}", manifest["release_sha"])
    ):
        raise ValueError("Invalid pinned scanner or release manifest")
    images = manifest.get("images")
    if not isinstance(images, dict) or set(images) != COMPONENTS:
        raise ValueError("Exactly seven final images must be scanned")
    records = {}
    vex = None
    for name, image in images.items():
        if not isinstance(image, dict) or not hexadecimal(image.get("image_id"), True):
            raise ValueError("Invalid candidate image identity")
        raw = proof(
            {"path": image.get("report_path"), "sha256": image.get("report_sha256")},
            root,
        )
        report = json.loads(raw)
        if (
            not isinstance(report, dict)
            or report.get("SchemaVersion") != 2
            or report.get("ArtifactType") != "container_image"
            or not hexadecimal(report.get("ArtifactID"), True)
            or not isinstance(report.get("Metadata"), dict)
            or report["Metadata"].get("ImageID") != image["image_id"]
            or not isinstance(report.get("Results"), list)
        ):
            raise ValueError("Image scan is missing or belongs to a different image")
        findings = []
        secrets = []
        for group in report["Results"]:
            if not isinstance(group, dict):
                raise TypeError("Malformed image scan result")
            for key, destination in [
                ("Vulnerabilities", findings),
                ("Secrets", secrets),
            ]:
                values = group.get(key, [])
                if not isinstance(values, list) or any(
                    not isinstance(item, dict) for item in values
                ):
                    raise ValueError("Malformed image scan findings")
                destination.extend(values)
        highs = [
            item for item in findings if item.get("Severity") in {"HIGH", "CRITICAL"}
        ]
        if secrets:
            raise ValueError("Image contains secret findings")
        fixed = []
        for finding in highs:
            if (
                name != "auth"
                or finding.get("VulnerabilityID") != "CVE-2026-32286"
                or finding.get("PkgName") != "github.com/jackc/pgproto3/v2"
                or finding.get("InstalledVersion") != "v2.3.3"
                or finding.get("Severity") != "HIGH"
            ):
                raise ValueError("Uncleared HIGH/CRITICAL finding")
            if vex is None:
                verified = reviewed_auth(
                    auth_review, root, manifest["release_sha"], image, report
                )
                vex = {
                    "subject": {
                        "image_id": image["image_id"],
                        "artifact_id": report["ArtifactID"],
                    },
                    "vulnerability": "CVE-2026-32286",
                    "status": "fixed",
                    "justification": "Exact compiled artifact contains independently reviewed negative-length source guard; original module version remains visible.",
                    **verified,
                }
            fixed.append(finding["VulnerabilityID"])
        records[name] = {
            "image_id": image["image_id"],
            "artifact_id": report["ArtifactID"],
            "raw_high": sum(v.get("Severity") == "HIGH" for v in highs),
            "raw_critical": sum(v.get("Severity") == "CRITICAL" for v in highs),
            "raw_secret_count": len(secrets),
            "effective_high": len(highs) - len(fixed),
            "effective_critical": 0,
            "fixed_advisories": fixed,
            "report_sha256": digest(raw),
        }
    return {
        "format": 1,
        "release_sha": manifest["release_sha"],
        "manifest_sha256": digest(manifest_bytes),
        "scanner_image": SCANNER,
        "decision": "cleared",
        "images": records,
        "auth_fixed_disposition": vex,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--auth-review", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        result = classify(
            args.manifest, args.auth_review, Path(__file__).resolve().parents[1]
        )
        if args.output.exists():
            raise ValueError("Existing image clearance must be preserved")
        descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as output:
            json.dump(result, output, indent=2)
            output.write("\n")
        print(
            "Seven exact image scans cleared; preserved raw reports and fixed-source proof."
        )
    except (ValueError, KeyError, TypeError, OSError, json.JSONDecodeError):
        raise SystemExit(
            "Image clearance refused; inspect preserved private reports/proofs."
        ) from None
