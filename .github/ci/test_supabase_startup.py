"""Failing startup diagnostics disclose bounded facts, never protected content."""

import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

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
            root = Path(tmp).resolve() / "repository"
            root.mkdir(mode=0o700)
            # Exercise the real startup script and strict path guard together
            # inside an owned copied repository. All external commands remain
            # the existing fake tools; no arbitrary-path guard bypass is used.
            for name in (
                "scripts/start-parity-supabase.sh",
                "infra/supabase/config.toml",
                "tests/database/lib/preprovision-local-custody-issuer.py",
                "tests/database/lib/preprovision-local-custody-verifier.py",
                ".github/ci/diagnose_supabase_startup.py",
                ".github/ci/observe_supabase_startup.py",
            ):
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / name, target)
            state = root / ".axiom-runtime/parity"
            bin_dir = root / "bin"
            bin_dir.mkdir()
            stubs = {
                "supabase": f"""#!/bin/bash
if [ "$1" = start ]; then
 if [ "${{STUB_OBSERVER_EVENT:-}}" = 1 ]; then /bin/sleep 0.15; fi
 echo start >> "$ATTEMPT_LOG"
 printf '%s\\n' "$@" >> "$ARGUMENT_LOG"
 echo 'supabase_db_{PROJECT} container is not ready: unhealthy' >&2
 echo '{MARKER}' >&2
 exit 1
fi
""",
                "sleep": "#!/bin/bash\nexit 0\n",
                "docker": f"""#!/bin/bash
if [ "${{STUB_OBSERVER_EVENT:-}}" = 1 ]; then
 if [ "$3" = events ]; then
  python3 - <<'OBS'
import json,time
print(json.dumps({{"id":"a"*64,"name":"supabase_db_{PROJECT}","project":"{PROJECT}","action":"create","exit":"0","nano":time.time_ns()}}))
OBS
  exit 0
 elif [ "$3" = inspect ]; then
  printf '%s\\n' '{{"id":"{"a" * 64}","name":"/supabase_db_{PROJECT}","project":"{PROJECT}","status":"exited","health":"unhealthy","exit":137,"pid":0,"oom":true,"Error":"{MARKER}"}}'
  exit 0
 fi
fi
exit 1
""",
                "uname": '#!/bin/bash\necho "${STUB_UNAME:-Linux}"\n',
            }
            for name, body in stubs.items():
                path = bin_dir / name
                path.write_text(body)
                path.chmod(0o700)
            env = {
                "PATH": f"{bin_dir}:{Path(sys.executable).parent}:/usr/bin:/bin",
                "AXIOM_PARITY_STATE_DIR": str(state),
                "ATTEMPT_LOG": str(root / "attempts"),
                "ARGUMENT_LOG": str(root / "arguments"),
                **(extra or {}),
            }
            result = subprocess.run(
                ["/bin/bash", str(root / "scripts/start-parity-supabase.sh")],
                env=env,
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            logs = {
                p.name: (p.read_text(), p.stat().st_mode & 0o777)
                for p in state.glob("start*.log")
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

    def test_hosted_debug_shell_emits_sanitized_observation_before_retry(self):
        result, _logs, attempts, args = self._startup_shell(
            {
                "AXIOM_PARITY_STARTUP_DEBUG": "1",
                "GITHUB_ACTIONS": "true",
                "RUNNER_ENVIRONMENT": "github-hosted",
                "RUNNER_OS": "Linux",
                "STUB_OBSERVER_EVENT": "1",
            }
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(attempts, ["start"] * 3)
        self.assertEqual(args.count("--debug"), 3)
        self.assertNotIn(MARKER, result.stdout + result.stderr)
        self.assertEqual(result.stdout.count("OOM killed: true"), 3)
        self.assertEqual(result.stdout.count("event: create"), 3)
        self.assertIn("state: exited; health: unhealthy", result.stdout)
        self.assertNotIn("--ignore-health-check", args)

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


spec = importlib.util.spec_from_file_location(
    "observer", ROOT / ".github/ci/observe_supabase_startup.py"
)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
OBS_PROJECT = "axiom-private-observer"
OBS_NAME = "supabase_db_" + OBS_PROJECT
OBS_OLD = "a" * 64
OBS_NEW = "b" * 64
OBS_MARKER = "secret-marker-must-never-reflect"


def event(**changes):
    value = {
        "id": OBS_OLD,
        "name": OBS_NAME,
        "project": OBS_PROJECT,
        "action": "die",
        "exit": "137",
        "nano": 10,
    }
    value.update(changes)
    return json.dumps(value)


def snapshot(**changes):
    value = {
        "id": OBS_OLD,
        "name": "/" + OBS_NAME,
        "project": OBS_PROJECT,
        "status": "exited",
        "health": "unhealthy",
        "exit": 137,
        "pid": 0,
        "oom": False,
        "Output": OBS_MARKER,
        "Error": OBS_MARKER,
        "Env": [OBS_MARKER],
    }
    value.update(changes)
    return json.dumps(value)


def inspections(trace):
    return [row for row in trace.rows if row.get("source") == "inspection"]


class StartupObserverTests(unittest.TestCase):
    def test_names_labels_ids_and_schema_all_required(self):
        for changes in (
            {"name": "supabase_db_axiom-other"},
            {"project": "axiom-other"},
            {"name": "supabase_unknown_" + OBS_PROJECT},
            {"project": None},
            {"action": [OBS_MARKER]},
            {"action": OBS_MARKER},
            {"nano": True},
            {"nano": -1},
            {"nano": 2**63},
            {"name": OBS_NAME + OBS_MARKER},
            {"id": OBS_MARKER},
            {"id": "a" * 63},
            {"id": "A" * 64},
            {"id": True},
        ):
            trace = m.Trace(OBS_PROJECT)
            self.assertIsNone(trace.event(event(**changes)))
            self.assertEqual(trace.rows, [])
        for raw in ("{bad" + OBS_MARKER, "x" * 16385):
            self.assertIsNone(m.Trace(OBS_PROJECT).event(raw))

    def test_stale_future_and_out_of_order_events_refused(self):
        trace = m.Trace(OBS_PROJECT, start_nano=100)
        for nano in (99, 100 + 1200 * 10**9 + 1):
            self.assertIsNone(trace.event(event(nano=nano)))
        self.assertEqual(trace.event(event(nano=100)), OBS_OLD)
        self.assertIsNone(trace.event(event(nano=99)))
        self.assertEqual(len(trace.rows), 1)
        self.assertEqual(trace.event(event(nano=102, action="start")), OBS_OLD)
        self.assertIsNone(trace.event(event(nano=101)))
        self.assertEqual(len(trace.rows), 2)
        self.assertEqual(trace.rows[0]["event_nano"], 100)
        self.assertTrue(0 <= trace.rows[0]["observed_ms"] <= 1200000)

    def test_rapid_name_reuse_cannot_rebind_old_event_inspection(self):
        trace = m.Trace(OBS_PROJECT)
        trace.event(event(action="create", nano=1))
        trace.event(event(action="die", nano=2))
        trace.event(event(id=OBS_NEW, action="create", nano=3))
        trace.snapshot(
            snapshot(id=OBS_NEW, status="running", health="healthy"), OBS_OLD
        )
        self.assertEqual(inspections(trace), [])
        trace.snapshot(
            snapshot(id=OBS_NEW, status="running", health="healthy"), OBS_NEW
        )
        trace.event(event(action="destroy", nano=4))
        trace.snapshot(snapshot(), OBS_OLD)
        self.assertEqual(trace.active_ids(), [OBS_NEW])
        self.assertEqual(len(inspections(trace)), 1)
        self.assertEqual(inspections(trace)[0]["id"], OBS_NEW)
        self.assertEqual(
            [row["id"] for row in trace.rows if row.get("source") == "event"],
            [OBS_OLD, OBS_OLD, OBS_NEW, OBS_OLD],
        )
        self.assertEqual(
            [row["event_nano"] for row in trace.rows if row.get("source") == "event"],
            [1, 2, 3, 4],
        )

    def test_snapshot_rejects_wrong_id_and_identity_name_label_mismatch(self):
        trace = m.Trace(OBS_PROJECT)
        trace.event(event(action="create", nano=1))
        for changes in (
            {"id": OBS_NEW},
            {"id": OBS_MARKER},
            {"name": "/supabase_auth_" + OBS_PROJECT},
            {"project": "axiom-other"},
            {"name": "/" + OBS_NAME + OBS_MARKER},
            {"status": [OBS_MARKER]},
            {"health": [OBS_MARKER]},
        ):
            trace.snapshot(snapshot(**changes), OBS_OLD)
        self.assertEqual(inspections(trace), [])
        self.assertIsNone(
            trace.event(event(name="supabase_auth_" + OBS_PROJECT, nano=2))
        )

    def test_safe_snapshot_fields_bounds_and_oom_not_inferred_from_137(self):
        trace = m.Trace(OBS_PROJECT)
        trace.event(event(action="create", nano=1))
        trace.snapshot(snapshot(), OBS_OLD)
        row = inspections(trace)[0]
        self.assertFalse(row["oom"])
        self.assertEqual(row["exit"], 137)
        self.assertEqual(row["pid"], 0)
        self.assertNotIn(OBS_MARKER, json.dumps(trace.rows))
        trace.snapshot(snapshot(exit=True, pid=2**31, oom=OBS_MARKER), OBS_OLD)
        row = inspections(trace)[-1]
        for field in ("exit", "pid", "oom"):
            self.assertNotIn(field, row)
        trace.event(event(action="oom", nano=2))
        self.assertEqual(trace.rows[-1]["event"], "oom")

    def test_per_identity_dedup_retains_replacement_and_late_failure(self):
        trace = m.Trace(OBS_PROJECT)
        trace.event(event(action="create", nano=1))
        for _ in range(10000):
            trace.snapshot(snapshot(status="running", health="healthy"), OBS_OLD)
        self.assertEqual(len(inspections(trace)), 1)
        trace.event(event(id=OBS_NEW, action="create", nano=2))
        trace.snapshot(
            snapshot(id=OBS_NEW, status="running", health="healthy"), OBS_NEW
        )
        self.assertEqual(len(inspections(trace)), 2)
        trace.snapshot(snapshot(id=OBS_NEW, oom=True), OBS_NEW)
        self.assertEqual(len(inspections(trace)), 3)
        self.assertTrue(inspections(trace)[-1]["oom"])
        for count in range(5000):
            trace.add({"service": "postgres", "exit": count % 256})
        self.assertEqual(len(trace.rows), 4096)

    def test_restricted_inspection_binds_id_and_drops_remote_environment(self):
        trace = m.Trace(OBS_PROJECT)
        trace.event(event(action="create", nano=1))
        with (
            patch.dict(
                os.environ,
                {"DOCKER_HOST": "tcp://unsafe:2375", "DOCKER_CONTEXT": OBS_MARKER},
            ),
            patch.object(
                m.subprocess,
                "run",
                return_value=subprocess.CompletedProcess([], 0, snapshot(), OBS_MARKER),
            ) as run,
        ):
            m.inspect(trace, OBS_OLD)
        self.assertEqual(run.call_args.args[0][:3], m.BASE)
        self.assertEqual(run.call_args.args[0][-1], OBS_OLD)
        for key in ("DOCKER_HOST", "DOCKER_CONTEXT"):
            self.assertNotIn(key, run.call_args.kwargs["env"])
        for unsafe in (
            ".State.Error",
            ".State.Health.Log",
            ".Config.Env",
            "{{json .State}}",
        ):
            self.assertNotIn(unsafe, m.INSPECT_FORMAT)
        self.assertNotIn(OBS_MARKER, json.dumps(trace.rows))

    def test_invalid_or_unregistered_inspection_id_refuses_before_docker(self):
        trace = m.Trace(OBS_PROJECT)
        with patch.object(m.subprocess, "run") as run:
            for identity in (OBS_MARKER, "a" * 63, OBS_NEW, True):
                m.inspect(trace, identity)
            run.assert_not_called()

    def test_fast_die_destroy_retained_even_when_no_state_survives(self):
        watcher = Mock()
        watcher.stdout = io.StringIO(
            event(action="create", nano=1)
            + "\n"
            + event(action="die", nano=2)
            + "\n"
            + event(action="destroy", nano=3)
            + "\n"
        )
        watcher.poll.return_value = None
        with (
            tempfile.TemporaryDirectory() as d,
            patch.object(m.time, "time_ns", return_value=0),
            patch.object(m.subprocess, "Popen", return_value=watcher) as popen,
            patch.object(
                m.subprocess,
                "run",
                return_value=subprocess.CompletedProcess([], 1, "", OBS_MARKER),
            ),
        ):
            evidence = Path(d) / "trace.json"

            def wait_cli():
                time.sleep(0.03)
                return 17

            self.assertEqual(m.observe_during(wait_cli, OBS_PROJECT, evidence), 17)
            rows = json.loads(evidence.read_text())
            self.assertEqual(
                [row["event"] for row in rows], ["create", "die", "destroy"]
            )
            self.assertNotIn(OBS_MARKER, evidence.read_text())
            self.assertEqual(evidence.stat().st_mode & 0o777, 0o600)
            argv = popen.call_args.args[0]
            self.assertIn("--since", argv)
            self.assertIn("label=" + m.LABEL + "=" + OBS_PROJECT, argv)
            watcher.terminate.assert_called_once()
            watcher.wait.assert_called_once()

    def test_after_callback_observer_failures_preserve_cli_return_and_timeout(self):
        with (
            tempfile.TemporaryDirectory() as d,
            patch.object(m.subprocess, "Popen", side_effect=OSError(OBS_MARKER)),
        ):
            evidence = Path(d) / "trace.json"
            self.assertEqual(m.observe_during(lambda: 1, OBS_PROJECT, evidence), 1)
            self.assertEqual(
                json.loads(evidence.read_text()), [{"observer": "unavailable"}]
            )
        watcher = Mock()
        watcher.stdout = io.StringIO("")
        watcher.poll.return_value = None
        watcher.wait.side_effect = subprocess.TimeoutExpired([OBS_MARKER], 3)
        with (
            tempfile.TemporaryDirectory() as d,
            patch.object(m.subprocess, "Popen", return_value=watcher),
        ):
            self.assertEqual(
                m.observe_during(lambda: 7, OBS_PROJECT, Path(d) / "trace.json"), 7
            )
            watcher.kill.assert_called_once()
        watcher = Mock()
        watcher.stdout = io.StringIO("")
        watcher.poll.return_value = None
        failure = subprocess.TimeoutExpired(["supabase", "start"], 10)
        with (
            tempfile.TemporaryDirectory() as d,
            patch.object(m.subprocess, "Popen", return_value=watcher),
        ):

            def wait_cli():
                raise failure

            with self.assertRaises(subprocess.TimeoutExpired) as caught:
                m.observe_during(wait_cli, OBS_PROJECT, Path(d) / "trace.json")
            self.assertIs(caught.exception, failure)
            watcher.terminate.assert_called_once()
            watcher.wait.assert_called_once()

    def test_direct_executor_refuses_arbitrary_commands_and_context_before_start(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            (state / "supabase").mkdir()
            (state / "supabase/config.toml").write_text(
                f'project_id = "{OBS_PROJECT}"\n'
            )
            argv = [
                OBS_PROJECT,
                str(state / "start-attempt-1.observer.json"),
                "--",
                "supabase",
                "start",
                "--workdir",
                str(state),
                "--exclude",
                m.EXCLUDES,
                "--debug",
            ]
            with (
                patch.object(m, "hosted_guard"),
                patch.object(m, "observe_during", return_value=23) as observe,
            ):
                self.assertEqual(m.main(argv), 23)
                for position, value in (
                    (3, "sh"),
                    (4, "stop"),
                    (6, str(state / "foreign")),
                    (8, "other"),
                    (9, "--ignore-health-check"),
                ):
                    bad = argv.copy()
                    bad[position] = value
                    with self.assertRaises(ValueError):
                        m.main(bad)
                self.assertEqual(observe.call_count, 1)
                (state / "supabase/config.toml").write_text(
                    'project_id = "axiom-other"\n'
                )
                with self.assertRaises(ValueError):
                    m.main(argv)
                self.assertEqual(observe.call_count, 1)
            context = {
                "AXIOM_PARITY_STARTUP_DEBUG": "1",
                "GITHUB_ACTIONS": "true",
                "RUNNER_ENVIRONMENT": "github-hosted",
                "RUNNER_OS": "Linux",
            }
            for key in context:
                invalid = context.copy()
                invalid.pop(key)
                with (
                    patch.dict(os.environ, invalid, clear=True),
                    patch.object(m.subprocess, "run") as run,
                ):
                    with self.assertRaises(ValueError):
                        m.hosted_guard()
                    run.assert_not_called()
            with (
                patch.dict(
                    os.environ, {**context, "DOCKER_HOST": "tcp://unsafe"}, clear=True
                ),
                patch.object(m.subprocess, "run") as run,
            ):
                with self.assertRaises(ValueError):
                    m.hosted_guard()
                run.assert_not_called()

    def test_serialized_report_revalidates_project_ids_and_sensitive_fields(self):
        trace = m.Trace(OBS_PROJECT)
        trace.event(event(action="create", nano=1))
        trace.snapshot(snapshot(), OBS_OLD)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "trace.json"
            path.write_text(json.dumps(trace.rows))
            path.chmod(0o600)
            facts = m.report_facts(path, OBS_PROJECT)
            self.assertIn("OOM killed: false", facts[-1])
            self.assertNotIn(OBS_MARKER, "\n".join(facts))
            for field, value in (
                ("project", "axiom-other"),
                ("id", OBS_MARKER),
                ("name", OBS_MARKER),
                ("service", OBS_MARKER),
                ("exit", True),
                ("Error", OBS_MARKER),
                ("observed_ms", 1200001),
            ):
                bad = [dict(trace.rows[-1])]
                bad[0][field] = value
                path.write_text(json.dumps(bad))
                with self.assertRaises((ValueError, TypeError)):
                    m.report_facts(path, OBS_PROJECT)
            secret_project = "axiom-" + OBS_MARKER
            secret_trace = m.Trace(secret_project)
            secret_trace.event(
                event(
                    project=secret_project,
                    name="supabase_db_" + secret_project,
                    action="create",
                    nano=1,
                )
            )
            path.write_text(json.dumps(secret_trace.rows))
            self.assertNotIn(
                OBS_MARKER, "\n".join(m.report_facts(path, secret_project))
            )
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                m.report_facts(path, OBS_PROJECT)

    def test_preflight_refusal_has_no_cli_verdict_or_callback(self):
        with (
            tempfile.TemporaryDirectory() as d,
            patch.object(m.subprocess, "Popen") as popen,
        ):
            path = Path(d) / "trace.json"
            path.write_text(OBS_MARKER)
            callback = Mock()
            for project in ("axiom-../../escape", OBS_PROJECT):
                with self.assertRaises(ValueError):
                    m.observe_during(callback, project, path)
            path.unlink()
            path.symlink_to(Path(d) / "target")
            with self.assertRaises(ValueError):
                m.observe_during(callback, OBS_PROJECT, path)
            callback.assert_not_called()
            popen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
