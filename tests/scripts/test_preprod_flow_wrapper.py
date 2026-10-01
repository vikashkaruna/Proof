"""The retired preprod flow must only delegate to strict deployed acceptance."""

from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]


class PreprodFlowWrapperTest(unittest.TestCase):
    def test_requires_explicit_private_target(self) -> None:
        result = subprocess.run(
            ["bash", str(ROOT / "scripts/run-preprod-flow.sh")],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("PRIVATE_PREPROD_TARGET_JSON", result.stderr)

    def test_forwards_only_explicit_target(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            scripts = Path(temp) / "scripts"
            scripts.mkdir()
            shutil.copy2(ROOT / "scripts/run-preprod-flow.sh", scripts)
            target = Path(temp) / "private-target.json"
            target.write_text("{}")
            stub = scripts / "run-deployed-acceptance.sh"
            stub.write_text('#!/bin/sh\nprintf "%s\\n" "$#" "$1"\n')
            stub.chmod(0o700)
            result = subprocess.run(
                ["bash", str(scripts / "run-preprod-flow.sh"), str(target)],
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.splitlines(), ["1", str(target)])


if __name__ == "__main__":
    unittest.main()
