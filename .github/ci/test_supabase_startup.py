"""Failing startup diagnostics disclose bounded facts, never protected content."""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "startup", ROOT / ".github/ci/diagnose_supabase_startup.py"
)
diagnostic = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(diagnostic)
PROJECT = "axiom-w0-parity"
MARKER = "synthetic-secret-must-never-be-printed"


class StartupDiagnosticTests(unittest.TestCase):
    def test_pinned_cli_health_and_exit_forms_emit_only_known_facts(self):
        message = (
            f"\x1b[31msupabase_db_{PROJECT} container is not ready: unhealthy\x1b[0m\n"
            f"supabase_auth_{PROJECT} container is not running: exited\n"
            f"supabase_rest_{PROJECT} unexpected status 503\n"
            f"JWT={MARKER} API_KEY={MARKER} PASSWORD={MARKER}\n"
            "exec format error\n"
        )
        facts = diagnostic.log_facts(message, PROJECT)
        self.assertIn("Startup service: postgres; reported health: unhealthy", facts)
        self.assertIn("Startup service: auth; reported state: exited", facts)
        self.assertIn("Startup service: postgrest; reported HTTP readiness: 503", facts)
        self.assertIn("image execution format failure", facts[0])
        self.assertNotIn(MARKER, "\n".join(facts))
        self.assertNotIn("\x1b", "\n".join(facts))

    def test_foreign_unknown_and_malformed_service_states_are_not_reported(self):
        message = (
            "supabase_db_axiom-other container is not ready: unhealthy\n"
            f"supabase_unknown_{PROJECT} container is not running: exited\n"
            f"supabase_db_{PROJECT} container is not ready: {MARKER}\n"
            f"prefix_supabase_db_{PROJECT} container is not ready: unhealthy\n"
        )
        self.assertEqual(len(diagnostic.log_facts(message, PROJECT)), 1)

    def test_invalid_project_refuses_before_inspection(self):
        with patch.object(diagnostic.subprocess, "run") as run:
            for project in (
                "other-project",
                "axiom-../../escape",
                "axiom-test\n" + MARKER,
            ):
                with self.subTest(project=project), self.assertRaises(ValueError):
                    diagnostic.container_facts(project)
            run.assert_not_called()

    def test_local_inspection_drops_remote_context_and_unsafe_fields(self):
        state = {
            "Status": "exited",
            "ExitCode": 137,
            "Error": MARKER,
            "Health": {
                "Status": "unhealthy",
                "Log": [{"ExitCode": 1, "Output": MARKER}],
            },
        }
        rows = (
            json.dumps(f"/supabase_db_{PROJECT}")
            + " "
            + json.dumps(state)
            + "\n"
            + json.dumps("/supabase_db_axiom-other")
            + " "
            + json.dumps(state)
            + "\n"
            + json.dumps(f"/supabase_auth_{PROJECT}")
            + " "
            + json.dumps({"Status": MARKER, "ExitCode": MARKER})
        )
        with (
            patch.dict(
                os.environ,
                {"DOCKER_HOST": "tcp://unsafe:2375", "DOCKER_CONTEXT": "unsafe"},
            ),
            patch.object(
                diagnostic.subprocess,
                "run",
                return_value=subprocess.CompletedProcess([], 1, rows, MARKER),
            ) as run,
        ):
            facts = diagnostic.container_facts(PROJECT)
        args = run.call_args.args[0]
        self.assertEqual(args[:3], ["docker", "--host", "unix:///var/run/docker.sock"])
        self.assertNotIn("DOCKER_HOST", run.call_args.kwargs["env"])
        self.assertNotIn("DOCKER_CONTEXT", run.call_args.kwargs["env"])
        self.assertEqual(
            args[-len(diagnostic.SERVICES) :],
            [f"supabase_{key}_{PROJECT}" for key in diagnostic.SERVICES],
        )
        self.assertEqual(
            facts,
            [
                "Startup service: postgres; observed state: exited",
                "Startup service: postgres; observed health: unhealthy",
                "Startup service: postgres; last health exit: 1",
                "Startup service: postgres; container exit: 137",
            ],
        )
        self.assertNotIn(MARKER, "\n".join(facts))

    def test_missing_or_malformed_inspection_keeps_cause_unconfirmed(self):
        for result in (
            subprocess.CompletedProcess([], 1, "", MARKER),
            subprocess.CompletedProcess([], 0, '{"unsafe":' + MARKER, MARKER),
        ):
            with patch.object(diagnostic.subprocess, "run", return_value=result):
                self.assertEqual(
                    diagnostic.container_facts(PROJECT),
                    ["Startup container inspection: no retained service state"],
                )
        with patch.object(
            diagnostic.subprocess, "run", side_effect=subprocess.TimeoutExpired([], 10)
        ):
            self.assertEqual(
                diagnostic.container_facts(PROJECT),
                ["Startup container inspection: unavailable"],
            )

    def test_actual_startup_shell_keeps_failure_and_protected_log(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bin_dir = root / "bin"
            bin_dir.mkdir()
            stubs = {
                "supabase": f"""#!/bin/bash
if [ "$1" = start ]; then
 echo start >> "$ATTEMPT_LOG"
 echo 'supabase_db_{PROJECT} container is not ready: unhealthy' >&2
 echo '{MARKER}' >&2
 exit 1
fi
""",
                "sleep": "#!/bin/bash\nexit 0\n",
                "docker": "#!/bin/bash\nexit 1\n",
            }
            for name, body in stubs.items():
                path = bin_dir / name
                path.write_text(body)
                path.chmod(0o700)
            env = {
                "PATH": f"{bin_dir}:{Path(sys.executable).parent}:/usr/bin:/bin",
                "AXIOM_PARITY_STATE_DIR": str(root / "state"),
                "ATTEMPT_LOG": str(root / "attempts"),
            }
            result = subprocess.run(
                ["/bin/bash", str(ROOT / "scripts/start-parity-supabase.sh")],
                env=env,
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            self.assertEqual(result.returncode, 1)
            self.assertNotIn(MARKER, result.stdout + result.stderr)
            self.assertIn(
                "Startup service: postgres; reported health: unhealthy", result.stderr
            )
            self.assertIn("no retained service state", result.stderr)
            self.assertEqual(
                (root / "attempts").read_text().splitlines(), ["start"] * 3
            )
            log = root / "state/start.log"
            self.assertIn(MARKER, log.read_text())
            self.assertEqual(log.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
