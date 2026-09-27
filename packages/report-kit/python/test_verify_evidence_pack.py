# ruff: noqa: PT009, PT027 -- standalone stdlib unittest suite, no pytest dependency
"""Independent stdlib-created ZIP attacks; matching outer digests exercise parser defenses."""

import copy
import hashlib
import io
import json
import stat
import struct
import tempfile
import unittest
import warnings
import zipfile
from pathlib import Path
from unittest.mock import patch

from verify_evidence_pack import BRANDING, MAX_ARCHIVE, InvalidPackError, preflight, verify


def uid(n):
    return f"00000000-0000-4000-8000-{n:012d}"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def fixture():
    body = b"Independent synthetic member"
    m = {
        "schema_version": 1,
        "serialization": "postgres-jsonb-text-v1",
        "kind": "evidence_pack",
        "pack_id": uid(1),
        "tenant_id": uid(2),
        "engagement_id": None,
        "library_version": "1.0",
        "title": "Independent pack",
        "created_at": "2026-09-27T00:00:00.000Z",
        "branding": BRANDING,
        "generator": {"name": "evidence-pack-builder", "version": "1"},
        "members": [
            {
                "evidence_id": uid(3),
                "receipt_id": uid(4),
                "version_id": "v1",
                "path": f"evidence/{uid(3)}.bin",
                "content_hash": sha(body),
                "byte_size": len(body),
                "filename": "original.txt",
                "mime_type": "text/plain",
                "description": None,
                "evidence_type": "document",
                "collected_by_agent": "human",
                "collected_at": "2026-09-26T00:00:00.000Z",
                "control_ids": [],
                "provenance": "human_submitted",
            }
        ],
        "limitations": ["Human-submitted source assertion only."],
    }
    return m, body


def entries(manifest=None, body=None):
    m, b = fixture()
    m = manifest or m
    b = b if body is None else body
    manifest_bytes = json.dumps(m, ensure_ascii=False, indent=2).encode()
    r = {
        "schema_version": 1,
        "pack_id": uid(1),
        "manifest_sha256": sha(manifest_bytes),
        "decision": "approved",
        "reviewer": {"id": uid(5), "display_name": "Named Fixture Approver"},
        "reviewed_at": "2026-09-27T00:01:00.000Z",
    }
    return [
        ("manifest.json", manifest_bytes),
        ("review.json", json.dumps(r).encode()),
        ("README.txt", b"Axiom Proof synthetic fixture"),
        ("verify_evidence_pack.py", b"# never execute archive contents"),
        (m["members"][0]["path"], b),
    ]


def archive(items, configure=None):
    target = io.BytesIO()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_STORED) as z:
            for name, body in items:
                info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = (stat.S_IFREG | 0o644) << 16
                if configure:
                    configure(info)
                z.writestr(info, body)
    return target.getvalue()


class VerifierTests(unittest.TestCase):
    def check(self, data, expected=None, manifest=None):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "candidate.zip"
            path.write_bytes(data)
            return verify(path, expected or sha(data), manifest)

    def refused(self, data, code=None):
        with self.assertRaises(InvalidPackError) as caught:
            self.check(data)
        if code:
            self.assertEqual(str(caught.exception), code)

    def test_independent_valid_archive(self):
        self.assertEqual(self.check(archive(entries()))["status"], "verified")

    def test_path_mutation_cannot_change_verified_snapshot(self):
        data = archive(entries())
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "candidate.zip"
            path.write_bytes(data)

            def mutate_then_parse(handle, size):
                path.write_bytes(b"changed after hashing")
                return preflight(handle, size)

            with patch("verify_evidence_pack.preflight", side_effect=mutate_then_parse):
                self.assertEqual(verify(path, sha(data))["status"], "verified")

    def test_oversized_regular_file_refused_before_reading(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "large.zip"
            with path.open("wb") as handle:
                handle.truncate(MAX_ARCHIVE + 1)
            with self.assertRaisesRegex(InvalidPackError, "archive_byte_limit"):
                verify(path, "0" * 64)

    def test_nonregular_file_refused(self):
        with self.assertRaisesRegex(InvalidPackError, "regular_archive_file_required"):
            verify("/dev/null", "0" * 64)

    def test_crc_corruption_with_matching_outer_digest(self):
        data = bytearray(archive(entries()))
        # Change README bytes without updating either recorded CRC.
        offset = data.index(b"Axiom Proof synthetic fixture")
        data[offset] ^= 1
        with self.assertRaises(zipfile.BadZipFile):
            self.check(bytes(data))

    def test_outer_digest_is_checked_before_zip_parser(self):
        with patch("verify_evidence_pack.zipfile.ZipFile") as parser:
            with self.assertRaisesRegex(InvalidPackError, "archive_hash_mismatch"):
                self.check(b"not a zip", "0" * 64)
            parser.assert_not_called()

    def test_trusted_manifest_mismatch(self):
        with self.assertRaisesRegex(InvalidPackError, "manifest_hash_mismatch"):
            self.check(archive(entries()), manifest="0" * 64)

    def test_changed_payload_with_matching_outer_digest(self):
        self.refused(
            archive(entries(body=b"Changed malicious bytes")), "member_hash_or_size_mismatch"
        )

    def test_wrong_declared_hash_and_size(self):
        for field, value in [("content_hash", "0" * 64), ("byte_size", 1)]:
            with self.subTest(field=field):
                m, _ = fixture()
                m["members"][0][field] = value
                self.refused(archive(entries(m)), "member_hash_or_size_mismatch")

    def test_missing_extra_duplicate_paths(self):
        base = entries()
        for candidate in [
            base[:-1],
            [*base, (f"evidence/{uid(8)}.bin", b"extra")],
            [*base, base[-1]],
        ]:
            with self.subTest(length=len(candidate)):
                self.refused(archive(candidate))

    def test_path_traversal_absolute_backslash_and_unicode(self):
        for name in ["../escape", "/absolute", "evidence\\evil", "C:/evil", "evidence/é.bin"]:
            with self.subTest(name=name):
                candidate = entries()
                candidate[-1] = (name, b"x")
                self.refused(archive(candidate))

    def test_symlink_and_executable_refused(self):
        for mode in [stat.S_IFLNK | 0o777, stat.S_IFREG | 0o755]:
            self.refused(
                archive(
                    entries(), lambda info, mode=mode: setattr(info, "external_attr", mode << 16)
                ),
                "unsafe_zip_attributes",
            )

    def test_compression_refused_even_with_small_actual_content(self):
        self.refused(
            archive(entries(), lambda info: setattr(info, "compress_type", zipfile.ZIP_DEFLATED)),
            "unsupported_zip_entry",
        )

    def test_archive_comment_refused(self):
        data = bytearray(archive(entries()))
        struct.pack_into("<H", data, len(data) - 2, 3)
        data.extend(b"abc")
        self.refused(bytes(data))

    def test_excessive_index_count_before_zipfile(self):
        data = bytearray(archive(entries()))
        struct.pack_into("<HH", data, len(data) - 22 + 8, 65535, 65535)
        with patch("verify_evidence_pack.zipfile.ZipFile") as parser:
            self.refused(bytes(data), "central_directory_limit")
            parser.assert_not_called()

    def test_zip64_and_oversized_central_directory_before_zipfile(self):
        data = bytearray(archive(entries()))
        struct.pack_into("<L", data, len(data) - 22 + 12, 0xFFFFFFFF)
        with patch("verify_evidence_pack.zipfile.ZipFile") as parser:
            self.refused(bytes(data), "central_directory_limit")
            parser.assert_not_called()

    def test_forged_uncompressed_bomb_size_before_zipfile(self):
        data = bytearray(archive(entries()))
        offset = data.index(b"PK\x01\x02")
        struct.pack_into("<LL", data, offset + 20, 0xFFFFFFFE, 0xFFFFFFFE)
        with patch("verify_evidence_pack.zipfile.ZipFile") as parser:
            self.refused(bytes(data), "entry_byte_limit")
            parser.assert_not_called()

    def test_overlapping_entry_offset(self):
        data = bytearray(archive(entries()))
        offset = data.index(b"PK\x01\x02")
        second = data.index(b"PK\x01\x02", offset + 4)
        struct.pack_into("<L", data, second + 42, 0)
        self.refused(bytes(data), "overlapping_or_gapped_entries")

    def test_local_central_disagreement(self):
        data = bytearray(archive(entries()))
        struct.pack_into("<H", data, 6, 1)
        self.refused(bytes(data), "local_central_mismatch")

    def test_embedded_prefix_and_trailer_are_not_ignored(self):
        original = archive(entries())
        self.refused(b"MZfake" + original)
        self.refused(original + b"trailer")

    def test_duplicate_json_keys(self):
        candidate = entries()
        candidate[0] = (
            "manifest.json",
            candidate[0][1].replace(
                b'"schema_version": 1', b'"schema_version": 1, "schema_version": 1'
            ),
        )
        self.refused(archive(candidate), "duplicate_json_key")

    def test_deep_json_and_nan_are_refused(self):
        for body in [b"[" * 33 + b"0" + b"]" * 33, b'{"x":NaN}']:
            candidate = entries()
            candidate[0] = ("manifest.json", body)
            self.refused(archive(candidate))

    def test_unknown_fields_and_foreign_path_cannot_enter_manifest(self):
        for mutate in [
            lambda m: m.update(bucket="private"),
            lambda m: m["members"][0].update(evidence_id=uid(9)),
        ]:
            m, _ = fixture()
            mutate(m)
            self.refused(archive(entries(m)))

    def test_unsupported_provenance_and_missing_named_approver(self):
        for provenance in ["reference", "sandbox", "fabricated"]:
            m, _ = fixture()
            m["members"][0]["provenance"] = provenance
            self.refused(archive(entries(m)))
        candidate = entries()
        r = json.loads(candidate[1][1])
        r["reviewer"]["display_name"] = " "
        candidate[1] = ("review.json", json.dumps(r).encode())
        self.refused(archive(candidate), "missing_named_approver")

    def test_review_must_bind_exact_manifest_and_pack(self):
        for field, value in [
            ("manifest_sha256", "0" * 64),
            ("pack_id", uid(8)),
            ("decision", "rejected"),
            ("reviewed_at", "2020-01-01T00:00:00.000Z"),
        ]:
            candidate = entries()
            r = json.loads(candidate[1][1])
            r[field] = value
            candidate[1] = ("review.json", json.dumps(r).encode())
            self.refused(archive(candidate))

    def test_booleans_are_not_integer_sizes_or_schema_versions(self):
        m, _ = fixture()
        m["schema_version"] = True
        self.refused(archive(entries(m)))
        m, _ = fixture()
        m["members"][0]["byte_size"] = True
        self.refused(archive(entries(m)))

    def test_unicode_codepoint_limits_and_lone_surrogates(self):
        m, _ = fixture()
        m["title"] = "😀" * 200
        self.assertEqual(self.check(archive(entries(m)))["status"], "verified")
        m["title"] += "😀"
        self.refused(archive(entries(m)), "invalid_text")
        candidate = entries()
        manifest = candidate[0][1].replace(b"Independent pack", b"\\ud800")
        candidate[0] = ("manifest.json", manifest)
        self.refused(archive(candidate), "invalid_text_encoding")

    def test_manifest_member_and_aggregate_limits(self):
        m, _ = fixture()
        member = m["members"][0]
        for count, size in [(21, 1), (7, 8 * 1024 * 1024), (1, 8 * 1024 * 1024 + 1)]:
            n = copy.deepcopy(m)
            n["members"] = [
                {
                    **member,
                    "evidence_id": uid(i + 10),
                    "receipt_id": uid(i + 100),
                    "path": f"evidence/{uid(i + 10)}.bin",
                    "byte_size": size,
                }
                for i in range(count)
            ]
            self.refused(archive(entries(n)))


if __name__ == "__main__":
    unittest.main()
