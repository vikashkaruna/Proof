"""Pure owned-fixture boundaries; never invokes Docker or SQL."""

import importlib.util
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
