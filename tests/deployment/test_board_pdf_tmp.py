"""The BFF renderer needs writable temporary space under a read-only root."""

import subprocess
import sys
import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]
CHECK = ROOT / "scripts/check-rendered-manifests.py"


def manifest(with_tmp: bool) -> str:
    pod = {
        "metadata": {"labels": {"app.kubernetes.io/component": "bff"}},
        "spec": {
            "containers": [
                {
                    "name": "bff",
                    "securityContext": {"readOnlyRootFilesystem": True},
                    "volumeMounts": [{"name": "report-tmp", "mountPath": "/tmp"}]
                    if with_tmp
                    else [],
                }
            ],
            "volumes": [{"name": "report-tmp", "emptyDir": {"sizeLimit": "256Mi"}}]
            if with_tmp
            else [],
        },
    }
    return yaml.safe_dump(
        {
            "apiVersion": "apps/v1",
            "kind": "Deployment",
            "metadata": {"name": "axiom-bff"},
            "spec": {"replicas": 2, "template": pod},
        }
    )


class BoardPdfTmpTests(unittest.TestCase):
    def check(self, with_tmp: bool):
        return subprocess.run(
            [sys.executable, str(CHECK)],
            input=manifest(with_tmp),
            text=True,
            capture_output=True,
            check=False,
            cwd=ROOT,
        )

    def test_writable_bounded_tmp_passes(self):
        self.assertEqual(self.check(True).returncode, 0)

    def test_read_only_root_without_tmp_fails(self):
        result = self.check(False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("read-only BFF root without bounded writable /tmp", result.stderr)


if __name__ == "__main__":
    unittest.main()
