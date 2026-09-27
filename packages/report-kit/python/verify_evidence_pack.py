#!/usr/bin/env python3
"""Axiom Proof pack v1 verifier. Obtain THIS program and digests independently.

Checks bounded stored ZIP bytes without extracting or executing any entry.
An embedded copy is a convenience, not a trust anchor. SHA-256 is not a signature.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import stat
import struct
import sys
import zipfile
from datetime import datetime
from pathlib import Path

MAX_ARCHIVE = 64 * 1024 * 1024
MAX_MEMBER = 8 * 1024 * 1024
MAX_AGGREGATE = 48 * 1024 * 1024
MAX_METADATA = 256 * 1024
MAX_ENTRIES = 24
MAX_CENTRAL = 65536
UUID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\Z")
HASH = re.compile(r"[0-9a-f]{64}\Z")
MEMBER_PATH = re.compile(r"evidence/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.bin\Z")
METADATA = ("manifest.json", "review.json", "README.txt", "verify_evidence_pack.py")
BRANDING = {
    "product": "Axiom Proof",
    "company": "Axiom Minds Private Limited",
    "company_url": "https://axiomminds.ai",
}


class InvalidPackError(ValueError):
    pass


def require(condition, code):
    if not condition:
        raise InvalidPackError(code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def object_keys(value, keys):
    require(type(value) is dict and set(value) == set(keys.split()), "invalid_schema_fields")


def text(value, maximum, nullable=False):
    if nullable and value is None:
        return
    require(type(value) is str and 0 < len(value) <= maximum, "invalid_text")
    require(
        not any(
            (ord(c) < 32 and c not in "\t\r\n") or ord(c) == 127 or 0xD800 <= ord(c) <= 0xDFFF
            for c in value
        ),
        "invalid_text_encoding",
    )


def uuid(value):
    require(type(value) is str and UUID.fullmatch(value), "invalid_uuid")


def timestamp(value):
    require(
        type(value) is str and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", value),
        "invalid_timestamp",
    )
    try:
        datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ")
    except ValueError as exc:
        raise InvalidPackError("invalid_timestamp") from exc


def strict_json(data):
    require(len(data) <= MAX_METADATA, "metadata_byte_limit")

    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "duplicate_json_key")
            result[key] = value
        return result

    def invalid_constant(_):
        raise InvalidPackError("nonfinite_json")

    try:
        decoded = data.decode("utf-8", errors="strict")
        # Bound nesting before recursive JSON parsing. String contents are skipped.
        depth = 0
        for match in re.finditer(r'"(?:\\[\s\S]|[^"\\])*"|[{}\[\]]', decoded):
            token = match.group()
            if token in ("{", "["):
                depth += 1
                require(depth <= 32, "json_depth_limit")
            elif token in ("}", "]"):
                depth -= 1
        return json.loads(decoded, object_pairs_hook=pairs, parse_constant=invalid_constant)
    except (UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        raise InvalidPackError("invalid_json") from exc


def validate_manifest(m):
    object_keys(
        m,
        "schema_version serialization kind pack_id tenant_id engagement_id library_version title created_at branding generator members limitations",
    )
    require(
        type(m["schema_version"]) is int
        and m["schema_version"] == 1
        and m["serialization"] == "postgres-jsonb-text-v1"
        and m["kind"] == "evidence_pack",
        "unsupported_manifest",
    )
    for key in ("pack_id", "tenant_id"):
        uuid(m[key])
    if m["engagement_id"] is not None:
        uuid(m["engagement_id"])
    text(m["library_version"], 200)
    text(m["title"], 200)
    timestamp(m["created_at"])
    require(
        m["branding"] == BRANDING
        and m["generator"] == {"name": "evidence-pack-builder", "version": "1"},
        "invalid_attribution",
    )
    members = m["members"]
    require(type(members) is list and 1 <= len(members) <= 20, "member_count_limit")
    ids, receipts, total = [], set(), 0
    for member in members:
        object_keys(
            member,
            "evidence_id receipt_id version_id path content_hash byte_size filename mime_type description evidence_type collected_by_agent collected_at control_ids provenance",
        )
        uuid(member["evidence_id"])
        uuid(member["receipt_id"])
        ids.append(member["evidence_id"])
        require(member["receipt_id"] not in receipts, "duplicate_receipt")
        receipts.add(member["receipt_id"])
        text(member["version_id"], 1024)
        require(member["version_id"].strip() and member["version_id"] != "null", "invalid_version")
        require(member["path"] == f"evidence/{member['evidence_id']}.bin", "unsafe_member_path")
        require(
            type(member["content_hash"]) is str and HASH.fullmatch(member["content_hash"]),
            "invalid_member_hash",
        )
        require(
            type(member["byte_size"]) is int and 1 <= member["byte_size"] <= MAX_MEMBER,
            "member_byte_limit",
        )
        total += member["byte_size"]
        text(member["filename"], 160, True)
        text(member["mime_type"], 200, True)
        text(member["description"], 2000, True)
        text(member["collected_by_agent"], 100)
        timestamp(member["collected_at"])
        require(
            member["evidence_type"]
            in (
                "document",
                "config",
                "screenshot",
                "log",
                "attestation",
                "interview",
                "inventory",
                "report",
            ),
            "invalid_evidence_type",
        )
        require(
            member["provenance"] in ("human_submitted", "unknown", "production"),
            "excluded_or_invalid_provenance",
        )
        controls = member["control_ids"]
        require(type(controls) is list and len(controls) <= 40, "control_count_limit")
        for control in controls:
            text(control, 100)
        require(controls == sorted(set(controls)), "invalid_control_order")
    require(ids == sorted(set(ids)), "duplicate_or_unsorted_members")
    require(total <= MAX_AGGREGATE, "aggregate_byte_limit")
    require(
        type(m["limitations"]) is list and 1 <= len(m["limitations"]) <= 20, "missing_limitations"
    )
    for item in m["limitations"]:
        text(item, 2000)


def validate_review(r, manifest, manifest_hash):
    object_keys(r, "schema_version pack_id manifest_sha256 decision reviewer reviewed_at")
    require(
        type(r["schema_version"]) is int
        and r["schema_version"] == 1
        and r["decision"] == "approved",
        "invalid_review",
    )
    require(
        r["pack_id"] == manifest["pack_id"] and r["manifest_sha256"] == manifest_hash,
        "review_binding_mismatch",
    )
    object_keys(r["reviewer"], "id display_name")
    uuid(r["reviewer"]["id"])
    text(r["reviewer"]["display_name"], 200)
    require(r["reviewer"]["display_name"].strip(), "missing_named_approver")
    timestamp(r["reviewed_at"])
    require(r["reviewed_at"] >= manifest["created_at"], "review_predates_manifest")


def preflight(handle, size):
    """Bound the index BEFORE zipfile allocates it. Reject non-v1 layouts."""
    require(22 <= size <= MAX_ARCHIVE, "archive_byte_limit")
    handle.seek(size - 22)
    eocd = handle.read(22)
    sig, disk, cd_disk, n_disk, n_total, cd_size, cd_offset, comment = struct.unpack(
        "<4s4H2LH", eocd
    )
    require(
        sig == b"PK\x05\x06" and disk == cd_disk == comment == 0 and n_disk == n_total,
        "unsupported_zip_layout",
    )
    require(
        5 <= n_total <= MAX_ENTRIES
        and 0 < cd_size <= MAX_CENTRAL
        and cd_offset + cd_size == size - 22,
        "central_directory_limit",
    )
    position, local_end, total = cd_offset, 0, 0
    entries, names = [], set()
    for _ in range(n_total):
        require(position + 46 <= cd_offset + cd_size, "truncated_central_directory")
        handle.seek(position)
        raw = handle.read(46)
        (
            sig,
            made,
            need,
            flags,
            method,
            mtime,
            mdate,
            crc,
            compressed,
            uncompressed,
            nlen,
            xlen,
            clen,
            disk,
            internal,
            external,
            offset,
        ) = struct.unpack("<4s6H3L5H2L", raw)
        require(
            sig == b"PK\x01\x02" and need <= 20 and flags in (0, 2048) and method == 0,
            "unsupported_zip_entry",
        )
        require(
            mtime == 0 and mdate == 33 and xlen == clen == disk == internal == 0,
            "unsupported_zip_metadata",
        )
        require(
            made >> 8 == 3
            and stat.S_IFMT(external >> 16) == stat.S_IFREG
            and (external >> 16) & 0o7777 == 0o644,
            "unsafe_zip_attributes",
        )
        require(0 < nlen <= 128 and position + 46 + nlen <= cd_offset + cd_size, "zip_name_limit")
        name_bytes = handle.read(nlen)
        try:
            name = name_bytes.decode("ascii")
        except UnicodeError as exc:
            raise InvalidPackError("unsafe_zip_name") from exc
        require(name in METADATA or MEMBER_PATH.fullmatch(name), "unsafe_or_undeclared_path")
        require(name not in names, "duplicate_zip_entry")
        names.add(name)
        require(
            compressed == uncompressed
            and uncompressed <= (MAX_METADATA if name in METADATA else MAX_MEMBER),
            "entry_byte_limit",
        )
        require(
            offset == local_end and offset + 30 + nlen + compressed <= cd_offset,
            "overlapping_or_gapped_entries",
        )
        handle.seek(offset)
        header = handle.read(30)
        (
            lsig,
            lneed,
            lflags,
            lmethod,
            ltime,
            ldate,
            lcrc,
            lcompressed,
            luncompressed,
            lnlen,
            lxlen,
        ) = struct.unpack("<4s5H3L2H", header)
        require(
            lsig == b"PK\x03\x04"
            and (
                lneed,
                lflags,
                lmethod,
                ltime,
                ldate,
                lcrc,
                lcompressed,
                luncompressed,
                lnlen,
                lxlen,
            )
            == (need, flags, method, mtime, mdate, crc, compressed, uncompressed, nlen, 0),
            "local_central_mismatch",
        )
        require(handle.read(nlen) == name_bytes, "local_name_mismatch")
        local_end = offset + 30 + nlen + compressed
        total += uncompressed
        require(total <= MAX_AGGREGATE + len(METADATA) * MAX_METADATA, "aggregate_archive_limit")
        entries.append(name)
        position += 46 + nlen
    require(position == cd_offset + cd_size and local_end == cd_offset, "zip_layout_mismatch")
    require(entries[:4] == list(METADATA), "metadata_entry_order")
    return entries


def verify(path, expected_archive_sha256, expected_manifest_sha256=None):
    require(
        type(expected_archive_sha256) is str and HASH.fullmatch(expected_archive_sha256),
        "trusted_archive_digest_required",
    )
    if expected_manifest_sha256 is not None:
        require(
            type(expected_manifest_sha256) is str and HASH.fullmatch(expected_manifest_sha256),
            "invalid_trusted_manifest_digest",
        )
    # Open nonblocking to reject FIFOs/devices without waiting for an external writer.
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        details = os.fstat(source.fileno())
        require(stat.S_ISREG(details.st_mode), "regular_archive_file_required")
        require(details.st_size <= MAX_ARCHIVE, "archive_byte_limit")
        snapshot = source.read(MAX_ARCHIVE + 1)
    size = len(snapshot)
    require(size <= MAX_ARCHIVE, "archive_byte_limit")
    outer_hash = digest(snapshot)
    require(outer_hash == expected_archive_sha256, "archive_hash_mismatch")
    # Parse the same immutable snapshot that was hashed, even if the path changes.
    with io.BytesIO(snapshot) as handle:
        names = preflight(handle, size)
        handle.seek(0)
        with zipfile.ZipFile(handle, "r") as archive:
            require(archive.namelist() == names, "zip_index_mismatch")
            manifest_bytes = archive.read("manifest.json")
            manifest_hash = digest(manifest_bytes)
            if expected_manifest_sha256 is not None:
                require(manifest_hash == expected_manifest_sha256, "manifest_hash_mismatch")
            manifest = strict_json(manifest_bytes)
            validate_manifest(manifest)
            review = strict_json(archive.read("review.json"))
            validate_review(review, manifest, manifest_hash)
            expected_names = list(METADATA) + [member["path"] for member in manifest["members"]]
            require(names == expected_names, "missing_or_undeclared_member")
            for member in manifest["members"]:
                data = archive.read(member["path"])
                require(
                    len(data) == member["byte_size"] and digest(data) == member["content_hash"],
                    "member_hash_or_size_mismatch",
                )
            # Read even non-payload entries to validate their standard CRCs.
            archive.read("README.txt")
            archive.read("verify_evidence_pack.py")
            return {
                "status": "verified",
                "schema_version": 1,
                "pack_id": manifest["pack_id"],
                "archive_sha256": outer_hash,
                "manifest_sha256": manifest_hash,
                "members": len(manifest["members"]),
                "byte_size": size,
            }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument(
        "--expected-archive-sha256",
        required=True,
        help="Released digest obtained through a separately trusted channel",
    )
    parser.add_argument(
        "--expected-manifest-sha256",
        help="Optional independently obtained reviewed manifest digest",
    )
    args = parser.parse_args()
    try:
        result = verify(args.archive, args.expected_archive_sha256, args.expected_manifest_sha256)
    except (
        InvalidPackError,
        OSError,
        ValueError,
        TypeError,
        KeyError,
        struct.error,
        zipfile.BadZipFile,
        RuntimeError,
    ):
        print(json.dumps({"status": "refused", "reason": "invalid_or_untrusted_pack"}))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
