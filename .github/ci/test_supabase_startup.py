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
        self.assertFalse(
            any(
                f.startswith("Startup service:")
                for f in diagnostic.log_facts(message, PROJECT)
            )
        )

    def test_pinned_readiness_log_headers_identify_only_owned_services(self):
        message = (
            f"supabase_storage_{PROJECT} container logs:\n{MARKER}\n"
            f"supabase_unknown_{PROJECT} container logs:\n{MARKER}\n"
            f"supabase_db_axiom-other container logs:\n{MARKER}\n"
        )
        facts = diagnostic.log_facts(message, PROJECT)
        self.assertEqual(
            [f for f in facts if f.startswith("Startup service:")],
            ["Startup service: storage; readiness failure log present"],
        )
        self.assertNotIn(MARKER, "\n".join(facts))

    def test_ordinary_registry_auth_challenge_is_not_a_registry_failure(self):
        ordinary = f"HTTP response 401 Unauthorized; fetching registry token {MARKER}"
        facts = diagnostic.log_facts(ordinary, PROJECT)
        self.assertNotIn("registry error text present", "\n".join(facts))
        for failed in (
            "toomanyrequests",
            "pull access denied",
            "manifest unknown",
            "429 too many requests",
        ):
            with self.subTest(failed=failed):
                facts = diagnostic.log_facts(failed + " " + MARKER, PROJECT)
                self.assertIn("registry error text present", facts[0])
                self.assertNotIn(MARKER, "\n".join(facts))

    def test_readiness_blocks_emit_exact_database_and_image_facts_only(self):
        message = (
            f"supabase_db_{PROJECT} container logs:\n"
            f"initdb: error: could not create directory '{MARKER}': Permission denied\n"
            "FATAL: database files are incompatible with server\n"
            f"supabase_auth_{PROJECT} container logs:\n"
            f"FATAL: password authentication failed for user '{MARKER}' (SQLSTATE 28P01)\n"
            f"supabase_storage_{PROJECT} container logs:\n"
            f"permission denied for schema {MARKER} (SQLSTATE 42501)\n"
            f"supabase_kong_{PROJECT} container logs:\n"
            f"exec /{MARKER}: exec format error\n"
        )
        facts = diagnostic.log_facts(message, PROJECT)
        for expected in (
            "Startup service: postgres; failure fact: database initialization permission",
            "Startup service: postgres; failure fact: database storage version mismatch",
            "Startup service: auth; failure fact: database password authentication",
            "Startup service: storage; failure fact: database object permission",
            "Startup service: gateway; failure fact: image execution format",
        ):
            self.assertIn(expected, facts)
        self.assertNotIn(MARKER, "\n".join(facts))

    def test_failure_facts_require_exact_owned_header_and_error_code(self):
        message = (
            f"credential=supabase_db_{PROJECT} container logs:\n"
            "initdb: error: could not create directory: Permission denied\n"
            f"supabase_auth_{PROJECT} container logs:\n"
            f"password authentication failed for user '{MARKER}' (SQLSTATE 99999)\n"
            "unrelated log: SQLSTATE 28P01\n"
            f"supabase_unknown_{PROJECT} container logs:\nexec format error\n"
            "supabase_db_axiom-other container logs:\n"
            "initdb: error: could not create directory: Permission denied\n"
        )
        facts = diagnostic.log_facts(message, PROJECT)
        self.assertFalse(any("failure fact:" in fact for fact in facts))
        self.assertEqual(
            [f for f in facts if f.startswith("Startup service:")],
            ["Startup service: auth; readiness failure log present"],
        )
        self.assertNotIn(MARKER, "\n".join(facts))

    def test_nested_http_probe_status_is_bounded_to_owned_service(self):
        message = json.dumps(
            {
                "unhealthy": [
                    {
                        "containerId": f"supabase_rest_{PROJECT}",
                        "reason": "unexpected status 401",
                    },
                    {
                        "containerId": f"supabase_auth_{PROJECT}",
                        "reason": "unexpected status " + MARKER,
                    },
                    {
                        "containerId": "supabase_rest_axiom-other",
                        "reason": "unexpected status 503",
                    },
                ]
            }
        )
        facts = diagnostic.log_facts(message, PROJECT)
        self.assertEqual(
            [f for f in facts if f.startswith("Startup service:")],
            ["Startup service: postgrest; reported HTTP readiness: 401"],
        )
        self.assertNotIn(MARKER, "\n".join(facts))

    def test_registry_literal_counts_are_bounded_presence_without_failure_inference(
        self,
    ):
        message = "\x1b[31mFAILED TO PULL\x1b[0m " * 1200 + MARKER
        facts = diagnostic.log_facts(message, PROJECT)
        counts = [f for f in facts if f.startswith("Startup registry literal counts:")]
        self.assertEqual(len(counts), 1)
        self.assertIn("failed to pull=999", counts[0])
        for term in (
            "toomanyrequests",
            "pull access denied",
            "manifest unknown",
            "error pulling",
            "429 too many",
        ):
            self.assertIn(term + "=0", counts[0])
        self.assertFalse(
            any(f.startswith("Startup reported pre-pull reason:") for f in facts)
        )
        self.assertNotIn(MARKER, "\n".join(facts))

    def test_exact_typed_prepull_json_reports_only_allowlisted_reasons(self):
        for reason, label in (
            ("docker_daemon", "Docker daemon"),
            ("registry_pull", "registry pull"),
            ("image_inspect", "image inspection"),
        ):
            with self.subTest(reason=reason):
                message = json.dumps(
                    {
                        "cause": {
                            "message": MARKER,
                            "reason": reason,
                            "_tag": "LegacyImagePrepullError",
                        }
                    }
                )
                facts = diagnostic.log_facts(message, PROJECT)
                self.assertIn("Startup reported pre-pull reason: " + label, facts)
                self.assertNotIn(MARKER, "\n".join(facts))
        self.assertEqual(
            diagnostic.prepull_facts(
                '{"_tag":"LegacyImagePrepullError", "reason":"registry_pull"}\n' * 3
            ),
            ["Startup reported pre-pull reason: registry pull"],
        )

    def test_prepull_cause_cannot_be_stitched_from_strings_or_untyped_errors(self):
        messages = [
            json.dumps({"_tag": "LegacyImagePrepullError", "reason": MARKER}),
            json.dumps({"_tag": "OtherError", "reason": "registry_pull"}),
            json.dumps({"_tag": "LegacyImagePrepullError"})
            + "\n"
            + json.dumps({"reason": "registry_pull"}),
            json.dumps(
                {
                    "message": json.dumps(
                        {"_tag": "LegacyImagePrepullError", "reason": "registry_pull"}
                    )
                }
            ),
            "LegacyImagePrepullError reason: registry_pull " + MARKER,
            '{"_tag":"LegacyImagePrepullError","reason":["registry_pull"]}',
            '{"_tag":"LegacyImagePrepullError","reason":"registry_pull"' + MARKER,
            "401 Unauthorized " + MARKER,
        ]
        for message in messages:
            with self.subTest(message=message):
                self.assertEqual(diagnostic.prepull_facts(message), [])
                self.assertNotIn(
                    MARKER, "\n".join(diagnostic.log_facts(message, PROJECT))
                )

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

    def test_nested_pinned_cli_error_facts_do_not_emit_dynamic_fields(self):
        message = json.dumps(
            {
                "_tag": "LegacyHealthCheckTimeoutError",
                "cause": MARKER,
                "unhealthy": [
                    {
                        "containerId": f"supabase_db_{PROJECT}",
                        "reason": "container is not ready: unhealthy",
                    }
                ],
                "unknownError": MARKER,
            }
        )
        facts = diagnostic.log_facts(message, PROJECT)
        self.assertIn("Startup failure tag: health timeout", facts)
        self.assertIn("Startup service: postgres; reported health: unhealthy", facts)
        self.assertNotIn(MARKER, "\n".join(facts))
        self.assertNotIn(
            "Startup failure tag:",
            "\n".join(diagnostic.log_facts("UnknownError " + MARKER, PROJECT)),
        )

    def _startup_shell(self, extra=None):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bin_dir = root / "bin"
            bin_dir.mkdir()
            stubs = {
                "supabase": f"""#!/bin/bash
if [ "$1" = start ]; then
 echo start >> "$ATTEMPT_LOG"
 printf '%s\\n' "$@" >> "$ARGUMENT_LOG"
 echo 'supabase_db_{PROJECT} container is not ready: unhealthy' >&2
 echo '{MARKER}' >&2
 exit 1
fi
""",
                "sleep": "#!/bin/bash\nexit 0\n",
                "docker": "#!/bin/bash\nexit 1\n",
                "uname": '#!/bin/bash\necho "${STUB_UNAME:-Linux}"\n',
            }
            for name, body in stubs.items():
                path = bin_dir / name
                path.write_text(body)
                path.chmod(0o700)
            env = {
                "PATH": f"{bin_dir}:{Path(sys.executable).parent}:/usr/bin:/bin",
                "AXIOM_PARITY_STATE_DIR": str(root / "state"),
                "ATTEMPT_LOG": str(root / "attempts"),
                "ARGUMENT_LOG": str(root / "arguments"),
                **(extra or {}),
            }
            result = subprocess.run(
                ["/bin/bash", str(ROOT / "scripts/start-parity-supabase.sh")],
                env=env,
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            logs = {
                p.name: (p.read_text(), p.stat().st_mode & 0o777)
                for p in (root / "state").glob("start*.log")
            }
            attempts = (
                (root / "attempts").read_text().splitlines()
                if (root / "attempts").exists()
                else []
            )
            args = (
                (root / "arguments").read_text().splitlines()
                if (root / "arguments").exists()
                else []
            )
            return result, logs, attempts, args

    def test_actual_startup_shell_keeps_failure_and_protected_log(self):
        for extra in (
            {},
            {
                "AXIOM_PARITY_STARTUP_DEBUG": "1",
                "GITHUB_ACTIONS": "true",
                "RUNNER_ENVIRONMENT": "github-hosted",
                "RUNNER_OS": "Linux",
            },
        ):
            with self.subTest(extra=extra):
                result, logs, attempts, args = self._startup_shell(extra)
                self.assertEqual(result.returncode, 1)
                self.assertNotIn(MARKER, result.stdout + result.stderr)
                self.assertIn(
                    "Startup service: postgres; reported health: unhealthy",
                    result.stderr,
                )
                self.assertIn("no retained service state", result.stderr)
                self.assertEqual(
                    result.stderr.count(
                        "Startup service: postgres; reported health: unhealthy"
                    ),
                    3,
                )
                self.assertEqual(attempts, ["start"] * 3)
                self.assertEqual(args.count("--debug"), 3 if extra else 0)
                self.assertEqual(args.count("--exclude"), 3)
                self.assertNotIn("--ignore-health-check", args)
                self.assertEqual(
                    set(logs),
                    {
                        "start.log",
                        "start-attempt-1.log",
                        "start-attempt-2.log",
                        "start-attempt-3.log",
                    },
                )
                for text, mode in logs.values():
                    self.assertIn(MARKER, text)
                    self.assertEqual(mode, 0o600)

    def test_debug_opt_in_refuses_incomplete_or_nonhosted_context_before_start(self):
        approved = {
            "AXIOM_PARITY_STARTUP_DEBUG": "1",
            "GITHUB_ACTIONS": "true",
            "RUNNER_ENVIRONMENT": "github-hosted",
            "RUNNER_OS": "Linux",
        }
        invalid = [
            {"AXIOM_PARITY_STARTUP_DEBUG": "1"},
            {**approved, "AXIOM_PARITY_STARTUP_DEBUG": "true"},
            {**approved, "RUNNER_ENVIRONMENT": "self-hosted"},
            {**approved, "RUNNER_OS": "macOS"},
            {**approved, "STUB_UNAME": "Darwin"},
        ]
        for key in ("GITHUB_ACTIONS", "RUNNER_ENVIRONMENT", "RUNNER_OS"):
            invalid.append({k: v for k, v in approved.items() if k != key})
        for extra in invalid:
            with self.subTest(extra=extra):
                result, logs, attempts, args = self._startup_shell(extra)
                self.assertEqual(result.returncode, 1)
                self.assertIn(
                    "requires explicit opt-in on GitHub-hosted Linux", result.stderr
                )
                self.assertEqual((logs, attempts, args), ({}, [], []))


if __name__ == "__main__":
    unittest.main()
