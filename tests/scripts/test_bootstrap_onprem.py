"""Exercise bootstrap command failures without touching Docker or a database."""

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class BootstrapOnpremTests(unittest.TestCase):
    def run_bootstrap(self, fail: str = "", license_value: str = "v1.synthetic.token", demo: bool = False):
        with tempfile.TemporaryDirectory(prefix="axiom-onprem-bootstrap-") as directory:
            root = Path(directory)
            (root / "scripts").mkdir()
            (root / "bin").mkdir()
            env_dir = root / "infra/docker/environments"
            env_dir.mkdir(parents=True)
            shutil.copyfile(ROOT / "scripts/bootstrap-onprem.sh", root / "scripts/bootstrap-onprem.sh")
            (env_dir / ".env.onprem").write_text(
                f"AXIOM_OFFLINE_LICENSE={license_value}\n"
                "SUPABASE_DB_URL=postgresql://tester:synthetic@localhost/test\n"
                "SUPABASE_URL=http://localhost:55321\n"
                "SUPABASE_SERVICE_KEY=synthetic-service-key\n"
                "APPROVAL_SIGNING_KEY=synthetic-signing-key-with-at-least-32-bytes\n"
            )
            stub = """#!/bin/sh
printf '%s %s\\n' "${0##*/}" "$*" >> "$STUB_LOG"
case "${0##*/} $*" in
  "docker info") exit 0 ;;
  "pnpm tsx scripts/verify-license.ts") [ "$STUB_FAIL" != license ]; exit $? ;;
  "python3 scripts/migrate-database.py "*) [ "$STUB_FAIL" != migration ]; exit $? ;;
  "python3 scripts/provision-reconciliation-key.py "*) [ "$STUB_FAIL" != reconciliation ]; exit $? ;;
  "pnpm seed:controls") [ "$STUB_FAIL" != controls ]; exit $? ;;
  "pnpm seed:users") [ "$STUB_FAIL" != users ]; exit $? ;;
esac
exit 99
"""
            for name in ("docker", "pnpm", "python3"):
                executable = root / "bin" / name
                executable.write_text(stub)
                executable.chmod(0o700)
            log = root / "calls.log"
            env = {
                "PATH": f"{root / 'bin'}:/usr/bin:/bin",
                "STUB_LOG": str(log),
                "STUB_FAIL": fail,
                "AXIOM_ONPREM_SEED_DEMO_USERS": "1" if demo else "0",
            }
            result = subprocess.run(
                ["/bin/bash", str(root / "scripts/bootstrap-onprem.sh")],
                cwd=root,
                env=env,
                text=True,
                capture_output=True,
                timeout=15,
            )
            calls = log.read_text().splitlines() if log.exists() else []
            self.assertNotIn("Admin@12345678", result.stdout + result.stderr)
            return result, calls

    def test_missing_license_stops_before_database(self):
        result, calls = self.run_bootstrap(license_value="")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(call.startswith("python3 ") for call in calls))

    def test_invalid_license_stops_before_database(self):
        result, calls = self.run_bootstrap(fail="license")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(call.startswith("python3 ") for call in calls))

    def test_migration_failure_stops_before_seeding(self):
        result, calls = self.run_bootstrap(fail="migration")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any("seed:" in call for call in calls))

    def test_control_seed_failure_stops_bootstrap(self):
        result, calls = self.run_bootstrap(fail="controls")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("pnpm seed:controls", calls)
        self.assertNotIn("BOOTSTRAP CHECKS PASSED", result.stdout)

    def test_reconciliation_key_failure_stops_before_seeding(self):
        result, calls = self.run_bootstrap(fail="reconciliation")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any("seed:" in call for call in calls))

    def test_demo_seed_failure_stops_bootstrap(self):
        result, calls = self.run_bootstrap(fail="users", demo=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("pnpm seed:users", calls)
        self.assertNotIn("BOOTSTRAP CHECKS PASSED", result.stdout)

    def test_success_does_not_create_demo_accounts_by_default(self):
        result, calls = self.run_bootstrap()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("BOOTSTRAP CHECKS PASSED", result.stdout)
        self.assertNotIn("pnpm seed:users", calls)
        self.assertTrue(any(call.startswith("python3 scripts/migrate-database.py --dsn ") for call in calls))
        self.assertIn(
            "python3 scripts/provision-reconciliation-key.py --container axiom-supabase-db",
            calls,
        )


if __name__ == "__main__":
    unittest.main()
