"""Exercise the operator CI failure aggregate without running external tools."""

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PYTHON_GATES = (
    ("agent-runtime", "run mypy src/axiom"),
    ("agent-runtime", "run ruff check src/axiom"),
    ("agent-runtime", "run pytest --cov --cov-fail-under=80 -q"),
    ("model-gateway", "run pytest --cov --cov-fail-under=80 -q"),
    ("temporal-workers", "run pytest --cov --cov-fail-under=80 -q"),
)


class OperatorCiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        scripts = self.root / "scripts"
        (scripts / "lib").mkdir(parents=True)
        for relative in ("axiom-ops.sh", "lib/ops-env.sh"):
            shutil.copyfile(ROOT / "scripts" / relative, scripts / relative)
        for name in ("check-control-count.sh", "check-tfvars-coverage.sh"):
            (scripts / name).write_text("#!/usr/bin/env bash\nexit 0\n")
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for name in ("pnpm", "python3", "uv"):
            stub = self.bin / name
            stub.write_text(
                "#!/usr/bin/env bash\n"
                'printf "%s|%s|%s\\n" "${0##*/}" "${PWD##*/}" "$*" >> "$OPS_CI_TEST_LOG"\n'
                'if [ "${0##*/}" = uv ] && [ "${PWD##*/}:$*" = "${OPS_CI_TEST_FAIL:-}" ]; then exit 9; fi\n'
                "exit 0\n"
            )
            stub.chmod(0o700)
        for service, _ in PYTHON_GATES:
            (self.root / "services" / service).mkdir(parents=True, exist_ok=True)
        self.log = self.root / "commands.txt"

    def run_ci(self, fail="", skip_python=False):
        env = dict(os.environ)
        env.update(
            PATH=f"{self.bin}{os.pathsep}{env['PATH']}",
            OPS_CI_TEST_LOG=str(self.log),
            OPS_CI_TEST_FAIL=fail,
        )
        args = ["bash", str(self.root / "scripts/axiom-ops.sh"), "ci", "--skip-config", "--skip-security"]
        if skip_python:
            args.append("--skip-python")
        result = subprocess.run(args, env=env, capture_output=True, text=True, timeout=10)
        commands = self.log.read_text().splitlines()
        return result, commands

    def test_all_python_quality_gates_run_in_their_service(self):
        result, commands = self.run_ci()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("all gates passed", result.stdout)
        self.assertEqual(
            [line for line in commands if line.startswith("uv|")],
            [f"uv|{service}|{command}" for service, command in PYTHON_GATES],
        )

    def test_any_python_quality_failure_prevents_success_and_keeps_other_results(self):
        for service, command in PYTHON_GATES:
            with self.subTest(service=service, command=command):
                self.log.write_text("")
                result, commands = self.run_ci(fail=f"{service}:{command}")
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIn("FAILED:", result.stdout)
                self.assertNotIn("all gates passed", result.stdout)
                self.assertEqual(len([line for line in commands if line.startswith("uv|")]), 5)

    def test_explicit_skip_python_omits_the_whole_python_quality_group(self):
        result, commands = self.run_ci(skip_python=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(any(line.startswith("uv|") for line in commands))


if __name__ == "__main__":
    unittest.main()
