"""Required real-uv acceptance, explicitly invoked by the image parity CI job.

General script discovery needs no uv. This integration has no dependency downloads:
it generates a genuine dependency-free lock in an empty owned cache, proves the
unchanged manifest succeeds, then proves the changed manifest refuses without
rewriting that lock. Missing uv is a failure, never a skip.
"""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class LockedManifestIntegrationTests(unittest.TestCase):
    def check_locked_refusal(self, operation):
        uv = shutil.which("uv")
        self.assertIsNotNone(uv, "Mandatory parity integration requires real uv")
        owned = ROOT / ".axiom-runtime" / "review" / "python-image-lock-parity"
        owned.mkdir(parents=True, exist_ok=True, mode=0o700)
        with tempfile.TemporaryDirectory(dir=owned) as directory:
            project = Path(directory)
            cache = project / "empty-cache"
            cache.mkdir(mode=0o700)
            manifest = project / "pyproject.toml"
            original = (
                '[project]\nname = "axiom-lock-refusal-fixture"\n'
                'version = "0.1.0"\nrequires-python = ">=3.14"\n'
                "dependencies = []\n[tool.uv]\npackage = false\n"
            )
            manifest.write_text(original)
            env = {
                **os.environ,
                "UV_CACHE_DIR": str(cache),
                "UV_PYTHON_DOWNLOADS": "never",
                "UV_NO_CONFIG": "1",
            }

            def run(args):
                return subprocess.run(
                    [
                        uv,
                        *args,
                        "--project",
                        str(project),
                        "--offline",
                        "--python",
                        sys.executable,
                    ],
                    capture_output=True,
                    text=True,
                    timeout=30,
                    check=False,
                    env=env,
                )

            created = run(["lock"])
            self.assertEqual(created.returncode, 0, created.stderr)
            raw_lock = (project / "uv.lock").read_bytes()
            args = [operation, "--locked", "--no-dev", "--no-editable"]
            accepted = run(args)
            self.assertEqual(accepted.returncode, 0, accepted.stderr)
            self.assertEqual((project / "uv.lock").read_bytes(), raw_lock)
            manifest.write_text(
                original.replace('version = "0.1.0"', 'version = "0.2.0"')
            )
            refused = run(args)
            self.assertNotEqual(refused.returncode, 0)
            self.assertIn("lockfile", refused.stderr.lower())
            self.assertIn("--locked", refused.stderr)
            self.assertEqual((project / "uv.lock").read_bytes(), raw_lock)

    def test_locked_export_refuses_stale_manifest_with_empty_cache(self):
        self.check_locked_refusal("export")

    def test_locked_sync_refuses_stale_manifest_with_empty_cache(self):
        self.check_locked_refusal("sync")


if __name__ == "__main__":
    unittest.main()
