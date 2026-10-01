"""A successful apply is not proof that nine running services use the reviewed digests."""

import importlib.util
import json
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("cloudrun_readback", ROOT / "scripts/verify-preprod-cloudrun.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class CloudRunReadbackTests(unittest.TestCase):
    def manifest(self):
        return {
            "projectId": "axiom-proof",
            "images": {name: f"asia-south1-docker.pkg.dev/axiom-proof/axiom-proof-preprod/{name}@sha256:" + "a" * 64
                       for name in MODULE.SERVICE_NAMES},
        }

    def test_exact_nine_service_images(self):
        manifest = self.manifest()
        seen = []

        def run(args, **kwargs):
            service = next(name for name, resource in MODULE.SERVICE_NAMES.items() if resource == args[4])
            seen.append(service)
            self.assertEqual(args[args.index("--project") + 1], "axiom-proof")
            return SimpleNamespace(returncode=0, stdout=json.dumps({"template": {"containers": [{"image": manifest["images"][service]}]}}))

        MODULE.verify(manifest, run)
        self.assertEqual(set(seen), set(MODULE.SERVICE_NAMES))

    def test_changed_digest_or_missing_service_fails(self):
        manifest = self.manifest()

        def changed(args, **kwargs):
            return SimpleNamespace(returncode=0, stdout=json.dumps({"spec": {"template": {"spec": {"containers": [{"image": "wrong"}]}}}}))

        with self.assertRaisesRegex(ValueError, "differs"):
            MODULE.verify(manifest, changed)
        with self.assertRaisesRegex(ValueError, "readback failed"):
            MODULE.verify(manifest, lambda args, **kwargs: SimpleNamespace(returncode=1, stdout=""))


if __name__ == "__main__":
    unittest.main()
