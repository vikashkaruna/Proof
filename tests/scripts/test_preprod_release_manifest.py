"""Preprod cannot select a mutable, missing, or wrong-source image."""

import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("release_manifest", ROOT / "scripts/preprod-release-manifest.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
SHA = "a" * 40
PREFIX = "asia-south1-docker.pkg.dev/axiom-proof/axiom-proof-preprod/"


class ReleaseManifestTests(unittest.TestCase):
    def manifest(self):
        return {
            "schemaVersion": 1,
            "releaseSha": SHA,
            "projectId": "axiom-proof",
            "region": "asia-south1",
            "images": {
                service: PREFIX + (service if service in {"gotrue", "postgrest"} else f"axiom-{service}") + "@sha256:" + "b" * 64
                for service in MODULE.SERVICES
            },
        }

    def test_exact_nine_digest_manifest(self):
        self.assertEqual(MODULE.validate(self.manifest(), SHA, "axiom-proof", "asia-south1"), self.manifest())

    def test_wrong_sha_missing_image_mutable_tag_or_foreign_registry_refused(self):
        for mutation in ("sha", "missing", "tag", "foreign"):
            with self.subTest(mutation=mutation):
                candidate = self.manifest()
                if mutation == "sha":
                    candidate["releaseSha"] = "c" * 40
                elif mutation == "missing":
                    del candidate["images"]["postgrest"]
                elif mutation == "tag":
                    candidate["images"]["bff"] = PREFIX + "axiom-bff:preprod"
                else:
                    candidate["images"]["bff"] = candidate["images"]["bff"].replace("axiom-proof/", "other-project/")
                with self.assertRaises(ValueError):
                    MODULE.validate(candidate, SHA, "axiom-proof", "asia-south1")

    def test_builder_reads_all_registry_digests(self):
        with patch.object(MODULE, "registry_digest", side_effect=lambda svc, prefix, tag: self.manifest()["images"][svc]) as resolve:
            self.assertEqual(MODULE.build(SHA, "axiom-proof", "asia-south1"), self.manifest())
            self.assertEqual(resolve.call_count, 9)
            self.assertTrue(all(call.args[2] == f"release-{SHA}" for call in resolve.call_args_list))

    def test_registry_readback_refuses_missing_or_changed_digest(self):
        manifest = self.manifest()
        with patch.object(MODULE.subprocess, "run", side_effect=lambda args, **kwargs: SimpleNamespace(returncode=0, stdout=(args[5] if "@" in args[5] else args[5].split(":release-")[0] + "@sha256:" + "b" * 64) + "\n")) as run:
            MODULE.verify_registry(manifest)
            self.assertEqual(run.call_count, 18)
        with patch.object(MODULE.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="other")):
            with self.assertRaisesRegex(ValueError, "registry cannot confirm"):
                MODULE.verify_registry(manifest)

    def test_tag_changed_after_manifest_is_refused(self):
        def lookup(args, **kwargs):
            identity = args[5]
            return SimpleNamespace(returncode=0, stdout=identity if "@" in identity else identity.split(":release-")[0] + "@sha256:" + "c" * 64)
        with patch.object(MODULE.subprocess, "run", side_effect=lookup):
            with self.assertRaisesRegex(ValueError, "registry cannot confirm"):
                MODULE.verify_registry(self.manifest())


if __name__ == "__main__":
    unittest.main()
