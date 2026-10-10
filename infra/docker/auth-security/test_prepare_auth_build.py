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

    def test_bounded_resource_context_preserves_actual_security_tests(self):
        context = self.base / "context"
        prepare(self.archive, context, BUILDER)
        dockerfile = (context / "Dockerfile").read_text()
        self.assertIn("GOMAXPROCS=1 GOFLAGS=-p=1 GOMEMLIMIT=512MiB GOGC=50", dockerfile)
        self.assertIn(
            "go test -mod=vendor -count=1 github.com/jackc/pgproto3/v2\n", dockerfile
        )
        self.assertIn(
            "-fuzz FuzzAxiomDataRowNeverPanics -fuzztime=10s -parallel=1", dockerfile
        )
        self.assertIn("FROM dependencies AS original-regression", dockerfile)
        self.assertIn("^TestAxiomNegativeLengthsReturnError$", dockerfile)
        snapshot = json.loads((context / "review/source-snapshot.json").read_bytes())
        self.assertEqual(
            snapshot["Dockerfile.auth"],
            hashlib.sha256((context / "Dockerfile").read_bytes()).hexdigest(),
        )

    def test_fuzz_targets_exact_patched_source_as_an_immutable_main_module(self):
        context = self.base / "context"
        prepare(self.archive, context, BUILDER)
        dockerfile = (context / "Dockerfile").read_text()
        self.assertNotIn(
            "go test -mod=vendor github.com/jackc/pgproto3/v2 -run '^$' -fuzz",
            dockerfile,
        )
        self.assertIn(
            "cp -a /src/vendor/github.com/jackc/pgproto3/v2/. /tmp/pgproto3-fuzz/",
            dockerfile,
        )
        for filename in ["go.mod", "go.sum"]:
            self.assertIn(
                "/go/pkg/mod/github.com/jackc/pgproto3/v2@v2.3.3/" + filename,
                dockerfile,
            )
        self.assertIn("GOWORK=off go test -mod=readonly -count=1", dockerfile)
        self.assertEqual(
            dockerfile.count("sha256sum -c /review/pgproto3-fuzz-source.sha256"), 3
        )
        self.assertIn("sha256sum -c /review/pgproto3-fuzz-module.sha256", dockerfile)
        self.assertEqual(
            dockerfile.count(
                "id=axiom-auth-go-build,target=/root/.cache/go-build,sharing=locked"
            ),
            5,
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
