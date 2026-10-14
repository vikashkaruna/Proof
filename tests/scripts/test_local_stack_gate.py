"""Exercise local readiness failures without reaching Docker or retained data."""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[2] / "scripts/test-local-stack.sh"


class LocalStackGateTests(unittest.TestCase):
    def run_gate(self, failure="", require_bounds=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for path in (
                "scripts",
                "services/agent-runtime",
                "services/model-gateway",
                "tests/e2e",
                "bin",
            ):
                (root / path).mkdir(parents=True)
            script = root / "scripts/test-local-stack.sh"
            script.write_text(SOURCE.read_text())
            for tool, body in {
                "pnpm": 'if [ "$1" = test:e2e ] && [ "$FAIL_GATE" = browser ]; then exit 9; fi\nexit 0\n',
                "uv": "exit 0\n",
                "curl": 'if [ "$REQUIRE_BOUNDS" = 1 ]; then case " $* " in *" --connect-timeout 5 --max-time 15 "*) ;; *) exit 12 ;; esac; fi\nfor value in "$@"; do if [ "$value" = "$FAIL_GATE" ]; then exit 7; fi; done\nexit 0\n',
            }.items():
                stub = root / "bin" / tool
                stub.write_text("#!/bin/sh\n" + body)
                stub.chmod(0o700)
            env = dict(
                os.environ,
                PATH=str(root / "bin") + os.pathsep + os.environ["PATH"],
                FAIL_GATE=failure,
                REQUIRE_BOUNDS="1" if require_bounds else "0",
            )
            return subprocess.run(
                ["bash", str(script)],
                env=env,
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )

    def test_green_requires_all_checks(self):
        result = self.run_gate()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(
            "All Pre-CI verification suites completed successfully", result.stdout
        )

    def test_each_live_service_failure_prevents_green(self):
        for url in (
            "http://localhost:8001/health",
            "http://localhost:8000/health",
            "http://localhost:4000/health",
            "http://localhost:8233",
            "http://localhost:3001",
            "http://localhost:3000",
        ):
            with self.subTest(url=url):
                result = self.run_gate(url)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertNotIn(
                    "All Pre-CI verification suites completed successfully",
                    result.stdout,
                )

    def test_browser_failure_prevents_green(self):
        result = self.run_gate("browser")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertNotIn(
            "All Pre-CI verification suites completed successfully", result.stdout
        )

    def test_live_requests_have_connection_and_total_deadlines(self):
        result = self.run_gate(require_bounds=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
