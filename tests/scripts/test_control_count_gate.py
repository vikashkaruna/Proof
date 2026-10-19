"""The count gate checks working source without reinterpreting ignored history."""

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


@unittest.skipUnless(shutil.which("rg") and shutil.which("node"), "gate tools required")
class ControlCountGateTests(unittest.TestCase):
    def test_ignored_history_is_preserved_but_current_drift_fails(self):
        with tempfile.TemporaryDirectory(prefix="axiom-count-gate-") as temporary:
            root = Path(temporary)
            (root / "scripts").mkdir()
            shutil.copyfile(ROOT / "scripts/check-control-count.sh", root / "scripts/gate.sh")
            source = root / "packages/control-library/src"
            source.mkdir(parents=True)
            (source / "controls.ts").write_text("\n".join(
                f"  id: 'DPDPA-TEST-{n:03d}'" for n in range(46)
            ))
            # rg honours ignore rules in this ordinary directory, as in a checkout.
            (root / ".ignore").write_text(".axiom-runtime/\nnode_modules/\n")
            old = root / ".axiom-runtime/backup/STATUS-session-log.md"
            old.parent.mkdir(parents=True)
            historical = "Historical record: 44 controls\n"
            old.write_text(historical)
            current = root / "README.md"
            current.write_text("Current catalogue: 46 controls\n")

            def run_gate():
                return subprocess.run(
                    ["bash", str(root / "scripts/gate.sh")],
                    capture_output=True, text=True, timeout=10, check=False,
                )

            self.assertEqual(run_gate().returncode, 0)
            current.write_text("Current catalogue: 45 controls\n")
            failed = run_gate()
            self.assertNotEqual(failed.returncode, 0)
            self.assertIn("45 controls", failed.stdout)
            current.write_text("Subset: 45 controls <!-- axiom-count-ok: subset -->\n")
            self.assertEqual(run_gate().returncode, 0)
            self.assertEqual(old.read_text(), historical)


if __name__ == "__main__":
    unittest.main()
