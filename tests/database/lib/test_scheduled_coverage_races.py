"""Pure owned-fixture boundaries; never invokes Docker or SQL."""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "coverage175_races", Path(__file__).with_name("scheduled-coverage-races.py")
)
if spec is None or spec.loader is None:
    raise RuntimeError("Reviewed fixture helper unavailable")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CoverageFixtureBoundary(unittest.TestCase):
    def test_exact_immutable_container_and_image_only(self):
        module.validate_fixture_inputs("a" * 64, "sha256:" + "b" * 64)
        for container, image in [
            ("axiom-bff", "sha256:" + "b" * 64),
            ("a" * 63, "sha256:" + "b" * 64),
            ("a" * 64, "supabase/postgres:latest"),
            ("--format=x", "sha256:" + "b" * 64),
            ("a" * 64, "sha256:" + "G" * 64),
        ]:
            with (
                self.subTest(container=container, image=image),
                self.assertRaises(module.Refused),
            ):
                module.validate_fixture_inputs(container, image)

    def test_actual_171_and_new175_owner_authority_precede_concurrent_poll(self):
        program = module.fixture_program()
        self.assertEqual(program.count("\nbegin;\n"), 1)
        self.assertTrue(program.endswith("commit;\n"))
        self.assertIn("public.record_monitoring_read_scope", program)
        self.assertIn("public.settle_monitoring_read_dispatch", program)
        self.assertIn("public.issue_scheduled_coverage_mfa_challenge", program)
        self.assertIn("public.record_scheduled_coverage_scope", program)
        self.assertIn("new source independently cleanup confirmed", program)
        self.assertNotIn("insert into coverage175_saved values('reserved'", program)
        self.assertNotIn(
            "set role agent_ledger_writer;select public.enqueue_scheduled_coverage_dispatch",
            program,
        )


class CoverageBarrierDiagnostics(unittest.TestCase):
    def test_sqlstate_exit_and_categories_are_sanitized(self):
        raw = "ERROR: 42501\nDETAIL: secret-session-and-synthetic-SQL"
        value = module.barrier_failure_diagnostic(raw, 3)
        self.assertEqual(
            value,
            {
                "category": "child-exit-before-barrier",
                "exitCode": 3,
                "sqlstate": "42501",
            },
        )
        self.assertNotIn("secret", json.dumps(value))
        self.assertEqual(
            module.barrier_failure_diagnostic("", None),
            {
                "category": "barrier-unavailable-live-child",
                "exitCode": None,
                "sqlstate": "unknown",
            },
        )

    def test_only_known_sqlstate_and_bounded_exit_are_emitted(self):
        for raw in ["ERROR: TOKEN private", "ERROR: 12345 private", "password 42501"]:
            self.assertEqual(
                module.barrier_failure_diagnostic(raw, 9999)["sqlstate"], "unknown"
            )
        self.assertIsNone(
            module.barrier_failure_diagnostic("ERROR: 55P03", 9999)["exitCode"]
        )
        for state in ["55P03", "57014", "40P01", "P0175"]:
            self.assertEqual(
                module.barrier_failure_diagnostic("ERROR: " + state, 3)["sqlstate"],
                state,
            )

    def test_private_stream_retention_is_bounded_and_mode600(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            diagnostic = module.retain_barrier_failure(
                root, 2, "x" * 70000, "ERROR: 57014\n" + "private" * 15000, 3
            )
            self.assertEqual(json.loads(diagnostic)["sqlstate"], "57014")
            self.assertNotIn("private", diagnostic)
            for path in root.iterdir():
                self.assertEqual(len(path.read_text()), 65536)
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
