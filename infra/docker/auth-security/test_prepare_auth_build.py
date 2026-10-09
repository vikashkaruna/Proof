"""Meaningful build admission checks; no Docker/application side effects."""

import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path

from prepare_auth_build import prepare

BUILDER = (
    "golang@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414"
)


class BuildContextTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.archive = Path(os.environ["AUTH_TEST_ARCHIVE"])

    def test_authentic_context_contains_only_verified_source_and_review(self):
        context = self.base / "context"
        digest = prepare(self.archive, context, BUILDER)
        encoded = (context / "review/source-snapshot.json").read_bytes()
        self.assertEqual(digest, hashlib.sha256(encoded).hexdigest())
        manifest = json.loads(encoded)
        self.assertEqual(manifest["go_build_image"], BUILDER)
        self.assertEqual(
            (context / "upstream/go.mod").read_text().splitlines()[0],
            "module github.com/supabase/auth",
        )
        self.assertEqual(
            {p.name for p in context.iterdir()},
            {"upstream", "review", "Dockerfile", ".dockerignore"},
        )
        self.assertFalse(list(context.rglob(".env")))
        for name, expected in manifest["owned_files"].items():
            self.assertEqual(
                hashlib.sha256((context / "review" / name).read_bytes()).hexdigest(),
                expected,
            )

    def test_existing_context_never_overwritten(self):
        context = self.base / "context"
        context.mkdir()
        (context / "operator-proof").write_text("keep")
        with self.assertRaisesRegex(ValueError, "existing contexts"):
            prepare(self.archive, context, BUILDER)
        self.assertEqual((context / "operator-proof").read_text(), "keep")

    def test_archive_tampering_refused_before_context_creation(self):
        archive = self.base / "tampered.tar.gz"
        archive.write_bytes(self.archive.read_bytes() + b"tampered")
        context = self.base / "context"
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            prepare(archive, context, BUILDER)
        self.assertFalse(context.exists())

    def test_floating_and_foreign_builder_refused_before_creation(self):
        for builder in ["golang:latest", "attacker@sha256:" + "a" * 64, BUILDER + "\n"]:
            with (
                self.subTest(builder=builder),
                self.assertRaisesRegex(ValueError, "immutable official"),
            ):
                prepare(self.archive, self.base / "context", builder)
        self.assertFalse((self.base / "context").exists())


if __name__ == "__main__":
    unittest.main()
