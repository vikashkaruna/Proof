"""Offline guard/setup checks; no Docker or SQL execution."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("brand177_races", Path(__file__).with_name("branded-report-races.py"))
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Fixture helper unavailable")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class BrandRaces(unittest.TestCase):
    def test_real_finalized_setup_has_one_owned_transaction_without_report_request(self):
        program = MODULE.fixture_program()
        self.assertEqual(program.count("\nbegin;\n"), 1)
        self.assertTrue(program.endswith("commit;\n"))
        self.assertIn("create schema brand177_race", program)
        self.assertIn("create table board_issued", program)
        self.assertIn("public.complete_workload_assessment", program)
        self.assertIn("public.confirm_workload_assessment", program)
        self.assertNotIn("request_branded", program)

    def test_changed_setup_boundary_fails_before_transport(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "tests/database").mkdir(parents=True)
            (root / "tests/database/branded-board-lifecycle.test.sql").write_text("begin;\n-- changed\n")
            with self.assertRaisesRegex(ValueError, "fixture boundary"):
                MODULE.fixture_program(root)

    def test_name_only_container_is_refused_without_docker(self):
        with patch("sys.argv", ["race", "--container", "friendly-name", "--image", "sha256:" + "a" * 64, "--database", "axiom_policy_test"]), patch.object(MODULE.shutil, "which", return_value="/usr/bin/docker"), patch.object(MODULE.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "Exact owned CID"):
                MODULE.main()
            run.assert_not_called()
