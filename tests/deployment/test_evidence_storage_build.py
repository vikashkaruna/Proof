# ruff: noqa: PT009, PT027 -- standalone stdlib unittest suite
"""Verify fixture source provenance without starting Docker or downloading code."""

import hashlib
import importlib.util
import io
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "evidence_storage", ROOT / "scripts/test-evidence-storage.py"
)
assert SPEC is not None
assert SPEC.loader is not None
HARNESS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HARNESS)


def fixture_archive():
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for name, content in {
            "main.go": b"verified upstream source",
            "LICENSE": b"fixture license",
        }.items():
            member = tarfile.TarInfo(f"minio-{HARNESS.COMMIT}/{name}")
            member.size = len(content)
            archive.addfile(member, io.BytesIO(content))
    return output.getvalue()


class EvidenceStorageBuildTests(unittest.TestCase):
    def test_each_build_ignores_tampered_extraction_and_preserves_go_caches(self):
        verified = fixture_archive()
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / "source.tar.gz").write_bytes(verified)
            stale = directory / f"minio-{HARNESS.COMMIT}"
            stale.mkdir()
            (stale / "main.go").write_text("tampered warm source")
            (stale / "injected.go").write_text("injected file")
            cache = directory / "output/cache/sentinel"
            cache.parent.mkdir(parents=True)
            cache.write_text("preserved cache")
            sources = []

            def compile_source(args, **_kwargs):
                mount = next(arg for arg in args if arg.endswith(":/src:ro"))
                source = Path(mount.removesuffix(":/src:ro"))
                sources.append(source)
                self.assertEqual((source / "main.go").read_bytes(), b"verified upstream source")
                self.assertFalse((source / "injected.go").exists())
                self.assertIn(HARNESS.BUILDER, args)
                # A replacement after verification cannot affect embedded provenance.
                (directory / "source.tar.gz").write_bytes(b"replacement after verification")
                return ""

            def package_source(_directory, source, _output, archive_bytes):
                self.assertEqual(archive_bytes, verified)
                self.assertEqual((source / "LICENSE").read_bytes(), b"fixture license")
                return "synthetic-image-id"

            with (
                patch.object(HARNESS, "ARCHIVE_SHA", hashlib.sha256(verified).hexdigest()),
                patch.object(HARNESS, "command", side_effect=compile_source),
                patch.object(HARNESS, "package", side_effect=package_source),
                patch.object(HARNESS.subprocess, "run") as cleanup,
            ):
                for attempt in range(2):
                    (directory / "source.tar.gz").write_bytes(verified)
                    self.assertEqual(HARNESS.build(directory, str(attempt)), "synthetic-image-id")
                self.assertEqual(cleanup.call_count, 2)
            self.assertNotEqual(sources[0], sources[1])
            self.assertTrue(all(not source.exists() for source in sources))
            self.assertEqual((stale / "main.go").read_text(), "tampered warm source")
            self.assertEqual(cache.read_text(), "preserved cache")

    def test_bad_archive_refuses_before_build_or_extraction(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / "source.tar.gz").write_bytes(b"corrupt archive")
            with (
                patch.object(HARNESS, "command") as command,
                patch.object(HARNESS, "package") as package,
            ):
                with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
                    HARNESS.build(directory, "bad")
                command.assert_not_called()
                package.assert_not_called()
            self.assertEqual(list(directory.glob("verified-source-*")), [])

    def test_failed_compilation_removes_fresh_source_and_cleans_builder(self):
        verified = fixture_archive()
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / "source.tar.gz").write_bytes(verified)
            with (
                patch.object(HARNESS, "ARCHIVE_SHA", hashlib.sha256(verified).hexdigest()),
                patch.object(
                    HARNESS,
                    "command",
                    side_effect=subprocess.TimeoutExpired("docker", 1),
                ),
                patch.object(HARNESS, "package") as package,
                patch.object(HARNESS.subprocess, "run") as cleanup,
            ):
                with self.assertRaises(subprocess.TimeoutExpired):
                    HARNESS.build(directory, "timeout")
                package.assert_not_called()
                cleanup.assert_called_once()
                self.assertEqual(
                    cleanup.call_args.args[0],
                    ["docker", "rm", "-f", "axiom-evidence-build-timeout"],
                )
            self.assertEqual(list(directory.glob("verified-source-*")), [])


if __name__ == "__main__":
    unittest.main()
