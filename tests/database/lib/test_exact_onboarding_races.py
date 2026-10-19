"""Offline fail-closed boundary checks; does not invoke native resources."""
import importlib.util
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("onboarding178_races", HERE / "exact-onboarding-races.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Exact onboarding race fixture unavailable")
RACES = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RACES)


class ExactOnboardingFixture(unittest.TestCase):
    def test_fixture_is_committed_owned_setup_without_running_business_assertions(self):
        program = RACES.fixture_program()
        self.assertNotIn("pg_temp.", program)
        self.assertNotIn("do $$declare r jsonb;readback", program)
        self.assertIn("create schema onboarding178_race;", program)
        self.assertTrue(program.endswith("\ncommit;\n"))
        self.assertEqual(program.count("\nbegin;\n"), 1)

    def test_source_boundary_changes_refuse_before_native_calls(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / "tests/database/exact-onboarding-operations.test.sql"
            target.parent.mkdir(parents=True)
            target.write_text("begin;select 1;commit;")
            with self.assertRaisesRegex(ValueError,"boundary"):
                RACES.fixture_program(root)


if __name__ == "__main__":
    unittest.main()
